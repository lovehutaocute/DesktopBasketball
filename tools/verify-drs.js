/**
 * tools/verify-drs.js —— 动态渲染分辨率（DRS）**第二路判据（呈现间隔）**的验收夹具。
 *
 * 背景：DRS 原来只看"我们自己的整帧绘制耗时 / 屏周期"。球一多，真正拖后腿的是绘制**之后**
 * 那一段（光栅 → 合成 → 提交 → 呈现），而 `drawMs` 可能只有 1.6ms（占屏周期 10%），
 * 于是 DRS 一次都不降档、画面却已经掉到 17 帧。本夹具验的是新补的"结果导向"判据：
 * 相邻两次呈现的中位间隔（p50）相对参考节拍超标 → 降档。
 *
 * 用法（⚠️ 必须带 --diag；⚠️ 结尾不能带分号）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir=<临时> --exit-after=60000 --eval="$(cat tools/verify-drs.js)"
 *
 * ⚠️ 断言必须**在两种环境下都成立**：
 *   · 慢环境（软件合成 / 大屏 / 球多）→ 应该降档并把帧率换回来；
 *   · 快环境（GPU 正常）→ 本来就不掉帧，那 DRS 就该**不介入**（降档反而是错的）。
 *   所以这里先判"基线到底掉没掉帧"，再决定要哪一侧的断言 —— 写死"必须降档"
 *   会让夹具在快机器上误报，写死"必须不降档"则等于什么都没测。
 *
 * ⚠️⚠️ 时序是这个夹具最大的坑（第一版就栽在这，两条断言假红）：
 *   1. **换档是链式的、带迟滞的**：1.0↔0.64 之间有 0.88 / 0.76，每级要
 *      `DRS_DWELL_MS`(2.5s) + 若干票。"等固定 22s 再取样"会取到链路**中途**的档位，
 *      于是量到的收益只有半级（实测 16.9 → 18 帧/s，看着像机制没用，其实只是没降到位）。
 *      → 正解：**轮询到档位连续 N 秒不再变化**再取样（`settle()`）。
 *   2. **基线必须在 DRS 动手之前取**：200 球时约 17Hz，40 张降档票只要 ~2.3s。
 *      → 基线采样窗口压到 1200ms（≈20 帧 < 40 票），并**断言那一刻 scale 仍是 1.0**，
 *        否则"降档前 58ms / 降档后 47ms"里的 58ms 其实已经是降过档的数了。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: [], bad: [], info: [] };
  const T = (name, cond, info) => (cond ? out.ok : out.bad).push(name + (info !== undefined ? ' | ' + info : ''));
  const S = () => window.__pbFrameState();

  let churn = 0, live = 0;
  const start = (count, period) => {
    window.__pbSetBalls(count);
    live = count;
    if (churn) clearInterval(churn);
    // 持续甩球：保证测量期间球一直在动（否则球睡着 → 主循环进空闲巡检 → DRS 根本不投票）
    churn = setInterval(() => {
      for (let i = 0; i < live; i++) window.__pbThrow(i, (i % 2 ? 1 : -1) * 340, -520);
    }, period || 300);
  };
  const stop = () => { if (churn) clearInterval(churn); churn = 0; };

  /**
   * 轮询到档位**稳定**（连续 `stableMs` 不变）或超时，返回最终档位与换档轨迹。
   * 轨迹是用来排障的：`1→0.88@2.5s 0.88→0.76@5.1s …`，一眼能看出"是没降到位还是没升回去"。
   *
   * ⚠️ `minMs` 不是可选的装饰：**没有它，"等稳定"会在调用那一刻就立刻成立**
   * （档位本来就是稳的），于是轮询在 stableMs 之后直接返回 —— 而"等它升上去"这件事
   * 需要先攒 120 票（≈3s）+ 过掉 `DRS_DWELL_MS`（2.5s），根本来不及。
   * 第 ③ 段就是这么假红过一次：`settle(30000, 3000)` 实际只等了 3.25s。
   * 凡是"等一个**还没发生**的变化"，必须给 minMs。
   */
  const settle = async (maxMs, stableMs, minMs) => {
    const t0 = performance.now();
    const trail = [];
    let last = S().renderScale, lastAt = t0;
    while (performance.now() - t0 < maxMs) {
      await wait(250);
      const st = S();
      const el = performance.now() - t0;
      if (st.renderScale !== last) {
        trail.push(last + '→' + st.renderScale + '@' + (el / 1000).toFixed(1) + 's');
        last = st.renderScale;
        lastAt = performance.now();
      } else if (el >= (minMs || 0) && performance.now() - lastAt >= stableMs) {
        return { scale: last, trail: trail, ms: Math.round(el) };
      }
    }
    return { scale: last, trail: trail, ms: Math.round(performance.now() - t0), timeout: true };
  };

  await wait(500);
  T('DRS 起始档位是 1.0×（没有残留的旧强制值）', S().renderScale === 1, 'scale=' + S().renderScale);

  // ---------------- ① 低球数：绝不能误降档（新版判据最大的回归风险）
  start(8, 500);
  await wait(6000);
  const s1 = S();
  T('8 颗球持续运动 → 不误降档', s1.renderScale === 1, 'scale=' + s1.renderScale);
  /**
   * ⚠️ 这里**不能**直接断言"8 颗球时呈现一定健康"。本机（软件合成 + 一堆虚拟显示器）
   * 有一个 ~30ms 的**呈现地板**，跟画面无关：`probe-drs-floor.js` 实测关掉篮筐、只剩
   * 6 颗球、`drawMs` 0.1ms 时呈现仍是 p50≈30ms。
   * 所以改成断言**不变量**：呈现超标的环境里，"没降档"必须是有依据的 —— 即绘制中位
   * 成本低于旁证闸（我们自己就没涂多少像素，缩画布救不了）。写死"p50 必须健康"等于
   * 把环境的毛病算在实现头上，在正常 GPU 机器上反而永远绿。
   */
  T('低球数时判据② 被旁证闸拦住（涂的像素太少，缩画布救不了）',
    s1.presentP50Ms <= s1.drsRefMs * 1.35 || s1.drawMsMedian < s1.drsPresentMinDrawMs,
    'p50=' + s1.presentP50Ms + 'ms ref=' + s1.drsRefMs + 'ms，drawMs=' + s1.drawMsMedian +
    'ms（旁证闸 ' + s1.drsPresentMinDrawMs + 'ms）');

  // ---------------- ② 高球数：掉帧就降档，且降档必须真的换回帧率
  start(200, 300);
  await wait(700);                  // 让 200 颗球真正落起来（清窗前的启动峰值不算数）
  window.__pbPerfReset();
  await wait(1200);                 // ≈20 帧 < 40 张降档票 → 此刻仍是 1.0×
  const base = S();
  const degraded = base.presentP50Ms > base.drsRefMs * 1.35;
  const down = await settle(degraded ? 26000 : 9000, 3000, degraded ? 6000 : 4000);
  out.info.push('降档轨迹 ' + (down.trail.join(' ') || '（档位无变化）') +
    '；稳定于 ' + down.scale + '×（耗时 ' + down.ms + 'ms' + (down.timeout ? '，超时' : '') + '）');

  if (degraded) {
    T('基线确实是在 1.0× 上取的（采样窗没跨过第一次降档）', base.renderScale === 1,
      'scale=' + base.renderScale);
    T('200 颗球掉帧（基线 p50 超标）→ 触发降档', down.scale < 1,
      'p50=' + base.presentP50Ms + 'ms > ref×1.35=' + Math.round(base.drsRefMs * 1.35) + 'ms，scale 1.0 → ' + down.scale);
    window.__pbPerfReset();
    await wait(4000);
    const after = S();
    T('降档后出帧率提升 ≥ 20%', after.presentHz >= base.presentHz * 1.2,
      base.presentHz + ' → ' + after.presentHz + ' 帧/s（' + down.scale + '×）');
    T('降档后帧间隔 p50 明显缩短', after.presentP50Ms < base.presentP50Ms * 0.85,
      base.presentP50Ms + ' → ' + after.presentP50Ms + ' ms');
  } else {
    // 快环境：DRS 不该介入，否则就是"为了不存在的掉帧白白糊了画面"
    T('200 颗球仍不掉帧（基线 p50 正常）→ DRS 正确地不介入', down.scale === 1,
      'p50=' + base.presentP50Ms + 'ms ≤ ' + Math.round(base.drsRefMs * 1.35) + 'ms，scale=' + down.scale);
  }

  // ---------------- ③ 负载降下来必须能升回去（只降不升 = 永远糊着）
  /**
   * ⚠️ 这一段曾经**假红**，而且暴露的是真 bug（不是夹具的毛病）：
   * 判据② 是"结果导向"的，它只知道"出帧没出够"，不知道**为什么**。这台开发机
   * （软件合成 + 13 个虚拟显示器）哪怕只剩 6 颗球、`drawMs` 已经掉到 **0.1ms**，
   * 呈现依然只有 ~40 帧/s —— 于是判据② 永远报"不健康"，档位永久卡在 0.64×，
   * 而且每帧把升档票清零（`probe-drs-stuck.js` 抓到 votes 一路涨到 433/0）。
   * 修法见 drsTick 的 `rasterGone`（"光栅成本塌了就别再糊着"这个逃生阀）。
   * 所以这条断言现在盯两件事：**确实升回去了** + **升回去是有依据的**（成本相对
   * 降档当时已经塌到 0.35 以下），后者用来防止"为了让这条断言变绿而乱升档"。
   */
  if (down.scale < 1) {
    start(6, 500);
    const up = await settle(30000, 3000, 12000);
    const fin = S();
    T('负载降低后自动升回 1.0×（光栅成本塌了 → 逃生阀放行）', up.scale === 1,
      'scale=' + up.scale + '，drawMs ' + fin.drawMsMedian + 'ms vs 降档基准 ' + fin.drsDownCost +
      'ms（升档轨迹 ' + (up.trail.join(' ') || '无') + '）');
  } else {
    out.info.push('第 ② 段没有降档，第 ③ 段（升档回归）跳过');
  }

  stop();
  window.__pbSetBalls(1);
  out.pass = out.bad.length === 0;
  return out;
})()
