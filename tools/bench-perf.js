// 流畅性基准：把 N 颗球全部保持唤醒，量渲染/物理/调度三处的耗时。
// 用法：electron . --no-gpu --diag --eval="$(cat tools/bench-perf.js)" --exit-after=26000
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const N = Number(window.__benchN) || 40;

  window.__pbSetBalls(N);
  window.__pbChaos(true, 220);          // 持续给冲量 → 全部球永远不休眠
  await wait(2500);                     // 让统计窗口稳定
  await wait(3000);
  const hot = window.__pbDiag();
  window.__pbChaos(false);
  await wait(400);
  const after = window.__pbDiag();

  return {
    n: N,
    hot: {
      fps: hot.fps, loopHz: hot.loopHz, stepHz: hot.stepHz,
      physMs: hot.physMs, physMaxMs: hot.physMaxMs,
      drawMs: hot.drawMs, drawMsAvg: hot.drawMsAvg,
      tiles: hot.tiles, tilesTotal: hot.tilesTotal,
      pairs: hot.pairs, draws: hot.draws,
      drawCalls: hot.drawCalls, mip: hot.mip,
    },
    after: { fps: after.fps, drawMs: after.drawMs },
  };
})()
