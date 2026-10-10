/**
 * tools/verify-framesync.js —— 帧同步（插值渲染 + 区域同口径 + 呈现度量）的一次性自测。
 * 用 `--eval` 注入渲染进程。
 *
 * 它盯的是用户报的"帧率满但运动一顿一顿"和"空中高速/下落时球被削掉一块"：
 *
 *   A. **插值渲染真的在起作用**（顿挫的根因）
 *      定点物理 60 步/秒，屏幕 60/120Hz。旧实现在 `acc < STEP` 时**直接早退、完全不画**，
 *      于是"推进 0 步的帧球不动、推进 2 步的帧一次跳两格" —— 平均 fps 仍是 60，看着却抖。
 *      判据（恒等式，不依赖抓时序）：
 *        `__pbRenderAt(0.5)` ⇒ `rx === (px + bx)/2`；
 *        `__pbRenderAt(0)`   ⇒ `rx === px`；`__pbRenderAt(1)` ⇒ `rx === bx`。
 *      再拿 `__pbSmooth(false)` 做对照：关掉插值后同一状态下 `rx === bx`（差异只能来自插值）。
 *
 *   B. **区域与画面同口径**（"球被削掉一块"的根因）
 *      区域圆是按 `renderer.posOf()`（插值后的画面位置）上报的。若还按 `body.position`
 *      算，圆心能差一个步长（高速球 30~50px）—— 那正是"球沿运动方向被齐刷刷削掉"。
 *      判据：`circle0 的圆心 === round(rx, ry)`。
 *
 *   C. **区域半径罩得住高速球**
 *      `rad = ceil(max(grab, visR + GRAB_PAD) + |v|·leadFrames)`，`grab = ballRadius+GRAB_PAD = 46`。
 *      下落/高速时 `|v|·leadFrames` 必须真的把半径撑大（不是常数）。
 *
 *   D. **呈现度量在记数**（这是把"fps 满但卡"暴露出来的尺子）
 *      `presentTotal` 在两次采样之间必须增长。
 *
 *   E. **分辨率 / 刷新率全谱适配**（用户报的"换设备"这一类）
 *      ①b 刷新率：`周期 = 1000/hz`、`节流 = min(1000/70, 周期×0.92)`，**没有 144Hz 封顶**
 *          （165/240/360Hz 屏不再按 144 算而白丢呈现帧）；主进程缺报（给 0）时回落 60
 *          并把 `displayHzSource` 标成 `default`。
 *      ①c 插值补帧预算 = `clamp(屏周期 × 0.75 − 每呈现帧物理耗时, 2.5, 14)`：
 *          旧的"常数 6ms"在 2K（3.7M px）/2K@125%（5.8M px）上会把补帧整条路封死。
 *      ①d 画布像素上限 8.3Mpx（= 4K@1x）：8K / 4K@150% / 1280×800@300% 都被兜住，
 *          而 **2K@125%（5.8Mpx）保持 1.25× 不被降** —— 那正是用户白板的实机分辨率。
 *      ①e DRS：绘制成本压不下来时降的是**分辨率**（1→0.88→0.76→0.64 ×dpr），不是帧率。
 *      ①f 换屏（尤其换到更小的屏）之后球被夹回场内 —— 否则球会掉进"地面"静态体
 *          被 position solver 弹到几万像素外，或留在右墙之外（看得见画、看不见球）。
 *
 * ⚠️ 两条硬约束（踩过，别忘）：
 *   1. **必须带 `--diag`**，否则 startCaptureTools 在守卫处 return，`--eval` / `--exit-after`
 *      都不被处理，进程会一直挂着。
 *   2. **脚本结尾不能带分号** —— 主进程是 `executeJavaScript('(' + script + ')')`，
 *      它自己会再套一层括号；写成 `})();` 会变成 `((...)();)` → 语法错误、一条断言都不输出。
 *      文件结尾写成 `})()`。
 *
 * ⚠️ 可用窗口只有约 `exit-after − 2200ms`（eval 在这一刻才开始），所以 wait 总时长必须压在里面。
 *    现在 ⓪ 段要先把性能窗口清干净再攒样本（最多 1.9s），因此**用 `--exit-after=10000`**；
 *    也不要在脚本里 log 大对象（主进程会把返回值 JSON 化写日志）。
 *
 * 用法：
 *   unset ELECTRON_RUN_AS_NODE
 *   cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"   # 夹具必须覆盖用户真实配置
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir="$T" --exit-after=10000 \
 *     --eval="$(cat tools/verify-framesync.js)"
 *   grep '\[FS\]\|EVAL ok' "$T/runtime.log"
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: [], bad: [] };
  const T = (name, cond, info) =>
    (cond ? out.ok : out.bad).push(name + (info !== undefined ? ' | ' + info : ''));
  const near = (a, b, e) => a !== null && b !== null && Math.abs(a - b) <= e;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  await wait(300);

  // ── ⓪ 夹具必须对**环境球数**免疫 ─────────────────────────────────────────
  // 踩过：用户真实配置里 ballCount=200（球数上限，见 README §2.12.1），
  // 直接 __pbPlace 新球进去，它会瞬间撞上球堆、速度被碰撞解算吃掉 ——
  // 表现为"插值恒等式不成立"，其实是前置条件根本没建起来。
  // 所以先把它压到 1 颗，并在结果里留档原始球数，免得下次又被误读成代码 bug。
  let fs = window.__pbFrameState();
  const ballsAtStart = fs.balls.length;
  window.__pbSetBalls(1);
  /**
   * ⚠️ **必须清掉性能测量窗口再等**（2026-10-11 坐实，见 `__pbPerfReset` 的注释）。
   *
   * 用户真实配置 `ballCount=200`：启动那两秒是"200 颗球一起落下"的最重负载，
   * 而 `physMsFrame` / `drawMsMedian` 是约 120 个呈现帧的滑动窗口 —— 不清窗口就取样，
   * ①c 读到的是**启动峰值**（实测 7.7~16.7ms），而 200 颗球稳态下每步只有 1.1~4.2ms。
   * 于是一批"预算够不够"的判据被环境噪声判负，且**靠地板值 2.5 假通过**（见 ①c 的说明）。
   *
   * 清完之后要等窗口重新攒够样本（`physFrames`）：这一球放到高处让它一路落/弹，
   * 保证这段时间主循环一直在出帧。上限 1.8s，到点如实记进 `cleanWin`。
   */
  window.__pbPlace(0, Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.22), 0, 0);
  window.__pbPerfReset();
  let cleanWin = false;
  for (let i = 0; i < 15; i++) {
    await wait(120);
    const f = window.__pbFrameState();
    if (f.physFrames >= 60 && f.physMsFrame < 3) { cleanWin = true; break; }
  }
  await wait(120);

  // ── ① 默认状态（A/D 的前置）─────────────────────────────────────────────
  fs = window.__pbFrameState();
  T('smooth 默认开启', fs.smooth === true, 'smooth=' + fs.smooth);
  T('displayHz 有效（20~360）', fs.displayHz >= 20 && fs.displayHz <= 360, 'displayHz=' + fs.displayHz);
  T('frameMinMs 跟着屏幕走（≤16.67，不再钉死 1000/70）',
    fs.frameMinMs <= 16.67 + 0.001, 'frameMinMs=' + fs.frameMinMs);
  T('alpha 落在 [0,1]', fs.alpha >= 0 && fs.alpha <= 1, 'alpha=' + fs.alpha);
  T('smoothBudgetMs 有定义且在地板之上',
    typeof fs.smoothBudgetMs === 'number' && fs.smoothBudgetMs >= fs.smoothBudgetMinMs,
    'smoothBudgetMs=' + fs.smoothBudgetMs + ' 地板=' + fs.smoothBudgetMinMs);
  T('绘制成本中位数可读（有限、非负）',
    isFinite(fs.drawMsMedian) && fs.drawMsMedian >= 0, 'drawMsMedian=' + fs.drawMsMedian);
  // 设备画像：2K 白板那类"就这台机器不对"的问题，判据必须先能读到画布像素数
  const dv = fs.device;
  T('设备画像齐全（w/h/dpr/rawDpr/画布像素/上限）',
    !!dv && dv.w > 0 && dv.h > 0 && dv.dpr > 0 && dv.rawDpr > 0 && dv.capMpx > 0 &&
    dv.backingW === Math.round(dv.w * dv.dpr) && dv.backingH === Math.round(dv.h * dv.dpr),
    dv ? (dv.w + 'x' + dv.h + ' dpr=' + dv.dpr + '(raw ' + dv.rawDpr + ') 画布=' +
      dv.backingW + 'x' + dv.backingH + ' (' + dv.backingMpx + ' Mpx / 上限 ' + dv.capMpx + ')')
      : 'missing');
  T('节拍量可读：屏周期与每呈现帧物理耗时都在（预算的两项来源）',
    fs.displayPeriod > 0 && fs.physMsFrame >= 0 && fs.smoothLoadFrac > 0,
    'period=' + fs.displayPeriod + 'ms 物理/帧=' + fs.physMsFrame + 'ms');
  // 窗口是否已经脱离启动负载：不是断言，是给 ①c 那组数字标注**置信度**用的
  T('性能窗口已脱离启动负载（清窗后攒够了样本）',
    cleanWin, 'physMsFrame=' + fs.physMsFrame + 'ms 样本=' + fs.physFrames + ' 帧 cleanWin=' + cleanWin);

  // ── ①b 「换设备」判据之一：刷新率全谱都要能用 ────────────────────────────
  //     刷新率是连续谱（24/30/48/50/60/75/90/120/144/165/240/360 都真实存在）。
  //     旧版把目标刷新率夹在 [60,144] —— 165/240Hz 屏会按 144 算节流（白丢呈现帧），
  //     30Hz 那侧则被抬到 60（多画的那些帧纯属浪费，还让每帧步数参差）。
  //     用 `__pbDisplayHz()` 在同一台机器上模拟各种屏，不必真插拔显示器。
  const realHz = fs.displayHz;
  const at = (hz) => window.__pbDisplayHz(hz);

  const hzRows = [];
  let hzOk = true, hzDetail = '';
  for (const hz of [24, 30, 50, 60, 75, 90, 120, 144, 165, 240, 360]) {
    const v = at(hz);
    const wantP = Math.round((1000 / hz) * 100) / 100;
    const wantT = Math.round(Math.min(1000 / 70, (1000 / hz) * 0.92) * 100) / 100;
    hzRows.push(hz + 'Hz:' + v.frameMinMs);
    if (Math.abs(v.period - wantP) > 0.02 || Math.abs(v.frameMinMs - wantT) > 0.02) {
      hzOk = false;
      hzDetail = hz + 'Hz 周期=' + v.period + '(期望' + wantP + ') 节流=' +
        v.frameMinMs + '(期望' + wantT + ')';
      break;
    }
  }
  T('刷新率全谱自洽：周期=1000/hz、节流=min(1000/70, 周期×0.92)',
    hzOk, hzDetail || hzRows.join(' '));
  const t144 = at(144).frameMinMs, t240 = at(240).frameMinMs, t360 = at(360).frameMinMs;
  T('没有 144Hz 封顶：节流继续随刷新率收紧（165/240/360 屏不再白丢呈现帧）',
    t240 < t144 - 0.5 && t360 < t240 - 0.5,
    '144→' + t144 + 'ms  240→' + t240 + 'ms  360→' + t360 + 'ms');
  T('24/30Hz 投屏白板：节流**不慢于** 1000/70（不拿流畅度换省电）',
    at(24).frameMinMs <= 1000 / 70 + 0.01 && at(30).frameMinMs <= 1000 / 70 + 0.01,
    '24→' + at(24).frameMinMs + 'ms  30→' + at(30).frameMinMs + 'ms');
  T('刷新率缺报（主进程给 0）→ 回落 60 兜底，并把来源标成 default',
    (() => { const z = at(0); return z.hz === 60 && z.source === 'default'; })(),
    JSON.stringify(at(0)));

  // ── ①c 「换设备」判据之二：插值补帧预算 = 屏周期×0.75 − 每帧物理，夹在 [2.5,14] ──
  //     旧的常数 6ms 在 2K（3.7M px）/ 2K@125%（5.8M px）上会把补帧整条路封死，
  //     而 60Hz 屏恰恰约一半的帧需要它（物理也是 60 步/秒）—— 那台希沃的报障正源于此。
  const budgetRows = [];
  let budgetOk = true, budgetDetail = '';
  for (const hz of [24, 30, 50, 60, 75, 90, 120, 144, 165, 240, 360]) {
    const v = at(hz);
    const want = Math.round(Math.max(v.minMs,
      Math.min(v.capMs, v.period * v.loadFrac - v.physMsFrame)) * 100) / 100;
    budgetRows.push(hz + 'Hz:' + v.smoothBudgetMs);
    if (Math.abs(v.smoothBudgetMs - want) > 0.02) {
      budgetOk = false;
      budgetDetail = hz + 'Hz 周期=' + v.period + ' 物理/帧=' + v.physMsFrame +
        ' 期望=' + want + ' 实际=' + v.smoothBudgetMs;
      break;
    }
  }
  T('预算恒等式：clamp(屏周期×0.75 − 物理/帧, 地板, 上限)', budgetOk, budgetDetail || budgetRows.join(' '));
  const v60 = at(60), v120 = at(120), v30 = at(30);
  const b60 = v60.smoothBudgetMs, b120 = v120.smoothBudgetMs, b30 = v30.smoothBudgetMs;
  T('60Hz 上预算高于旧的常数 6ms（2K/高分辨率上补帧不再被封死）', b60 > 6,
    '60Hz → ' + b60 + 'ms（物理/帧 ' + v60.physMsFrame + 'ms、样本 ' + v60.physFrames + ' 帧）');
  T('屏越快预算越紧（60Hz 宽于 120Hz）', b60 > b120, '60→' + b60 + '  120→' + b120);
  /**
   * ⚠️ 这条判据**不是**"预算 ≤ 半个屏周期"（原先那么写是错的，只因为预算被地板 2.5 夹住
   *     才假通过 —— 而 `0.75 × 周期` 天然大于半个周期，轻载时必然超）。
   *     真正要守的是**总账**：物理（必花）+ 绘制允许量 必须落在屏周期的 75% 以内，
   *     也就是"补帧不会把整帧预算吃光、逼得主循环掉帧"。它在任何负载下都成立且恒有区分度
   *     （把 SMOOTH_LOAD_FRAC 调大就会立刻失败）。
   */
  T('预算不把整帧吃光：物理 + 绘制允许量 ≤ 屏周期×0.75',
    b120 + v120.physMsFrame <= v120.period * v120.loadFrac + 0.02 &&
    b60 + v60.physMsFrame <= v60.period * v60.loadFrac + 0.02,
    '120Hz: ' + b120 + '+' + v120.physMsFrame + ' ≤ ' + r3(v120.period * v120.loadFrac) +
    '  60Hz: ' + b60 + '+' + v60.physMsFrame + ' ≤ ' + r3(v60.period * v60.loadFrac));
  T('慢屏（30Hz 投屏/白板）上预算封顶，不无限放宽',
    b30 <= v30.capMs + 0.01, '30Hz → ' + b30 + 'ms（上限 ' + v30.capMs + '）');
  at(realHz);   // 还原真实屏幕，后面还要量呈现节拍

  // ── ①d 分辨率全谱：画布像素上限（4K@1x = 8.3Mpx）─────────────────────────
  //     8K、4K@150/200%、1280×800@300% 这些配置的"画布"能到 1 亿像素：两张全屏画布的
  //     显存与被合成器上传的代价都按像素数走。上限只影响清晰度，不碰帧率。
  const fit = (w, h, d) => window.__pbDeviceFit(w, h, d, null);
  const cap = dv.capMpx;
  const f2k = fit(2560, 1440, 1.25);
  T('2K@125%（5.8Mpx）不被上限动到：dpr 保持 1.25（用户的希沃白板就是这台）',
    Math.abs(f2k.dpr - 1.25) < 0.001 && f2k.mpx > 5.7 && f2k.mpx < 5.8,
    '2560×1440@1.25 → dpr=' + f2k.dpr + ' ' + f2k.mpx + 'Mpx');
  const f4k = fit(3840, 2160, 1);
  T('4K 原生（8.29Mpx）恰好在上限之内、不被砍',
    Math.abs(f4k.dpr - 1) < 0.001 && f4k.mpx <= cap + 0.05,
    '3840×2160@1 → dpr=' + f4k.dpr + ' ' + f4k.mpx + 'Mpx（上限 ' + cap + '）');
  let capOk = true, capDetail = '';
  for (const p of [[1920, 1080, 2], [3840, 2160, 1.5], [3840, 2160, 2], [7680, 4320, 1], [1280, 800, 3]]) {
    const f = fit(p[0], p[1], p[2]);
    if (f.mpx > cap + 0.05 || f.dpr < 0.5 - 0.001) {
      capOk = false;
      capDetail = p.join('×' ) + ' → dpr=' + f.dpr + ' ' + f.mpx + 'Mpx';
      break;
    }
  }
  T('极端分辨率都被画布上限兜住（且 dpr 不低于 0.5）', capOk, capDetail ||
    [[1920, 1080, 2], [3840, 2160, 1.5], [3840, 2160, 2], [7680, 4320, 1], [1280, 800, 3]]
      .map((p) => p[0] + 'x' + p[1] + '@' + p[2] + '→' + fit(p[0], p[1], p[2]).mpx + 'Mpx').join(' '));

  // ── ①e DRS：绘制成本压不下来时降的是**分辨率**，不是帧率 ──────────────────
  const s064 = window.__pbScale(0.64);
  T('强制渲染缩放真的改了画布（0.64×）',
    s064.dpr < s064.rawDpr - 0.001,
    'rawDpr=' + s064.rawDpr + ' → dpr=' + s064.dpr + ' 画布=' + s064.backingW + 'x' + s064.backingH);
  T('画布像素数按下限比例下降（不是只改了个数字）',
    s064.mpx < dv.backingMpx * 0.5 && s064.mpx > dv.backingMpx * 0.3,
    dv.backingMpx + 'Mpx → ' + s064.mpx + 'Mpx');
  const sAuto = window.__pbScale('auto');
  T('交回自动后 dpr 回到窗口真实值（DRS 不粘住）',
    Math.abs(sAuto.dpr - sAuto.rawDpr) < 0.001 && sAuto.force === null,
    'rawDpr=' + sAuto.rawDpr + ' dpr=' + sAuto.dpr + ' force=' + sAuto.force);
  T('DRS 档位表与开关可读（renderScaleSteps / dynScale）',
    Array.isArray(fs.renderScaleSteps) && fs.renderScaleSteps[0] === 1 &&
    typeof fs.dynScale === 'boolean',
    'steps=' + JSON.stringify(fs.renderScaleSteps) + ' dynScale=' + fs.dynScale);

  // ── ①f 换屏（尤其换到更小的屏）之后球必须被夹回场内 ──────────────────────
  //     不夹的两种事故：球留在旧屏下方 → 掉进"地面"静态体 → 被 position solver 弹到
  //     几万像素外；球留在旧屏右侧 → 在右墙之外，渲染层照画但窗口区域里没有它。
  //     两者在用户那里都读作"换了设备之后球不见了"。
  const cx = Math.round(innerWidth + 800), cy = Math.round(innerHeight + 900);
  window.__pbPlace(0, cx, cy, 0, 0);
  const movedBack = window.__pbResize();
  await wait(60);
  const back = window.__pbDiag().pos[0];
  T('窗外的球被夹回窗口之内（换到更小的屏也不会"球不见了"）',
    back[0] > 0 && back[0] < innerWidth && back[1] > 0 && back[1] < innerHeight,
    '放=(' + cx + ',' + cy + ') → 夹后=(' + back[0] + ',' + back[1] + ') 窗口=' +
      innerWidth + 'x' + innerHeight);
  T('resize 如实报告夹回了几颗球', movedBack >= 1, 'moved=' + movedBack);

  // ── ② 摆一个"空中高速下落"的场景 ────────────────────────────────────────
  // 竖直下落、1400px/s ≈ 23.3px/步 —— 正是用户说"下落时被削掉"的那种速度。
  window.__pbPlace(0, Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.28), 0, 1400);

  // 等物理跑几步，让 `_px/_py`（上一步位置）被写上，且与当前位置拉开距离
  // ⚠️ 这个场景是**竖直下落**，变化的只有 y —— 判"动了没动"必须看 y（看过一次 x，
  //    因为没有水平速度，bx 恒等于 px，前置永远建不起来）。
  // 同时看 `vy`：位置没变既可能"没步进"，也可能"速度被碰撞清零"（球堆场景），
  // 两者要分开，否则会把环境问题读成代码 bug。
  let st = null;
  for (let i = 0; i < 8; i++) {
    await wait(30);
    st = window.__pbFrameState();
    if (st.ball && st.ball.py !== null && Math.abs(st.ball.by - st.ball.py) > 3) break;
  }
  const b = st.ball;
  T('已建立"上一步位置 ≠ 当前位置"的前置（插值才有意义）',
    !!b && b.py !== null && Math.abs(b.by - b.py) > 3,
    b ? 'py=' + r3(b.py) + ' by=' + r3(b.by) + ' vy=' + b.vy + ' 起始球数=' + ballsAtStart : 'no-ball');
  T('下落的球确实带着速度（排除"速度被碰撞吃掉"）',
    !!b && Math.abs(b.vy) > 1,
    b ? 'vy=' + b.vy + ' px/步 (起始球数=' + ballsAtStart + ')' : 'no-ball');

  // ── ③ A. 插值恒等式 ────────────────────────────────────────────────────
  const h = window.__pbRenderAt(0.5);
  const hb = h.ball;
  T('alpha=0.5 → ry 恰为上一步与当前的中点',
    !!hb && near(hb.ry, (hb.py + hb.by) / 2, 0.01),
    hb ? 'py=' + hb.py + ' by=' + hb.by + ' ry=' + hb.ry + ' 期望=' + r3((hb.py + hb.by) / 2) : 'no-ball');
  T('alpha=0.5 时 ry 不等于任一端点（确实是补出来的中间帧）',
    !!hb && Math.abs(hb.ry - hb.py) > 0.5 && Math.abs(hb.ry - hb.by) > 0.5,
    hb ? 'ry=' + hb.ry + ' py=' + hb.py + ' by=' + hb.by : 'no-ball');

  const lo = window.__pbRenderAt(0);
  T('alpha=0 → ry 回到上一步位置', !!lo.ball && near(lo.ball.ry, lo.ball.py, 0.01),
    lo.ball ? 'ry=' + lo.ball.ry + ' py=' + lo.ball.py : 'no-ball');
  const hi = window.__pbRenderAt(1);
  T('alpha=1 → ry 回到物理当前位置', !!hi.ball && near(hi.ball.ry, hi.ball.by, 0.01),
    hi.ball ? 'ry=' + hi.ball.ry + ' by=' + hi.ball.by : 'no-ball');

  // ── ④ B. 区域与画面同口径（"削角"的直接判据）────────────────────────────
  const mid = window.__pbRenderAt(0.5);
  const c0 = mid.circle0;
  const mb = mid.ball;
  T('窗口区域里有 0 号球的圆', !!c0, JSON.stringify(c0));
  T('区域圆心 === round(画面位置)（同口径，不削角）',
    !!c0 && !!mb && c0[0] === Math.round(mb.rx) && c0[1] === Math.round(mb.ry),
    c0 && mb ? 'circle=[' + c0[0] + ',' + c0[1] + ',' + c0[2] + '] 画面=(' + r3(mb.rx) + ',' + r3(mb.ry) + ')' : 'no-circle');
  // 反向判据：区域圆心**不能**等于物理位置（否则说明没跟着画面走）
  // 只在插值确实拉开了距离的轴上判（y），否则 px==bx 的轴上本来就分不出来。
  T('区域圆心与物理位置不同（证明它跟的是画面而不是 body.position）',
    !!c0 && !!mb && Math.abs(mb.ry - mb.by) > 0.5 && c0[1] !== Math.round(mb.by),
    c0 && mb ? 'circle.y=' + c0[1] + ' 画面y=' + r3(mb.ry) + ' body.y=' + r3(mb.by) : 'no-circle');

  // ── ⑤ C. 区域半径罩得住高速球 ───────────────────────────────────────────
  const GRAB = 46;   // ballRadius(34) + GRAB_PAD(12)，见 config / app.js
  T('静止口径成立：区域半径 ≥ ballRadius + GRAB_PAD = 46',
    !!c0 && c0[2] >= GRAB, c0 ? 'rad=' + c0[2] : 'no-circle');
  T('高速下落时区域半径被前瞻撑大（不是常数 46）',
    !!c0 && c0[2] >= GRAB + 60, c0 ? 'rad=' + c0[2] + ' 期望 ≥ ' + (GRAB + 60) : 'no-circle');
  // 球画到的最大外延（1.5×r ≈ 45px）也必须落在区域里
  T('区域半径罩得住 drawBall 的最大形变（1.5r ≈ 45px）',
    !!c0 && c0[2] >= 45, c0 ? 'rad=' + c0[2] : 'no-circle');

  // 所有活动球的画面位置都必须夹在 [min(px,bx), max(px,bx)] 之间（插值有界）
  let bounded = true, bd = '';
  for (const x of (window.__pbFrameState().balls || [])) {
    if (x.rx === null || x.px === null) continue;
    const loX = Math.min(x.px, x.bx), hiX = Math.max(x.px, x.bx);
    const loY = Math.min(x.py, x.by), hiY = Math.max(x.py, x.by);
    if (x.rx < loX - 0.01 || x.rx > hiX + 0.01 || x.ry < loY - 0.01 || x.ry > hiY + 0.01) {
      bounded = false;
      bd = 'rx=' + x.rx + ' ∈ [' + loX + ',' + hiX + '] ry=' + x.ry + ' ∈ [' + loY + ',' + hiY + ']';
      break;
    }
  }
  T('插值有界：所有球画面位置都夹在「上一步 → 当前」之间', bounded, bd);

  // ── ⑥ A 的对照：关掉插值后 ry 必须等于物理位置 ──────────────────────────
  window.__pbSmooth(false);
  const off = window.__pbRenderAt(0.5);
  T('smooth=false 时 ry === by（差异确实来自插值，不是随机）',
    !!off.ball && near(off.ball.ry, off.ball.by, 0.001) && near(off.ball.rx, off.ball.bx, 0.001),
    off.ball ? 'r=(' + off.ball.rx + ',' + off.ball.ry + ') b=(' + off.ball.bx + ',' + off.ball.by + ')' : 'no-ball');
  window.__pbSmooth(true);
  T('可以重新打开插值', window.__pbFrameState().smooth === true);

  // ── ⑦ D. 呈现度量在记数 ────────────────────────────────────────────────
  const p0 = window.__pbFrameState().presentTotal;
  await wait(420);
  const fs2 = window.__pbFrameState();
  T('presentTotal 持续增长（主循环确实在出帧）', fs2.presentTotal > p0,
    p0 + ' → ' + fs2.presentTotal);
  T('presentHz 有值且合理（> 0）', fs2.presentHz > 0, 'presentHz=' + fs2.presentHz);
  T('呈现抖动是有限数（度量本身没坏）',
    isFinite(fs2.presentJitterMs) && isFinite(fs2.presentP50Ms),
    'p50=' + fs2.presentP50Ms + ' jitter=' + fs2.presentJitterMs);

  // ── ⑦b 瞬移保护：被「搬」过去的球不能画在「旧位置 → 新位置」的连线上 ─────
  // 插值引入后 `_px/_py` 成了**活跃状态**，而 __pbPlace / resetGame / 从 ballStates
  // 恢复球位都是直接 setPosition 的"搬球"路径。不拦的话球会被画在
  // `_px + (bp - _px)·alpha` —— 一个谁都没想到的位置：闪一下，
  // 并在旧位置或新位置留下擦不掉的残影（verify-render 的休眠球像素判据抓到的就是这个）。
  const beforeTp = window.__pbFrameState().ball;
  const TX = Math.round(innerWidth * 0.25), TY = Math.round(innerHeight * 0.20);
  window.__pbPlace(0, TX, TY, 0, 0);
  const tp = window.__pbRenderAt(0.5);
  T('瞬移确实跨过了保护阈值（旧位置与新位置 > 200px）',
    !!beforeTp && Math.abs(TX - beforeTp.px) + Math.abs(TY - beforeTp.py) > 200,
    beforeTp ? '旧=(' + r3(beforeTp.px) + ',' + r3(beforeTp.py) + ') 新=(' + TX + ',' + TY + ')' : 'no-ball');
  T('alpha=0.5 时 rx/ry 落在新位置（而不是旧→新连线的中点）',
    !!tp.ball && Math.abs(tp.ball.rx - TX) < 0.01 && Math.abs(tp.ball.ry - TY) < 0.01,
    tp.ball ? '放=(' + TX + ',' + TY + ') 画=(' + r3(tp.ball.rx) + ',' + r3(tp.ball.ry) + ')' : 'no-ball');

  // ── ⑧ 收尾：还原球数（万一有人没带 --user-data-dir 就跑，别把人家的 200 颗清成 1 颗）——
  window.__pbPlace(0, Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.6), 0, 0);
  if (ballsAtStart !== 1) window.__pbSetBalls(ballsAtStart);

  out.pass = out.bad.length === 0;
  out.summary = 'ok=' + out.ok.length + ' bad=' + out.bad.length;
  out.ballsAtStart = ballsAtStart;
  out.cleanWin = cleanWin;
  return out;
})()
