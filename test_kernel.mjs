// MiniAgent 内核端到端测试：不依赖前端，直接打 HTTP API。
// 覆盖：健康检查 / run 创建 / 模型解析(DeepSeek) / 沙箱 / 工具(write+read) / 上下文(AGENTS.md) / 落盘校验。
// 运行： node test_kernel.mjs   （服务需在 http://localhost:3100 运行）
import { readFileSync } from 'node:fs';

const BASE = process.env.MINIAGENT_URL || 'http://localhost:3100';

function extractText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (v.trim()) out.push(v); }
    else if (Array.isArray(v)) { v.forEach(walk); }
    else if (v && typeof v === 'object') {
      if (v.role === 'assistant' && (v.content || v.text)) {
        const c = v.content;
        if (typeof c === 'string') out.push(c);
        else if (Array.isArray(c)) c.forEach((p) => { if (p && (p.text || p.content)) out.push(p.text || p.content); });
      }
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(payload);
  return out.length ? out.join('\n') : null;
}

async function main() {
  const health = await (await fetch(`${BASE}/api/agent/health`)).json();
  const cwd = health.engine?.cwd;
  console.log(`[engine] ${health.engine?.engine}@${health.engine?.version} mode=${health.engine?.mode} cwd=${cwd}`);

  const runRes = await fetch(`${BASE}/api/agent/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const run = await runRes.json();
  const id = run.id;
  console.log(`[run] id=${id} model=${JSON.stringify(run.model)} cwd=${run.cwd}`);

  const task = `Use the write tool to create a file at the absolute path ${cwd}/kernel_probe.txt whose content is exactly the text KERNEL_OK. Then use the read tool to read that file back and tell me what you see. Do not create files anywhere else.`;
  const pRes = await fetch(`${BASE}/api/agent/runs/${id}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: task }),
  });
  console.log(`[prompt] accepted=${pRes.status}`);

  const all = [];
  let since = 0;
  let settled = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const e = await (await fetch(`${BASE}/api/agent/runs/${id}/events?since=${since}`)).json();
    const evs = e.events || [];
    for (const ev of evs) all.push(ev);
    if (evs.length) since = evs[evs.length - 1].seq + 1;
    const st = e.run?.status;
    if (st === 'error') { console.log('[run error]', e.run?.lastError); break; }
    if (st === 'idle' && all.some((x) => x.type === 'agent_start')) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!settled) console.log('[warn] did not observe settle within timeout');

  console.log('--- agent / tool trace (best-effort) ---');
  for (const ev of all) {
    const t = extractText(ev.payload);
    if (t) console.log(`[${ev.type}] ${t.slice(0, 400)}`);
  }

  const p = `${cwd}/kernel_probe.txt`;
  let disk = null;
  try { disk = readFileSync(p, 'utf-8'); } catch {}
  console.log('--- disk check ---');
  console.log(`file: ${p}`);
  console.log(`exists: ${disk !== null} | content: ${JSON.stringify(disk)}`);
  const ok = disk !== null && disk.includes('KERNEL_OK');
  console.log(ok ? 'KERNEL TEST: PASS ✅' : 'KERNEL TEST: FAIL ❌');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
