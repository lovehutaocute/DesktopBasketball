/**
 * tools/probe-drs-stuck.js —— 排障探针：DRS **卡在低档位升不回去** 时的逐秒取样。
 *
 * 用法（⚠️ 必须带 --diag；⚠️ 结尾不能带分号）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir=<临时> --exit-after=42000 --eval="$(cat tools/probe-drs-stuck.js)"
 *
 * 输出是 `EVAL ok {"rows":[...]}`，每行一秒：
 *   `DOWN+3s scale=0.76 votes=12/0 idle=false p50=41.2 hz=24.3 gapN=6 drawMs=1.8 ref=16.67`
 *
 * 要一眼看出来的三件事（`verify-drs.js` 第③段失败时按这个顺序排）：
 *   1. `idle=true`  ⇒ 主循环在空闲巡检里**根本没调 drsTick**，跟票数阈值无关；
 *   2. `votes` 两列**始终 0/0** ⇒ 掉进了 drsTick 的 else 分支（迟滞死区）被每帧清零；
 *   3. `votes` 的 up 列在涨但 `scale` 不动 ⇒ 才是票数阈值 / dwell 的问题。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__pbFrameState();
  let churn = 0, live = 0;
  const start = (count, period) => {
    window.__pbSetBalls(count);
    live = count;
    if (churn) clearInterval(churn);
    churn = setInterval(() => {
      for (let i = 0; i < live; i++) window.__pbThrow(i, (i % 2 ? 1 : -1) * 340, -520);
    }, period);
  };
  const rows = [];
  const snap = (tag) => {
    const st = S();
    rows.push(tag + ' scale=' + st.renderScale +
      ' votes=' + st.drsVotes.join('/') +
      ' idle=' + st.idle +
      ' p50=' + st.presentP50Ms +
      ' hz=' + st.presentHz +
      ' gapN=' + st.presentGapN +
      ' drawMs=' + st.drawMsMedian +
      ' ref=' + st.drsRefMs);
  };

  start(200, 300);
  for (let i = 0; i < 12; i++) { await wait(1000); snap('DOWN+' + (i + 1) + 's'); }
  start(6, 500);
  for (let i = 0; i < 18; i++) { await wait(1000); snap('UP+' + (i + 1) + 's'); }

  if (churn) clearInterval(churn);
  window.__pbSetBalls(1);
  return { rows: rows };
})()
