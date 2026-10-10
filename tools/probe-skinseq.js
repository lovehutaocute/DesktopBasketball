/**
 * tools/probe-skinseq.js —— 依次切换全部 5 套皮肤（每套停留 2.6s），供真实屏幕截图逐一核对。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  const seq = [];
  for (const s of ['classic', 'neon', 'soccer', 'watermelon', 'planet']) {
    window.__pbSkin(s);
    const d = window.__pbDiag();
    seq.push(s + '@' + d.pos[0][0] + ',' + d.pos[0][1] + ' skin=' + window.__pbSkin());
    await wait(2600);
  }
  return seq;
})()
