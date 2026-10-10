'use strict';
/**
 * config.js —— 本地配置读写（%APPDATA%/DesktopBasketball/config.json）
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 2,
  ballCount: 1,
  hoopEnabled: true,
  soundEnabled: true,
  autoStart: false,
  /** 'region' = SetWindowRgn 逐像素点击穿透（默认，零延迟）
   *  'hook'   = WH_MOUSE_LL + WS_EX_TRANSPARENT 动态切换（备用） */
  hitTestMode: 'region',
  /** 窗口层级（两种互斥的 z 序目标，随即生效）：
   *  'desktop' = 默认：浮于桌面图标之上、所有普通窗口之下（像个桌面挂件）
   *  'top'     = 置顶：显示在所有普通窗口与任务栏之上（前台开着别的窗口也看得见）
   *  逐像素点击穿透（SetWindowRgn）在两种模式下都照常生效，球盘之外依旧点到桌面。 */
  zMode: 'desktop',
  /** 串流兼容模式（用远程控制 / 多屏串流时打开，需重启生效）：
   *  Windows 下 Electron 的透明窗口默认走 **DirectComposition** 呈现 —— 每帧内容
   *  是独立提交的 DComp visual。部分远程控制软件（如 UU 远程的「超级屏」，它靠
   *  虚拟显示驱动串流桌面）的屏幕捕获**抓不到独立提交的这一层**，症状恰好是
   *  「篮球架（静态层 #stat）和控制栏（DOM）都在，只有球（动态层 #dyn）整层不见
   *  或缺一块」——本地显示器上完全正常，只有被串流的那一端看不到。
   *  开启后启动参数加 --disable-direct-composition（**以及 --disable-gpu-compositing /
   *  --disable-zero-copy**，见 src/stream.js::COMPAT_SWITCHES 的说明：只关 DComp
   *  够不着"每帧变化的 canvas 被 GPU 进程单独提交"这一层），让内容回到窗口后备缓冲，
   *  任何屏幕捕获都能拿到。**不降低帧率**：物理步长/绘制调用/脏块策略一概不变。 */
  streamMode: false,
  /** 用户是否**显式**点过「串流兼容模式」开关（真/假都算表态）。
   *
   *  它存在的唯一理由：让自动检测不跟用户对着干。用户在托盘里关掉兼容模式之后，
   *  之后插拔显示器 / 接上远程屏都不该把它自动改回来 —— 那会变成"点了关闭，
   *  过一会儿自己又开了"。没点过时（false），检测到远程会话或虚拟显示才自动开。
   *  见 src/stream.js::resolve。 */
  streamExplicit: false,
  /** 虚拟/远程显示关键字表覆盖（留空 = 用 stream.js::DEFAULT_HINTS）。
   *  新增厂商不必改代码，写进 config.json 即可。 */
  streamDisplayHints: [],
  /** 运动平滑：定点物理 + 插值渲染（见 app.js 的 renderPos 说明）。
   *  物理仍固定 60Hz，绘制按显示刷新率把球画在"两步之间"的插值位置上，
   *  于是 60/75/120Hz 屏、以及换设备后刷新率变化时都不会出现"帧率满但一顿一顿"。
   *  关掉它 → 球严格画在物理位置上（旧行为，换设备时可能看出台阶感）。 */
  smooth: true,
  /**
   * 动态渲染分辨率（DRS）：**绘制成本压不下来时降的是画布分辨率，不是帧率**。
   *
   * 判据是"近 120 帧整帧绘制耗时的中位数 ÷ 屏幕帧周期"（见 app.js::drsTick）：
   * 超过 0.62 才逐档降（1 → 0.88 → 0.76 → 0.64 × devicePixelRatio），
   * 低于 0.34 才逐档升，档间静默 2.5 秒 —— 只在**实测**画不动时才介入。
   * 4K/8K、高 dpr、软件合成（串流兼容模式）这些"分辨率压垮绘制"的场合靠它兜住；
   * 屏比 120Hz 更快时完全不介入（那时少呈现几帧比糊一点更划算）。
   * 想固定清晰度就设 false（代价是极端分辨率下可能顶不住插值补帧）。
   */
  dynScale: true,
  showPerf: false,
  showControlBar: true,
  gravity: 1.0,
  ballRadius: 34,
  throwGain: 1.12,
  maxThrowSpeed: 2200,
  /** 球数上限。**60 → 100 → 200** —— 每次抬高都会明显推高每帧绘制次数，
   *  所以每次顺带把皮肤管线里能省的都省了（素材皮肤从 3 次绘制降到 1 次，见 render.js::drawBall）。
   *  ⚠️ 200 是**能力上限**，不是推荐值：100 球在 100% 单核左右就能跑满 60fps，
   *  200 球会让中端机器明显掉帧（见 README §2.12）。用户自己按机器选。
   *  老配置里落盘过 maxBalls: 60 / 100，那会盖掉这里的默认值，所以 init() 里有定向迁移。 */
  maxBalls: 200,
  restitution: 0.72,
  frictionAir: 0.0115,
  /** 历史最高分（跨会话保留；得分归零不会清掉它） */
  highScore: 0,
  /** 球皮肤主题（见 render.js SKINS / SKIN_IMG）：
   *  程序化外观 classic 经典篮球 / neon 能量球 / soccer 足球
   *  照片级素材 watermelon 西瓜 / planet 地球 / jupiter 木星 */
  skin: 'classic',
  /** 已解锁的成就 id（跨会话保留，见 app.js ACHIEVEMENTS） */
  achievements: [],
  /** 顶部记分板（得分 / 连击 / 最高分） */
  showHud: true,
  /** 金球彩蛋：定时随机把一颗球变成金球，投进得双倍分 */
  goldenEnabled: true,
  /** 进球特效：冲击波光环 + 全向爆散火花 + 彩带（见 app.js::onScore）。
   *  纯装饰、纯事件驱动 —— 进球那一刻生成，之后自然消亡，不影响静置降频。 */
  fxBurst: true,
  /** 运动拖尾：球高速飞行时在身后留下痕迹（见 render.js::drawTrail）。
   *  只在 |v| ≥ 阈值时记录位置历史，慢球/休眠球零成本。 */
  trail: true,
  /** 拖尾样式：'fire' 火焰（默认，见 FIRE 拾色） / 'ghost' 原版贴图残影。 */
  trailStyle: 'fire',
  /** 上次退出时的球位置，用于下次恢复 */
  ballStates: [],
  savedAt: 0,
};

