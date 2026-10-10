/**
 * tools/probe-vis.js —— 让窗口处于「有加分特效 + 性能面板打开」的状态，供真实屏幕截图验收。
 * 配合 --diag 使用；用法见 probe-skin.js 顶部。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2600);
  window.__pbPerf(true);            // 打开性能面板（DOM）
  window.__pbPlace(0, 1233, 300, 0, 120);   // 从篮圈正上方落下 → 空心球 + 加分特效
  await wait(500);
  return { skin: window.__pbSkin(), perf: document.getElementById('perf').style.display,
           balls: window.__pbDiag().balls };
})()
