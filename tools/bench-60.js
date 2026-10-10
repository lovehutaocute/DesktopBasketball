// 60 球上限档：判断 49fps 到底还是不是"球的光栅化"造成的。
//   A1/A2 同条件重复两遍 → 先看噪声有多大（软件合成下同一份代码能差好几帧）
//   B     flatBall（每球 1 次 fill 代替 4 次 drawImage）→ 若回到 60，瓶颈仍是贴图绘制
//
// 结论（已据此改 render.js）：瓶颈是**每帧的绘制调用次数**，不是像素本身。三项对照：
//   ① 球缝换成同样 1 次绘制的**不透明纯色块** → 帧率纹丝不动（54.5 vs 54.3）
//   ② 所有层强制走 1:1 的 exact 档（彻底不做重采样）→ 纹丝不动（55.1）
//   ③ 每球少画一层：4 次 → 240 次/帧时 54fps；3 次 → 180 次/帧时 60fps
// 于是把「不随球旋转、又同坐标系」的底色与高光烘前合并成一张 body，每球 4 次降到 3 次。
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const snap = () => {
    const d = window.__pbDiag();
    return { fps: d.fps, stepHz: d.stepHz, drawMsAvg: d.drawMsAvg, drawCalls: d.drawCalls, tiles: d.tiles };
  };
  window.__pbSetBalls(60);
  window.__pbChaos(true, 200);
  await wait(3000);
  const out = {};
  await wait(2500); out.A1 = snap();
  await wait(2500); out.A2 = snap();
  window.__pbFlyRunner('flat', 1);
  await wait(2500); out.B_flat = snap();
  window.__pbFlyRunner('flat', 0);
  window.__pbChaos(false);
  return out;
})()
