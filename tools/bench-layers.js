// 层数 → 帧率曲线（60 球上限档）。
// 目的：决定「把某些层合并成一张贴图」值不值得做 —— 先量收益，再决定改不改。
//   mask 15 = 阴影+底色+球缝+高光（现状，4 次 drawImage/球）
//   mask 11 = 阴影+底色+高光            （3 次；= 阴影+底色合并后的层数）
//   mask  3 = 阴影+底色                 （2 次）
//   mask  2 = 只有底色                  （1 次）
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
  for (const m of [15, 31, 11, 15]) {
    window.__pbLayers(m);
    await wait(2600);
    out['mask' + m] = snap();
  }
  window.__pbLayers(15);
  window.__pbChaos(false);
  return out;
})()
