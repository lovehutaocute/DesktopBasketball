/**
 * tools/probe-region-loop.js —— 让「加分特效 / 气泡 / 成就列表 / 性能面板」长时间**始终有内容**，
 * 这样真实屏幕连拍里任何一帧都必然处在这几种状态之一，不再依赖掐时间。
 * 用法见 probe-skin.js 顶部（必须 --diag）。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__pbPerf(true);
  window.__pbSkin('classic');
  let i = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 26000) {
    i++;
    if (i % 3 === 1) window.__pbScore();          // 空心球 → 加分飘字 + 火花
    if (i % 3 === 2) window.__pbAction('toggle-sound'); // 气泡（DOM toast）
    if (i % 2 === 0) window.__pbAction('achievements'); // 成就列表（canvas 飘字）
    await wait(800);
  }
  return 'done';
})()
