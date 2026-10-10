// 分档扫：不同球数下 fps / 各段耗时，找出真正的瓶颈随什么增长
(async () => {
  const wait = (m) => new Promise((r) => setTimeout(r, m));
  const out = [];
  const Ns = [20, 40, 60];
  for (const N of Ns) {
    window.__pbChaos(false);
    window.__pbSetBalls(N);
    await wait(500);
    const s0 = window.__pbDragRunner('state');
    window.__pbChaos(true, 220);
    await wait(4200);
    const d = window.__pbDiag();
    const s1 = window.__pbDragRunner('state');
    out.push({
      n: N,
      fps: d.fps, loopHz: d.loopHz, stepHz: d.stepHz,
      physMs: d.physMs, drawMs: d.drawMs,
      tiles: d.tiles, tilesTotal: d.tilesTotal, pairs: d.pairs,
      // 本档窗口内：循环自身耗时（不含 frame）与迭代数
      iters: s1.iters - s0.iters,
      loopMs: Math.round((s1.loopMs - s0.loopMs) * 10) / 10,
      draws: s1.draws - s0.draws,
      drawMs: Math.round((s1.drawMs - s0.drawMs) * 10) / 10,
    });
  }
  window.__pbChaos(false);
  for (const r of out) {
    r.msPerIter = r.iters ? Math.round((r.loopMs / r.iters) * 1000) / 1000 : 0;
    r.msPerDraw = r.draws ? Math.round((r.drawMs / r.draws) * 1000) / 1000 : 0;
  }
  return out;
})()
