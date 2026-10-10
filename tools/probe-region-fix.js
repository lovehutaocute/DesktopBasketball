/**
 * tools/probe-region-fix.js —— 验收「窗口区域补齐」：性能面板 / 成就列表 / 提示气泡 / 加分特效
 * 是否都能在**真实屏幕**上完整显示（配合 tools\screencap.ps1 + tools\crop.ps1）。
 *
 * 用法见 probe-skin.js 顶部（必须 --diag）。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(900);
  window.__pbPerf(true);              // 1) 性能面板（DOM）
  window.__pbAction('achievements');  // 2) 画布上的成就列表（fx.texts）
  await wait(1400);
  window.__pbAction('toggle-sound');  // 3) 提示气泡（DOM toast）
  await wait(1400);
  window.__pbScore();                 // 4) 空心球 → 加分飘字 + 火花
  await wait(1200);
  return {
    skin: window.__pbSkin(),
    perf: document.getElementById('perf').style.display,
    toastShown: document.getElementById('toast').classList.contains('show'),
  };
})()
