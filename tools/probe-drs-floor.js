/**
 * tools/probe-drs-floor.js —— 排障探针：DRS 降到底之后**为什么升不回去**。
 *
 * 用法（⚠️ 必须带 --diag；⚠️ 结尾不能带分号）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir=<临时> --exit-after=55000 --eval="$(cat tools/probe-drs-floor.js)"
 *
 * `probe-drs-stuck.js` 已经证明：200 球把 DRS 压到 0.64× 之后，负载掉到 6 颗球，
 * 档位 18s 纹丝不动，而且 `votes` 的**降档列一路涨到 433** —— 说明 `presentP50`
 * 一直 > 参考节拍 × 1.35，被 presentBad 判成"呈现还是不健康，不许升"。
 *
 * 本探针要回答的是：**那个 ~30ms 的呈现间隔是"真的画不动"，还是被别的东西污染的**。
 * 于是把它拆成两段对照 + 逐秒带上特效计数：
 *   U1：6 颗球、**关掉篮筐**（`__pbToggleHoop`）→ 不会进球 → 没有火花/光环/彩带；
 *   U2：6 颗球、开回篮筐 → 会进球 → 每进一个球就 200+ 粒火花。
 * 如果 U1 的 p50 掉回 ~16ms 而 U2 卡在 30ms ⇒ 瓶颈是**特效**不是球数，
 * 那 DRS "不升档" 的判断本身是对的，要改的是夹具的负载构造（别让它一直进球）。
 * 如果两段都卡在 30ms ⇒ 这台机器（软件合成 + 13 个虚拟显示器）有一个**与球数无关的
 * 呈现地板**，那 DRS 就永远不会自动升回来 —— 那是真问题，得给一条"底噪逃生"规则。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.__pbFrameState();
  let churn = 0, live = 0;
  const start = (count, period, vx) => {
    window.__pbSetBalls(count);
    live = count;
    if (churn) clearInterval(churn);
    churn = setInterval(() => {
      for (let i = 0; i < live; i++) window.__pbThrow(i, (i % 2 ? 1 : -1) * (vx || 340), -520);
    }, period);
  };
  const rows = [];
  const snap = (tag) => {
    const st = S();
    rows.push(tag + ' scale=' + st.renderScale +
      ' votes=' + st.drsVotes.join('/') +
      ' idle=' + st.idle +
      ' p50=' + st.presentP50Ms + ' p95=' + st.presentP95Ms +
      ' hz=' + st.presentHz +
      ' drawMs=' + st.drawMsMedian +
      ' fx=' + st.fxParts + '/' + st.fxRings +
      ' trail=' + st.trailBalls +
      ' stall=' + st.presentStalls);
  };

  start(200, 300);
  for (let i = 0; i < 12; i++) { await wait(1000); snap('DOWN+' + (i + 1) + 's'); }

  // ---- U1：关掉篮筐（不进球 → 无特效）----
  const hoopWas = window.__pbToggleHoop();
  snap('U1-start(hoopWas=' + hoopWas + ')');
  start(6, 700, 120);        // 甩得轻一点，别把球撞进筐里
  for (let i = 0; i < 12; i++) { await wait(1000); snap('U1+' + (i + 1) + 's'); }

  // ---- U2：开回篮筐（会进球 → 特效常驻）----
  window.__pbToggleHoop();
  for (let i = 0; i < 10; i++) { await wait(1000); snap('U2+' + (i + 1) + 's'); }

  if (churn) clearInterval(churn);
  window.__pbSetBalls(1);
  return { rows: rows };
})()
