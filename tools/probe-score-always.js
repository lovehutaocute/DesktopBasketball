/**
 * tools/probe-score-always.js —— 让加分飘字**始终在场**（每 900ms 投一次空心球，
 * 飘字寿命 1.0~1.6s），这样任意时刻截图都必然拍到特效，不再靠掐时间。
 * 用法见 probe-skin.js 顶部（必须 --diag）。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__pbPerf(true);
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    window.__pbScore();
    await wait(900);
  }
  return 'done';
})()
