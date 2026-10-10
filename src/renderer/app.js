'use strict';
/**
 * app.js —— 渲染进程主控
 *
 * 一帧的顺序（固定时间步长，物理与渲染解耦）：
 *   积累真实时间 → 以 16.667ms 为步长跑 0~4 次物理 → 推进特效 → 脏块渲染 → 上报可交互形状
 * 全部球都休眠且无拖拽/无特效时，整帧退化成 160ms 一次的巡检，CPU 接近 0。
 */
(function () {
  /**
   * 渲染进程侧的启动计时（相对**页面导航开始**）。基础设施在 physics.js 顶部
   * （`window.__pbRMark`，它是第一个干活的脚本，所以落点最准），这里只补本文件的两点。
   *
   * 为什么需要它：主进程那侧只看到「did-finish-load / renderer-ready」两个点，
   * 而渲染进程从导航到首帧之间发生的事全被这两点盖住了 —— 实测这段占了总启动的一半
   * 以上。到底是 HTML 解析、vendor 脚本编译、还是 boot() 里的同步工作占大头，
   * 只有在这里打点才分得开。
   *
   * 基准 `performance.now()` = 页面 timeOrigin 起的毫秒数，**只在这一把尺子上比较**；
   * 不要和主进程日志的 BOOT 行相减（两个进程 timeOrigin 不对齐，跨进程比会差几十毫秒）。
   */
  const rmark = window.__pbRMark || function () {};
  rmark('app-start');
  window.__pbBootLine = function () {
    return 'RBOOT ' + (window.__pbRLine || []).join(' ');
  };

  const M = window.Matter;
  const PB = window.PB;
  const STEP = PB.STEP_MS;
  const GRAB_PAD = 12;
  /**
   * 球盘前瞻量（物理步长）。上报半径 = ballRadius + GRAB_PAD + |body.velocity|·本值。
   *
   * 它补偿的是「区域管线比画面慢」。区域（渲染进程算好 → IPC → 主进程 → SetWindowRgn）
   * 与画面（canvas → 合成 → 提交 → DWM）是两条独立流水线，实测区域恒定落后
   * p50 8~15ms、忙时 max 34ms（README §6.6 的探针表）。球速 2200px/s（上限）时，
   * 40ms 滞后就吃掉球的右上角、70~75ms 直接让整颗球从屏幕上消失。
   *
   * 余量公式：露出多少 = 滞后距离 −[(ballRadius+GRAB_PAD+|v|·L) − 球视觉半径]
   *                        = |v|·(滞后帧数 − L) − 6.6px
   * 其中 |v| 是 px/步、球视觉半径 = ballRadius·1.16 ≈ 39px（drawBall 沿速度拉伸）。
   * 也就是说：**L 必须 ≥ 最坏滞后帧数**，否则那 6.6px 的固有余量瞬间被吃掉。
   *
   * 取 5（= 83ms）。依据是两次实测：
   *   · README §6.6 的探针表：滞后 p50 8~15ms、忙时 max 34ms（球速 1376px/s）。
   *   · 本机复现（球速 2193px/s、前瞻关掉 = 阳性对照）：`--fly-test` 连拍 18 张真实屏幕
   *     截图，**17 张字节完全相同** —— 飞行球整个不在屏幕上，即"完全消失"复现成功。
   *     按余量公式反推，当时滞后 ≥ 39ms（≈2.3 帧），已经比旧参数 `leadFrames=2`
   *     能容忍的 33ms 还大，所以旧版"经常缺一块 / 偶尔整颗消失"完全解释得通。
   *   · 取 5 后容忍到 83ms，是上面最坏观测值的两倍余量；再往上加收益递减，
   *     而点击死区（区域圆半径 = 46 + |v|·L）会线性变大。
   * **不要凭感觉往下调**：先跑 --fly-test 量滞后，再按上面那条式子定。
   */
  const LEAD_FRAMES_DEFAULT = 5;

  /** 把数字收成两位小数（性能面板与诊断输出用，免得满屏浮点噪声）。非数按 0 计。 */
  const rd2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

  let cfg = null;
  let world = null;
  let renderer = null;
  let sfx = null;
  let dynCanvas = null;

  let W = 0, H = 0, dpr = 1;
  const fx = { particles: [], texts: [], rings: [] };
  let currentHoop = null;
  let lastScoreInfo = null;   // 最近一次进球详情，供 __pbScoreState 验收

  let drag = null;
  let menuOpen = false;
  let menuAnchor = null;
  let lockState = false;

  let scheduled = null;      // 'running' | 'raf' | 'step' | 'timer' | null（见 wake/scheduleNext）
  let idleTimer = 0;
  let wakeT0 = 0, lastWakeLatency = 0;
  let lastTime = 0, acc = 0;
  let lastShapeSent = '';
  // 夹具用：最近一次真的发出去的区域形状（见 sendShape 末尾与 __pbFlyRunner 的 state）
  let lastSentShape = null;
  let lastPerfAt = 0, lastPersistAt = 0, lastBallSnapshot = '';
  // 非有限球位/速度的计数器（见 sendShape 里的 visR 注释），只在第一次出现时报一次
  let shapeBad = 0, shapeBadLogged = false;
  let frames = 0, fpsAt = 0, fps = 0;
  // 诊断用：分开量「rAF 回调频率」与「物理步进频率」。
  // 两者差得多，问题在调度；两者都低，问题在渲染/合成压力。
  let loopCount = 0, stepCount = 0, loopHz = 0, stepHz = 0;
  // 主循环异常只上报一次（见 loop() 的注释）；重复刷屏会把 runtime.log 淹掉
  let loopErrLogged = false;

  /**
   * 绘制节流（ms）。
   *
   * ⚠️ 必须**略低于**物理步长（1000/60 = 16.67ms），否则当主循环正好卡在 60Hz 的
   * 节拍上时（正常情况），每隔一拍就会被节流掉一次 → 画面掉到 30fps。
   * 取 70Hz 留出抖动余量。
   *
   * 它的定位是"兜底"，不是主力：主力是 scheduleNext() 把循环压到物理节拍上
   * （见那段注释，已经把循环从 130~420 次/秒压到 ~60 次/秒）。这里再兜一层，
   * 是为了将来有人把循环重新挂回 rAF（或粒子/特效把自己推到 rAF 频率）时，
   * 单帧重绘不会跟着频率一起涨上去。
   */
  const FRAME_MIN_MS = 1000 / 70;
  let frameMinMs = FRAME_MIN_MS;
  let lastDrawAt = 0;
  let drawCount = 0, drawMsTotal = 0;
  // 主循环自身的开销（不含 renderer.frame）：用来把"重绘贵"和"rAF 回调贵"分开量。
  let iterCount = 0, loopMsTotal = 0;

  /**
   * 主显示器的刷新率（Hz），由主进程通过 layout / app-info 告知。
   *
   * ⚠️ 这里**不做任何"常见值"夹取**。刷新率是一个连续谱：24/30/48/50/59.94/60/72/75/
   *    90/100/120/144/165/180/240/360 都真实存在（笔记本内置屏、白板、投影、电竞屏、
   *    虚拟显示驱动各报各的）。凡是"按 60Hz 想当然"或"到 144 就封顶"的常数，
   *    在别的屏上一定错：封顶会让 165/240Hz 屏白丢一半呈现帧，按 60 则让 120Hz 屏
   *    白插一场。所有节拍量一律从 `displayPeriod` 推出来（见 refreshSmoothBudget / drsTick）。
   */
  let displayHz = 60;
  /** 主进程报的**原始**刷新率；0 = 没报（部分虚拟显示驱动/白板/投屏模式会给 0）。 */
  let displayHzReported = 0;
  /** `displayHz` 的来源：'reported'（主进程报的）/ 'raf'（本机实测兜底）/ 'default'（60 兜底）。 */
  let displayHzSource = 'default';
  /** rafProbe 实测出来的刷新率（Hz）。只在主进程**没报**的时候采信（见 rafProbe）。 */
  let rafHzMeasured = 0;
  let rafHzAdopted = false;
  /** 一个显示帧周期（ms）。60Hz=16.67、120Hz=8.33、30Hz=33.3、240Hz=4.17。 */
  let displayPeriod = 1000 / 60;
  /** 窗口真实的 devicePixelRatio（未夹取）。`dpr` 是夹取后真正用于建画布的值。 */
  let rawDpr = 1;
  /**
   * rAF 是否**与屏幕同频**（被 vsync 卡住）。
   *   null = 还没测出来；true = 可以拿 rAF 当绘制节拍；false = rAF 在自由跑
   *   （软件合成下实测 150~410Hz），只能用定时器压节拍。
   * 见 rafProbe / scheduleNext。
   */
  let rafPaced = null;
  const rafTimes = [];
  let rafProbeOn = false;
  /**
   * ⚠️ **插值补帧预算 = 「一个显示帧周期里，扣掉必须做的物理之后，还剩多少给一次整帧绘制」**
   *    （2026-10-11 重写：旧版是「屏周期×0.55 夹在 [6,12]」的常数式，本质是在猜分辨率）
   *
   * 判据链（每一项都能从 `__pbDiag()` 直接读到，便于远程排障）：
   *   ① `displayPeriod` —— 所有刷新率的**唯一**公共度量（24Hz→41.7ms、60→16.7、240→4.17）。
   *   ② `physMsPerFrame()` —— 每个呈现帧平均摊到的物理时间（**实测均值**；屏越慢每帧步数越多：
   *      60Hz 屏一帧 1 步，30Hz 屏一帧 2 步，120Hz 屏两帧才 1 步）。
   *   ③ 剩下的才是绘制余量：`period·0.75 − 物理`。
   *   ④ 只要"一次整帧绘制的典型成本"≤ 这个余量，就允许为插值额外出帧。
   *
   * **为什么不按像素数猜**：整帧绘制成本取决于**脏块数量**，而脏块取决于"同时有多少东西在动"，
   * 跟分辨率只是间接相关。拍一个 `backingMpx × k` 会在最需要它的设备上猜错（2K 白板上实测
   * 一次整帧 7~9ms，而同样 5.8M px 的 4K 桌面因为没啥东西在动只要 3ms）。
   * 实测成本天然带着机器/驱动/合成路径/球数的全部信息，换设备不需要改代码。
   *
   * **为什么是 0.75**：给合成器、事件处理、GC 留 25%。取值偏大会让"补帧把帧预算吃光"，
   * 偏小则在高分辨率设备上过早放弃补帧 —— 那正是这次报障的 2K 希沃白板。
   */
  const SMOOTH_LOAD_FRAC = 0.75;
  /** 预算地板：再保守也不低于它，否则一点测量噪声就会把补帧关掉。 */
  const SMOOTH_BUDGET_MIN_MS = 2.5;
  /** 预算上限：30Hz 投屏/白板上屏周期 33ms，不给无上限的宽松值。 */
  const SMOOTH_BUDGET_CAP_MS = 14;
  /** 当前生效的插值补帧预算（ms）。由 refreshSmoothBudget() 重算。 */
  let smoothBudgetMs = SMOOTH_BUDGET_MIN_MS;
  /**
   * 近 N 个**呈现帧**各自摊到的物理耗时（ms；一帧可能跑 0~4 步，记整轮之和）。
   * 它就是"屏越慢、绘制余量越小"的来源：30Hz 屏一帧要塞 2 步、120Hz 屏两帧才 1 步。
   */
  const physFrameWin = [];
  const PHYS_WIN = 120;
  let physFrameSum = 0;
  function notePhysFrame(ms) {
    physFrameWin.push(ms);
    physFrameSum += ms;
    if (physFrameWin.length > PHYS_WIN) physFrameSum -= physFrameWin.shift();
  }
  /**
   * 每个呈现帧平均要花的物理时间（ms）。
   *
   * ⚠️ 必须用**平均**而不是中位数：60Hz 屏上约一半的帧 `acc` 还没攒够一个步长
   *    （跑 0 步、物理开销 0），中位数会被这些 0 拉到 0 → 预算恒等于上限，方向恰好是错的。
   *    平均值才是"每帧要摊到的物理开销"这个量。
   */
  function physMsPerFrame() {
    return physFrameWin.length ? physFrameSum / physFrameWin.length : 0;
  }
  /** 重算插值补帧预算。屏周期变（换屏）或物理成本变（球数变）都要重算。 */
  function refreshSmoothBudget() {
    smoothBudgetMs = Math.max(SMOOTH_BUDGET_MIN_MS,
      Math.min(SMOOTH_BUDGET_CAP_MS, displayPeriod * SMOOTH_LOAD_FRAC - physMsPerFrame()));
  }

  /**
   * 动态渲染分辨率（DRS）。
   *
   * 「适配更多分辨率」的最后一道闸：**绘制成本压不下来时，降的是画布分辨率，不是帧率**。
   * 这是本轮唯一允许改变画面清晰度的地方，但它：
   *   · 只在**实测**绘制中位成本 > 屏周期 62% 时降档（说明连"每帧画一次"都开始吃紧）；
   *   · 有迟滞（降 40 票 ≈ 0.6s、升 240 票 ≈ 4s）+ 档间静默 2.5s，不会来回抖；
   *   · 屏比 120Hz 更快时**完全不介入** —— 那种屏上"少呈现几帧"比"糊一点"更划算，
   *     而且物理只走 60 步/秒，240Hz 下 4 帧才对应 1 步，插值帧本身就是冗余的。
   */
  const DRS_STEPS = [1, 0.88, 0.76, 0.64];
  const DRS_DOWN_AT = 0.62;   // 绘制中位成本 / 屏周期 超过它 → 投"降"票
  const DRS_UP_AT = 0.34;     // 低于它 → 投"升"票
  const DRS_DOWN_VOTES = 40;
  const DRS_UP_VOTES = 240;
  const DRS_DWELL_MS = 2500;
  const DRS_MAX_HZ = 120;
  let drsIndex = 0;
  let drsLastChange = 0;
  let drsDownVotes = 0, drsUpVotes = 0;
  /** 验收用：强制渲染缩放（null = 交给 DRS 自动）。见 `__pbScale`。 */
  let renderScaleForce = null;
  /**
   * 画布像素总数上限（Mpx）。4K@1x = 8.29M px，取它当"画布不比 4K 更大"的硬线。
   * 超过就按面积等比缩 dpr —— 8K、4K@200% 这类极端配置上，两张全屏画布的
   * 显存占用与"每次合成上传"的代价都是按像素数走的，必须封顶（这只影响清晰度，不影响帧率）。
   */
  const MAX_BACKING_MPX = 8.3;
  /** 无论如何不低于这个 dpr（再糊也得能看清球）。 */
  const ABSOLUTE_MIN_DPR = 0.5;

  /**
   * 最近 N 次整帧绘制的耗时（ms）。用它算**中位成本**而不是只看最后一次：
   * 单次采样会被一次 GC / 一次进球特效（几十粒火花 + 光环 + 彩带）抬高，
   * 拿"最后一次"去卡预算会让补帧在特效期间忽开忽关，反而更顿。
   */
  const drawCostWin = [];
  const DRAW_COST_WIN = 120;
  /** 近 DRAW_COST_WIN 帧整帧绘制耗时的中位数（ms）。样本不足时退回最近一次的实测值。 */
  function drawMsMedian() {
    if (!drawCostWin.length) return renderer ? renderer.lastDrawMs : 0;
    const s = drawCostWin.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  // ---- 呈现（present）度量：把"帧率满但卡顿"变成一个可读的数字 ----
  /**
   * ⚠️ 这里量的是**真的画出去的帧**之间的间隔，不是物理步率。
   *
   * 为什么必须单独量：`fps` 这个数字来自 `frames`，而 `frames` 只在**推进了物理步**
   * 时自增（见 loopInner）—— 它是"物理步率"，永远接近 60。真正会"一顿一顿"的是
   * **呈现节拍**：软件合成 / 关掉 DComp 之后，画面不再由 vsync 兜底合帧，而是我们
   * 的定时器什么时候画、系统就什么时候显示，定时器抖动直接变成肉眼可见的顿挫。
   * 旧版面板只有"物理帧率 60/60"，于是这个现象看起来"完全正常"。
   *   presentHz  —— 每秒真正提交了多少帧
   *   p50 / p95  —— 相邻两帧间隔的中位/95 分位（60Hz 下应都是 16.7ms）
   *   jitter     —— p95 − p50：>5ms 就已经能看出来（忽快忽慢）
   *   stalls     —— 间隔超过 1.6×显示周期 的次数（丢给合成器的空档）
   */
  let presentLastAt = 0, presentN = 0, presentGaps = [], presentStalls = 0, presentMaxGap = 0;
  let presentHz = 0, presentP50 = 0, presentP95 = 0, presentJitter = 0;
  /** 累计值（不被 250ms 窗口清掉）——验收脚本靠它判断"确实一直在出帧" */
  let presentTotal = 0, presentStallTotal = 0;

  // 拖拽验收钩子的状态（见文件末尾 __pbDragRunner）。
  // noLock=true 时拖拽期间**不**把窗口区域撑成全窗 —— 用来隔离"区域面积"
  // 与"绘制频率"这两个变量，见 main.js 的 --drag-test。
  // region 决定拖拽期间怎么上报区域：'full' = 整窗（默认，见 sendShape 的说明）；
  // 'corridor' = 只报一条跟着指针走的窄走廊（被 --drag-test 用来做 A/B）。
  const bench = { timer: 0, t: 0, cx: 0, cy: 0, r: 150, hz: 200, om: 0.09, noLock: false, region: 'full', park: false, raf: 0 };
  let probeN = 0;

  // 高速飞行验收钩子的状态（见文件末尾 __pbFlyRunner）。
  const fly = { on: false, off: null, x: 0, y: 0, vx: 0, vy: 0, speed: 0 };
  // 球盘前瞻量，单位是**物理步长**：上报半径 = grab + |body.velocity|·leadFrames。
  // 注意 |body.velocity| 已经是 px/步，别再乘 STEP/1000（那是把它当 px/s，会小 60 倍，
  // 踩过并因此误判成"前瞻没生效"，见 sendShape 里的详细记录）。
  // 默认见 LEAD_FRAMES_DEFAULT。--fly-test 会把它当参数扫，用来量出"需要几帧才够"，
  // 而不是凭感觉挑一个数（见 README §6.6）。
  let leadFrames = LEAD_FRAMES_DEFAULT;
  /**
   * 区域管线滞后采样开关（只给 --fly-test / --lag-probe 用，生产恒为 false）。
   *
   * 打开后每次 sendShape 都会把 **发出那一刻的 Date.now()** 塞进 shape._t。主进程
   * 在 SetWindowRgn 前算出 Date.now()−_t，就得到"区域从算好到真正生效"的端到端
   * 滞后。这正是"球被削掉一角"的直接自变量，也是 leadFrames 该取多少的唯一依据 ——
   * 不要去猜主进程忙不忙，直接量（见 README §6.6）。
   *
   * 注意 shape._t 每帧都不同，形状去重会因此失效（每帧必发）。诊断模式下无所谓：
   * 本来也只有球在动时才会走到这里。
   */
  let lagProbe = false;

  let barEls = [], menuEl, toastEl, perfEl;
  let hudEl, hudScoreEl, hudComboEl, hudHighEl, hudComboCell;
  /** 实测的重力「每步增量」（px/步），用于瞄准预测 —— 见 measureGravityStep */
  let gStep = 0;
  let goldenTimer = 0;

  // ================================================================== 入口
  let booted = false;

  /**
   * 确保某套皮肤需要的素材已解码（不需要素材的程序化皮肤直接返回，什么都不做）。
   *
   * 幂等：已解码过的不会重复请求（判据在 render.js::loadSkinTexture 里），
   * 所以启动、切皮肤、金球临时换皮肤都可以放心调。
   *
   * @param {string} skin 皮肤键；传 null/undefined 时用当前配置里的皮肤
   * @returns {Promise<boolean>} 素材是否可用（false = 该皮肤走程序化外观）
   */
  function ensureSkinTexture(skin) {
    const name = skin || (cfg && cfg.skin) || 'classic';
    if (!PB.skinNeedsTexture(name)) return Promise.resolve(false);
    const texName = PB.skinTextureName(name);
    return PB.loadSkinTexture(texName).then((ok) => {
      // 切皮肤的过程中可能已经又切走了：只有目标皮肤仍生效时才重烘。
      if (ok && renderer && renderer.skin === name) {
        renderer.reloadTextures();
        renderer.invalidateAll();
        wake();
      }
      return ok;
    });
  }

  function boot() {
    if (booted) return;
    booted = true;
    barEls = Array.prototype.slice.call(document.querySelectorAll('.bar'));
    menuEl = document.getElementById('menu');
    toastEl = document.getElementById('toast');
    perfEl = document.getElementById('perf');
    hudEl = document.getElementById('hud');
    hudScoreEl = document.getElementById('hudScore');
    hudComboEl = document.getElementById('hudCombo');
    hudHighEl = document.getElementById('hudHigh');
    hudComboCell = document.getElementById('hudComboCell');
    dynCanvas = document.getElementById('dyn');

    /**
     * 素材皮肤的照片/贴图：**按需**取当前皮肤那一张（见 render.js::loadSkinTexture）。
     *
     * ⚠️ 旧实现在这里**同步**读走全部三张素材（390 KB → 520 KB base64），
     * 卡在首帧之前；而默认皮肤 classic 是程序化绘制、一张都不需要，等于每次启动
     * 都白读一遍。现在改成：只有当前皮肤真的要素材时才请求那一张，且不等它完成
     * 就继续启动 —— 先用程序化调色板把球画出来，素材到位后清缓存重烘
     * （见 Renderer.reloadTextures），最坏情况是"皮肤晚几十毫秒才变成照片"。
     */
    PB.onTexturesLoaded = (name) => {
      if (!renderer || !name) return;
      // 只在"刚烘出来的那张就是当前皮肤"时才重烘，否则浪费（用户已经切走了）。
      if (PB.skinTextureName(renderer.skin) !== name) return;
      renderer.reloadTextures();
      renderer.invalidateAll();
      sendShape(true);
      wake();
      console.log('[textures] ' + name + ' 素材就绪，皮肤已重烘');
    };
    // ⚠️ 这里**不能**就地调 ensureSkinTexture(cfg && cfg.skin)：boot() 跑在
    // DOMContentLoaded 上，而配置是主进程通过**异步 IPC** `init` 送进来的 ——
    // 此刻 cfg 还是 null，`cfg && cfg.skin` 会退化成 'classic'，于是素材皮肤
    // 在启动路径上一次都不会去取（切皮肤时才补上，用户看到的是"启动时先用
    // 程序化外观、过一会儿才变照片"）。正确的位置是 onInit 里 setSkin 之后。
    // 教训：任何依赖 cfg 的启动期工作都必须挂在 onInit 里，不能挂在 boot() 里。

    window.dbb.ready(onInit);
    window.dbb.onAction(onAction);
    window.dbb.onLayout(onLayout);

    bindInput();
    bindMenuEvents();
    rmark('boot-end');
    // 这行会被主进程的 console-message 转发进 runtime.log —— 跨进程看启动分段就靠它。
    // 放在 sendReady() **之前**：主进程收到 renderer-ready 后的第一个 BOOT 行才有它。
    console.log(window.__pbBootLine());
    window.dbb.sendReady();
    rmark('sendReady');
  }

  // ================================================================== 初始化
  function onInit(c) {
    cfg = c;
    world = new PB.World(cfg, {
      onScore: onScore,
      onHoopChanged: (h) => {
        currentHoop = h;
        renderer.drawHoopStatic(h);
        renderer.invalidateAll();
        // 篮球架的开关会改变窗口区域（hoopRects 依赖 currentHoop.enabled），
        // 不在这里重报的话，关掉再打开就会留下一块被裁掉的空白。
        sendShape(true);
        wake();
      },
    });
    renderer = new PB.Renderer(document.getElementById('dyn'), document.getElementById('stat'));
    // 贴图烘焙尺寸依赖球半径，必须在 resize（首次调用 resize() 时定 dpr）之前告知
    renderer.setBallRadius(cfg.ballRadius);
    sfx = new PB.Sfx(cfg.soundEnabled);
    world.highScore = cfg.highScore || 0;   // 历史最高分（跨会话），破纪录时写回
    renderer.setSkin(cfg.skin);             // 皮肤主题（config.skin）
    // 素材皮肤要按需取贴图（见 ensureSkinTexture）。必须在**这里**而不是 boot()：
    // 配置是异步 IPC 送进来的，boot() 阶段 cfg 还是 null。
    ensureSkinTexture(cfg.skin);
    renderer.setTrail(cfg.trail !== false); // 运动拖尾开关（config.trail）
    renderer.setTrailStyle(cfg.trailStyle); // 拖尾样式：fire（默认）/ ghost
    // 运动平滑（config.smooth）：定点物理 + 插值渲染。默认开 —— 它要修的正是
    // "帧率显示满、动起来一顿一顿"，而且换到 75/120Hz 屏或投屏 30Hz 时尤其明显。
    renderer.setSmooth(cfg.smooth !== false);
    loadAchievements();                      // 已解锁成就（config.achievements）
    // 重力标定 gStep **故意不在这里算** —— 它只服务瞄准预测，而预测只在拖拽时发生。
    // 旧实现放在这一行，等于每次启动都在首帧之前白建一个 Engine 跑一步。
    // 现在改成首次拖拽时惰性标定，见 gravityStep()。

    world.bindCollisions((ball, relSpeed) => {
      if (relSpeed < 40) return;
      const s = Math.min(1, relSpeed / 1500);
      if (s > 0.07) ball.squash = Math.max(ball.squash, 0.08 + s * 0.26);
      sfx.bounce(s);
      // 落地/撞墙扬尘：只在强撞击时洒几粒，短寿命，球停下即消失（不影响空闲降频）
      if (relSpeed > 620) spawnDust(ball.body.position, Math.min(1, relSpeed / 2000));
    });

    resize();
    currentHoop = world.hoop;
    world.setHoop(!!cfg.hoopEnabled, true);
    renderer.drawHoopStatic(world.hoop);
    spawnBalls(cfg.ballCount);

    perfEl.style.display = cfg.showPerf ? 'block' : 'none';
    if (cfg.showControlBar === false) for (const el of barEls) el.style.display = 'none';
    if (hudEl) hudEl.classList.toggle('hide', cfg.showHud === false);
    updateHud();
    scheduleGolden();

    window.addEventListener('resize', resize);
    world.engine.timing.timeScale = 1;

    // 主显示器刷新率：绘制节流与插值节拍都依赖它（见 applyDisplayHz）。
    // 用异步 invoke 拿，不阻塞首帧 —— 拿不到就按 60Hz 兜底（applyDisplayHz 的默认值）。
    try {
      window.dbb.info().then((i) => { if (i) applyDisplayHz(i.displayHz); }).catch(() => {});
    } catch (e) { /* ignore */ }

    lastTime = performance.now();
    fpsAt = lastTime;
    wake();
    if (cfg.ballCount <= 0) addBall();
  }

  /**
   * 窗口尺寸 / 缩放 / 显示器变化后的统一重排。
   *
   * ⚠️ `dpr` 不再是"窗口报多少就是多少"：它要过 effectiveDpr 的三层夹取
   *    （DRS 档位 + 画布像素上限）。dpr 一变，两张画布与全部球贴图都要重建，
   *    所以这里必须把"绘制成本基线"一起清空，否则 DRS 会拿旧档位的成本去判新档位。
   */
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    rawDpr = window.devicePixelRatio || 1;
    const nd = effectiveDpr(rawDpr, W, H);
    const dprChanged = Math.abs(nd - dpr) > 0.001;
    dpr = nd;
    renderer.resize(W, H, dpr);
    world.setBounds(W, H);
    /**
     * ⚠️ 换设备（尤其换到**更小**的屏）之后必须把球夹回场地内，否则会出两种事故，
     *    表现出来都是"换了设备之后篮球画面缺失"：
     *      ① 球留在旧屏下方 → 落在"地面"静态体（厚 400、从 h 往下伸 200）内部，
     *         Matter 的 position solver 把深穿透当成需要猛推的分离量，直接把球弹到几万像素外；
     *      ② 球留在旧屏右侧 → 在右墙之外：渲染层照画，但窗口区域里没有它（被裁掉）。
     *    见 physics.clampBalls 与 physics.findSpawn 的注释。
     */
    const moved = world.clampBalls();
    if (moved) console.log('[resize] ' + W + '×' + H + ' 场地，把 ' + moved + ' 颗球夹回场内');
    renderer.drawHoopStatic(world.hoop);
    renderer.invalidateAll();
    lastShapeSent = '';
    if (dprChanged) {
      // 画布分辨率/贴图尺寸都变了 → 绘制成本基线作废，DRS 重新计票
      drawCostWin.length = 0;
      physFrameWin.length = 0; physFrameSum = 0;
      drsDownVotes = 0; drsUpVotes = 0;
      presentGaps.length = 0;
    }
    watchDpr();
    wake();
    return moved;
  }

  /**
   * 盯住 devicePixelRatio 的变化。
   *
   * ⚠️ 光靠 `window.resize` 抓不到"尺寸没变但缩放变了"：把窗口从 100% 的显示器挪到
   *    150% 的显示器上，或在系统设置里改缩放，`innerWidth` 可能一像素都不变、resize
   *    事件不触发 —— 但画布该重建、球贴图该重烘。用 matchMedia 的 resolution 查询逐档盯，
   *    每命中一次就重挂一次（`once`），开销只有一次对象分配。
   */
  let dprWatch = null;
  function watchDpr() {
    if (typeof window.matchMedia !== 'function') return;
    if (dprWatch && dprWatch.removeEventListener) dprWatch.removeEventListener('change', onDprChange);
    const q = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    if (q.addEventListener) q.addEventListener('change', onDprChange, { once: true });
    dprWatch = q;
  }
  function onDprChange() {
    dprWatch = null;
    resize();          // resize() 内部会重新 watchDpr()
  }

  function onLayout(l) {
    // 显示器换了 / 投屏插入 → 刷新率可能变（白板切成 30Hz、笔记本插上 120Hz 外接屏），
    // 节拍要跟着改，否则要么白插值、要么白绘制。
    if (l && l.displayHz) applyDisplayHz(l.displayHz);
    setTimeout(resize, 60);
  }

  // ================================================================== 球
  function spawnBalls(n) {
    const saved = Array.isArray(cfg.ballStates) ? cfg.ballStates : [];
    for (let i = 0; i < n; i++) {
      const s = saved[i];
      let x, y;
      if (s && isFinite(s[0]) && isFinite(s[1]) &&
          s[0] > 40 && s[0] < W - 40 && s[1] > 30 && s[1] < H - 40) {
        x = s[0]; y = s[1];
      }
      world.addBall(x, y);
    }
  }

  function addBall() {
    if (world.balls.length >= cfg.maxBalls) { toast('最多 ' + cfg.maxBalls + ' 颗篮球'); return; }
    const b = world.addBall();
    const p = b.body.position, r = b.r;
    renderer.invalidate(p.x - r * 1.5, p.y - r * 1.5, r * 3, r * 3);
    cfg.ballCount = world.balls.length;
    persistCount();
    if (world.balls.length >= 20) unlock('flood');
    wake();
  }

  function removeBall() {
    if (!world.balls.length) { toast('已经没有了'); return; }
    const b = world.removeBall();
    const p = b.body.position, r = b.r;
    renderer.invalidate(p.x - r * 1.5, p.y - r * 1.5, r * 3, r * 3);
    cfg.ballCount = world.balls.length;
    persistCount();
    wake();
  }

  function persistCount() {
    window.dbb.patchConfig({ ballCount: cfg.ballCount });
  }

  /** 把所有球随机上抛一次（快速把场子玩起来；没球时先补一颗） */
  function throwAll() {
    if (!world.balls.length) {
      addBall();
    }
    for (const b of world.balls) {
      M.Sleeping.set(b.body, false);
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
      const sp = 700 + Math.random() * 900;
      M.Body.setVelocity(b.body, { x: PB.V(Math.cos(ang) * sp), y: PB.V(Math.sin(ang) * sp) });
      M.Body.setAngularVelocity(b.body, (Math.random() - 0.5) * 1.2);
    }
    wake();
  }

  /** 清空重来：球回到 1 颗、得分与连击归零（最高分保留） */
  function resetGame() {
    world.clearBalls();
    world.resetScore();
    world.addBall();
    cfg.ballCount = world.balls.length;
    persistCount();
    currentHoop = world.hoop;
    renderer.invalidateAll();   // 整层重画：旧球的像素必须清掉
    renderer.drawHoopStatic(world.hoop);
    sendShape(true);
    updateHud();
    toast('已清空重来');
    scheduleGolden();           // 重开一局 → 金球计时也重排
    wake();
  }

  // ================================================================== 特效
  /**
   * 进球回调。
   * @param {object} hoop 篮筐
   * @param {object} ball 进球的球
   * @param {object} info { points, swish, combo, score, highScore }（见 physics.registerScore）
   */
  function onScore(hoop, ball, info) {
    const points = (info && info.points) || 2;
    const swish = !!(info && info.swish);
    const combo = (info && info.combo) || 1;
    const score = (info && info.score) || world.score;
    const golden = !!(info && info.golden);
    if (golden) sfx.gold();
    sfx.score(combo, swish);
    lastScoreInfo = {
      points, swish, combo, score, golden,
      at: Math.round(performance.now()),
    };
    // 金球已入网：立刻恢复成常规皮肤（golden 标记由 physics.registerScore 消费掉），
    // 并重新排下一颗金球的出现时间。球的形状变了 → 必须作废它当前的像素。
    if (golden) {
      const bp = ball.body.position, br = ball.r;
      ball.skin = null;
      renderer.invalidate(bp.x - br * 1.8, bp.y - br * 1.8, br * 3.6, br * 3.6);
      scheduleGolden();
    }

    const p = ball.body.position;
    const cx = hoop ? hoop.cx : p.x;
    const cy = hoop ? hoop.rimY : p.y;

    // 主飘字：+2 / +3（空心球更大、偏青；金球双倍、金色）
    fx.texts.push({
      text: '+' + points, x: cx, y: cy - 26, a: 1, vy: -34,
      size: golden ? 38 : (swish ? 34 : 30),
      color: golden ? '#ffe066' : (swish ? '#8ef0ff' : '#ffd977'),
      life: 1000, t: 0,
    });
    if (golden) {
      fx.texts.push({
        text: '金球双倍！', x: cx, y: cy - 66, a: 0.98, vy: -20,
        size: 17, color: '#fff0a0', life: 1200, t: 0,
      });
    }
    if (swish) {
      fx.texts.push({
        text: '空心球', x: cx, y: cy - 62, a: 0.95, vy: -20,
        size: 16, color: '#bff3ff', life: 1100, t: 0,
      });
    }
    if (combo >= 2) {
      fx.texts.push({
        text: '连击 ×' + combo, x: cx, y: cy - (swish ? 88 : 60), a: 0.95, vy: -14,
        size: 15, color: '#ffb0d6', life: 1200, t: 0,
      });
    }
    fx.texts.push({
      text: '得分 ' + score, x: cx, y: cy - (swish ? 114 : 86), a: 0.9, vy: -18,
      size: 15, color: '#ffffff', life: 1100, t: 0,
    });

    // 火花（空心球更旺、更青）
    const n = swish ? 28 : 18;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = 90 + Math.random() * 260;
      fx.particles.push({
        x: cx + (Math.random() - 0.5) * 50,
        y: cy + (Math.random() - 0.5) * 26,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        r: 2 + Math.random() * 3.2,
        color: swish
          ? (Math.random() > 0.5 ? '#8ef0ff' : '#ffffff')
          : (Math.random() > 0.45 ? '#ffd66b' : (Math.random() > 0.5 ? '#ff8a3d' : '#ffffff')),
        a: 1, life: 620 + Math.random() * 380, t: 0,
      });
    }

    /**
     * 进球特效（`config.fxBurst`）：冲击波光环 + 全向爆散 + 彩带。
     *
     * 与上面那撮「上扬火花」的分工：火花沿篮筐上方呈扇形铺开，是"网刷了一下"的写实反馈；
     * 这一组是全向烟花（360° 爆散）+ 两圈扩散光环 + 会翻转下坠的彩带 —— 负责"爽"。
     * 两者叠加不重叠观感，所以保留两套而不是替换。
     *
     * 全部在进球那一刻一次性生成，之后交给 updateFx 自然消亡 —— 没有任何按帧轮询，
     * 静置降频（球休眠 → 160ms 巡检）不受影响，和 §2.10 那条性能约定一致。
     */
    if (cfg.fxBurst !== false) {
      const gm = golden ? 1.35 : 1;
      const ringColor = golden ? '#ffe066' : (swish ? '#8ef0ff' : '#ffc46b');
      // 两圈错开出发的光环：外圈快、内圈慢而白，叠出"冲击波"的层次
      fx.rings.push({
        x: cx, y: cy, r: 16, v: swish ? 560 : 430, w: 3.4,
        color: ringColor, a: 1, life: swish ? 660 : 540, t: 0,
      });
      fx.rings.push({
        x: cx, y: cy, r: 6, v: (swish ? 560 : 430) * 0.62, w: 2,
        color: '#ffffff', a: 0.72, life: swish ? 520 : 430, t: 0,
      });
      // 全向爆散：一整圈等分 + 微抖动，读起来是"炸开"而不是"喷出"
      const bn = Math.round((swish ? 26 : 18) * gm);
      const bcol = golden
        ? ['#ffe066', '#fff6c2']
        : swish ? ['#8ef0ff', '#e8fbff']
        : ['#ffd66b', '#ff9a4d', '#ffffff'];
      for (let i = 0; i < bn; i++) {
        const a = (i / bn) * Math.PI * 2 + (Math.random() - 0.5) * 0.36;
        const sp = 120 + Math.random() * 330;
        fx.particles.push({
          x: cx, y: cy,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          r: 1.8 + Math.random() * 2.6,
          color: bcol[(Math.random() * bcol.length) | 0],
          a: 1, life: 520 + Math.random() * 420, t: 0,
        });
      }
      // 彩带：细长条、边飞边自转、重力下坠 —— 圆点堆不出"彩纸在飘"的观感
      const cn = Math.round((swish ? 22 : 14) * gm);
      const ccol = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff'];
      for (let i = 0; i < cn; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.0;
        const sp = 150 + Math.random() * 300;
        const w = 4 + Math.random() * 4, h = 9 + Math.random() * 8;
        fx.particles.push({
          x: cx + (Math.random() - 0.5) * 40, y: cy + (Math.random() - 0.5) * 18,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
          // r 是给包围盒/区域用的"外接半径" = 半对角，彩带旋转到任意角度都罩得住
          r: Math.hypot(w, h) / 2,
          shape: 'ribbon', w: w, h: h,
          rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 14,
          color: ccol[(Math.random() * ccol.length) | 0],
          a: 1, life: 1100 + Math.random() * 900, t: 0,
        });
      }
    }

    // 破纪录：`score === highScore` 恰好等价于"本次是新高"（分值只增不减，
    // 且 handle 里只有新高才会把 highScore 拉到 score）。得分归零后 highScore 保留，
    // 所以重新打到旧纪录之上才算刷新。
    if (info && score === info.highScore) {
      sfx.record();
      const colors = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff'];
      for (let i = 0; i < 90; i++) {
        fx.particles.push({
          x: cx + (Math.random() - 0.5) * Math.max(240, W * 0.55),
          y: cy - 40 - Math.random() * 70,
          vx: (Math.random() - 0.5) * 340,
          vy: -130 - Math.random() * 260,
          r: 2.5 + Math.random() * 3.5,
          color: colors[(Math.random() * colors.length) | 0],
          a: 1, life: 1400 + Math.random() * 900, t: 0,
        });
      }
      fx.texts.push({
        text: '新纪录！', x: cx, y: cy - 148, a: 1, vy: -10,
        size: 22, color: '#ffd166', life: 1600, t: 0,
      });
      toast('最高分 ' + score);
      cfg.highScore = score;
      window.dbb.patchConfig({ highScore: score });
      unlock('record');
    }
    updateHud();
    checkAchievements(info, ball);
    wake();
  }

  /** 强撞击扬尘：几粒小灰点，寿命短，随球停下自然消失 */
  function spawnDust(pos, s) {
    const n = 2 + ((s * 3) | 0);
    for (let i = 0; i < n; i++) {
      fx.particles.push({
        x: pos.x + (Math.random() - 0.5) * 18,
        y: pos.y + (Math.random() - 0.5) * 12,
        vx: (Math.random() - 0.5) * 140,
        vy: -20 - Math.random() * 90,
        r: 1.4 + Math.random() * 2.2,
        color: 'rgba(210,205,196,1)',
        a: 0.7, life: 320 + Math.random() * 260, t: 0,
      });
    }
  }

  function updateFx(dt) {
    const s = dt / 1000;
    for (let i = fx.particles.length - 1; i >= 0; i--) {
      const p = fx.particles[i];
      p.t += dt;
      if (p.t >= p.life) { fx.particles.splice(i, 1); continue; }
      p.vy += 900 * s;
      p.vx *= 0.985;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.a = 1 - p.t / p.life;
      // 彩带自转（圆点没有 rot/vrot，这一行对它们无影响）
      if (p.vrot) p.rot = (p.rot || 0) + p.vrot * s;
    }
    /**
     * 冲击波光环：半径匀速外扩、透明度加速衰减。
     * `1.6` 次幂让它在后半程"淡得比扩得更快"，收尾才不会像一圈静止的细线。
     */
    for (let i = fx.rings.length - 1; i >= 0; i--) {
      const r = fx.rings[i];
      r.t += dt;
      if (r.t >= r.life) { fx.rings.splice(i, 1); continue; }
      r.r += r.v * s;
      r.a = Math.pow(1 - r.t / r.life, 1.6);
    }
    for (let i = fx.texts.length - 1; i >= 0; i--) {
      const t = fx.texts[i];
      t.t += dt;
      if (t.t >= t.life) { fx.texts.splice(i, 1); continue; }
      t.y += t.vy * s;
      t.vy *= 0.97;
      t.a = Math.min(1, 1 - Math.pow(t.t / t.life, 2.2));
    }
  }

  // ================================================================== 瞄准辅助线
  /**
   * 实测「一个物理步长里重力给球加多少速度」（px/步）。
   *
   * 不自己推导公式（Matter 的 deltaTime 单位与 timeScale 折算很容易算错一处就偏 30%），
   * 而是拿一个一次性引擎跑一步、把结果读出来 —— 于是预测用的一定是引擎自己的标定，
   * 引擎升级也不会失配。
   *
   * ⚠️ **懒执行**（2026-10-07 启动优化）：它只在**瞄准预测**里用（predictPathFrom），
   * 而预测只在拖拽球时才发生 —— 启动阶段一次都用不到。旧实现在 onInit 里同步跑它，
   * 等于在首帧之前白建一个 Engine + 跑一步求解。现在首次用到时才算，算完缓存。
   * 代价是"第一次拖拽的第一帧多花零点几毫秒"，感知不到。
   */
  function gravityStep() {
    if (gStep) return gStep;
    try {
      const probe = M.Engine.create();
      probe.gravity.y = world.engine.gravity.y;
      probe.gravity.scale = world.engine.gravity.scale;
      const b = M.Bodies.circle(100, 100, 5, { frictionAir: 0 });
      M.Composite.add(probe.world, b);
      M.Body.setVelocity(b, { x: 0, y: 0 });
      M.Engine.update(probe, STEP);
      gStep = b.velocity.y || 0;
    } catch (e) {
      gStep = 0.0012 * STEP * STEP;
    }
    if (!gStep) gStep = 0.0012 * STEP * STEP;
    return gStep;
  }

  /**
   * 预测：给定出手速度（px/s），从球当前位置积分出一条抛物线。
   * 积分方式与 Matter 的 Body.update 一致 —— 每步先乘空气阻尼再加重力，然后位移。
   * 只做预测，不碰任何真实刚体。
   */
  function predictPathFrom(ball, vx, vy) {
    if (!ball) return null;
    const sp = Math.hypot(vx, vy);
    if (sp < 90) return null;                       // 与 onUp 一致：太慢等于没抛
    const lim = cfg.maxThrowSpeed;
    if (sp > lim) { vx = (vx / sp) * lim; vy = (vy / sp) * lim; }
    const fa = 1 - cfg.frictionAir;
    const r = ball.r;
    let sx = PB.V(vx), sy = PB.V(vy);
    let x = ball.body.position.x, y = ball.body.position.y;
    const pts = [];
    let hit = null;
    const hp = world.hoop;
    const hoopOn = !!(hp && hp.enabled);
    const floor = H - r;
    for (let i = 0; i < 180; i++) {
      sx *= fa;
      sy = sy * fa + gravityStep();
      x += sx; y += sy;
      if (x < r || x > W - r) break;                // 撞侧墙后不再预测（反弹路径意义不大）
      if (y < r) continue;                          // 顶到天花板：略过，继续等它落下来
      if (hoopOn && Math.abs(x - hp.cx) < hp.openW / 2 && Math.abs(y - hp.rimY) < 14) {
        pts.push({ x: x, y: y });
        hit = { x: hp.cx, y: hp.rimY };              // 直穿篮筐：落点标在圈心
        break;
      }
      if (y >= floor) { pts.push({ x: x, y: floor }); hit = { x: x, y: floor }; break; }
      if ((i & 1) === 0) pts.push({ x: x, y: y });   // 隔一步取点，够密也够省
    }
    if (!pts.length) return null;
    return { pts: pts, hit: hit, color: cfg.skin === 'neon' ? '#8ff2ff' : '#ffd977' };
  }

  function predictPath(ball) {
    const v = recentVelocity();                     // 指针速度（px/s）
    return predictPathFrom(ball, v.x * cfg.throwGain, v.y * cfg.throwGain);
  }

  // ================================================================== 记分板
  function updateHud() {
    if (!hudEl) return;
    hudScoreEl.textContent = String(world.score);
    hudComboEl.textContent = '×' + (world.combo || 0);
    hudHighEl.textContent = String(world.highScore);
    hudComboCell.classList.toggle('hot', (world.combo || 0) >= 3);
  }

  /** 记分板的窗口区域矩形（DOM 不在区域里就会被 SetWindowRgn 裁掉 → 看不见） */
  function hudRect() {
    if (!hudEl || cfg.showHud === false) return null;
    if (hudEl.classList.contains('hide')) return null;
    const r = hudEl.getBoundingClientRect();
    if (!r.width) return null;
    return [Math.round(r.left) - 4, Math.round(r.top) - 4,
            Math.round(r.width) + 8, Math.round(r.height) + 8];
  }

  // ================================================================== 成就
  /**
   * 成就表。判定全部挂在事件上（进球 / 加球 / 换皮肤），不做逐帧轮询 ——
   * 逐帧检查会让 isIdle() 永远为假，静置降频直接失效。
   */
  const ACHIEVEMENTS = [
    { id: 'first',       icon: '🏀', name: '初次得分', desc: '投进第一颗球' },
    { id: 'swish',       icon: '✨', name: '空心球',   desc: '投进一记空心球（不碰板不碰框）' },
    { id: 'carom',       icon: '🎪', name: '打板得分', desc: '擦板或擦框之后仍然命中' },
    { id: 'combo3',      icon: '🔥', name: '三连击',   desc: '4 秒内连续命中 3 次' },
    { id: 'combo5',      icon: '⚡', name: '五连击',   desc: '4 秒内连续命中 5 次' },
    { id: 'score10',     icon: '🎯', name: '十分',     desc: '单局累计 10 分' },
    { id: 'score50',     icon: '🏆', name: '五十分',   desc: '单局累计 50 分' },
    { id: 'score100',    icon: '👑', name: '百分',     desc: '单局累计 100 分' },
    { id: 'golden',      icon: '🌟', name: '金球入网', desc: '投进一颗金球' },
    { id: 'goldenSwish', icon: '💎', name: '金球空心', desc: '空心投进一颗金球' },
    { id: 'flood',       icon: '🌊', name: '球满为患', desc: '场上同时有 20 颗球' },
    { id: 'record',      icon: '📈', name: '刷新纪录', desc: '打破历史最高分' },
    { id: 'style',       icon: '🎨', name: '换装达人', desc: '更换一次球皮肤' },
  ];
  const achSet = new Set();

  function loadAchievements() {
    achSet.clear();
    const list = Array.isArray(cfg.achievements) ? cfg.achievements : [];
    for (const id of list) achSet.add(id);
    return achSet.size;
  }

  function unlock(id) {
    if (achSet.has(id)) return false;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return false;
    achSet.add(id);
    cfg.achievements = Array.from(achSet);
    window.dbb.patchConfig({ achievements: cfg.achievements });

    // 横幅 + 彩带（走 canvas 特效，天然进入脏块渲染，不额外驻留 DOM）
    const ty = Math.max(96, H * 0.17);
    fx.texts.push({
      text: a.icon + '  成就解锁：' + a.name, x: W / 2, y: ty, a: 1, vy: -8,
      size: 20, color: '#ffe28a', life: 2000, t: 0,
    });
    fx.texts.push({
      text: a.desc, x: W / 2, y: ty + 27, a: 0.95, vy: -6,
      size: 13, color: '#fff3cf', life: 2000, t: 0,
    });
    const colors = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff', '#c77dff'];
    for (let i = 0; i < 70; i++) {
      fx.particles.push({
        x: W / 2 + (Math.random() - 0.5) * Math.min(560, W * 0.72),
        y: ty - 34 - Math.random() * 46,
        vx: (Math.random() - 0.5) * 250,
        vy: -40 - Math.random() * 190,
        r: 2.4 + Math.random() * 3,
        color: colors[(Math.random() * colors.length) | 0],
        a: 1, life: 1100 + Math.random() * 900, t: 0,
      });
    }
    sfx.achievement();
    toast('成就解锁：' + a.name + '（' + achSet.size + '/' + ACHIEVEMENTS.length + '）');
    updateHud();
    wake();
    return true;
  }

  /** 进球后的成就判定（事件驱动，只在进球这一刻跑一次） */
  function checkAchievements(info, ball) {
    if (world.score > 0) unlock('first');
    if (!info) return;
    if (info.swish) unlock('swish');
    else unlock('carom');
    if (info.combo >= 3) unlock('combo3');
    if (info.combo >= 5) unlock('combo5');
    if (world.score >= 10) unlock('score10');
    if (world.score >= 50) unlock('score50');
    if (world.score >= 100) unlock('score100');
    if (info.golden) unlock('golden');
    if (info.golden && info.swish) unlock('goldenSwish');
  }

  // ================================================================== 金球彩蛋
  /** 安排下一次金球出现（默认 18~40 秒后）。复用同一个 timeout，不叠加。 */
  function scheduleGolden(delayMs) {
    if (goldenTimer) { clearTimeout(goldenTimer); goldenTimer = 0; }
    if (cfg.goldenEnabled === false) return;
    goldenTimer = setTimeout(spawnGolden, delayMs || (18000 + Math.random() * 22000));
  }

  function clearGolden() {
    if (goldenTimer) { clearTimeout(goldenTimer); goldenTimer = 0; }
    for (const b of world.balls) {
      if (!b.golden) continue;
      b.golden = false;
      b.skin = null;
      const p = b.body.position, r = b.r;
      renderer.invalidate(p.x - r * 1.8, p.y - r * 1.8, r * 3.6, r * 3.6);
    }
  }

  /**
   * 随机把一颗球变成金球。
   * 注意这是**空闲期唯一会主动触发的东西** —— 但它是纯事件：换一次贴图、标一次脏块、
   * 唤醒一帧，随后 isIdle() 仍为真、主循环照旧退回 160ms 巡检。不会破坏降频。
   */
  function spawnGolden(idx) {
    goldenTimer = 0;
    if (!world || cfg.goldenEnabled === false) return;
    const cands = world.balls.filter((b) => !b.golden);
    if (!cands.length) { scheduleGolden(20000); return; }
    const b = (typeof idx === 'number' && world.balls[idx] && !world.balls[idx].golden)
      ? world.balls[idx]
      : cands[(Math.random() * cands.length) | 0];
    b.golden = true;
    b.skin = 'gold';
    const p = b.body.position, r = b.r;
    renderer.invalidate(p.x - r * 1.8, p.y - r * 1.8, r * 3.6, r * 3.6);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.particles.push({
        x: p.x + Math.cos(a) * r * 0.7, y: p.y + Math.sin(a) * r * 0.7,
        vx: Math.cos(a) * 80, vy: Math.sin(a) * 80 - 30,
        r: 1.8 + Math.random() * 2.4, color: '#ffe066', a: 1, t: 0,
        life: 620 + Math.random() * 420,
      });
    }
    toast('金球出现！投进得双倍分');
    wake();
    scheduleGolden();
  }

  // ================================================================== 节拍 / 插值
  /**
   * 应用主显示器刷新率（来自主进程的 layout / app-info）。
   *
   * 两处必须跟着屏幕走，否则"换设备"必翻车：
   *  ① `frameMinMs` 绘制节流。旧版钉死 `1000/70`，在 120Hz 屏上会把插值补出来的
   *     中间帧**全部节流掉**（120Hz 的帧间隔 8.3ms < 14.3ms），于是插值等于没做；
   *     在 30Hz 的投屏/白板上则反过来：节流上限比屏幕还快，多出来的绘制纯属浪费。
   *  ② `displayPeriod`：呈现度量里判定"这一帧是不是卡了"的基准。
   *
   * ⚠️ 只往**更快**的方向放开（`Math.min`）：不能因为屏幕是 30Hz 就把节流调到 33ms ——
   *    那会让主循环的绘制节拍比物理步长还慢，反倒从 60 掉到 30。
   */
  function applyDisplayHz(hz, src) {
    const n = Number(hz);
    const valid = isFinite(n) && n >= 15 && n <= 500;
    if (src === 'raf') {
      // rAF 实测值：只在主进程**没报**刷新率时采信，且只采信一次
      if (!valid || displayHzReported || rafHzAdopted) return;
      rafHzAdopted = true;
      displayHzSource = 'raf';
      rafHzMeasured = n;
    } else {
      displayHzReported = valid ? n : 0;
      if (valid) displayHzSource = 'reported';
      else if (displayHzSource !== 'raf') displayHzSource = 'default';
    }
    const h = valid ? n : (displayHzSource === 'raf' ? displayHz : 60);
    const changed = Math.abs(h - displayHz) > 0.5;
    displayHz = h;
    displayPeriod = 1000 / h;
    /**
     * 绘制节流：**只往"更快"的方向放开**（`Math.min(FRAME_MIN_MS, …)`）。
     *
     * 旧版是 `Math.min(FRAME_MIN_MS, (1000 / clamp(h,60,144)) * 0.92)` —— 两头都错：
     *   · 上限 144 把 165/240Hz 屏按 144 算 → 节流上限比屏幕周期还长 → 白丢呈现帧；
     *   · 下限 60 在 30Hz 投屏/白板上把节流定成 14ms（比屏幕还快一倍）→ 多出来的绘制
     *     纯属浪费，而且让"每帧步数"从 2 变成 0/1/2 参差，反而更不平滑。
     * 现在直接用真实屏周期。**但绝不取到比 FRAME_MIN_MS 更慢**：这个量只是"防止有人把
     * 循环重新挂回自由跑的 rAF 时绘制跟着涨"的兜底，真正的节拍由 scheduleNext/rAF 决定；
     * 若把它当主力（比如 30Hz 屏上定成 33ms）会真的把画面压成 30fps —— 那是拿流畅度换省电，
     * 属于被明确否掉的规避手段。
     */
    frameMinMs = Math.min(FRAME_MIN_MS, displayPeriod * 0.92);
    refreshSmoothBudget();
    // 刷新率变了 → 之前"rAF 是否跟屏幕同频"的结论作废，重新探一次
    if (changed || rafPaced === null) {
      rafPaced = null;
      startRafProbe();
    }
  }

  /**
   * 真正拿来建画布的 dpr。三层夹取（顺序有意义）：
   *   ① 窗口真实的 devicePixelRatio（1 / 1.25 / 1.5 / 2 …，非整数缩放很常见）
   *   ② DRS 档位（按实测绘制成本自动升降，见 drsTick；`renderScaleForce` 可强制）
   *   ③ **画布总像素上限** `MAX_BACKING_MPX`（8K / 4K@200% 上能让画布涨到上亿像素）
   *
   * ⚠️ dpr 一变，`renderer.resize()` 会重建两张画布**并重烘全部球贴图**（`refreshBake`），
   *    所以它必须是个低频、带迟滞的决定 —— 别在这里接任何高频输入。
   */
  function effectiveDpr(raw, w, h, scaleOverride) {
    const s = scaleOverride === undefined
      ? (renderScaleForce === null ? DRS_STEPS[drsIndex] : renderScaleForce)
      : scaleOverride;
    let d = Math.max(0.5, Number(raw) || 1) * s;
    const mpx = (w * d * h * d) / 1e6;
    if (mpx > MAX_BACKING_MPX) d *= Math.sqrt(MAX_BACKING_MPX / mpx);
    return Math.max(ABSOLUTE_MIN_DPR, Math.min(4, d));
  }

  /**
   * DRS 的投票器：每帧投一次"降/升/不动"票，票数够了才真的换档。
   *
   * 判据用**比值**（绘制中位成本 / 屏周期）而不是绝对值 —— 同一个 8ms 的绘制，
   * 在 60Hz 屏（周期 16.7）上是宽裕的，在 144Hz 屏（6.9）上已经超支。
   */
  function drsTick(now) {
    if (bench.park || !cfg) return;
    if (renderScaleForce !== null) return;      // 验收强制值优先，别把它顶掉
    if (!cfg.dynScale || displayHz > DRS_MAX_HZ) return;   // 见 DRS_MAX_HZ 那段注释
    const cost = drawMsMedian();
    if (!(cost > 0) || !(displayPeriod > 0)) return;
    const ratio = cost / displayPeriod;
    if (ratio > DRS_DOWN_AT) { drsDownVotes++; drsUpVotes = 0; }
    else if (ratio < DRS_UP_AT) { drsUpVotes++; drsDownVotes = 0; }
    else { drsDownVotes = 0; drsUpVotes = 0; }
    if (now - drsLastChange < DRS_DWELL_MS) return;
    if (drsDownVotes >= DRS_DOWN_VOTES && drsIndex < DRS_STEPS.length - 1) {
      drsIndex++;
      applyDrs('降');
    } else if (drsUpVotes >= DRS_UP_VOTES && drsIndex > 0) {
      drsIndex--;
      applyDrs('升');
    }
  }
  /** DRS 换档只在第一次打一条日志（换挡本身很少发生，但排障时需要知道发生过）。 */
  let drsLogged = false;
  function applyDrs(dir) {
    drsLastChange = performance.now();
    drsDownVotes = 0; drsUpVotes = 0;
    const before = dpr;
    resize();
    if (!drsLogged && Math.abs(dpr - before) > 0.001) {
      drsLogged = true;
      console.log('[drs] ' + dir + '到 ' + (Math.round(dpr * 100) / 100) + '× dpr（' +
        W + '×' + H + '，画布 ' + Math.round(W * dpr) + '×' + Math.round(H * dpr) +
        '，绘制中位 ' + (Math.round(drawMsMedian() * 100) / 100) + 'ms / 屏周期 ' +
        (Math.round(displayPeriod * 100) / 100) + 'ms）');
    }
  }

  /**
   * 探测 rAF 是不是被 vsync 卡着（= 能不能拿它当绘制节拍）。
   *
   * 为什么要探：软件合成 / 关掉 DComp 的环境里 rAF 会**自由跑**（本机实测 150~410Hz），
   * 拿它当节拍会让主循环跑几百次/秒（CPU 白白浮沉）；而正常 GPU 路径下 rAF 恰好
   * 等于屏幕刷新率，用它出帧才能让画面落在屏幕的帧边界上、不再和我们的定时器打架 ——
   * 那正是"开了串流兼容模式之后运动发顿"的直接原因。
   *
   * 只在主循环**已经在跑**的时候开（wake 时启动、进入空闲巡检时停）：
   * 常驻的 rAF 会让合成器一直产帧、把空闲省电彻底毁掉（见 §2.7 空闲降频）。
   */
  function startRafProbe() {
    if (rafProbeOn || rafPaced === false) return;   // 已知"自由跑" → 再探也是白探
    rafProbeOn = true;
    if (rafPaced === null) rafTimes.length = 0;
    requestAnimationFrame(rafProbe);
  }
  /** 只停回调，**保留**已有结论（否则每次进空闲都会丢掉"rAF 跟屏幕同频"这个结果） */
  function stopRafProbe() {
    rafProbeOn = false;
    rafTimes.length = 0;
  }
  function rafProbe() {
    if (!rafProbeOn) return;
    const t = performance.now();
    rafTimes.push(t);
    if (rafTimes.length > 14) rafTimes.shift();
    if (rafPaced === null && rafTimes.length >= 9) {
      const gaps = [];
      for (let i = 1; i < rafTimes.length; i++) gaps.push(rafTimes[i] - rafTimes[i - 1]);
      gaps.sort((a, b) => a - b);
      const med = gaps[gaps.length >> 1];
      // 中位间隔落在屏幕周期的 0.6~1.6 倍之内 ⇒ rAF 跟着屏幕走。
      rafPaced = (med > displayPeriod * 0.6 && med < displayPeriod * 1.6);
      // 测出来是"自由跑"就不用再探了（结论也不会变），省掉常驻回调。
      // 显示器变化时 onLayout 会经 applyDisplayHz 重新起探针。
      if (rafPaced === false) { rafProbeOn = false; rafTimes.length = 0; return; }
      /**
       * rAF 跟屏幕同频 ⇒ 它就是一个**免费的刷新率测量仪**。
       *
       * 主进程报的 `displayFrequency` 在某些环境下是 0 或明显失真（虚拟显示驱动、
       * 白板投屏、部分远程桌面），那时节流上限与插值预算全按 60Hz 兜底 → 120Hz 上白插一场、
       * 30Hz 上把帧预算算宽。这里用实测值把它补齐（只补一次、只在主进程没报时补）。
       */
      if (rafPaced === true && !displayHzReported && !rafHzAdopted) {
        const hz = Math.round((1000 / med) * 10) / 10;
        if (hz >= 15 && hz <= 500) applyDisplayHz(hz, 'raf');
      }
    }
    requestAnimationFrame(rafProbe);
  }

  /**
   * 物理步**之前**给每颗球打一份位置/角度快照，供插值取"上一步"。
   * 必须打在每一步之前（不是每帧一次）—— 理由见 render.js::syncRenderPos。
   */
  function snapshotPrev() {
    const bs = world.balls;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const p = b.body.position;
      b._px = p.x; b._py = p.y; b._pa = b.body.angle;
    }
  }

  /**
   * 记一次"真的画出去了一帧"。相邻两次的间隔就是**呈现节拍** ——
   * 它和物理步率是两个数，见 presentHz 那一组变量的说明。
   * 只在 renderer.frame() 真正执行后调用（没画的帧不算）。
   */
  function notePresent(now) {
    presentN++;
    presentTotal++;
    if (presentLastAt > 0) {
      const g = now - presentLastAt;
      if (g > 0 && g < 600) {
        presentGaps.push(g);
        if (g > presentMaxGap) presentMaxGap = g;
        if (g > displayPeriod * 1.6) { presentStalls++; presentStallTotal++; }
      }
    }
    presentLastAt = now;
  }

  // ================================================================== 主循环
  function isIdle() {
    if (bench.park) return true;   // 探针期间把主循环停到 160ms 巡检，隔离出被测量
    if (drag || menuOpen) return false;
    if (fx.particles.length || fx.texts.length) return false;
    // 篮筐动画 / 闪光：threshold 用 0.02 与物理层的归零阈值一致
    if (world.hoop && world.hoop.enabled &&
        (world.hoop.netAnim > 0.02 || world.hoop.flash > 0.02)) return false;
    for (let i = 0; i < world.balls.length; i++) {
      if (!world.balls[i].body.isSleeping) return false;
    }
    return true;
  }

  /**
   * 唤醒主循环。
   *
   * ⚠️ `scheduled === 'running'` 这一条是必须的：loop() 体内（从 `scheduled='running'`
   * 到本轮真正安排下一次为止）会执行物理步与绘制，期间完全可能被输入事件打断
   * —— 而 pointerdown/pointermove 都会调 wake()。旧代码在这里看到 `scheduled` 是 null
   * 就当成"没人在跑"，于是又挂一条 rAF 链；**每挂一条就等于把主循环永久提速一档**。
   * 拖拽时 pointermove 高达 200~1000 Hz，于是循环频率一路涨到 400 次/秒：
   * 这就是"球多时拖球卡、松手立刻流畅"的第二个根因（松手后 pointermove 停了，
   * 不再挂新链，已被加速的链也会随空闲降频）。
   */
  function wake() {
    if (scheduled === 'raf' || scheduled === 'step' || scheduled === 'running') return;
    // 空闲期挂的是 160ms 的定时器：此刻来事件必须立刻掐掉它并改走 rAF，
    // 否则按下/拖动最多要等 160ms 才被处理 —— 这是最容易被忽略的触控延迟源。
    if (scheduled === 'timer') { clearTimeout(idleTimer); idleTimer = 0; }
    wakeT0 = performance.now();
    lastTime = performance.now();
    // 主循环即将变"热"，顺便把 rAF 节拍探针打开（只在热的时候开，见 startRafProbe）
    startRafProbe();
    scheduled = 'raf';
    requestAnimationFrame(loop);
  }

  /**
   * 安排下一轮循环。
   *
   * 这里决定的是"循环跑多快"，而物理是固定 60Hz —— 跑得比 60Hz 更快不会多出
   * 任何信息，只会让每次回调都过一次浏览器的帧流水线（含透明窗口的合成）。
   * 本机软件合成下 rAF 不锁 vsync：实测 150~410 Hz，且随桌面其它动画浮沉，
   * 于是拖拽的 CPU 占用也跟着浮沉（同一份代码实测 2.8%~9.4%）。
   * 所以：还差一个步长就在等 → 用定时器按步长补上；该跑了 → rAF。
   *
   * ⚠️ 例外（2026-10-11）：**rAF 被 vsync 卡住时优先用它当节拍**。
   *    关掉 DirectComposition 之后（串流兼容模式），画面不再由 DWM 兜底合帧，
   *    而是"我们的定时器什么时候 RequestPaint、系统就什么时候显示"。定时器
   *    哪怕只抖 1ms，落到 60Hz 的显示上就会变成隔三差五的一次顿挫 ——
   *    这正是用户报的"开了兼容开关之后运动卡顿、但帧率还是满的"。
   *    改用 rAF 出帧，帧就落在屏幕的帧边界上，顿挫消失。
   *    判据不能拍脑袋（软件合成下 rAF 会自由跑）—— 用 rafProbe 实测间隔决定，
   *    测出来是"自由跑"就仍然走定时器，行为与本改动之前完全一致。
   */
  function scheduleNext(waitMs) {
    if (!(waitMs > 2)) {
      scheduled = 'raf';
      requestAnimationFrame(loop);
      return;
    }
    if (rafPaced === true && waitMs <= STEP) {
      scheduled = 'raf';
      requestAnimationFrame(loop);
      return;
    }
    scheduled = 'step';
    idleTimer = setTimeout(loop, Math.min(waitMs, STEP));
  }

  /**
   * 主循环的**保护壳**。
   *
   * ⚠️ 这里不是"防御性编程"，是踩过的血案：渲染循环里任何一处未捕获异常都会让
   * `loopInner()` 在**排下一帧之前**就中断 —— `requestAnimationFrame(loop)` 再也
   * 不会被调用，循环永久停摆。表现出来却是"整个程序坏了"：球不再绘制（画布停在
   * 上一帧）、`sendShape()` 不再上报（区域冻结）、`+/-` 按钮点下去世界变了但画面
   * 毫无反应。2026-10-06 用户报的「篮球没了 / 按钮没反应 / 性能卡片没了」三连
   * 就是 `renderer.lastDrawMs` 未初始化（见 render.js 构造函数的注释）引发的一次。
   *
   * 只在**没来得及排下一帧**时才补排（`scheduled === 'running'`），避免：
   * 异常发生在 `scheduleNext()` 之后 → 重复排帧 → 两个循环同时步进物理。
   */
  function loop() {
    try {
      loopInner();
    } catch (e) {
      if (!loopErrLogged) {
        loopErrLogged = true;
        console.error('[loop] 主循环异常（只记一次，循环继续）：' + ((e && e.stack) || e));
      }
      if (scheduled === 'running') {
        scheduled = 'raf';
        requestAnimationFrame(loop);
      }
    }
  }

  function loopInner() {
    const loopT0 = performance.now();
    scheduled = 'running';
    const now = loopT0;
    if (wakeT0) { lastWakeLatency = now - wakeT0; wakeT0 = 0; }
    let dt = now - lastTime;
    lastTime = now;
    if (dt > 250) dt = 250;
    if (dt < 0) dt = 0;
    loopCount++;
    let drew = false;

    const idle = isIdle();
    const fxBusy = fx.particles.length > 0 || fx.texts.length > 0;
    let needDraw = false;
    if (!idle) {
      acc += dt;
      if (acc >= STEP || drag || fxBusy) {
        let steps = 0;
        const physT0 = performance.now();
        // ⚠️ 每一步之前打一份位置快照：插值渲染要靠它拿到"上一步在哪"
        // （见 render.js::syncRenderPos —— 必须每步一次，不能每帧一次）。
        while (acc >= STEP && steps < 4) { snapshotPrev(); world.step(); acc -= STEP; steps++; }
        if (steps >= 4) acc = 0;
        // 本帧的物理开销进窗口（**只记"真的要呈现"的帧**：走插值补帧那条也记 0，
        // 更下面那个早退分支不记 —— 于是均值 = "每个呈现帧摊到的物理"）
        notePhysFrame(performance.now() - physT0);
        refreshSmoothBudget();
        // 只把"真正推进了物理"的循环计进 FPS：软件合成下 rAF 不锁 vsync
        // （本机 150~450 Hz），按回调数算出来的 FPS 没有意义。
        // 这个数字 = 实际物理帧率，低于 60 才说明真的跑不动了。
        if (steps > 0) { frames++; stepCount += steps; }
        updateFx(dt);
        needDraw = true;   // 走到这里一定有事要重画（步进 / 拖拽 / 特效）
      } else if (renderer.smooth && drawMsMedian() <= smoothBudgetMs) {
        /**
         * 离散步长还没攒够 —— 旧版在这里直接早退，那一帧什么都不画。
         * 于是"推进 0 步的那一帧球不动、下一帧连跳两格"，读起来就是
         * 「帧率显示满的、动起来一顿一顿」（见 render.js::smooth 的说明）。
         *
   * 打开插值后改为：只要还有醒着的球，就用当前 acc 插值补一帧。
   * 两重自我约束，避免"为了顺滑把帧率搞下去"：
   *   · 只有 smooth 打开才走这条（config.smooth 可关，回到旧行为）；
   *   · 整帧绘制的**典型成本**（近 120 帧中位数）超过预算 → 放弃插值补帧。
   *     用中位数而不是"最后一次"，是为了不在进球特效那几帧忽开忽关
   *     （一次进球有几十粒火花 + 光环 + 彩带，单帧会被抬高）。
   * 预算 = 屏周期 × 0.75 − 实测物理耗时，见 SMOOTH_LOAD_FRAC。
   * 在它之前还有一道 DRS（降画布分辨率，见 drsTick）——
   * 顺序是"先保证画得动，再保证画得滑"，两者都不碰物理步长与帧率。
   */
        notePhysFrame(0);          // 这一帧没跑物理，如实记 0（见 physMsPerFrame）
        refreshSmoothBudget();
        needDraw = true;
      } else {
        // 攒够一个固定步长之前不推进物理、也不尝试渲染。
        // 软件合成下 rAF 不锁 vsync（本机实测 150~410 fps），少了这个早退
        // 就会有大量"离散步长没到、脏块也没变"的空转循环。
        iterCount++; loopMsTotal += performance.now() - loopT0;
        updatePerf(now, idle);
        scheduleNext(STEP - acc);
        return;
      }
    } else if (renderer.pending()) {
      // 空闲期也要消化一次挂起的重绘：切换篮球框、增删球、窗口尺寸变化
      // 都只是标脏块，不主动渲染的话要等到下次有球动起来才可见。
      needDraw = true;
    }
    // 绘制节流：见 FRAME_MIN_MS / applyDisplayHz 的注释。被节流跳过的这一帧不丢状态 ——
    // 脏块和 needFull 都留在 renderer 里，下一个回调会照常消费掉。
    if (needDraw && now - lastDrawAt >= frameMinMs) {
      lastDrawAt = now;
      renderer.frame({
        balls: world.balls,
        hoop: world.hoop,
        particles: fx.particles,
        rings: fx.rings,
        texts: fx.texts,
        dragging: drag ? drag.ball : null,
        aim: drag ? predictPath(drag.ball) : null,
        // 插值系数：本帧"没被物理步消耗掉"的那部分时间（0..1）。
        // 1 = 画在物理位置上；0.5 = 画在上一步与这一步的正中间。
        alpha: Math.max(0, Math.min(1, acc / STEP)),
      });
      drawCount++;
      drawMsTotal += renderer.lastDrawMs;
      drawCostWin.push(renderer.lastDrawMs);
      if (drawCostWin.length > DRAW_COST_WIN) drawCostWin.shift();
      drew = true;
      notePresent(now);
      sendShape();
    }
    // 主循环自身开销 = 整轮 − frame()（frame 内部自己量过 lastDrawMs）
    iterCount++;
    loopMsTotal += performance.now() - loopT0 - (drew ? renderer.lastDrawMs : 0);
    // DRS 只在"有东西在动"时评估：空闲期没有绘制成本样本，别乱换档（见 drsTick）
    if (!idle) drsTick(now);
    updatePerf(now, idle);

    if (now - lastPersistAt > 10000) { lastPersistAt = now; persistBalls(); }

    if (idle) {
      scheduled = 'timer';
      stopRafProbe();          // 空闲期不留常驻 rAF（否则合成器一直产帧，省电全废）
      idleTimer = setTimeout(loop, 160);
    } else if (acc < STEP) {
      // 该做的都做完了，物理步还没到 → 按物理节奏等（见 scheduleNext）。
      // 拖拽时 needDraw 恒为真，但球的位置每步才更新一次，画得更密没有意义。
      scheduleNext(STEP - acc);
    } else {
      scheduled = 'raf';
      requestAnimationFrame(loop);
    }
  }

  // ================================================================== 形状上报（点击穿透）
  /**
   * 篮球架的窗口区域矩形（篮板 / 篮圈 / 网 / 立柱+底座）。
   *
   * ⚠️ 这不是可选项。SetWindowRgn 设的区域就是窗口的**可见范围**，区域之外的
   * 像素根本不绘制。早先这里只上报「球圆盘 + 控制栏 + 菜单」，篮球架不在区域里，
   * 于是真实屏幕上篮球架是隐形的 ——
   *   · 拖动球时区域被临时撑成全窗（sendShape 的 locked 分支）→ 篮球架闪一下；
   *   · 球滚到架子旁边时，球圆盘那 46px 的圆蹭到架子边缘 → 只露一角。
   * 这就是"篮球框平时完全不显示，只有篮球周围一圈能看到"的真正原因。
   *
   * `capturePage()` 截图看不出来：它读渲染进程自己的合成结果，不受区域裁剪。
   * 验收必须用 `tools/region-probe.ps1`（真实屏幕坐标打 WindowFromPoint）。
   *
   * 几何必须与 physics.js::setHoop 的碰撞体、render.js 的绘制三者一致：
   *   tube=6  span=openW+2*tube  boardW=124  boardH=96  boardRight=w-30
   *   rimY=max(180,h-322)  boardY=rimY+10-boardH/2  poleX=w-22
   * ry 用与 render.js `rimSquash` 相同的公式（篮圈透视压扁）。
   */
  function hoopRects() {
    const hp = currentHoop;
    if (!hp || !hp.enabled || !W || !H) return [];
    const tube = hp.tube || 6;
    const span = hp.span;
    const rx = span / 2;
    const ry = Math.max(7.5, rx * 0.26);       // 同 render.js::rimSquash
    const cx = hp.cx, rimY = hp.rimY;
    const netLen = hp.netLen || 82;
    const bL = hp.boardLeft, bW = hp.boardW, bH = hp.boardH;
    const bT = rimY + 10 - bH;                 // 篮板顶沿 = boardY - boardH/2
    const poleX = W - 22;
    const poleTop = Math.round(rimY - 38 - bH * 1.25);  // boardY - boardH*1.25
    const rimL = cx - rx - tube;
    const rimW = span + tube * 2;
    return [
      // 篮板（含边框）
      [Math.round(bL) - 2, Math.round(bT) - 2, bW + 4, bH + 4],
      // 篮圈：连圈内的"洞"一起纳入。洞不纳入会省下约 114x30px 的桌面点击，
      // 但那样球从洞里穿过的瞬间才补上区域，边缘会闪；代价可接受。
      [Math.round(rimL) - 2, Math.round(rimY - ry - tube) - 2, rimW + 4, Math.round(ry * 2 + tube * 2) + 4],
      // 网（碗状，两侧收窄）
      [Math.round(rimL) + 8, Math.round(rimY), rimW - 16, Math.round(netLen + ry) + 34],
      // 立柱 + 底座 + 支撑臂：一直覆盖到窗口右缘和地面
      [W - 56, poleTop - 6, 56, H - poleTop + 6],
    ];
  }

  /**
   * 两侧控制栏的窗口区域矩形。
   * ⚠️ 左、右两组都必须在这里出现 —— 漏掉哪一组，那一组就会被 SetWindowRgn
   * 从窗口区域里裁掉，在真实屏幕上直接消失（捕获截图看不出来，见 §7 区域探针）。
   * 同理它们也**不能**跟随球的圆盘走：区域是按窗口坐标静态算出来的，
   * 不随窗口移动/滚动，所以按钮固定在角落是安全的。
   */
  function barRects() {
    if (cfg && cfg.showControlBar === false) return [];
    const out = [];
    for (let i = 0; i < barEls.length; i++) {
      const el = barEls[i];
      if (el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      out.push([Math.round(r.left) - 4, Math.round(r.top) - 4,
                Math.round(r.width) + 8, Math.round(r.height) + 8]);
    }
    return out;
  }

  function menuRect() {
    if (!menuOpen) return null;
    const r = menuEl.getBoundingClientRect();
    return [Math.round(r.left) - 4, Math.round(r.top) - 4,
            Math.round(r.width) + 8, Math.round(r.height) + 8];
  }

  /**
   * 性能面板的窗口区域矩形。
   *
   * ⚠️ 与记分板完全同理：它是 **DOM**，而 SetWindowRgn 设的区域就是窗口的**可见范围**，
   * 不进区域的 DOM 一个像素都不会绘制。早先这里漏了它，于是症状是
   * 「性能信息明明打开了却看不见 —— 只有拖动篮球（区域被临时撑成全窗）或把球拖到卡片
   * 附近（球圆盘那 46px 蹭到一角）时才露出来，而且露出来的部分是个圆形」。
   * 这不是渲染 bug，是窗口区域少了一块。
   *
   * 代价与记分板/控制栏同级：左上角多一小块"能点但点不进桌面"的死区。
   * 它同样是可开关的（右键菜单 / 托盘「性能信息」），关掉后区域立刻收回。
   */
  function perfRect() {
    if (!perfEl || !cfg || !cfg.showPerf) return null;
    if (perfEl.style.display === 'none') return null;
    const r = perfEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [Math.round(r.left) - 4, Math.round(r.top) - 4,
            Math.round(r.width) + 8, Math.round(r.height) + 8];
  }

  /**
   * 提示气泡（DOM）的窗口区域矩形。
   * 它是本程序**唯一的操作反馈**（换皮肤 / 开关某项 / 成就播报都只靠它）。
   * 早先它不在区域里 → 所有 toast 都看不见 → 用户点「球皮肤」来回切了 4 次，
   * 屏幕上没有任何回执，于是报「球皮肤功能无法正常启用使用」（见 README §6.9）。
   */
  function toastRect() {
    if (!toastEl || !toastEl.classList.contains('show')) return null;
    const r = toastEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [Math.round(r.left) - 4, Math.round(r.top) - 4,
            Math.round(r.width) + 8, Math.round(r.height) + 8];
  }

  /**
   * 画布上的临时特效（加分飘字 / 火花 / 成就列表）的窗口区域矩形。
   *
   * ⚠️ 它们画在 #dyn 上，**同样受区域裁剪** —— "画在 canvas 上就不用管区域"是错的
   * （篮球架当初就是这么隐形过一次）。以前 sendShape 完全没上报它们，于是
   * 「+3 空心球」「得分 N」「新纪录！」这些飘字只有落在篮圈那个小矩形里的一条能显示，
   * 上半截被齐刷刷切掉；火花更是绝大部分看不见。真实屏幕截图可复现（README §6.9）。
   *
   * 飘字逐条上报（条数少、每条都要完整可见，成就列表就是十几行）；
   * 火花按 FX_CELL 网格**合并**成一格一个矩形 —— 一次进球有 18~28 粒火花，
   * 逐粒上报等于每帧重建 30+ 个区域（主进程 CreateRectRgn/CombineRgn 跟着涨），
   * 而它们的空间分布本来就只有一片扇形那么大。网格量化后通常 2~6 个矩形，
   * 破纪录那一下最多 FX_RECT_CAP 个（超出的丢弃 —— 纯装饰，且那一刻本来就在放礼花）。
   */
  const FX_CELL = 128, FX_RECT_CAP = 20;
  function fxRects() {
    const out = [];
    for (let i = 0; i < fx.texts.length; i++) {
      const b = renderer.textBox(fx.texts[i]);
      out.push([Math.round(b[0]) - 3, Math.round(b[1]) - 3,
                Math.round(b[2]) + 6, Math.round(b[3]) + 6]);
      if (out.length >= FX_RECT_CAP) return out;
    }
    // 冲击波光环：每帧半径都在变（最大约 400px），逐圈上报一个包围盒。
    // 圈数恒为 2，所以不占多少额度，但漏了它光环就只剩落在篮筐矩形里的那一段能看见。
    for (let i = 0; i < fx.rings.length; i++) {
      const rg = fx.rings[i];
      if (!isFinite(rg.x) || !isFinite(rg.y)) continue;
      const pad = rg.r + rg.w + 4;
      out.push([Math.round(rg.x - pad), Math.round(rg.y - pad),
                Math.round(pad * 2), Math.round(pad * 2)]);
      if (out.length >= FX_RECT_CAP) return out;
    }
    const cells = new Set();
    for (let i = 0; i < fx.particles.length; i++) {
      const p = fx.particles[i];
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      cells.add(Math.floor(p.x / FX_CELL) + ',' + Math.floor(p.y / FX_CELL));
    }
    for (const k of cells) {
      if (out.length >= FX_RECT_CAP) break;
      const c = k.split(',');
      out.push([Number(c[0]) * FX_CELL, Number(c[1]) * FX_CELL, FX_CELL, FX_CELL]);
    }
    return out;
  }

  /**
   * 上报「可交互形状」给主进程，由它 SetWindowRgn 做逐像素穿透。
   * @param {boolean} force 绕过形状去重
   * @param {boolean} sync  同步等待区域设定完成（右键菜单必须用，见 openMenu）
   */
  function sendShape(force, sync) {
    // 兜底：早期调用（onInit 里的 world.setHoop → onHoopChanged）可能早于 W/H 就位
    if (!renderer || !world || !cfg || !W || !H) return;
    /**
     * 拖拽 / 右键菜单期间一律把窗口区域撑成**整窗**。
     *
     * 这么做的关键是**形状去重**：整窗矩形在开始拖拽时上报一次，之后形状字符串
     * 恒定不变，`SetWindowRgn` 一次都不会再被调用 → 主进程零成本。而"指针跑出
     * 区域、pointermove 漏给桌面、拖拽凭空断掉"的风险也一并不存在了。
     *
     * 反面教材（曾有实现，现由 bench.region='corridor' 保留做对照）：拖拽期间只
     * 上报一条跟着指针走的窄走廊。听起来省了合成面积，实测反而更贵 —— 走廊每帧
     * 都在变、去重永远失效，主进程每帧重建区域并重定向窗口表面。60 球同进程 A/B
     * （iters/s 相同）：合计单核 17.28%（整窗）→ 19.39%（走廊），差值全在主进程。
     * 详见 README §6.5。
     */
    const lock = menuOpen || (drag && bench.region !== 'corridor');
    if (lock && !bench.noLock) {
      if (lockState !== 'locked' || force) {
        lockState = 'locked';
        lastShapeSent = '';
        if (sync && window.dbb.shapeSync) window.dbb.shapeSync({ circles: [], rects: [] }, true);
        else window.dbb.shape({ circles: [], rects: [] }, true);
      }
      return;
    }
    const shape = { circles: [], rects: [] };
    const grab = cfg.ballRadius + GRAB_PAD;
    /**
     * 球盘外扩：空中高速飞行时球会被 SetWindowRgn 削掉一块（用户报的 bug）。
     *
     * 上报半径 = ballRadius + GRAB_PAD = 46，而球自身的视觉外延（沿速度被
     * drawBall 拉伸到 1.16r ≈ 39px）已经吃掉了大半，**只剩 6~12px 余量**。
     * 这点余量在球静止时够用，但"生效中的区域"和"屏幕上那一帧"不是同一条管线：
     *   · 区域：渲染进程算好 → IPC → 主进程 → SetWindowRgn
     *   · 画面：渲染进程 canvas → Chromium 合成 → 提交 → DWM 呈现
     * 两条管线之间必然错开。实测（tools/screencap.ps1 连拍 + 逐帧比对球心，
     * 见 README §6.6）：画面本身跟球位是同步的（偏差 1~17ms），**落后的是区域**，
     * 典型 1 帧、主进程一忙就到 2~3 帧。球速 1200px/s 时一帧就是 20px，
     * 远超那 6~12px 余量 —— 于是球沿速度方向缺一块，慢下来又自己长回来。
     *
     * 修法：上报圆半径加 |v|·leadFrames，即"从现在起 leadFrames 个物理步内球会走多远"。
     * 它同时罩住"上一帧的球位"和"下一帧的球位"，不必去猜这次是区域超前还是画面超前。
     *
     * ⚠️ 单位：`body.velocity` 是 **px/步**（见 physics.js 开头那条单位约定），不是 px/s。
     * 一个"前瞻帧"就是一个物理步长，所以前瞻距离 = |velocity| · leadFrames，
     * **绝不能再乘 STEP/1000**。
     *
     * 这个坑真实发生过，而且差点把结论带偏：先前写成 |v|·leadFrames·STEP/1000
     * （拿 px/步 当 px/s 用），前瞻被整整缩小 60 倍。用洋红大圆盘当区域探针量出来
     * 的半径是 45.1 → 48.1px（lead 从 0 扫到 4 只涨 3px，而按公式该涨 90px+），
     * 于是"加了前瞻照样缺一块"，看起来跟没生效一样 —— 其实一直在生效，只是幅度
     * 小到落在噪声里（理论斜率 49.5px/步 × 0.01667 = 0.825px/帧，实测 0.75px/帧）。
     * 详见 README §6.6。
     *
     * 取几帧不是拍脑袋定的，是用 --fly-test 配 --region-lag 做**剂量-反应实验**
     * 量出来的（同一趟飞行里把前瞻量在 0/1/2/3/4 帧之间轮换，见 README §6.6）。
     * 静止 / 慢速球 |v|·leadFrames ≈ 0，与旧的固定圆完全等价，不会平白多出点击
     * 死区（桌面上"点不进去"的范围只在球真的飞起来时才变大，而飞行只有一两秒）。
     */
    for (let i = 0; i < world.balls.length; i++) {
      const b = world.balls[i];
      const bp = b.body.position;
      const v = b.body.velocity;
      /**
       * ⚠️ 上报的是**画面上的位置**（插值后的 `posOf`），不是物理位置。
       *
       * 必须与 `drawBall` 同一个口径：区域圆的圆心如果还按 `body.position` 算，而球
       * 被画在插值点上，两者最多相差**一个步长**（高速球 30~50px）—— 那正好就是
       * "球沿运动方向被齐刷刷削掉一块"的样子。内插位置恒在
       * 「上一步位置 → 当前位置」之间，再叠上 `leadFrames` 的前瞻，两个方向都罩住。
       */
      const rp = renderer.posOf(b);
      /**
       * 上报半径必须 ≥ **这一帧球真正画到多远**，否则球的一角会被区域直接削掉。
       *
       * 早先这里写的是 `grab = ballRadius + GRAB_PAD`（= 46）定值，注释里按
       * "沿速度拉伸到 1.16r ≈ 39px" 估的余量 —— 但那只算了**速度拉伸**，漏了
       * **撞击挤压**：drawBall 的 `s = (ball.squash||0) + stretch`，而 squash 在
       * 撞击时最大到 0.34（见 world.bindCollisions），stretch 最大 0.16，
       * 于是 `g.scale(1 + s, ...)` 能把球沿一个轴放大到 **1.50r = 51px**。
       * 46 < 51 → 撞一下之后球就有一角露在区域外，被裁掉几像素；撞击越猛露得越多，
       * squash 每步 ×0.86 衰减，于是"撞完那一两帧缺一角、慢慢长回来"。
       *
       * 现在半径直接由 drawBall 的同一套算式反推（visR），与渲染口径锁死 ——
       * 以后改 drawBall 的形变系数，这里跟着一起改，不要再退回定值。
       * 静止球 squash=0、stretch=0 → visR+GRAB_PAD = 34+12 = 46，与旧值完全一致，
       * 所以点击死区只在球真的被挤压/高速时才变大。
       *
       * 顺带把非有限值挡掉：NaN/Infinity 经 JSON.stringify 会变成 null，
       * 到了 native.js 会被 Math.max(1, ...) 收成半径 1 的圆 —— 那颗球在屏幕上
       * 就等于凭空消失，而且不留任何日志。这是"球整颗不见了"的候选路径之一。
       */
      const vx = isFinite(v.x) ? v.x : 0;
      const vy = isFinite(v.y) ? v.y : 0;
      const px = isFinite(rp.x) ? rp.x : (isFinite(bp.x) ? bp.x : 0);
      const py = isFinite(rp.y) ? rp.y : (isFinite(bp.y) ? bp.y : 0);
      if (vx !== v.x || vy !== v.y || px !== rp.x || py !== rp.y) shapeBad++;
      const sp = Math.sqrt(vx * vx + vy * vy);
      const stretch = Math.min(0.16, sp / 14000);
      const grow = Math.min(1.5, 1 + (b.squash || 0) + stretch);
      const visR = (b.r || cfg.ballRadius) * grow;
      const lead = sp * leadFrames;
      const rad = Math.min(4000, Math.ceil(Math.max(grab, visR + GRAB_PAD) + lead));
      shape.circles.push([Math.round(px), Math.round(py), rad]);
    }
    if (shapeBad > 0 && !shapeBadLogged) {
      shapeBadLogged = true;
      // console 会被主进程的 console-message 钩子转写进 runtime.log（前缀 [renderer:N]）
      console.warn('SHAPEBAD 出现非有限球位/速度 n=' + shapeBad + '（已按 0 处理）');
    }
    // 走廊：把「球心 → 指针」整段用一个盒子罩住（**仅** --drag-test 的 A/B 对照用，
    // 默认不开。开着的代价见上面的反面教材）。
    if (bench.region === 'corridor' && drag && world.dragTarget) {
      const b = drag.ball.body.position;
      const tx = world.dragTarget.x, ty = world.dragTarget.y;
      const pad = 96;
      const x0 = Math.round(Math.min(b.x, tx) - pad);
      const y0 = Math.round(Math.min(b.y, ty) - pad);
      shape.rects.push([x0, y0,
        Math.round(Math.max(b.x, tx) + pad) - x0,
        Math.round(Math.max(b.y, ty) + pad) - y0]);
    }
    const brs = barRects();
    for (let i = 0; i < brs.length; i++) shape.rects.push(brs[i]);
    const mr = menuRect();
    if (mr) shape.rects.push(mr);
    // 记分板：DOM 也必须进区域，否则 SetWindowRgn 直接把它裁掉（真机上"看不见"）
    const hr2 = hudRect();
    if (hr2) shape.rects.push(hr2);
    // 篮球架必须一直在区域里，否则被 SetWindowRgn 裁掉（见 hoopRects 注释）
    const hr = hoopRects();
    for (let i = 0; i < hr.length; i++) shape.rects.push(hr[i]);
    // ⚠️ 下面三样以前全都漏了，是"面板看不见 / 特效缺一块 / 点了没反应"的根因：
    //   性能面板、提示气泡（都是 DOM）、以及画在 canvas 上的飘字与火花。
    // SetWindowRgn 的区域就是可见范围 —— 画上去但不在区域里的东西一律不显示，
    // 无论是 DOM 还是 canvas。新增任何常驻/临时 UI 时，**这里必须同步加一行**。
    const pr = perfRect();
    if (pr) shape.rects.push(pr);
    const tr = toastRect();
    if (tr) shape.rects.push(tr);
    const fr = fxRects();
    for (let i = 0; i < fr.length; i++) shape.rects.push(fr[i]);

    const json = JSON.stringify(shape);
    if (json === lastShapeSent && !force) return;
    lastShapeSent = json;
    // ⚠️ 时间戳必须在 JSON.stringify **之后**才挂上：它每帧都不同，若参与去重，
    // 形状去重会永久失效（静止时也每帧发一条 IPC）。见 lagProbe 的注释。
    if (lagProbe) shape._t = Date.now();
    // 夹具用：把"真的发出去的那一份"留档，好让 __pbFlyRunner('state') 直接报出
    // 区域圆半径，不必靠截图反推（截图只能量到"区域 ∩ 球盘"，两者混在一起）。
    lastSentShape = shape;
    lockState = false;
    if (sync && window.dbb.shapeSync) window.dbb.shapeSync(shape, false);
    else window.dbb.shape(shape, false);
  }

  // ================================================================== 输入
  function setupDrag(ball, e) {
    drag = {
      ball,
      id: e.pointerId,
      sx: e.clientX, sy: e.clientY,
      pts: [],
      moved: false,
      downT: performance.now(),
    };
    pushPoint(e.clientX, e.clientY, drag.downT);
    world.beginDrag(ball, e.clientX, e.clientY);
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
    // 同步上报：区域要先就位再让指针动起来。现在拖拽不再整窗放开（见 sendShape
    // 的"拖拽走廊"），但走廊盒子必须在本帧的 pointermove 之前生效。
    sendShape(true, true);
    wake();
  }

  function pushPoint(x, y, t) {
    drag.pts.push({ x, y, t });
    while (drag.pts.length > 2 && t - drag.pts[0].t > 110) drag.pts.shift();
  }

  function recentVelocity() {
    if (!drag || drag.pts.length < 2) return { x: 0, y: 0 };
    const a = drag.pts[0];
    const b = drag.pts[drag.pts.length - 1];
    let dt = (b.t - a.t) / 1000;
    if (dt < 0.008) {
      // 采样太密，取最后两点
      const c = drag.pts[drag.pts.length - 2];
      dt = (b.t - c.t) / 1000;
      if (dt < 0.004) return { x: 0, y: 0 };
      return { x: (b.x - c.x) / dt, y: (b.y - c.y) / dt };
    }
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  function bindInput() {
    const onDown = (e) => {
      wake();
      if (sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
      const x = e.clientX, y = e.clientY;

      if (menuOpen) {
        const r = menuEl.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
        closeMenu();
        return;
      }
      // 控制栏（左右两组）：落在按钮上就直接交给按钮自己处理，
      // 不能让 pointerdown 走到「挑选篮球」，否则按 + 会顺带抓起一颗球。
      if (cfg && cfg.showControlBar !== false) {
        let onBar = false;
        for (const el of barEls) {
          const br = el.getBoundingClientRect();
          if (br.width && x >= br.left - 3 && x <= br.right + 3 &&
              y >= br.top - 3 && y <= br.bottom + 3) { onBar = true; break; }
        }
        if (onBar) return; // 交给按钮自己处理
      }

      if (e.button === 2) {
        e.preventDefault();
        openMenu(x, y);
        return;
      }
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const ball = world.pick(x, y, GRAB_PAD);
      if (!ball) return;
      e.preventDefault();
      setupDrag(ball, e);
    };

    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      const t = performance.now();
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length) {
        for (let i = 0; i < list.length; i++) pushPoint(list[i].clientX, list[i].clientY, t);
      }
      pushPoint(e.clientX, e.clientY, t);
      const v = recentVelocity();
      world.moveDrag(e.clientX, e.clientY, v.x, v.y);
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
      wake();
    };

    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const v = recentVelocity();          // px/s
      const body = world.endDrag();
      const quick = performance.now() - drag.downT < 240;
      if (body) {
        let vx = v.x * cfg.throwGain;      // px/s
        let vy = v.y * cfg.throwGain;
        const sp = Math.hypot(vx, vy);
        if ((!drag.moved && quick && sp < 420) || sp < 90) {
          vx = 0; vy = 0;
        } else {
          const lim = cfg.maxThrowSpeed;
          if (sp > lim) { vx = (vx / sp) * lim; vy = (vy / sp) * lim; }
        }
        // px/s → Matter 的「像素/步」
        const vxs = PB.V(vx), vys = PB.V(vy);
        M.Sleeping.set(body, false);
        M.Body.setVelocity(body, { x: vxs, y: vys });
        M.Body.setAngularVelocity(body, Math.max(-0.85, Math.min(0.85, vxs * 0.02)));
      }
      drag = null;
      try { e.target.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      lockState = false;
      sendShape(true);
      wake();
    };

    window.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
    window.addEventListener('pointercancel', onUp, { passive: false });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('selectstart', (e) => e.preventDefault());
    window.addEventListener('dragstart', (e) => e.preventDefault());
    window.addEventListener('mousedown', (e) => { if (e.button !== 2) e.preventDefault(); });
    window.addEventListener('dblclick', (e) => e.preventDefault());

    // 控制栏：左右两组各自绑定 设置 / + / −，悬停变亮，其余时间保持常显。
    // ⚠️ 之前有「5 秒后自动降到 opacity .13」的淡出，那个透明度 + 深色半透明底
    // 铺在桌面上几乎等于隐形，用户会直接报成"按钮不见了"。加/减球是高频操作，
    // 宁可一直显眼，也不为了"不打扰"而隐身。
    for (const el of barEls) {
      const add = el.querySelector('.add');
      const del = el.querySelector('.del');
      const cfgBtn = el.querySelector('.cfg');
      if (add) {
        add.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); addBall(); });
        add.addEventListener('contextmenu', (e) => e.preventDefault());
      }
      if (del) {
        del.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); removeBall(); });
        del.addEventListener('contextmenu', (e) => e.preventDefault());
      }
      if (cfgBtn) {
        // 设置入口 = 打开与右键完全相同的那个菜单（menuModel 是唯一一份设置清单，
        // 不另起一套，避免两条设置路径日后不同步）。
        // ⚠️ 必须 stopPropagation：否则这次 pointerdown 会继续冒泡到 window 的 onDown，
        //    被当成"挑选篮球"，在按钮旁顺带抓起一颗球。
        // 锚点取按钮上沿：菜单优先向下展开，随即被 openMenu 的边界钳制顶到按钮上方，
        // 因此左/右下角的按钮都不会被菜单盖住，小窗也放得下。
        // 锚点取按钮上沿、并要菜单**向上翻**：菜单比按钮高得多，向下展开会被
        // 边界钳制一路顶到底边、把自己这个按钮盖掉（见 openMenu 的 preferAbove）。
        cfgBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const r = cfgBtn.getBoundingClientRect();
          openMenu(Math.round(r.left + r.width / 2), Math.round(r.top), true);
        });
        cfgBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      }
      const hot = () => el.classList.add('hot');
      el.addEventListener('pointerenter', hot);
      el.addEventListener('pointermove', hot);
      el.addEventListener('pointerleave', () => el.classList.remove('hot'));
    }
  }

  // ================================================================== 右键菜单
  function menuModel() {
    return [
      { id: 'add', label: '增加一颗篮球', key: 'Ctrl+Shift+↑' },
      { id: 'remove', label: '减少一颗篮球', key: 'Ctrl+Shift+↓' },
      { id: 'throw-all', label: '把所有球抛起来', key: 'Ctrl+Shift+空格' },
      { id: 'reset', label: '清空重来', key: 'Ctrl+Shift+R' },
      { sep: true },
      { id: 'cycle-skin', label: '球皮肤', value: (PB.SKINS[cfg.skin] || PB.SKINS.classic).label },
      { id: 'toggle-golden', label: '金球彩蛋', value: cfg.goldenEnabled !== false ? '开启' : '关闭', on: cfg.goldenEnabled !== false },
      { id: 'toggle-hud', label: '记分板', value: cfg.showHud !== false ? '开启' : '关闭', on: cfg.showHud !== false },
      { id: 'toggle-burst', label: '进球特效', value: cfg.fxBurst !== false ? '开启' : '关闭', on: cfg.fxBurst !== false },
      { id: 'toggle-trail', label: '运动拖尾', value: cfg.trail !== false ? '开启' : '关闭', on: cfg.trail !== false },
      { id: 'cycle-trailstyle', label: '拖尾样式', value: cfg.trailStyle === 'ghost' ? '残影' : '火焰' },
      { id: 'achievements', label: '成就', value: achSet.size + '/' + ACHIEVEMENTS.length },
      { sep: true },
      { id: 'toggle-hoop', label: '篮球框', value: cfg.hoopEnabled ? '开启' : '关闭', on: cfg.hoopEnabled },
      { id: 'toggle-sound', label: '音效', value: cfg.soundEnabled ? '开启' : '关闭', on: cfg.soundEnabled },
      { id: 'toggle-ztop', label: '显示在窗口之上', value: cfg.zMode === 'top' ? '开启' : '关闭', on: cfg.zMode === 'top' },
      { id: 'toggle-autostart', label: '开机自启动', value: cfg.autoStart ? '开启' : '关闭', on: cfg.autoStart },
      { id: 'toggle-perf', label: '性能信息', value: cfg.showPerf ? '开启' : '关闭', on: cfg.showPerf },
      { id: 'toggle-bar', label: '快捷控制栏', value: cfg.showControlBar !== false ? '开启' : '关闭', on: cfg.showControlBar !== false },
      { sep: true },
      { id: 'quit', label: '退出程序' },
    ];
  }

  /**
   * 打开右键菜单。
   *
   * ⚠️ 顺序至关重要：菜单是 DOM 画出来的，窗口的 SetWindowRgn 区域是另一条流水线。
   * 如果先把菜单显示出来、再异步去改窗口区域，则菜单会先以「上一次的区域」
   * （= 一串球圆盘）被裁切，边缘出现半圆形缺口。
   * 所以这里：先 layout（visibility:hidden，不产生任何像素）→ 量尺寸 → 摆位置
   *         → **同步**把窗口区域改成整窗 → 最后才 visibility:visible。
   *
   * @param {number} x 锚点 x
   * @param {number} y 锚点 y
   * @param {boolean} [preferAbove] 优先向**上**展开（控制栏的 ⚙ 用）。
   *   不给就保持旧的"向下展开"语义（右键菜单）。
   *   ⚠️ 为什么需要它：菜单有 20+ 项、高约 700px，而窗口区域里 `my` 的钳制是
   *   "贴到屏幕底部"（`H - h - 6`）。控制栏 ⚙ 就在底部，向下展开会被钳成
   *   从底往上铺 → **菜单正好压住它自己的按钮**，用户没法再点一次收起来。
   *   改成先按"上沿 = 锚点 - 高度"上翻，再统一钳进窗口，就谁都不压谁。
   */
  function openMenu(x, y, preferAbove) {
    const items = menuModel();
    let html = '';
    for (const it of items) {
      if (it.sep) { html += '<div class="sep"></div>'; continue; }
      const val = it.value !== undefined
        ? '<span class="v">' + it.value + '</span>'
        : (it.key ? '<span class="k">' + it.key + '</span>' : '');
      html += '<div class="mi' + (it.value !== undefined ? (it.on ? ' on' : ' off') : '') +
              '" data-id="' + it.id + '"><span>' + it.label + '</span>' + val + '</div>';
    }
    menuEl.innerHTML = html;
    menuEl.style.visibility = 'hidden';
    menuEl.style.display = 'block';
    const r = menuEl.getBoundingClientRect();
    let mx = x + 2;
    // 水平：默认向右展开，右边放不下就翻到锚点左侧（两种屏幕尺寸下都不出界）。
    if (mx + r.width > W - 6) mx = Math.max(6, x - r.width - 2);
    // 垂直：preferAbove 时先上翻，再统一钳进 [6, H-6-h]；越界时至少保证贴边可见。
    let my = preferAbove ? y - r.height - 2 : y + 2;
    my = Math.max(6, Math.min(my, H - 6 - r.height));
    menuEl.style.left = mx + 'px';
    menuEl.style.top = my + 'px';

    menuOpen = true;
    menuAnchor = { x, y };
    sendShape(true, true);          // 同步：区域先就位
    menuEl.style.visibility = 'visible';   // 再露面
    wake();
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.style.display = 'none';
    menuEl.style.visibility = 'visible';
    menuEl.innerHTML = '';
    lockState = false;
    sendShape(true);
    wake();
  }

  function bindMenuEvents() {
    menuEl.addEventListener('pointerdown', (e) => {
      const el = e.target.closest ? e.target.closest('.mi') : null;
      if (!el) return;
      e.stopPropagation();
      e.preventDefault();
      const id = el.getAttribute('data-id');
      closeMenu();
      doAction(id);
    });
  }

  // ================================================================== 动作
  function doAction(id) {
    wake();
    switch (id) {
      case 'add': addBall(); break;
      case 'remove': removeBall(); break;
      case 'throw-all': throwAll(); break;
      case 'reset': resetGame(); break;
      case 'cycle-skin': {
        const order = PB.SKIN_ORDER;
        const i = order.indexOf(cfg.skin);
        cfg.skin = order[(i + 1) % order.length];
        renderer.setSkin(cfg.skin);
        renderer.invalidateAll();          // 全套球都换了外观，整层重画
        // 素材皮肤此刻多半还没解码（按需取，见 ensureSkinTexture）——先画程序化外观，
        // 素材到位后回调会重烘。不阻塞切换动作，视觉上就是"立刻变色，随后变清晰"。
        ensureSkinTexture(cfg.skin);
        window.dbb.patchConfig({ skin: cfg.skin });
        toast('球皮肤：' + PB.SKINS[cfg.skin].label);
        /**
         * 除了底部气泡，再在**球旁边**画一条飘字。
         *
         * 理由不是"好看"：换皮肤的用户视线在球上，而气泡固定在屏幕底部中央 ——
         * 一旦气泡那份反馈的可见性再出问题（踩过一次，见 toastRect/fxRects），
         * 用户就会得出"皮肤功能根本用不了"的结论。飘字跟着球走，视线在哪里反馈就在哪里。
         * 它同样要走窗口区域，所以和加分特效一起被 fxRects 上报。
         */
        const b0 = world.balls[0];
        if (b0) {
          fx.texts.push({
            text: '球皮肤：' + PB.SKINS[cfg.skin].label,
            x: b0.body.position.x, y: b0.body.position.y - 48,
            a: 1, vy: -26, size: 15, color: '#bfe9ff', life: 1100, t: 0,
          });
        }
        unlock('style');
        wake();
        break;
      }
      case 'toggle-golden': {
        const on = cfg.goldenEnabled === false;
        cfg.goldenEnabled = on;
        window.dbb.patchConfig({ goldenEnabled: on });
        if (on) scheduleGolden();
        else clearGolden();
        toast('金球彩蛋 ' + (on ? '开启' : '关闭'));
        break;
      }
      case 'toggle-hud': {
        const show = cfg.showHud === false;
        cfg.showHud = show;
        if (hudEl) hudEl.classList.toggle('hide', !show);
        window.dbb.patchConfig({ showHud: show });
        sendShape(true);   // 区域要同步收缩/张开，否则隐藏后留下一块死区
        toast('记分板 ' + (show ? '已显示' : '已隐藏'));
        break;
      }
      case 'toggle-burst': {
        const on = cfg.fxBurst === false;
        cfg.fxBurst = on;
        window.dbb.patchConfig({ fxBurst: on });
        // 关掉只是不再**生成**新特效；已经在飞的那批任其自然消亡（不必强杀，
        // 它们最多再活 1~2 秒，强行清空反而会有"啪一下全没了"的突兀感）。
        toast('进球特效 ' + (on ? '开启' : '关闭'));
        break;
      }
      case 'toggle-trail': {
        const on = cfg.trail === false;
        cfg.trail = on;
        renderer.setTrail(on);
        /**
         * 关掉时必须**同时**清掉已经存在的残影像素，否则它们会冻在画布上直到下次重画。
         * 两步：① 抹掉每颗球的位置历史；② 整层无效化 + 主动醒一帧。
         * 只做 ① 不做 ② 的话，那几帧残影会一直留着 —— 因为主循环只有在"有球动"时才重绘。
         */
        if (!on) {
          for (let i = 0; i < world.balls.length; i++) {
            const b = world.balls[i];
            if (b._trail) b._trail.length = 0;
          }
          renderer.invalidateAll();
          sendShape(true);
          wake();
        }
        window.dbb.patchConfig({ trail: on });
        toast('运动拖尾 ' + (on ? '开启' : '关闭'));
        break;
      }
      case 'cycle-trailstyle': {
        /**
         * 火焰 ↔ 残影。两种样式的**几何完全不同**，换完必须整层重画：
         * 只改 `renderer.trailStyle` 是不够的 —— 上一帧的火焰像素没有任何东西会去擦，
         * 而主循环只在"有球动"时才重绘（见 toggle-trail 的注释）。
         */
        const next = cfg.trailStyle === 'ghost' ? 'fire' : 'ghost';
        cfg.trailStyle = next;
        renderer.setTrailStyle(next);
        for (let i = 0; i < world.balls.length; i++) {
          const b = world.balls[i];
          if (b._trail) b._trail.length = 0;
        }
        renderer.invalidateAll();
        sendShape(true);
        wake();
        window.dbb.patchConfig({ trailStyle: next });
        toast('拖尾样式：' + (next === 'ghost' ? '残影' : '火焰'));
        break;
      }
      case 'achievements': {
        // 直接在画布上列出全部成就（用 canvas 而不是新弹层：不额外驻留 DOM 节点）
        // ⚠️ 但**画布同样受窗口区域裁剪** —— 早先这里写着"不用再往窗口区域里加东西"，
        // 那是错的：整块成就列表在真机上根本不可见。现在 sendShape 会把 fx.texts 的
        // 包围盒一起上报（见 fxRects），列表才会真的显示出来。
        const top = Math.max(84, H * 0.15);
        fx.texts.push({
          text: '成就 ' + achSet.size + ' / ' + ACHIEVEMENTS.length, x: W / 2, y: top,
          a: 1, vy: 0, size: 18, color: '#ffe28a', life: 3400, t: 0,
        });
        for (let i = 0; i < ACHIEVEMENTS.length; i++) {
          const a = ACHIEVEMENTS[i];
          const got = achSet.has(a.id);
          fx.texts.push({
            text: (got ? a.icon : '🔒') + '  ' + a.name, x: W / 2, y: top + 28 + i * 20,
            a: got ? 0.96 : 0.5, vy: 0, size: 13,
            color: got ? '#d9f7c8' : 'rgba(255,255,255,0.6)', life: 3400, t: 0,
          });
        }
        wake();
        break;
      }
      case 'toggle-hoop': {
        cfg.hoopEnabled = !cfg.hoopEnabled;
        world.setHoop(cfg.hoopEnabled);
        window.dbb.patchConfig({ hoopEnabled: cfg.hoopEnabled });
        toast('篮球框 ' + (cfg.hoopEnabled ? '开启' : '关闭'));
        break;
      }
      case 'toggle-sound': {
        cfg.soundEnabled = !cfg.soundEnabled;
        sfx.setEnabled(cfg.soundEnabled);
        window.dbb.patchConfig({ soundEnabled: cfg.soundEnabled });
        toast('音效 ' + (cfg.soundEnabled ? '开启' : '关闭'));
        break;
      }
      case 'toggle-autostart': {
        cfg.autoStart = !cfg.autoStart;
        window.dbb.setAutoStart(cfg.autoStart);
        toast('开机自启动 ' + (cfg.autoStart ? '开启' : '关闭'));
        break;
      }
      case 'toggle-ztop': {
        // 两档互斥：'top' = 显示在所有普通窗口与任务栏之上；'desktop' = 贴回桌面层。
        // 主进程收到 patchConfig 后会立即重排 z 序（不需要重启），并刷新托盘的单选项。
        const top = cfg.zMode !== 'top';
        cfg.zMode = top ? 'top' : 'desktop';
        window.dbb.patchConfig({ zMode: cfg.zMode });
        toast(top ? '已置顶：显示在所有窗口之上' : '已贴回桌面层：被普通窗口盖住');
        break;
      }
      case 'toggle-perf': {
        cfg.showPerf = !cfg.showPerf;
        perfEl.style.display = cfg.showPerf ? 'block' : 'none';
        window.dbb.patchConfig({ showPerf: cfg.showPerf });
        // 面板必须立刻进/出窗口区域，否则"开了也看不见"（见 perfRect 注释）
        sendShape(true);
        toast('性能信息 ' + (cfg.showPerf ? '已显示' : '已隐藏'));
        break;
      }
      case 'toggle-bar': {
        // ⚠️ 原来托盘里有这个菜单项，但渲染进程根本没实现它 —— 点了没反应。
        // 控制栏既影响绘制、又影响窗口区域（barRects），所以要同步重报一次形状，
        // 否则隐藏后那两块会留下"能点但看不见"的死区。
        const show = cfg.showControlBar === false;
        cfg.showControlBar = show;
        for (const el of barEls) el.style.display = show ? '' : 'none';
        window.dbb.patchConfig({ showControlBar: show });
        sendShape(true);
        toast('快捷控制栏 ' + (show ? '已显示' : '已隐藏'));
        break;
      }
      case 'quit': persistBalls(); window.dbb.quit(); break;
    }
  }

  function onAction(a) {
    if (!a) return;
    if (a.type === 'sync-state') { Object.assign(cfg, a); return; }
    if (a.type === 'toast') { toast(a.text); return; }
    if (a.type === 'before-quit') { persistBalls(); return; }
    doAction(a.type);
  }

  // ================================================================== 杂项
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    // 气泡是 DOM，不进窗口区域就根本看不见（它是唯一的操作反馈，少了它"点了没反应"）。
    // 显示/消失都要重报一次：消失那次不报的话，屏幕上会留下一块"能点但点不进桌面"的死区。
    sendShape(true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      sendShape(true);
    }, 1500);
  }

  function persistBalls() {
    const states = world.balls.map((b) => [
      Math.round(b.body.position.x), Math.round(b.body.position.y),
    ]);
    const json = JSON.stringify(states);
    if (json === lastBallSnapshot) return;
    lastBallSnapshot = json;
    window.dbb.saveBalls(states);
  }

  function updatePerf(now, idle) {
    if (now - lastPerfAt < 250) return;
    const elapsed = now - fpsAt;
    const sec = elapsed / 1000;
    fps = sec > 0 ? frames / sec : 0;
    loopHz = sec > 0 ? loopCount / sec : 0;
    stepHz = sec > 0 ? stepCount / sec : 0;
    // ---- 呈现节拍：真的画出去的帧之间的间隔（见 presentHz 那一组变量）
    presentHz = sec > 0 ? presentN / sec : 0;
    if (presentGaps.length) {
      const gs = presentGaps.slice().sort((a, b) => a - b);
      presentP50 = gs[gs.length >> 1];
      presentP95 = gs[Math.min(gs.length - 1, Math.floor(gs.length * 0.95))];
      presentJitter = presentP95 - presentP50;
    } else {
      presentP50 = 0; presentP95 = 0; presentJitter = 0;
    }
    frames = 0;
    loopCount = 0;
    stepCount = 0;
    presentN = 0;
    presentGaps.length = 0;
    fpsAt = now;
    lastPerfAt = now;
    const stallN = presentStalls;
    const maxGap = presentMaxGap;
    presentStalls = 0;
    presentMaxGap = 0;
    if (!cfg.showPerf) return;
    const s = world.stats;
    perfEl.textContent =
      // 「物理」是**步率**（永远接近 60），「呈现」才是肉眼看到的那个节拍 ——
      // 「帧率满但一动一顿」的现场就是这两行数字不对称：物理 60 / 呈现 40 抖动 20ms。
      '物理     ' + fps.toFixed(1) + ' / 60 步' + (idle ? '  (idle 160ms 巡检)' : '') + '\n' +
      '呈现     ' + presentHz.toFixed(1) + ' Hz  中位 ' + presentP50.toFixed(1) +
        'ms  抖动 ' + presentJitter.toFixed(1) + 'ms  卡顿 ' + stallN +
        '  峰 ' + maxGap.toFixed(1) + 'ms\n' +
      // 「屏」这一行是换设备排障的第一现场：刷新率来源、真实节流、插值预算、DRS 档位。
      '节拍     屏 ' + displayHz + 'Hz' + (displayHzSource === 'raf' ? '(实测)' : '') +
        '  ' + (rafPaced === true ? 'rAF/vsync'
        : rafPaced === false ? 'rAF 自由跑' : '探测中') +
        '  节流 ' + rd2(frameMinMs) + 'ms' +
        (renderer.smooth ? '  插值开 预算 ' + rd2(smoothBudgetMs) + 'ms' : '  插值关') +
        (DRS_STEPS[drsIndex] < 1 ? '  DRS ' + DRS_STEPS[drsIndex] + '×' : '') + '\n' +
      // 设备画像：`dpr` 是原始缩放，`实渲` 是夹取后真正建画布用的值（DRS / 像素上限）
      '设备     ' + W + '×' + H + '  dpr ' + rd2(rawDpr) +
        (Math.abs(dpr - rawDpr) > 0.001 ? ' → 实渲 ' + rd2(dpr) + '×' : '') +
        '  画布 ' + Math.round(W * dpr) + '×' + Math.round(H * dpr) +
        '(' + rd2(W * dpr * H * dpr / 1e6) + 'Mpx)\n' +
      '调度     loop ' + loopHz.toFixed(0) + ' Hz   step ' + stepHz.toFixed(0) + ' Hz\n' +
      '球数     ' + world.balls.length + '  活跃 ' + s.awake + '\n' +
      '物理步   ' + s.avgStepMs.toFixed(2) + ' ms  (峰 ' + s.maxStepMs.toFixed(2) + ')' +
        '  每帧 ' + rd2(physMsPerFrame()) + ' ms\n' +
      '碰撞对   ' + s.pairs + '\n' +
      '脏块     ' + renderer.tilesDrawn + '/' + (renderer.tw * renderer.th) +
      '  绘制 ' + renderer.lastDrawMs.toFixed(2) + ' ms 中位 ' + drawMsMedian().toFixed(2) + '\n' +
      '画布调用 ' + renderer.drawCalls + '\n' +
      '得分     ' + world.score + '   最高 ' + world.highScore + '   连击 ×' + (world.combo || 0) + '\n' +
      '皮肤     ' + ((PB.SKINS[cfg.skin] || PB.SKINS.classic).label) +
      '   成就 ' + achSet.size + '/' + ACHIEVEMENTS.length +
      '   金球 ' + (world.balls.some((b) => b.golden) ? '有' : '无');
    if (fps < 30) s.maxStepMs = 0;
  }

  // ================================================================== 诊断 / 压测钩子
  window.__pbDiag = function () {
    return {
      w: W, h: H, dpr: dpr,
      // ---- 设备画像 / 节拍：换设备、换刷新率、白板投屏排障的"第一现场" ----
      //  `dpr` 是实渲用的（过了 DRS 与像素上限），`rawDpr` 是窗口真实缩放，两者不同即有夹取。
      rawDpr: rd2(rawDpr),
      backingMpx: rd2(W * dpr * H * dpr / 1e6),
      backingCapMpx: MAX_BACKING_MPX,
      displayHz: displayHz,
      displayHzReported: displayHzReported,
      displayHzSource: displayHzSource,
      rafHz: rafHzMeasured,
      displayPeriod: rd2(displayPeriod),
      frameMinMs: rd2(frameMinMs),
      rafPaced: rafPaced,
      smoothBudgetMs: rd2(smoothBudgetMs),
      physMsFrame: rd2(physMsPerFrame()),
      drawMsMedian: rd2(drawMsMedian()),
      renderScale: DRS_STEPS[drsIndex],
      dynScale: cfg.dynScale !== false,
      balls: world.balls.length,
      pos: world.balls.slice(0, 50).map((b) => [
        Math.round(b.body.position.x), Math.round(b.body.position.y), b.body.isSleeping ? 1 : 0,
        Math.round(PB.V_INV(b.body.velocity.x)), Math.round(PB.V_INV(b.body.velocity.y)),
      ]),
      fps: Math.round(fps * 10) / 10,
      loopHz: Math.round(loopHz * 10) / 10,
      stepHz: Math.round(stepHz * 10) / 10,
      physMs: Math.round(world.stats.avgStepMs * 100) / 100,
      physMaxMs: Math.round(world.stats.maxStepMs * 100) / 100,
      drawMs: Math.round(renderer.lastDrawMs * 100) / 100,
      tiles: renderer.tilesDrawn,
      tilesTotal: renderer.tw * renderer.th,
      drawCalls: renderer.drawCalls,
      mip: renderer.mipExact + '/' + renderer.mipHead,
      pairs: world.stats.pairs,
      hoop: !!cfg.hoopEnabled,
      score: world.score,
      highScore: world.highScore,
      combo: world.combo || 0,
      maxBalls: cfg.maxBalls,
      skin: renderer.skin,
      texCache: renderer.texCache.size,
      achievements: achSet.size,
      achievementList: Array.from(achSet),
      goldenBalls: world.balls.filter((b) => b.golden).length,
      // 视觉特效（§2.13）：验收要能直接看到"生成了几圈光环 / 几粒火花 / 几个残影"
      fxBurst: cfg.fxBurst !== false,
      fxRings: fx.rings.length,
      fxParts: fx.particles.length,
      fxCalls: fxRects().length,
      trailOn: renderer.trailOn,
      trailStyle: renderer.trailStyle,
      trailBalls: world.balls.filter((b) => b._trail && b._trail.length > 1).length,
      hud: hudRect(),
      idle: isIdle(),
      wakeLatMs: Math.round(lastWakeLatency * 100) / 100,
      menuOpen: !!menuOpen,
      menu: menuOpen ? menuRect() : null,
      dragging: !!drag,
      dragTarget: world.dragTarget
        ? [Math.round(world.dragTarget.x), Math.round(world.dragTarget.y)] : null,
      draggedBall: drag ? [Math.round(drag.ball.body.position.x), Math.round(drag.ball.body.position.y)] : null,
      scheduled: scheduled,
      shapeLocked: lockState,
      bars: barRects(),
      draws: drawCount,
      drawMsTotal: Math.round(drawMsTotal * 10) / 10,
      drawMsAvg: drawCount ? Math.round((drawMsTotal / drawCount) * 1000) / 1000 : 0,
      /**
       * 主循环**自身**的平均开销（不含 renderer.frame 的绘制）：
       * `snapshotPrev` + `world.step` + `updateFx` + `sendShape` + 调度。
       * 存在的理由：`drawMs` 便宜、`physMs` 也便宜，`presentHz` 却只有 22 时，
       * 必须能一眼看出时间到底花在哪一段 —— 别再把"合成/调度慢"读成"绘制慢"。
       */
      loopMsAvg: iterCount ? Math.round((loopMsTotal / iterCount) * 1000) / 1000 : 0,
      iterCount: iterCount,
      loops: loopCount,
      steps: stepCount,
      frameCapMs: Math.round(frameMinMs * 100) / 100,
      // ---- 帧同步 / 呈现节拍（见 app.js 顶部 presentHz 与 render.js::smooth）----
      displayHz: displayHz,
      smooth: renderer.smooth,
      smoothBudgetMs: Math.round(smoothBudgetMs * 100) / 100,
      drawMsMedian: Math.round(drawMsMedian() * 100) / 100,
      alpha: Math.round(renderer.alpha * 1000) / 1000,
      rafPaced: rafPaced,
      presentHz: Math.round(presentHz * 10) / 10,
      presentP50Ms: Math.round(presentP50 * 100) / 100,
      presentP95Ms: Math.round(presentP95 * 100) / 100,
      presentJitterMs: Math.round(presentJitter * 100) / 100,
      presentStalls: presentStalls,
      presentTotal: presentTotal,
      presentStallTotal: presentStallTotal,
      // 0 号球：物理位置 vs 画面位置（插值后）——两者不等就说明插值真的在起作用
      ball0: world.balls[0] ? {
        bx: Math.round(world.balls[0].body.position.x * 100) / 100,
        by: Math.round(world.balls[0].body.position.y * 100) / 100,
        px: world.balls[0]._px === undefined ? null : Math.round(world.balls[0]._px * 100) / 100,
        py: world.balls[0]._py === undefined ? null : Math.round(world.balls[0]._py * 100) / 100,
        rx: world.balls[0].rx === undefined ? null : Math.round(world.balls[0].rx * 100) / 100,
        ry: world.balls[0].ry === undefined ? null : Math.round(world.balls[0].ry * 100) / 100,
        rep: (lastSentShape && lastSentShape.circles[0]) || null,
      } : null,
      hoops: currentHoop ? { cx: Math.round(currentHoop.cx || 0), rimY: Math.round(currentHoop.rimY || 0), on: !!currentHoop.enabled } : null,
      // 篮球架的窗口区域矩形 —— 供 region-probe / --diag 打点核对
      hoopRects: hoopRects(),
    };
  };
  /**
   * 帧同步验收钩子（见 tools/verify-framesync.js）。
   *
   * 它把"插值渲染到底有没有生效、区域有没有跟着画面走"这两件事变成可直接比对的数字：
   *   · `px/py`（上一步位置）、`bx/by`（物理当前位置）、`rx/ry`（画面位置）
   *     → 恒等式：min(px,bx) ≤ rx ≤ max(px,bx)，且 alpha∈[0,1]。
   *       `rx` 落在两端点之间且不等于任一端点 ⇒ 插值确实在补中间帧。
   *   · `circle0`（最近一次真正上报的区域圆）的圆心 == round(rx,ry)
   *     → 证明区域与画面同口径（否则球会被削角）。
   *   · `presentTotal` 在两次采样之间必须增长 → 证明"确实在出帧"。
   */
  window.__pbFrameState = function () {
    const bs = world.balls.slice(0, 4).map((b) => ({
      bx: b.body.position.x, by: b.body.position.y, ba: b.body.angle,
      px: b._px === undefined ? null : b._px,
      py: b._py === undefined ? null : b._py,
      rx: b.rx === undefined ? null : b.rx,
      ry: b.ry === undefined ? null : b.ry,
      ra: b.ra === undefined ? null : b.ra,
      sleeping: !!b.body.isSleeping,
      // 速度（px/步）。验收时"球到底动没动"要靠它，而不是靠猜两个采样点之差 ——
      // 反复踩过：位置没变既可能是"没步进"，也可能是"速度被物理后处理清零"。
      vx: Math.round(b.body.velocity.x * 1000) / 1000,
      vy: Math.round(b.body.velocity.y * 1000) / 1000,
      /**
       * 落地挤压余量。**它是"位置没变但画面会变"的唯一来源**：
       * `drawBall` 用 `s = squash + stretch` 同时决定①贴图档位（`s > 0.006` → head）
       * ②是否施加形变变换；而 `squash` **只在 `world.step()` 里衰减**（physics.js 尾部），
       * 空闲期主循环不步进 ⇒ 它会冻在原值。
       *
       * 严重性：`bindCollisions` 里只要 `relSpeed > 105`（s > 0.07）就置
       * `squash = 0.08 + s*0.26` —— 哪怕极轻的一碰也是 0.098（9.8% 形变，肉眼可见）。
       * 若球在这点余量还没衰减完就入睡，它就会**一直以压扁的样子留在桌面上**，
       * 直到别的球动起来才"啪"地弹回圆形（`verify-render` 的休眠球像素保留判据抓到的
       * 就是这个：一次 +37px 的跳变）。
       */
      sq: Math.round((b.squash || 0) * 1000) / 1000,
      asleepTimer: b.body.sleepCounter || 0,
    }));
    const b0 = bs[0] || null;
    return {
      smooth: renderer.smooth,
      alpha: Math.round(renderer.alpha * 1000) / 1000,
      displayHz: displayHz,
      /** 主进程报的原始刷新率；0 = 没报（部分虚拟显示驱动/白板会给 0） */
      displayHzReported: displayHzReported,
      /** 'reported' | 'raf' | 'default' —— "屏幕上显示的 Hz 到底哪来的" */
      displayHzSource: displayHzSource,
      rafHz: rafHzMeasured,
      displayPeriod: rd2(displayPeriod),
      frameMinMs: rd2(frameMinMs),
      rafPaced: rafPaced,
      // 插值补帧预算（= 屏周期 × 0.75 − 实测物理耗时，见 SMOOTH_LOAD_FRAC）
      smoothBudgetMs: rd2(smoothBudgetMs),
      smoothBudgetMinMs: SMOOTH_BUDGET_MIN_MS,
      smoothBudgetCapMs: SMOOTH_BUDGET_CAP_MS,
      smoothLoadFrac: SMOOTH_LOAD_FRAC,
      /** 每帧必须花的物理时间（ms）—— 就是预算里被减掉的那一项（见 refreshSmoothBudget） */
      physMsFrame: rd2(physMsPerFrame()),
      /** 上面那个均值采样了多少个"呈现帧"；窗口还没填满时它的置信度不够（见 __pbPerfReset） */
      physFrames: physFrameWin.length,
      drawMsMedian: rd2(drawMsMedian()),
      /**
       * 设备画像。2K 希沃白板这类"换设备"问题必须先能读到它：
       * `w×h` 是 CSS 像素，`backing` = `w·dpr × h·dpr` 才是**真正的画布像素数** ——
       * 一次整帧绘制的成本正比于它。2K 屏带 125% 缩放时画布是 3200×1800（5.8M px），
       * 是默认 1440×852（1.2M px）的近 5 倍，这才是"在别人机器上卡"的量级差。
       */
      device: {
        w: W, h: H, dpr: dpr,
        /** 窗口真实缩放（未夹取）。与 `dpr` 不同 ⇒ 说明 DRS 或像素上限介入了。 */
        rawDpr: rd2(rawDpr),
        backingW: Math.round(W * dpr), backingH: Math.round(H * dpr),
        backingMpx: rd2(W * dpr * H * dpr / 1e6),
        capMpx: MAX_BACKING_MPX,
      },
      // ---- 动态渲染分辨率（DRS，见 drsTick）----
      renderScale: DRS_STEPS[drsIndex],
      renderScaleSteps: DRS_STEPS.slice(),
      renderScaleForce: renderScaleForce,
      drsVotes: [drsDownVotes, drsUpVotes],
      dynScale: cfg.dynScale !== false,
      scheduled: scheduled,
      presentHz: Math.round(presentHz * 10) / 10,
      presentP50Ms: Math.round(presentP50 * 100) / 100,
      presentP95Ms: Math.round(presentP95 * 100) / 100,
      presentJitterMs: Math.round(presentJitter * 100) / 100,
      presentStalls: presentStalls,
      presentTotal: presentTotal,
      presentStallTotal: presentStallTotal,
      // 区域圆：最近一次真正发出去的 0 号球圆（与画面位置同口径）
      circle0: (lastSentShape && lastSentShape.circles[0]) || null,
      ball: b0,
      balls: bs,
    };
  };
  /**
   * 唤醒延迟探针：只在「已经完全空闲」时才有意义。
   * 量的是 wake() 被调用 → 主循环真正开始处理 之间的间隔。
   * 修复前空闲期挂的是 setTimeout(160)，事件来了要等最多 160ms 才被处理。
   */
  window.__pbWakeLatency = function (rounds) {
    return new Promise((resolve) => {
      if (!isIdle()) { resolve({ idle: false }); return; }
      const n = Math.max(1, rounds || 5);
      const xs = [];
      let i = 0;
      const once = () => {
        if (i++ >= n) {
          xs.sort((a, b) => a - b);
          resolve({
            idle: true, samples: n,
            avgMs: Math.round((xs.reduce((a, b) => a + b, 0) / n) * 100) / 100,
            maxMs: Math.round(xs[n - 1] * 100) / 100,
            p50Ms: Math.round(xs[Math.floor(n / 2)] * 100) / 100,
          });
          return;
        }
        wake();
        setTimeout(() => { xs.push(lastWakeLatency); once(); }, 400);
      };
      once();
    });
  };
  window.__pbAddBalls = function (n) {
    for (let i = 0; i < n; i++) addBall();
    return world.balls.length;
  };
  window.__pbSetBalls = function (n) {
    while (world.balls.length > n) removeBall();
    while (world.balls.length < n) addBall();
    return world.balls.length;
  };
  window.__pbToggleHoop = function () { doAction('toggle-hoop'); return cfg.hoopEnabled; };
  /** 验收用：运行时开关「运动平滑（插值渲染）」，用来做前后对照（见 verify-framesync.js）。 */
  window.__pbSmooth = function (on) {
    cfg.smooth = on !== false;
    renderer.setSmooth(cfg.smooth);
    renderer.invalidateAll();
    wake();
    return renderer.smooth;
  };
  /**
   * 验收用：**强制**按指定刷新率重算节拍，返回生效的插值补帧预算（ms）。
   *
   * 存在的理由：这台开发机可能只有一种刷新率，而"2K 希沃白板 @60Hz"那类问题恰恰
   * 要靠**换屏幕参数**才复现得出来。有了它，夹具就能在同一台机器上验证
   * 「预算跟着屏周期缩放」这条判据，而不必真的插一块 2K 屏。
   * 会顺带把 `rafPaced` 结论作废重探（和真实换屏走的是同一条路，见 applyDisplayHz）。
   */
  window.__pbDisplayHz = function (hz) {
    applyDisplayHz(hz);
    return {
      hz: displayHz,
      reported: displayHzReported,
      source: displayHzSource,
      period: rd2(displayPeriod),
      frameMinMs: rd2(frameMinMs),
      smoothBudgetMs: rd2(smoothBudgetMs),
      physMsFrame: rd2(physMsPerFrame()),
      physFrames: physFrameWin.length,
      loadFrac: SMOOTH_LOAD_FRAC,
      minMs: SMOOTH_BUDGET_MIN_MS,
      capMs: SMOOTH_BUDGET_CAP_MS,
    };
  };
  /**
   * 验收用：**清空性能测量窗口**，让接下来的断言只基于"当前这一帧的负载"。
   *
   * 存在的理由（2026-10-11 实测坐实）：`physMsPerFrame` / `drawMsMedian` / 呈现抖动都是
   * **滑动窗口**（约 120 个呈现帧）。用户真实配置是 `ballCount=200`，启动那两秒正是
   * "200 颗球一起落下"的最重负载 —— 夹具如果趁窗口还没滚过去就取样，读到的是**启动峰值**：
   * 实测 `physMsFrame` 报到 7.7~16.7ms，而 200 颗球稳态下真实每步只有 1.1~4.2ms。
   * 后果是"60Hz 预算 > 旧常数 6ms"这类判据被环境噪声判负 —— 看着像模型坏了，其实只是尺子错了。
   *
   * 只清窗口，不碰任何行为：切球数 / 换皮肤 / 换分辨率之后想要干净的基线，都该调它。
   */
  window.__pbPerfReset = function () {
    physFrameWin.length = 0; physFrameSum = 0;
    drawCostWin.length = 0;
    drsDownVotes = 0; drsUpVotes = 0;
    presentGaps.length = 0;
    return true;
  };
  /**
   * 验收用：强制渲染缩放档位（DRS），`null` / `'auto'` 交回自动。
   *
   * 存在的理由同 `__pbDisplayHz`：这台开发机只有一种 dpr，而"4K@150% 上画布 830 万像素"
   * 那类问题要靠**喂参数**才复现得出来（配合 `__pbDeviceFit`）。
   */
  /**
   * 验收用：手动触发一次 `resize()`（= 换设备那条路径），返回被夹回场内的球数。
   *
   * 存在的理由：真去插拔显示器才能触发的路径没法在夹具里验，而这个函数会把
   * `dpr → 画布重建 → 球夹回场内 → 区域重报` 整条链走一遍（见 resize）。
   */
  window.__pbResize = function () { return resize(); };
  window.__pbScale = function (s) {
    renderScaleForce = (s === null || s === undefined || s === 0 || s === 'auto')
      ? null : Math.max(0.3, Math.min(1, Number(s) || 1));
    drsIndex = 0; drsDownVotes = 0; drsUpVotes = 0;
    resize();
    return {
      rawDpr: rd2(rawDpr), dpr: rd2(dpr), force: renderScaleForce,
      backingW: Math.round(W * dpr), backingH: Math.round(H * dpr),
      mpx: rd2(W * dpr * H * dpr / 1e6),
    };
  };
  /**
   * 验收用：**不改窗口**，算"给定设备参数会得到多大的画布"。
   *
   * 覆盖分辨率全谱（1280×720 / 1920×1080 / 2560×1440 / 3440×1440 带鱼屏 /
   * 3840×2160 / 7680×4320，dpr 1 / 1.25 / 1.5 / 2 / 3）—— 靠它就能在同一台机器上
   * 验证"画布像素上限"这条夹取，不必真去插一块 8K 屏。
   */
  window.__pbDeviceFit = function (w, h, rawD, scale) {
    const ww = Number(w) || 0, hh = Number(h) || 0;
    const d = effectiveDpr(Number(rawD) || 1, ww, hh,
      scale === undefined || scale === null ? undefined : Number(scale));
    return {
      dpr: rd2(d), backingW: Math.round(ww * d), backingH: Math.round(hh * d),
      mpx: rd2(ww * d * hh * d / 1e6),
    };
  };
  /**
   * 验收用：**强制**以指定插值系数渲染一帧，并立刻重报区域。
   *
   * 断言不再依赖"恰好抓到时序"——夹具可以自己摆好物理状态，再要求
   * "请按 alpha=0.5 画一帧"，于是能直接验证
   *   `rx === (px + bx)/2` 与 `区域圆心 === round(rx, ry)`
   * 这两条恒等式。见 tools/verify-framesync.js。
   */
  window.__pbRenderAt = function (a) {
    const v = Math.max(0, Math.min(1, Number(a)));
    renderer.frame({
      balls: world.balls, hoop: world.hoop,
      particles: fx.particles, rings: fx.rings, texts: fx.texts,
      dragging: drag ? drag.ball : null,
      aim: drag ? predictPath(drag.ball) : null,
      alpha: v,
    });
    sendShape(true);
    const b = world.balls[0];
    return {
      alpha: renderer.alpha,
      ball: b ? {
        px: b._px === undefined ? null : Math.round(b._px * 1000) / 1000,
        py: b._py === undefined ? null : Math.round(b._py * 1000) / 1000,
        bx: Math.round(b.body.position.x * 1000) / 1000,
        by: Math.round(b.body.position.y * 1000) / 1000,
        rx: b.rx === undefined ? null : Math.round(b.rx * 1000) / 1000,
        ry: b.ry === undefined ? null : Math.round(b.ry * 1000) / 1000,
        ra: b.ra === undefined ? null : Math.round(b.ra * 1000) / 1000,
      } : null,
      circle0: (lastSentShape && lastSentShape.circles[0]) || null,
    };
  };
  window.__pbOpenMenu = function (x, y) { openMenu(x || W / 2, y || H / 2); return menuOpen; };
  /**
   * 验收专用：运行时切换窗口层级（'top' = 置顶 / 'desktop' = 贴桌面），返回切换后的值。
   * 走的是和右键菜单同一条路径（patchConfig → 主进程立即重排 z 序，不重启），
   * 所以它能证明"切换立刻生效"，而不只是"启动参数生效"。
   */
  window.__pbZMode = function (m) {
    cfg.zMode = (m === 'top') ? 'top' : 'desktop';
    window.dbb.patchConfig({ zMode: cfg.zMode });
    return cfg.zMode;
  };
  window.__pbThrow = function (i, vxPerSec, vyPerSec) {
    const b = world.balls[i];
    if (!b) return false;
    M.Sleeping.set(b.body, false);
    M.Body.setVelocity(b.body, { x: PB.V(vxPerSec), y: PB.V(vyPerSec) });
    wake();
    return true;
  };
  window.__pbPlace = function (i, x, y, vxPerSec, vyPerSec) {
    const b = world.balls[i];
    if (!b) return false;
    M.Sleeping.set(b.body, false);
    M.Body.setPosition(b.body, { x: x, y: y });
    b.prevY = y;
    M.Body.setVelocity(b.body, { x: PB.V(vxPerSec || 0), y: PB.V(vyPerSec || 0) });
    /**
     * ⚠️ 插值快照必须一起搬（`_px/_py/_pa` 是 `snapshotPrev` 打的"上一步位置"）。
     *
     * 不搬的话，这颗球在被摆到新位置的**下一帧之前**会被画在
     * `_px + (body.position - _px) · alpha` —— 也就是"旧位置 → 新位置"连线上的某点，
     * 那是一处**谁都没想到的位置**：`ballAABB` 罩的是那个错位点，于是
     * 球会在屏幕上闪一下、并且在旧位置或新位置留下擦不掉的残影
     * （`verify-render` 的休眠球像素保留判据就是这么抓到的）。
     * 插值之前 `_p*` 没人读，所以这个坑是随插值一起引入的。
     */
    b._px = x; b._py = y;
    if (b.body.angle !== undefined) b._pa = b.body.angle;
    b.rx = x; b.ry = y; b.ra = b.body.angle;
    renderer.invalidate(x - 60, y - 60, 120, 120);
    wake();
    return true;
  };
  window.__pbScore = function () {
    if (!currentHoop || !currentHoop.enabled) return 'no-hoop';
    window.__pbPlace(0, currentHoop.cx, currentHoop.rimY - 130, 0, 260);
    return 'ok';
  };
  /** 计分状态快照（验收用）：得分 / 最高分 / 连击 / 最近一次进球详情 */
  window.__pbScoreState = function () {
    return {
      score: world.score, highScore: world.highScore, combo: world.combo || 0,
      last: lastScoreInfo, hasHoop: !!(currentHoop && currentHoop.enabled),
    };
  };
  /** 清空重来（走和菜单同一条路径） */
  /**
   * 验收专用：给**单独某一颗球**指定皮肤（其余球仍跟随全局主题）。
   * 走的是金球那条现成路径（renderer.drawBall 里 `ball.skin` 优先于全局皮肤），
   * 因此可以用它把整套皮肤摆成一行，一张截图横向对比，不必逐套跑一遍。
   * @param {number} i 球下标
   * @param {string} name 皮肤键；传 null 恢复跟随全局
   */
  window.__pbBallSkin = function (i, name) {
    const b = world.balls[i];
    if (!b) return null;
    b.skin = (name && PB.SKINS[name]) ? name : null;
    const p = b.body.position;
    renderer.invalidate(p.x - 240, p.y - 240, 480, 480);
    wake();
    return b.skin;
  };
  window.__pbReset = function () { resetGame(); return window.__pbScoreState(); };
  /** 皮肤：__pbSkin() 读当前；__pbSkin('neon') 直接切；__pbSkin('next') 走菜单的循环切换 */
  window.__pbSkin = function (name) {
    if (name === undefined) return renderer.skin;
    if (name === 'next') { doAction('cycle-skin'); return renderer.skin; }
    cfg.skin = PB.SKINS[name] ? name : 'classic';
    renderer.setSkin(cfg.skin);
    renderer.invalidateAll();
    ensureSkinTexture(cfg.skin);      // 验收钩子也要走按需取素材，否则切过去只有程序化外观
    window.dbb.patchConfig({ skin: cfg.skin });
    wake();
    return renderer.skin;
  };
  /**
   * 瞄准预测核对：给定出手速度（px/s）算一遍预测路径。
   * 验收用它比对「预测落点」与「真实抛出后的落点」—— 两者一致才说明
   * gStep（重力标定）和积分顺序与引擎一致。
   */
  window.__pbPredict = function (vxPerSec, vyPerSec) {
    const path = predictPathFrom(world.balls[0], vxPerSec, vyPerSec);
    if (!path) return null;
    const last = path.pts[path.pts.length - 1];
    return {
      n: path.pts.length,
      last: [Math.round(last.x), Math.round(last.y)],
      hit: path.hit,
      gStep: Math.round(gravityStep() * 1e5) / 1e5,
    };
  };
  /** 当前瞄准线的快照（验收用）：拖拽中才有内容 */
  window.__pbAimNow = function () {
    if (!drag) return { dragging: false };
    const a = predictPath(drag.ball);
    return {
      dragging: true,
      v: recentVelocity(),
      pts: a ? a.pts.length : 0,
      hit: a ? a.hit : null,
      last: a ? [Math.round(a.pts[a.pts.length - 1].x), Math.round(a.pts[a.pts.length - 1].y)] : null,
      color: a ? a.color : null,
    };
  };
  /**
   * 数一块区域里"有墨"的像素个数（alpha > 8）。
   * 验收专用：脏块算错时画布会留下擦不掉的残影，而残影在截图里很难一眼看出来 ——
   * 用数字说话：飘字存活期该 >0，过期之后该回到 0。
   */
  window.__pbInk = function (x, y, w, h) {
    const g = dynCanvas.getContext('2d');
    const d = g.getImageData(Math.round(x * dpr), Math.round(y * dpr),
      Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  };
  /**
   * 框内像素差分（验收/排障用）。
   *
   * `__pbInk` 只给一个总数，回答不了"到底什么变了"。2026-10-11 排查休眠球像素跳变
   * 时就卡在这里：球的 `bx/by/rx/ry/squash/sleeping` **两次采样完全相同**，ink 却差了
   * 130 —— 说明变的是同一框里的**别的图元**（或描边 alpha 累积），不是球本身。
   *
   * 这一对钩子把差异拆成"变亮/变暗了多少 alpha、多少像素跨过了 alpha>8 这条线、
   * 差异落在相对球心的哪个半径带"。跨线像素数（`crossIn`）正是 `__pbInk` 变化的原因；
   * 若它集中在球的外圈半径上 ⇒ 是抗锯齿外环被重复叠加；
   * 若两侧都大且偏向一边 ⇒ 是图元整体位移。
   */
  const boxSnaps = new Map();
  let boxSnapId = 0;
  window.__pbSnapBox = function (x, y, w, h) {
    const g = dynCanvas.getContext('2d');
    const X = Math.round(x * dpr), Y = Math.round(y * dpr);
    const Wd = Math.max(1, Math.round(w * dpr)), Hd = Math.max(1, Math.round(h * dpr));
    const img = g.getImageData(X, Y, Wd, Hd);
    const id = ++boxSnapId;
    boxSnaps.set(id, { x: X, y: Y, w: Wd, h: Hd, cx: x + w / 2, cy: y + h / 2, data: new Uint8ClampedArray(img.data) });
    if (boxSnaps.size > 24) boxSnaps.delete(boxSnaps.keys().next().value);
    return id;
  };
  window.__pbDiffBox = function (id) {
    const s = boxSnaps.get(id);
    if (!s) return null;
    const g = dynCanvas.getContext('2d');
    const b = g.getImageData(s.x, s.y, s.w, s.h).data;
    const a = s.data;
    let gain = 0, lost = 0, crossIn = 0, crossOut = 0, maxGain = 0, maxLost = 0;
    let sx = 0, sy = 0, nch = 0;                 // 差异像素的重心（用于判断偏哪边）
    const rings = [0, 0, 0, 0];                  // 半径带 <0.7r / <1.0r / <1.3r / 其余
    const r = 30 * dpr;                          // b.r = 30（物理/绘制半径，见 README §2.9）
    const npx = s.w * s.h;
    // ⚠️ 按**像素**循环：`i` 是字节下标（步进 4），别拿它跟 `npx` 比 —— 写成
    //    `p < b.length` 会越界，越界读出来是 undefined，`NaN === 0` 又为假，
    //    于是每个越界项都被算成一次"差异"（实测 changed 报成 26104 > 框内 8464）。
    for (let p = 0; p < npx; p++) {
      const i = p * 4;
      const d = b[i + 3] - a[i + 3];
      if (d === 0) continue;
      const px = s.x + (p % s.w), py = s.y + ((p / s.w) | 0);
      nch++; sx += px; sy += py;
      if (d > 0) {
        gain += d; if (d > maxGain) maxGain = d;
        if (a[i + 3] <= 8 && b[i + 3] > 8) crossIn++;
      } else {
        lost -= d; if (-d > maxLost) maxLost = -d;
        if (a[i + 3] > 8 && b[i + 3] <= 8) crossOut++;
      }
      const dx = px / dpr - s.cx, dy = py / dpr - s.cy;
      const rr = Math.sqrt(dx * dx + dy * dy) / r;
      rings[rr < 0.7 ? 0 : rr < 1.0 ? 1 : rr < 1.3 ? 2 : 3]++;
    }
    return {
      gain: gain, lost: lost, crossIn: crossIn, crossOut: crossOut,
      maxGain: maxGain, maxLost: maxLost, changed: nch, rings: rings,
      cx: nch ? Math.round((sx / nch) / dpr * 10) / 10 : null,
      cy: nch ? Math.round((sy / nch) / dpr * 10) / 10 : null,
      boxCx: s.cx, boxCy: s.cy,
    };
  };
  /** 直接触发一个动作 id（验收用，等价于点菜单项） */
  window.__pbAction = function (id) { doAction(id); return true; };
  /** 纹理质量回归：预烘焙 mip vs 320² 母版，逐像素差（见 render.js::texDiff） */
  window.__pbTexDiff = function (skin) { return renderer.texDiff(skin); };

  /**
   * 合并 base+hi 前后的**整球**像素差。
   * 每球绘制 4 次 → 3 次是 60 球档回到 60fps 的关键，但合成顺序也随之改了
   * （旧：高光压球缝；新：球缝压高光）。差异必须用数字证明只在「球缝 ∩ 高光」那一小块。
   */
  window.__pbBallDiff = function (skin) { return renderer.ballDiff(skin); };

  /**
   * 取某套皮肤的 320² 母版各层（验收用）。
   * `texFor()` 返回的是**按当前设备像素缩过的 mip 层级**（exact / head），
   * 尺寸随 dpr 变；要验"这一套皮肤烘了几层、是不是专用算法"，必须看 `master`。
   */
  window.__pbTexFor = function (skin) {
    const t = renderer.texFor(skin);
    return t ? t.master : null;
  };
  /** 球的分层开关（验收用）：bit1 阴影 / bit2 底色 / bit4 球缝 / bit8 高光 */
  window.__pbLayers = function (mask) {
    if (mask === undefined) return renderer.layerMask;
    renderer.layerMask = Number(mask) & 15;
    renderer.invalidateAll();
    wake();
    return renderer.layerMask;
  };
  /** 成就清单；传 'reset' 清空（验收用，避免"已解锁过 → 不出横幅"把测试带偏） */
  window.__pbAchievements = function (cmd) {
    if (cmd === 'reset') {
      achSet.clear();
      cfg.achievements = [];
      window.dbb.patchConfig({ achievements: [] });
      updateHud();
      return 0;
    }
    return ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, got: achSet.has(a.id) }));
  };
  window.__pbUnlock = function (id) { return unlock(id); };
  /** 金球：不带参读数量；'spawn' 立即生成（可带球下标）；'clear' 全部收回 */
  window.__pbGolden = function (cmd, idx) {
    if (cmd === 'spawn') { spawnGolden(idx); return world.balls.filter((b) => b.golden).length; }
    if (cmd === 'clear') { clearGolden(); return 0; }
    return world.balls.filter((b) => b.golden).length;
  };
  /**
   * 瞄准预测 vs 真实飞行的对照（验收用）。
   * 同一组出手速度：一条走 predictPathFrom（纯计算），一条真的写进刚体让引擎跑，
   * 记录实际顶点与落点。两者接近 → 预测的积分顺序与重力标定和引擎一致。
   */
  window.__pbAimTrace = function (vxPerSec, vyPerSec) {
    const ball = world.balls[0];
    if (!ball) return null;
    const path = predictPathFrom(ball, vxPerSec, vyPerSec);
    let predApex = Infinity;
    if (path) for (const q of path.pts) if (q.y < predApex) predApex = q.y;
    const predLast = path ? path.pts[path.pts.length - 1] : null;

    const p0 = ball.body.position;
    return new Promise((resolve) => {
      let minY = p0.y, landX = 0, landY = 0, steps = 0;
      const onStep = () => {
        const p = ball.body.position;
        steps++;
        if (p.y < minY) minY = p.y;
        if (!landY && p.y >= H - ball.r - 1) { landX = p.x; landY = p.y; }
        if (steps >= 200 || (landY && steps > 8)) {
          M.Events.off(world.engine, 'afterUpdate', onStep);
          resolve({
            predicted: path ? {
              apexY: Math.round(predApex),
              last: [Math.round(predLast.x), Math.round(predLast.y)],
              n: path.pts.length,
            } : null,
            real: { apexY: Math.round(minY), landX: Math.round(landX), landY: Math.round(landY), steps: steps },
            gStep: Math.round(gravityStep() * 1e5) / 1e5,
          });
        }
      };
      M.Sleeping.set(ball.body, false);
      M.Body.setVelocity(ball.body, { x: PB.V(vxPerSec), y: PB.V(vyPerSec) });
      M.Events.on(world.engine, 'afterUpdate', onStep);
      wake();
    });
  };
  window.__pbHud = function (on) {
    if (on === undefined) return cfg.showHud !== false;
    cfg.showHud = !!on;
    if (hudEl) hudEl.classList.toggle('hide', !cfg.showHud);
    sendShape(true);
    return cfg.showHud;
  };
  window.__pbPerf = function (on) {
    cfg.showPerf = !!on;
    perfEl.style.display = cfg.showPerf ? 'block' : 'none';
    sendShape(true);      // 区域要跟着变，否则开发期也会看到"开了不显示"
    wake();
    return cfg.showPerf;
  };
  /** 压测：周期性给所有球随机冲量，保证它们永远不进入休眠 */
  window.__pbChaos = function (on, periodMs) {
    if (window.__pbChaosTimer) { clearInterval(window.__pbChaosTimer); window.__pbChaosTimer = 0; }
    if (!on) return 'off';
    const p = periodMs || 700;
    window.__pbChaosTimer = setInterval(() => {
      for (let i = 0; i < world.balls.length; i++) {
        const b = world.balls[i];
        M.Sleeping.set(b.body, false);
        M.Body.setVelocity(b.body, {
          x: PB.V((Math.random() - 0.5) * 1600),
          y: PB.V(-Math.random() * 1100 - 300),
        });
      }
      wake();
    }, p);
    return 'on:' + p + 'ms';
  };

  /**
   * 拖拽性能验收钩子。
   *
   * 走**真实**的拖拽代码路径（setupDrag / onMove 里那几步：同步形状上报、区域变更、
   * wake()、world.moveDrag），只是坐标由内部定时器给定，不必真的去动系统鼠标 ——
   * 于是可以无人值守地量出"拖球时到底慢在哪"，并且能在同一个进程里做 A/B。
   *
   *   cap <ms>  设置绘制节流（0 = 关掉节流，复现旧行为）
   *   begin [i] 在某颗球上挂起拖拽（不移动）
   *   spin [hz] 以 hz 的频率绕圈移动（等价于 onMove 连续触发）
   *   end       松手（等价于 onUp）
   *   state     取计数器快照
   */
  window.__pbDragRunner = function (cmd, a, b) {
    if (cmd === 'state') {
      return {
        dragging: !!drag, draws: drawCount, drawMs: Math.round(drawMsTotal * 10) / 10,
        iters: iterCount, loopMs: Math.round(loopMsTotal * 10) / 10,
        loops: loopCount, steps: stepCount, cap: Math.round(frameMinMs * 100) / 100,
        fps: Math.round(fps * 10) / 10, loopHz: Math.round(loopHz * 10) / 10,
        stepHz: Math.round(stepHz * 10) / 10,
        physMs: Math.round(world.stats.avgStepMs * 100) / 100,
        physMaxMs: Math.round(world.stats.maxStepMs * 100) / 100,
        tiles: renderer.tilesDrawn, pairs: world.stats.pairs,
        awake: world.stats.awake, balls: world.balls.length,
      };
    }
    if (cmd === 'cap') { frameMinMs = Math.max(0, Number(a) || 0); return frameMinMs; }
    if (cmd === 'shape') { bench.noLock = !!a; sendShape(true, true); return bench.noLock; }
    // 'full'（默认）= 拖拽期间整窗放开；'corridor' = 只报窄走廊。A/B 用，见 sendShape 注释。
    if (cmd === 'region') {
      bench.region = (a === 'corridor') ? 'corridor' : 'full';
      sendShape(true, true);
      return bench.region;
    }
    // 把全部球按回休眠：让 A/B 两个回合从同一个"只有被拖那颗是活的"状态开始，
    // 否则上一回合残留的运动量会直接污染下一段的 CPU 数字（实测差 3 倍）。
    if (cmd === 'freeze') {
      for (let i = 0; i < world.balls.length; i++) M.Sleeping.set(world.balls[i].body, true);
      return world.balls.length;
    }
    /**
     * 隔离探针：把主循环停到 160ms 巡检，只让探针自己的 rAF 在跑，
     * 从而把「rAF 回调本身的成本」与「renderer.frame 的成本」分开：
     *   raf      只 requestAnimationFrame 空转
     *   rafdraw  空转 + 每轮 renderer.frame()
     *   end      收工，恢复主循环
     */
    if (cmd === 'probe') {
      const mode = a || 'raf';
      if (bench.raf) { cancelAnimationFrame(bench.raf); bench.raf = 0; }
      if (mode === 'end') {
        bench.park = false;
        wake();
        return 'probe-end';
      }
      const ms = Number(b) || 4000;
      const draw = mode === 'rafdraw';
      bench.park = true;
      const p0 = performance.now();
      const tick = () => {
        if (performance.now() - p0 >= ms) {
          bench.raf = 0;
          return;
        }
        probeN++;
        if (draw) {
          renderer.frame({
            balls: world.balls, hoop: world.hoop, particles: fx.particles,
            texts: fx.texts, dragging: null,
          });
          drawCount++;
          drawMsTotal += renderer.lastDrawMs;
        }
        bench.raf = requestAnimationFrame(tick);
      };
      probeN = 0;
      bench.raf = requestAnimationFrame(tick);
      return 'probe:' + mode + ':' + ms;
    }
    if (cmd === 'probeState') {
      return { n: probeN, draws: drawCount, drawMs: Math.round(drawMsTotal * 10) / 10 };
    }
    if (cmd === 'begin') {
      const ball = world.balls[a || 0];
      if (!ball) return 'no-ball';
      const p = ball.body.position;
      bench.cx = p.x; bench.cy = p.y; bench.t = 0;
      if (b) bench.r = b;
      setupDrag(ball, {
        pointerId: 991, clientX: p.x, clientY: p.y,
        target: { setPointerCapture() {}, releasePointerCapture() {} },
      });
      return 'dragging';
    }
    if (cmd === 'spin') {
      if (bench.timer) clearInterval(bench.timer);
      if (a) bench.hz = a;
      bench.timer = setInterval(() => {
        if (!drag) { clearInterval(bench.timer); bench.timer = 0; return; }
        bench.t++;
        const ang = bench.t * bench.om;
        const x = bench.cx + Math.cos(ang) * bench.r;
        const y = bench.cy + Math.sin(ang) * bench.r * 0.45;
        const t = performance.now();
        pushPoint(x, y, t);
        const v = recentVelocity();
        world.moveDrag(x, y, v.x, v.y);
        drag.moved = true;
        wake();
      }, 1000 / bench.hz);
      return 'spin@' + bench.hz;
    }
    if (cmd === 'end') {
      if (bench.timer) { clearInterval(bench.timer); bench.timer = 0; }
      world.endDrag();
      drag = null;
      lockState = false;
      sendShape(true);
      wake();
      return 'ended';
    }
    return 'unknown:' + cmd;
  };

  /**
   * 高速飞行验收钩子。
   *
   * 解决的是一个**只能在真实屏幕上看见**的问题：球在空中快速飞行时会被
   * `SetWindowRgn` 裁掉一块。所以这里做的事很单一 —— 把 0 号球按在一条椭圆
   * 轨道上匀速飞，让它**一直**处在"高速"状态，这样任何时刻抓一张真实屏幕截图
   * 都能拍到它（不用去赌"恰好抓到抛出那一瞬"）。
   *
   * 走的是**不拖拽**的路径，也就是 sendShape 里"逐球圆盘"那条分支 ——
   * 拖拽期间窗口区域是整窗，裁不到球，反而复现不出来。
   *
   * 位置与速度都直接写进刚体，所以 `drawBall` 的沿速度拉伸、`sendShape` 的
   * 上报口径、脏块包围盒全都和玩家抛出去的球完全一致。
   *
   *   orbit [i] [om]  第 i 颗球绕椭圆轨道飞（om = 角速度 rad/s，默认 3.2）
   *   state           取当前球心与线速度
   *   lead <n>        把球盘前瞻量设为 n 个物理步长（0 = 关），并立刻重报一次形状
   *   stop            摘掉钩子，交还物理引擎
   */
  window.__pbFlyRunner = function (cmd, a, b) {
    if (cmd === 'state') {
      // repR = 最近一次真正发出去的区域圆半径（0 号球）。它把"前瞻到底有没有生效"
      // 变成一个可直接比对的数字：repR 应当 ≈ grab + speedPerStep·leadFrames。
      const c0 = lastSentShape && lastSentShape.circles[0];
      const b0 = world.balls[0];
      return {
        on: fly.on, x: Math.round(fly.x), y: Math.round(fly.y),
        vx: Math.round(fly.vx), vy: Math.round(fly.vy), speed: Math.round(fly.speed),
        lead: leadFrames,
        vstep: b0 ? Math.round(Math.hypot(b0.body.velocity.x, b0.body.velocity.y) * 10) / 10 : 0,
        repR: c0 ? c0[2] : 0,
      };
    }
    if (cmd === 'stop') {
      if (fly.off) fly.off();
      fly.on = false; fly.off = null;
      return 'stopped';
    }
    if (cmd === 'lead') {
      // 剂量-反应实验用：同一趟飞行里只改这一个量，别的条件一概不动，
      // 于是各组帧之间的差别就只能来自前瞻量本身。
      const n = Number(a);
      leadFrames = (isFinite(n) && n > 0) ? n : 0;
      sendShape(true, false);
      return 'lead=' + leadFrames;
    }
    if (cmd === 'lagprobe') {
      // 打开区域管线滞后采样（见 lagProbe）。采样数据在主进程侧统计并写进 runtime.log，
      // 渲染进程只负责给出"发出时刻"。用 __pbLagProbe 这个名字也在 __pbFlyRunner 里，
      // 是因为它唯一的用途就是配合 --fly-test 量 leadFrames 该取多少。
      lagProbe = !!a;
      return 'lagprobe=' + lagProbe;
    }
    if (cmd === 'flat') {
      // 验收专用：把球画成纯洋红圆盘，好让截图里的球能被精确分割（见 render.js
      // 构造函数里的说明）。传 b 时改用那个半径画 —— b 大于区域半径时，
      // 可见的洋红块就是**区域圆本身**，于是能直接量出区域的位置与滞后。
      renderer.flatBall = !!a;
      renderer.flatBallR = Number(b) || 0;
      renderer.needFull = true;   // 换外观那一帧必须整层重画，否则会留下旧贴图残影
      return 'flat=' + renderer.flatBall + ' R=' + renderer.flatBallR;
    }
    if (cmd === 'orbit') {
      if (fly.on) return 'already';
      const ball = world.balls[a || 0];
      if (!ball) return 'no-ball';
      // 轨道放在窗口中部偏上，避开篮球架与左右两组控制栏，免得被别的东西挡着看不清
      const rx = Math.min(W * 0.30, 430);
      const ry = Math.min(H * 0.24, 190);
      const cx = W * 0.46, cy = H * 0.44;
      const om = Number(b) || 3.2;          // rad/s
      const t0 = performance.now();
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        const ang = t * om;
        const x = cx + Math.cos(ang) * rx;
        const y = cy + Math.sin(ang) * ry;
        const vx = -Math.sin(ang) * rx * om;
        const vy = Math.cos(ang) * ry * om;
        M.Sleeping.set(ball.body, false);
        M.Body.setPosition(ball.body, { x: x, y: y });
        // ⚠️ 这里必须 PB.V() 折成 px/步。直接塞 px/s 的话 body.velocity 会大 60 倍，
        // 立刻被物理后处理的限速（maxThrowSpeed·1.35 = 49.5px/步）钳死，
        // 于是 body.velocity 只剩一个跟真实轨道速度毫无关系的常数 ——
        // 而 sendShape 的前瞻正是读 body.velocity，量出来的立刻成了假数据。
        M.Body.setVelocity(ball.body, { x: PB.V(vx), y: PB.V(vy) });
        M.Body.setAngularVelocity(ball.body, 3);
        fly.x = x; fly.y = y; fly.vx = vx; fly.vy = vy; fly.speed = Math.hypot(vx, vy);
      };
      M.Events.on(world.engine, 'afterUpdate', step);
      fly.off = function () { M.Events.off(world.engine, 'afterUpdate', step); };
      fly.on = true;
      // ⚠️ 必须先自己跑一步把球唤醒再挂 afterUpdate。
      // 球落地后会休眠，而主循环的 isIdle() 一旦看到"所有球都睡着"就退化成 160ms
      // 巡检、**根本不推进物理** —— 于是 afterUpdate 永远不会触发，钩子形同虚设，
      // 屏幕上球一动不动（第一次就是这么被骗过去的：截图全 8 张字节相同）。
      step();
      wake();
      return 'orbit rx=' + Math.round(rx) + ' ry=' + Math.round(ry) +
             ' om=' + om + ' v=' + Math.round(rx * om);
    }
    return 'unknown:' + cmd;
  };

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
