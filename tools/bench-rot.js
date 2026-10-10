// 旋转单变量：只有「球缝这一层转不转」不同，其余完全一致。
//   mask 15 = 球缝旋转（现状）   mask 31 = 球缝不旋转（其余同）
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const snap = () => {
    const d = window.__pbDiag();
    return { fps: d.fps, stepHz: d.stepHz, drawMsAvg: d.drawMsAvg, drawCalls: d.drawCalls };
  };
  window.__pbSetBalls(60);
  window.__pbChaos(true, 200);
  await wait(3000);
  const out = {};
  out.rotated = (window.__pbLayers(15), await wait(2600), snap());
  out.unrotated = (window.__pbLayers(31), await wait(2600), snap());
  out.rotatedAgain = (window.__pbLayers(15), await wait(2600), snap());
  window.__pbChaos(false);
  return out;
})()
