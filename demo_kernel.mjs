// MiniAgent 内核演示（最直观版）：让 agent 在沙箱里生成一个能打开的单文件网页。
// 覆盖并展示：HTTP API / DeepSeek 模型解析 / 上下文(AGENTS.md) / 沙箱 / write+read 工具 / 事件流 / 落盘成品。
// 运行： node demo_kernel.mjs   （服务需在 http://localhost:3100 运行）
import { readdirSync, readFileSync, statSync } from 'node:fs';

const BASE = process.env.MINIAGENT_URL || 'http://localhost:3100';
const NOISY = new Set(['message_start', 'message_update']);   // 流式增量，太吵，跳过
const TOOLS = ['write', 'read', 'powershell', 'edit', 'bash'];

function listFiles(dir) {
  try { return readdirSync(dir).filter((f) => { try { return statSync(`${dir}/${f}`).isFile(); } catch { return false; } }); }
  catch { return []; }
}

// 只提取 assistant 的正文，不把 payload 里所有字符串都倒出来
function findAssistantText(payload) {
  let best = null;
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v.role === 'assistant' && v.content !== undefined) {
      let t = '';
      if (typeof v.content === 'string') t = v.content;
      else if (Array.isArray(v.content)) {
        t = v.content.map((p) => (p && typeof p === 'object' ? (p.text ?? p.content ?? '') : String(p))).join('');
      }
      if (t.trim()) best = t;
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(payload);
  return best;
}

// 尽力识别工具调用（不同 pi 版本 payload 形状不同，识别不到也不影响演示）
function findToolCalls(payload) {
  const found = [];
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    const n = typeof v.tool === 'string' ? v.tool : (typeof v.name === 'string' ? v.name : null);
    if (n && TOOLS.includes(n)) {
      const a = v.args ?? v.input ?? v.arguments ?? v.command ?? '';
      found.push({ tool: n, arg: typeof a === 'string' ? a : JSON.stringify(a) });
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(payload);
  return found;
}

async function main() {
  const health = await (await fetch(`${BASE}/api/agent/health`)).json();
  const cwd = health.engine?.cwd;
  console.log(`[engine] ${health.engine?.engine}@${health.engine?.version} mode=${health.engine?.mode}`);
  console.log(`[sandbox] ${cwd}`);

  const before = listFiles(cwd);
  console.log(`[workspace before] ${before.length} file(s): ${before.join(', ')}`);

  const run = await (await fetch(`${BASE}/api/agent/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();
  const id = run.id;
  console.log(`[run] ${id.slice(0, 8)}… model=${run.model?.provider}/${run.model?.id}`);

  const task = `Use the write tool to create ONE self-contained HTML file at ${cwd}/demo.html: a "MiniAgent Sandbox Demo" page. It must have: a title, a short paragraph explaining MiniAgent (a local HTTP service that wraps a coding agent and runs it in a sandbox), and a WORKING interactive to-do list (text input + Add button + list of items + delete each item). All CSS and JS must be inline, no external files or dependencies. Use a clean light theme with a centered card layout. Then use the read tool to read it back and confirm it is complete.`;
  await fetch(`${BASE}/api/agent/runs/${id}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task }),
  });
  console.log('[prompt] sent — agent is working…\n');

  const all = [];
  let since = 0, settled = false, seenRunning = false;
  const deadline = Date.now() + 240000;
  process.stdout.write('[live] ');
  while (Date.now() < deadline) {
    const e = await (await fetch(`${BASE}/api/agent/runs/${id}/events?since=${since}`)).json();
    const evs = e.events || [];
    for (const ev of evs) {
      all.push(ev);
      if (NOISY.has(ev.type)) { process.stdout.write('.'); continue; }   // 思考/输出增量只打个点
      const tools = findToolCalls(ev.payload);
      if (tools.length) { for (const t of tools) console.log(`\n[tool→${t.tool}] ${t.arg.slice(0, 120)}`); process.stdout.write('[live] '); }
      else if (ev.type !== 'message_start') console.log(`\n[${ev.type}]`), process.stdout.write('[live] ');
    }
    if (evs.length) since = evs[evs.length - 1].seq + 1;
    const st = e.run?.status;
    if (st === 'running') seenRunning = true;
    if (st === 'error') { console.log('\n[run error]', e.run?.lastError); break; }
    if (st === 'idle' && seenRunning) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!settled) console.log('\n[warn] timeout before settle');

  // 最终回答
  const finals = all.filter((e) => ['message_end', 'agent_end', 'turn_end'].includes(e.type));
  let answer = null;
  for (const f of finals) { const t = findAssistantText(f.payload); if (t) answer = t; }
  console.log(`\n\n[agent answer]\n${(answer ?? '(no text captured)').trim()}`);

  // 沙箱前后对比 —— 最直观的证据
  const after = listFiles(cwd);
  const created = after.filter((f) => !before.includes(f));
  console.log(`\n[workspace after] ${after.length} file(s): ${after.join(', ')}`);
  console.log(`[new files] ${created.length ? created.join(', ') : '(none)'}`);

  const ok = created.includes('demo.html');
  if (ok) {
    const size = statSync(`${cwd}/demo.html`).size;
    const head = readFileSync(`${cwd}/demo.html`, 'utf-8').slice(0, 60).replace(/\s+/g, ' ');
    console.log(`\ndemo.html: ${size} bytes | starts with: ${head}…`);
    console.log(`打开它： file:///${cwd.replace(/\\/g, '/')}/demo.html`);
    console.log('DEMO: PASS ✅  (内核真实地在沙箱里造出了一个能打开的网页)');
  } else {
    console.log('\nDEMO: FAIL ❌  (agent 没有产出 demo.html，看上面 [run error] / answer)');
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
