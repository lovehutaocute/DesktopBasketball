/**
 * tools/verify-features.js —— 计分/连击/重置 的一次性自测脚本（用 --eval 注入渲染进程）。
 *
 * 用法（⚠️ 必须同时带 --diag，否则 startCaptureTools 会在守卫处直接 return，
 * --eval 与 --exit-after 都不会被处理，进程会一直挂着）：
 *
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --eval="$(cat tools/verify-features.js)" --exit-after=9000
 *
 * 结果写在 %APPDATA%\DesktopBasketball\runtime.log 的 `EVAL ok {...}` 一行。
 * 期望：afterSwish 是 +3 / swish:true / combo:2，afterReset 是 score:0 且 highScore 保留。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__pbScoreState();
  const out = {};
  await wait(300);
  out.before = S();
  // 从篮圈正上方自然落下 → 空心球，应得 3 分；若紧接着再进一球则连击 +1
  window.__pbScore();
  await wait(1400);
  out.afterSwish = S();
  // 重置：得分/连击归零，最高分保留
  out.afterReset = window.__pbReset();
  const d = window.__pbDiag();
  out.diag = { score: d.score, highScore: d.highScore, combo: d.combo };
  return out;
})()
