// 合并 base+hi（每球 4 次绘制 → 3 次）之后的质量回归。
//   1. ballDiff —— 合成顺序改变（旧：高光压球缝 / 新：球缝压高光）造成的整球像素差
//   2. texDiff  —— 预烘焙贴图 vs 320² 母版现算，确认这轮改动没顺带把贴图弄糊
//   3. hot      —— 20 球全活跃时的每帧绘制次数（应为 3×球数）与帧率
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  await wait(600);
  const skins = ['classic', 'neon', 'soccer', 'watermelon', 'planet', 'gold'];
  const out = { ball: {}, tex: {} };
  for (const s of skins) {
    out.ball[s] = window.__pbBallDiff(s);
    out.tex[s] = window.__pbTexDiff(s).layers.exact;
  }
  window.__pbSetBalls(20);
  window.__pbChaos(true, 200);
  await wait(2600);
  const d = window.__pbDiag();
  out.hot = { fps: d.fps, stepHz: d.stepHz, balls: d.balls, drawCalls: d.drawCalls, expectCalls: d.balls * 3 };
  window.__pbChaos(false);
  return out;
})()
