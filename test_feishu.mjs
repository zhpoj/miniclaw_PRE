/**
 * 端到端冒烟：飞书消息 → agent run → 飞书回复。
 *
 * 做法：在本进程里起一个假的飞书开放平台（tenant token + 发消息 + 改消息三个接口），
 * 再让服务把 FEISHU_BASE_URL 指向它，最后投递一条真实的 im.message.receive_v1 事件，
 * 看agent 的回复是不是真的被"发回飞书"。
 *
 * 用法：
 *   npm run build            # 脚本跑的是 dist/
 *   node test_feishu.mjs     # 加 --stream 走流式卡片回写分支
 *
 * 说明：这条链路会真的调用大模型（默认 ~1 次对话），会产生少量 token 费用。
 */

import { createServer } from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STREAM = process.argv.includes('--stream');
const API_PORT = 8799;
const APP_PORT = Number(process.env.MINIAGENT_PORT ?? 3101);
const CHAT_ID = 'oc_e2e_chat';
const PROMPT = '只回复两个字：OK。不要调用任何工具。';
const TIMEOUT_MS = 180_000;
const POLL_MS = 1000;

const received = [];

function json(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => resolve(raw));
    request.on('error', reject);
  });
}

/** Minimal stand-in for https://open.feishu.cn. */
const fakeFeishu = createServer((request, response) => {
  void readBody(request)
    .then((raw) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${API_PORT}`);
      const payload = raw ? JSON.parse(raw) : {};

      if (url.pathname.includes('tenant_access_token')) {
        json(response, { code: 0, tenant_access_token: 't_mock', expire: 7200 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/open-apis/im/v1/messages') {
        received.push({ kind: 'send', ...describe(payload) });
        json(response, { code: 0, data: { message_id: `om_${received.length}` } });
        return;
      }

      if (request.method === 'PATCH' && url.pathname.startsWith('/open-apis/im/v1/messages/')) {
        received.push({
          kind: 'update',
          id: url.pathname.split('/').pop(),
          ...describe(payload),
        });
        json(response, { code: 0 });
        return;
      }

      json(response, { code: 0 });
    })
    .catch((error) => {
      json(response, { code: 1, msg: String(error) }, 500);
    });
});

function describe(payload) {
  const content = payload.content ?? '';
  if (payload.msg_type === 'interactive') {
    const card = typeof content === 'string' ? JSON.parse(content) : content;
    const markdown = (card.elements ?? []).find((element) => element.tag === 'markdown');
    return { type: 'interactive', text: markdown?.content ?? '' };
  }
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  return { type: payload.msg_type ?? 'text', text: parsed?.text ?? '' };
}

function start(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let dots = 0;
  while (Date.now() < deadline) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    dots += 1;
    if (dots % 10 === 0) process.stdout.write(`  ...已等待 ${dots}s\n`);
  }
  throw new Error(`超时：${label}（${TIMEOUT_MS / 1000}s 内没有发生）`);
}

async function main() {
  await start(fakeFeishu, API_PORT);
  console.log(`[1/5] 假飞书开放平台已启动: http://127.0.0.1:${API_PORT}`);

  process.env['FEISHU_APP_ID'] = process.env['FEISHU_APP_ID'] ?? 'cli_e2e';
  process.env['FEISHU_APP_SECRET'] = process.env['FEISHU_APP_SECRET'] ?? 'secret_e2e';
  process.env['FEISHU_BASE_URL'] = `http://127.0.0.1:${API_PORT}`;
  process.env['AGENT_CWD'] ??= fileURLToPath(new URL('./workspace/', import.meta.url));
  if (STREAM) process.env['IM_STREAMING'] = '1';

  const { serve } = await import('@hono/node-server');
  let createApp;
  try {
    ({ createApp } = await import('./dist/app.js'));
  } catch {
    throw new Error('找不到 dist/app.js，先执行 npm run build');
  }

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: APP_PORT, hostname: '127.0.0.1' });
  console.log(`[2/5] MiniAgent 服务已启动: http://127.0.0.1:${APP_PORT}`);

  const health = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/im/health`)).json();
  console.log(`[3/5] IM 健康检查: ${JSON.stringify(health)}`);
  if (!health.channels.some((channel) => channel.id === 'feishu')) {
    throw new Error('飞书通道没有挂载，检查 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }

  const event = {
    schema: '2.0',
    header: {
      event_id: 'evt_e2e',
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant_e2e',
      app_id: 'cli_e2e',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_e2e_user', union_id: 'on_e2e_user' },
        tenant_key: 'tenant_e2e',
        type: 'user',
      },
      message: {
        message_id: 'om_e2e_in',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 ${PROMPT}` }),
      },
    },
  };

  const webhook = await fetch(`http://127.0.0.1:${APP_PORT}/api/im/feishu/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  console.log(
    `[4/5] 已投递一条飞书消息（${PROMPT.slice(0, 24)}…），webhook 返回 ${webhook.status} ${JSON.stringify(
      await webhook.json(),
    )}`,
  );

  const binding = await waitFor(
    () =>
      fetch(`http://127.0.0.1:${APP_PORT}/api/im/conversations`)
        .then((response) => response.json())
        .then((data) => data.conversations.find((item) => item.runId))
        .catch(() => undefined),
    '会话没有绑定到 agent run',
  );
  console.log(`      会话绑定: ${JSON.stringify(binding)}`);

  const agentRun = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/agent/runs/${binding.runId}`)).json();
  console.log(
    `      run 详情: status=${agentRun.status} model=${agentRun.model?.provider}/${agentRun.model?.id} cwd=${agentRun.cwd}`,
  );

  const reply = await waitFor(
    () => received.find((item) => item.text && !item.text.includes('正在处理')),
    '没有收到 agent 的回复',
  );
  console.log(`[5/5] 飞书收到的回复 (${reply.kind}/${reply.type}):\n${reply.text}`);

  if (STREAM) {
    const patched = await waitFor(
      () => received.filter((item) => item.kind === 'update').at(-1),
      '流式卡片没有被回填',
    );
    console.log(`      卡片回填: ${JSON.stringify(patched).slice(0, 200)}`);
  }

  server.close();
  fakeFeishu.close();

  if (!reply.text.trim()) throw new Error('回复是空的');
  console.log('\n✅ 飞书消息 → agent run → 飞书回复 全链路打通');
  process.exit(0);
}

main().catch((error) => {
  console.error('\n❌ 失败:', error instanceof Error ? error.message : error);
  fakeFeishu.close();
  process.exit(1);
});
