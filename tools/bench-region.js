// 关键实验：区域上报（SetWindowRgn）是不是帧率杀手。
// 对照组：noLock=true → 区域恒定锁成"整窗"，去重后主进程一次 SetWindowRgn 都不再调用。
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const out = { n: 40 };
  window.__pbSetBalls(40);
  window.__pbChaos(true, 220);
  await wait(3000);

  const snap = () => {
    const d = window.__pbDiag();
    return { fps: d.fps, loopHz: d.loopHz, stepHz: d.stepHz, drawMsAvg: d.drawMsAvg };
  };

  await wait(2500); const a = snap();          // A：正常逐球圆盘区域，每帧都在变
  window.__pbDragRunner('shape', true);        // B：区域锁成整窗 → 去重后零更新
  await wait(2500); const b = snap();
  window.__pbDragRunner('shape', false);       // C：恢复
  await wait(2500); const c = snap();
  window.__pbChaos(false);

  out.A_regionPerFrame = a;
  out.B_regionLocked = b;
  out.C_restored = c;
  return out;
})()
