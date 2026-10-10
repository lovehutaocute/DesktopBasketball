'use strict';
/**
 * tools/verify-stream.js —— 「串流兼容模式」开关逻辑的一次性自测（**纯 node，不起 GUI**）。
 *
 * 为什么单独拿纯 node 测：
 *   本机的 GUI 采样不可信（README §4.1.4：Agent 从 Bash 启动 GUI 会让 GPU 进程崩），
 *   而开关逻辑本身是**纯函数**（src/stream.js 不 require electron / koffi），
 *   所以直接 require 进来断言即可 —— 5 秒跑完、零环境依赖。
 *
 * 它盯的是这次修复掉的两条真实 bug（README §6.10）：
 *   ① 「托盘读配置、实际按命令行」→ 点了没反应 / 显示与实际不符。
 *      → 判据：`resolve()` 的 `source` 必须如实区分 arg / user / user-off / auto / default，
 *        且 `active` 必须与 `source` 自洽，绝不出现 active=true 但 source=default。
 *   ② 「重启参数不清洗」→ 同时带 --stream 与 --no-stream，点了没反应。
 *      → 判据：`sanitizeArgs()` 消除后**有且仅有一个**串流开关，且目标值正确。
 *
 * 用法：
 *   node tools/verify-stream.js
 * 退出码：0 = 全过，1 = 有失败。
 */

const stream = require('../src/stream');

