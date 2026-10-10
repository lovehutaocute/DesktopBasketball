// 隔离到底是谁限制了帧率：物理 / 绘制(raster) / 提交(合成)
//   A 基线（正常绘制节流 14.3ms）
//   B 把绘制节流压到 200ms（≈5Hz）→ 若 fps 冲到 60，瓶颈在绘制/提交；若不动，瓶颈在别处
//   C 恢复节流 + flatBall（每球 1 次 fill 代替 4 次 drawImage）
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const out = {};
  window.__pbSetBalls(40);
  window.__pbChaos(true, 220);
  await wait(3000);
  const snap = (k) => {
    const d = window.__pbDiag();
    out[k] = { fps: d.fps, loopHz: d.loopHz, stepHz: d.stepHz, drawMsAvg: d.drawMsAvg, tiles: d.tiles };
  };

  await wait(2500); snap('A_base');
  window.__pbDragRunner('cap', 200);
  await wait(2500); snap('B_drawThrottled');
  window.__pbDragRunner('cap', 1000 / 70);
  await wait(1500);
  window.__pbFlyRunner('flat', 1);
  await wait(2500); snap('C_flatBall');
  window.__pbFlyRunner('flat', 0);
  window.__pbChaos(false);
  return out;
})()
