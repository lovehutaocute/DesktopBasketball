// 渲染层验收：残影 / 休眠球像素保留 / 贴图质量回归。
// 改动点是「先清脏块、再按全局 z 序把每个图元只画一次」，必须证明它没有留下擦不掉的像素。
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dg = () => window.__pbDiag();
  const ink = (x, y, w, h) => window.__pbInk(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  const out = {};

  // ---------- 1. 残影：球移走后，原位必须一个像素都不剩 ----------
  window.__pbSetBalls(1);
  window.__pbPlace(0, 300, 320, 0, 0);
  await wait(2600);                                  // 落地 → 入睡 → 像素留在画布上
  const p0 = dg().pos[0];
  out.restPos = [p0[0], p0[1]];
  out.inkAtRest = ink(p0[0] - 55, p0[1] - 55, 110, 110);
  window.__pbPlace(0, 1280, 320, 0, 0);              // 挪到很远的地方
  await wait(1400);                                  // 等 prevActive 两代过期
  out.inkAfterMove = ink(p0[0] - 55, p0[1] - 55, 110, 110);
  out.residuePass = out.inkAtRest > 60 && out.inkAfterMove === 0;

  // ---------- 2. 休眠球的像素不能被"顺带"擦掉 ----------
  window.__pbSetBalls(4);
  window.__pbPlace(0, 260, 620, 0, 0);
  window.__pbPlace(1, 470, 620, 0, 0);
  window.__pbPlace(2, 680, 620, 0, 0);
  window.__pbPlace(3, 890, 620, 0, 0);
  /**
   * ⚠️ **必须轮询到"四颗全部入睡"，不能固定 `wait(4600)`**（2026-10-11 实测坐实）。
   *
   * 球落地之后有很长一段时间在**以 ≤0.23px/步 慢慢爬**（`sleepTimer` 5~51，阈值 52）：
   * 这期间它的抗锯齿像素**每帧都在变**，而 `sleepPass` 断言的是"另外三颗逐字节不变"。
   * 撞上"刚好还在爬"就会差 1~100 像素 → **随机失败**（本夹具的旧注释早就记过这条，
   * 当时只能把 `asleep` 降级成诊断信息；现在改成等到位，断言才真的确定）。
   *
   * 判据：等到 `isSleeping` 全为真。实测约 3.0~3.4s 到位（`idleAt≈15`），留 6s 上限；
   * 超时也如实记进 `allAsleep=false`，不静默降级。
   */
  let allAsleep = false;
  for (let i = 0; i < 30; i++) {
    await wait(200);
    const s = dg().pos.slice(0, 4);
    if (s.length === 4 && s.every((p) => p[2] === 1) && dg().idle) { allAsleep = true; break; }
  }
  const st = dg().pos;
  const pos = st.map((p) => [p[0], p[1]]);
  const asleep = st.map((p) => p[2] === 1);
  out.allAsleep = allAsleep;
  const box = (p) => ink(p[0] - 46, p[1] - 46, 92, 92);
  const before = pos.map(box);
  const old0 = before[0];
  // 失败时的现场快照：只靠 before/after 两个数字无法判断"是球动了、还是贴图档位换了、
  // 还是画布被换了"。这一组状态是排查"未动的球像素却变了"的最小充分集。
  const dump = () => {
    const f = window.__pbFrameState();
    const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
    return {
      sq: f.balls.map((b) => b.sq),
      sl: f.balls.map((b) => (b.sleeping ? 1 : 0)),
      vx: f.balls.map((b) => b.vx),
      rx: f.balls.map((b) => r3(b.rx)),
      ry: f.balls.map((b) => r3(b.ry)),
      px: f.balls.map((b) => r3(b.px)),
      bx: f.balls.map((b) => r3(b.bx)),
      by: f.balls.map((b) => r3(b.by)),
      dpr: f.device.dpr,
      mpx: f.device.backingMpx,
    };
  };
  const d0 = dump();
  const idle0 = dg().idle;
  const mip0 = dg().mip;
  window.__pbThrow(0, -1100, -1750);                 // 只让 0 号动起来，其余保持休眠
  await wait(300);
  const after = pos.map(box);
  const d1 = dump();
  // 被抛走的 0 号：原位必须干净；1/2/3 号睡着且没被碰过 → 必须逐字节不变。
  // ⚠️ `allAsleep` 现在是**硬门槛**（旧版只能当诊断信息，见上面那段注释）：先等到位再采样，
  //    这条断言才真的确定；"球一直不入睡"本身也是要修的缺陷（睡眠阈值见 physics.js）。
  out.sleepInk = {
    asleep: asleep, before: before, after: after, d0: d0, d1: d1,
    idle0: idle0, mip0: mip0, mip1: dg().mip,
  };
  out.sleepPass = allAsleep && after[0] === 0 &&
                  before[1] === after[1] && before[2] === after[2] && before[3] === after[3];
  out.oldBoxCleaned = { before: old0, after: after[0] };
  window.__pbChaos(false);
  await wait(2500);

  // ---------- 3. 删球：被删掉的那些球不能留下像素 ----------
  window.__pbSetBalls(5);
  await wait(400);
  for (let i = 0; i < 5; i++) window.__pbPlace(i, 240 + i * 180, 560, 0, 0);
  await wait(3200);                                  // 五颗全部静止
  const p5 = dg().pos.map((p) => [p[0], p[1]]);
  const ink5 = p5.map((p) => ink(p[0] - 46, p[1] - 46, 92, 92));
  window.__pbSetBalls(1);                            // 只留 0 号（removeBall 从末尾弹）
  await wait(1300);
  out.ballsNow = dg().balls;
  const inkDel = p5.slice(1).map((p) => ink(p[0] - 46, p[1] - 46, 92, 92));
  out.deleteInk = { before: ink5, afterDelete: inkDel, kept: ink(p5[0][0] - 46, p5[0][1] - 46, 92, 92) };
  out.deletePass = ink5.slice(1).every((v) => v > 100) && inkDel.every((v) => v === 0);

  // ---------- 4. 贴图质量：预烘焙 mip vs 320² 母版 ----------
  out.texClassic = window.__pbTexDiff('classic');
  out.texWatermelon = window.__pbTexDiff('watermelon');
  out.texGold = window.__pbTexDiff('gold');
  out.mip = dg().mip;

  return out;
})()