let ok = 0, bad = 0;
const fails = [];
function T(name, cond, info) {
  if (cond) { ok++; }
  else { bad++; fails.push(name + (info !== undefined ? '  →  ' + info : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. parseArg：命令行表态 ────────────────────────────────────────────────
T('parseArg 空 argv → null', stream.parseArg([]) === null);
T('parseArg 无关参数 → null', stream.parseArg(['--diag', '--no-gpu', '.']) === null);
T('parseArg --stream → on', stream.parseArg(['--stream']) === 'on');
T('parseArg --no-stream → off', stream.parseArg(['--no-stream']) === 'off');
T('parseArg --stream=1 → on', stream.parseArg(['--stream=1']) === 'on');
T('parseArg --no-stream=0 → off', stream.parseArg(['--no-stream=0']) === 'off');
T('parseArg 非数组 → null', stream.parseArg(null) === null);
// 后写的胜出（Chromium 也是后者覆盖语义更符合直觉；重点是"只有一个结论"）
T('parseArg 同时出现取最后一个', stream.parseArg(['--stream', '--no-stream']) === 'off',
  stream.parseArg(['--stream', '--no-stream']));

// ── 2. sanitizeArgs：重启参数清洗（bug ② 的直接判据）──────────────────────
{
  const out = stream.sanitizeArgs(['--diag', '--stream', '--no-gpu'], 'off');
  T('sanitizeArgs 摘掉旧的 --stream 并补 --no-stream',
    eq(out, ['--diag', '--no-gpu', '--no-stream']), JSON.stringify(out));
}
{
  // 关键场景：用户带 --stream 启动、想关掉 —— 修复前会留下两个互斥开关
  const out = stream.sanitizeArgs(['--stream'], 'off');
  T('sanitizeArgs 互斥开关只留一个（off）',
    out.filter(stream.isStreamArg).length === 1 && !out.includes('--stream'),
    JSON.stringify(out));
}
{
  const out = stream.sanitizeArgs(['--no-stream=1', '--stream'], 'on');
  T('sanitizeArgs 带值写法也被摘干净',
    out.filter(stream.isStreamArg).length === 1 && out[out.length - 1] === '--stream',
    JSON.stringify(out));
}
{
  const src = ['--diag', '--stream'];
  const copy = src.slice();
  stream.sanitizeArgs(src, 'off');
  T('sanitizeArgs 不修改入参', eq(src, copy), JSON.stringify(src));
}
T('sanitizeArgs(null, null) → []', eq(stream.sanitizeArgs(null, null), []));

// ── 3. matchVirtualDisplay：设备名判定（宁可漏判、不要误判）───────────────
T('匹配 UU 超级屏', !!stream.matchVirtualDisplay(['UU Super Screen']));
T('匹配希沃（中文名）', !!stream.matchVirtualDisplay(['希沃白板虚拟显示']));
T('匹配 ToDesk', !!stream.matchVirtualDisplay(['ToDesk Virtual Display']));
T('匹配大小写无关', !!stream.matchVirtualDisplay(['todesk VIRTUAL display']));
T('普通 Intel 核显不误判', stream.matchVirtualDisplay(['Intel(R) UHD Graphics 630']) === null);
T('普通显示器不误判', stream.matchVirtualDisplay(['Generic PnP Monitor']) === null);
T('空列表 → null', stream.matchVirtualDisplay([]) === null);
T('未挂载的闲置驱动名也不该误判（只匹配传入项）',
  stream.matchVirtualDisplay(['NVIDIA GeForce RTX 4060']) === null);
// 自定义 hints 覆盖默认表
T('自定义 hints 生效',
  stream.matchVirtualDisplay(['MyStream Box'], ['mystream']) === 'MyStream Box');
T('自定义 hints 覆盖默认表（uu 不再命中）',
  stream.matchVirtualDisplay(['UU Super Screen'], ['mystream']) === null);

// ── 4. resolve：优先级与 source 自洽（bug ① 的直接判据）───────────────────
{
  // ① 命令行最高
  const r = stream.resolve({ argv: ['--stream'], config: {}, devices: [] });
  T('argv --stream → active, source=arg', r.active === true && r.source === 'arg');
}
{
  const r = stream.resolve({ argv: ['--no-stream'], config: { streamMode: true }, devices: ['UU Super Screen'] });
  T('argv --no-stream 压过配置与自动检测',
    r.active === false && r.source === 'arg', JSON.stringify(r));
}
{
  // ② 配置显式开
  const r = stream.resolve({ argv: [], config: { streamMode: true }, devices: [] });
  T('config.streamMode=true → active, source=user',
    r.active === true && r.source === 'user', JSON.stringify(r));
}
{
  // ③ 用户显式关过 → 不再自动开（哪怕检测到虚拟显示）
  const r = stream.resolve({
    argv: [], config: { streamMode: false, streamExplicit: true },
    devices: ['UU Super Screen'],
  });
  T('用户显式关过 → 不自动开（source=user-off）',
    r.active === false && r.source === 'user-off', JSON.stringify(r));
}
{
  // ④ 自动检测：远程会话
  const r = stream.resolve({ argv: [], config: {}, remoteSession: true, devices: [] });
  T('远程会话（RDP）→ 自动开, source=auto',
    r.active === true && r.source === 'auto', JSON.stringify(r));
}
{
  // ④ 自动检测：虚拟显示
  const r = stream.resolve({ argv: [], config: {}, devices: ['UU Super Screen'] });
  T('检测到虚拟显示 → 自动开, source=auto',
    r.active === true && r.source === 'auto', JSON.stringify(r));
  T('自动开时 detected 记下命中的设备名（便于日志追溯）',
    r.detected === 'UU Super Screen', r.detected);
}
{
  // ⑤ 默认
  const r = stream.resolve({ argv: [], config: {}, devices: ['Intel(R) UHD Graphics 630'] });
  T('普通环境 → active=false, source=default',
    r.active === false && r.source === 'default', JSON.stringify(r));
}
// 自洽性：source 决定 active 该是什么（这就是"显示与实际不符"的形式化）
//   · 'user' / 'auto'  ⇒ active 必须 true（这两种来源只可能来自"要开"）
//   · 'default' / 'user-off' ⇒ active 必须 false
//   · 'arg' 取决于传的是 --stream 还是 --no-stream，不在此约束
{
  const cases = [
    { argv: [], config: {} },
    { argv: ['--stream'], config: {} },
    { argv: ['--no-stream'], config: {} },
    { argv: [], config: { streamMode: true } },
    { argv: [], config: { streamExplicit: true } },
    { argv: [], config: {}, remoteSession: true },
    { argv: [], config: {}, devices: ['UU Super Screen'] },
    // 组合：命令行压过配置；用户表态压过自动检测
    { argv: ['--no-stream'], config: { streamMode: true } },
    { argv: [], config: { streamExplicit: true }, devices: ['UU Super Screen'] },
  ];
  let consistent = true, detail = '';
  for (const c of cases) {
    const r = stream.resolve(c);
    const want = (r.source === 'user' || r.source === 'auto') ? true
      : (r.source === 'default' || r.source === 'user-off') ? false
        : null;
    if (want !== null && r.active !== want) {
      consistent = false; detail = JSON.stringify(c) + ' → ' + JSON.stringify(r); break;
    }
  }
  T('source 与 active 永远自洽（不出现开着却显示关）', consistent, detail);
}
// resolve 不修改入参
{
  const argv = ['--stream'];
  const cfg = { streamMode: false };
  stream.resolve({ argv, config: cfg, devices: [] });
  T('resolve 不修改入参', eq(argv, ['--stream']) && eq(cfg, { streamMode: false }));
}

// ── 5. COMPAT_SWITCHES：三条开关齐全且顺序稳定 ───────────────────────────
T('兼容开关三条齐全',
  eq(stream.COMPAT_SWITCHES,
    ['disable-direct-composition', 'disable-gpu-compositing', 'disable-zero-copy']),
  JSON.stringify(stream.COMPAT_SWITCHES));

// ── 结果 ─────────────────────────────────────────────────────────────────
console.log(`[STREAM] ok=${ok} bad=${bad}`);
if (bad) { console.log('[STREAM] 失败项：\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('[STREAM] 全部通过');