let cache = null;
let file = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'config.json');
  let fresh = true;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Object.assign({}, DEFAULTS, parsed);
    fresh = false;
    if (!Array.isArray(cache.ballStates)) cache.ballStates = [];
    // 成就：只保留字符串 id，坏数据一律丢掉（老版本 / 手改配置都可能写出了脏值）
    if (!Array.isArray(cache.achievements)) cache.achievements = [];
    else cache.achievements = cache.achievements.filter((x) => typeof x === 'string');
  } catch (e) {
    cache = Object.assign({}, DEFAULTS);
  }

  // --- 迁移
  // v1 → v2：窗口层级改为可切换（desktop / top）；把球数重新落到默认的 1 颗
  // （老配置里存的 3/20 颗会让"首次只有 1 颗"看不出效果）。
  // 篮球框也强制打开一次：v1 的篮球框有"不拖动就不显示"的渲染 bug，
  // 老用户可能因此把它关掉过；升级后必须能直接看到修好的篮球架。
  if (!fresh && cache.version !== DEFAULTS.version) {
    cache.ballCount = DEFAULTS.ballCount;
    cache.hoopEnabled = DEFAULTS.hoopEnabled;
    cache.ballStates = [];
    cache.version = DEFAULTS.version;
  }
  // ⚠️ 这里**不能**再 `delete cache.zMode` —— 它是用户可切换的持久设置，
  // 无条件删掉等于每次启动都把"置顶"重置回"贴桌面"。
  if (cache.zMode !== 'top') cache.zMode = 'desktop';
  if (!(cache.ballCount >= 1)) cache.ballCount = 1;

  // 球数上限 60 → 100 → 200。
  // ⚠️ 单独做这一条、**不碰 version**：版本迁移那个分支会把 ballCount 重置回 1
  // 并清空球位置，用户正玩着几十颗球时被重置一次会很难受。
  // 只在"恰好等于某个历史上限"时抬升到当前上限，用户自己调过的其它值不动。
  // ⚠️ 必须写成「命中旧值就抬到 DEFAULTS.maxBalls」而不是「< 200 就抬到 200」：
  // 后者会把用户**故意调小**的上限（比如为了省电设 50）也一起改掉。
  if (cache.maxBalls === 60 || cache.maxBalls === 100) cache.maxBalls = DEFAULTS.maxBalls;
  if (!(cache.maxBalls >= 1)) cache.maxBalls = DEFAULTS.maxBalls;

  // 串流兼容模式相关的三个字段：老配置 / 手改配置里可能是 0/1、"true"、null。
  // 一律收成严格的真布尔值 —— `resolve()` 用的是 `=== true` 判断，脏值会静默变成
  // "没表态"，于是用户在托盘里点过的开关下次启动就失效了（正是"开关异常"的一种）。
  cache.streamMode = cache.streamMode === true;
  cache.streamExplicit = cache.streamExplicit === true;
  cache.smooth = cache.smooth !== false;                 // 默认开
  cache.dynScale = cache.dynScale !== false;             // 默认开
  if (!Array.isArray(cache.streamDisplayHints)) cache.streamDisplayHints = [];

  return cache;
}

function get() {
  return cache || Object.assign({}, DEFAULTS);
}

function patch(p) {
  cache = Object.assign(get(), p);
  return cache;
}

function save() {
  if (!file) return;
  try {
    cache.savedAt = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    /* 配置写入失败不影响运行 */
  }
}

module.exports = { init, get, patch, save, DEFAULTS, path: () => file };
