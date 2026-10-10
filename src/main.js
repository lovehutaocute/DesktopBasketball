'use strict';
/**
 * main.js —— 主进程
 *
 * 职责边界（刻意保持窄）：
 *   · 窗口：一个无边框透明覆盖窗（唯一窗口），尺寸 = 主显示器工作区（天然不覆盖任务栏）
 *   · 层级：两档可选，见 config.zMode（托盘菜单 / 球的右键菜单即时切换）——
 *         'desktop'（默认）桌面图标之上、所有普通窗口之下（SetWindowPos 插到紧贴桌面上方那个窗口的下面）
 *         'top'     显示在所有普通窗口与任务栏之上（setAlwaysOnTop(true,'screen-saver')）
 *         1.2s 一次校正 z 序
 *   · 命中：接收渲染进程上报的「可交互形状」，交给 native.SetWindowRgn 做逐像素穿透
 *   · 托盘：全部控制项
 *   · 配置：读写 config.json，开机自启
 * 物理与渲染都在渲染进程，主进程不做任何逐帧计算。
 */

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// ------------------------------------------------------------------ 启动计时
/**
 * 启动各阶段的耗时（毫秒），基准是**进程创建时刻**而不是脚本第一行。
 *
 * 为什么必须反推进程创建时刻：`perf_hooks.performance.timeOrigin` 就是 Node 进程
 * 的启动时刻，`performance.now()` 是它之后的单调毫秒数。Electron 自己从
 * `app.whenReady()` 才开始跑，而**加载 exe（210MB）+ 初始化 Chromium** 这一段
 * 发生在我们的代码之前 —— 只从第一行计时会把它整个漏掉，于是"启动慢"永远查不出
 * 慢在哪一段。用外部秒表掐双击到球出现才是用户体感的口径，但那个受 Explorer /
 * 杀软 / 磁盘缓存干扰太大，所以进程内埋点 + 外部秒表两条数据对着看。
 */
const BOOT_T0 = Date.now() - Math.round(performance.now());
/** 阶段名 -> 距进程创建的毫秒数 */
const bootMarks = [];
function mark(name) {
  bootMarks.push([name, Date.now() - BOOT_T0]);
}
/** 把已记录的所有阶段拼成一行，方便 grep 与跨版本对比 */
function bootLine() {
  return bootMarks.map(([k, v]) => k + '=' + v + 'ms').join(' ');
}
mark('main.js-top');

const config = require('./config');
const native = require('./native');
const stream = require('./stream');
mark('requires-done');

// ------------------------------------------------------------------ 启动前开关
const cfg = config.init(app.getPath('userData'));

const argv = process.argv.slice(1);
/**
 * GPU 自愈降级：本机若没有可用 GPU（虚拟机 / 远程会话 / 老驱动），
 * Chromium 的 GPU 进程会反复崩溃并 FATAL 退出进程。这里用「上次是否正常跑起来过」
 * 作为探针：上次没跑起来 → 这次直接走软件合成。
 * 透明覆盖窗在软件合成下反而更稳（见 README 的性能说明）。
 */
const gpuFailedLastRun = cfg.lastRunStarted === false;
/**
 * `--gpu` 是 `--no-gpu` 的**反向逃生口**，必须排在判断最前面（见 setSoftwareRendering）。
 * 它存在的理由：`forceNoGpu` 一旦落盘就是**粘性**的 —— 只要有过一次 GPU 崩溃自愈、
 * 或有人带 `--no-gpu` 跑过一次，配置里就永久写上 true，之后每次启动都是软件合成。
 * 本机真踩过：一次带 `--no-gpu` 的验收运行把用户的真实配置钉死，用户侧只表现为
 * "变卡了"，没有任何入口能改回来。
 */
const forceNoGpu = argv.includes('--gpu') ? false
  : (argv.includes('--no-gpu') || cfg.forceNoGpu === true || gpuFailedLastRun);

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

/**
 * 串流兼容模式（见 config.js::streamMode / src/stream.js）：
 * 让透明窗内容回到窗口后备缓冲，任何屏幕捕获（含虚拟显示驱动）都能拿到完整画面。
 *
 * 判定优先级：命令行 > 用户显式配置 > 环境自动检测（远程会话/虚拟显示）。
 * `streamInfo` 是**实际生效**的结果，托盘文案 / app-info / 日志 / 提示全都读它 ——
 * 不再读 `cfg.streamMode`（那是"配置里写了什么"，两者可以不一致，读错就是"开关失效"）。
 */
const displayInfo = native.getDisplayInfo ? native.getDisplayInfo() : { remote: false, devices: [], virtual: null, activeDevices: [] };
const streamInfo = stream.resolve({
  argv,
  config: cfg,
  remoteSession: displayInfo.remote,
  devices: displayInfo.activeDevices && displayInfo.activeDevices.length
    ? displayInfo.activeDevices : displayInfo.devices,
  hints: cfg.streamDisplayHints,
});
const forceStream = streamInfo.active;
/** 本次生效的兼容开关清单（写日志用；顺序即 stream.COMPAT_SWITCHES） */
const streamSwitches = [];
if (forceStream) {
  for (const sw of stream.COMPAT_SWITCHES) {
    app.commandLine.appendSwitch(sw);
    streamSwitches.push(sw);
  }
}
/** 自动检测出来的环境结论，供 app-info / 日志用（无论是否已进兼容模式都要报） */
const envInfo = {
  remote: !!displayInfo.remote,
  virtual: displayInfo.virtual || null,
  devices: displayInfo.devices || [],
};
/**
 * 显示器拓扑变化时**自动**进兼容模式只允许做一次（否则插拔显示器会反复重启）。
 * 只在"自动档、且当前没开兼容模式"时才会用到，见 onDisplayChanged。
 */
let streamRelaunched = false;

if (forceNoGpu) {
  app.disableHardwareAcceleration();
  // 在没有可用 GPU 的环境里，Chromium 连"软件 GPU 进程"都起不来（ACCESS_VIOLATION），
  // 把 GPU 线程并入主进程是唯一能稳定跑通的组合；代价是主进程扛一点光栅化开销。
  app.commandLine.appendSwitch('in-process-gpu');
}

// 标记「本次启动尚未确认健康」，10 秒后翻转为 true 并落盘
config.patch({ lastRunStarted: false, forceNoGpu: forceNoGpu });
config.save();
mark('config-saved');
setTimeout(() => {
  config.patch({ lastRunStarted: true });
  config.save();
}, 10000);

// 只允许一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ------------------------------------------------------------------ 全局状态
let win = null;
let tray = null;
let hwnd = 0;
let scaleFactor = 1;
let workArea = { x: 0, y: 0, width: 1280, height: 720 };
let zKeeperTimer = null;
let zFrozen = false;   // 验收夹具用：见 anchorToDesktop 的说明
/** 验收用的层级覆盖（--z-top / --z-desktop）：只影响本次运行，不写盘，
 *  这样 CI/脚本可以强制某种层级做对照，又不会污染用户的 config.json。 */
const zModeOverride = argv.includes('--z-top') ? 'top'
  : (argv.includes('--z-desktop') ? 'desktop' : null);
let hookState = { interactive: true, locked: false, lastShape: null };
let regionFailures = 0;
let okLoggedRegion = false;
let regionDisabled = false;
let lastShapeJson = '';

/** 显示器拓扑变化时提示过「串流兼容模式」没有（只提示一次，免得插拔显示器反复弹） */
let streamHinted = false;

/**
 * 区域管线滞后采样（只给 --fly-test / --lag-probe 用，生产路径不进这里）。
 *
 * 量的是 **渲染进程算好这一份区域 → 主进程真正调 SetWindowRgn** 的端到端时间。
 * 为什么必须是这个数：区域与画面是两条独立流水线，区域慢多少，球沿速度方向就
 * 露出多少 —— 露出量 = |v|·(滞后帧数 − leadFrames) − 6.6px，是"球被削一角/整颗
 * 消失"的直接自变量。leadFrames 该取几，只有这个分布说了算（见 README §6.6）。
 *
 * 时间戳来源：渲染进程 sendShape 在 JSON.stringify 之后给 shape 挂的 `_t`
 * （见 renderer/app.js 的 lagProbe）。用 Date.now() 而不是 performance.now()：
 * 两个进程的 performance 基准不同，绝对时间只能靠墙上时钟对齐（±1ms 足够）。
 */
const lagSamples = [];
let lagLastLogAt = 0;
let lagSeenT = false;
/**
 * 两个进程 Date.now() 的恒定偏差（实测本机 ≈ −7~−11ms，即渲染进程的墙上时钟比主进程
 * 快这么多；Chromium 的渲染进程并不直接读系统时钟）。这是**常数**，不是滞后，必须在
 * 报告前减掉，否则会得出"滞后是负数"的荒谬结论 —— 第一版就是因为没减它，
 * 所有样本都被 `d >= 0` 这条守卫当"时钟跳变"丢掉了，看起来像"采样链路没通"。
 *
 * 用"观测到的最小 d"当偏差估计：管道再快也有个下限，取长期最小值即可收敛到
 * 偏差 + 最小传输时延，剩下的抖动才是真正的调度滞后。
 *
 * ⚠️ 这套采样只覆盖「渲染进程发出 → 主进程调 SetWindowRgn」这一段，实测 p50 1ms /
 * max 2ms —— **它回答不了"球为什么被削"**。真正让球露出来的那部分滞后发生在
 * SetWindowRgn 之后（DWM 重定向窗口表面并呈现），进程内测不到，只能靠真实屏幕截图，
 * 而本机上 screencap.ps1 自己的流水线就要 270~780ms，量不出几十毫秒的差别（连拍 18 张
 * 里 17 张字节完全相同，同时 capturePage 却 40/40 都是完整球 —— 用它下结论会被带偏）。
 * 所以这个采样的价值是**证伪**：证明 IPC/主进程不是瓶颈，别再往那边优化。
 */
let lagOffset = null;
function noteRegionLag(shape) {
  if (!shape || !shape._t) return;   // 生产路径没有 _t，直接走不到下面
  if (!lagSeenT) {
    lagSeenT = true;
    log('LAGPROBE with _t OK keys=[' + Object.keys(shape).join(',') + '] circles=' +
        (shape.circles || []).length + ' rects=' + (shape.rects || []).length);
  }
  const d = Date.now() - shape._t;
  if (!(d > -500 && d < 5000)) return;
  if (lagOffset === null || d < lagOffset) lagOffset = d;
  lagSamples.push(d);
  const now = Date.now();
  if (now - lagLastLogAt < 2000 || lagSamples.length < 60) return;
  lagLastLogAt = now;
  // 减掉恒定时钟偏差后再看分布：这才是"区域比画面晚了多少毫秒"。
  const s = lagSamples.slice().sort((a, b) => a - b).map((x) => x - lagOffset);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  log('LAGSTAT', 'n=' + s.length, 'off=' + lagOffset + 'ms',
      'p50=' + q(0.5) + 'ms', 'p90=' + q(0.9) + 'ms', 'p99=' + q(0.99) + 'ms',
      'max=' + s[s.length - 1] + 'ms',
      '帧@60Hz: p50=' + (q(0.5) / 16.667).toFixed(2) + ' p90=' + (q(0.9) / 16.667).toFixed(2) +
      ' max=' + (s[s.length - 1] / 16.667).toFixed(2));
  lagSamples.length = 0;
}

const LOG_FILE = path.join(app.getPath('userData'), 'runtime.log');
function log() {
  const line = '[' + new Date().toISOString() + '] ' + Array.prototype.join.call(arguments, ' ') + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* ignore */ }
  process.stdout.write(line);
}

function findArg(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].indexOf(name + '=') === 0) return argv[i].slice(name.length + 1);
  }
  return null;
}

// ------------------------------------------------------------------ 层级验收：模拟一个"普通窗口"
/**
 * --test-normal-window：开一个真正的不透明普通窗口盖住大部分屏幕，
 * 用来验证「篮球永远不会显示在普通窗口之上」。
 * 验收判据：WindowFromPoint(球心) 必须返回这个窗口的 hwnd，而不是我们的覆盖窗。
 *
 * 这个窗口是**验收夹具**，所以刻意 setAlwaysOnTop(true)：
 * 否则它可能被当前前台应用（例如正在跑命令的编辑器/宿主窗口）压在下面，
 * 判据就变成"测夹具自己"，永远失败。置顶的窗口更苛刻 —— 连置顶窗口都不许被球盖住。
 */
let testWin = null;
function openTestNormalWindow() {
  if (!argv.includes('--test-normal-window')) return;
  const wa = workArea;
  testWin = new BrowserWindow({
    x: wa.x + 80,
    y: wa.y + 60,
    width: Math.max(200, wa.width - 400),
    height: Math.max(200, wa.height - 260),
    frame: true,
    show: false,
    backgroundColor: '#2b6cf0',
    title: '普通窗口（层级测试）',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  testWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:#2b6cf0;color:#fff;font:16px/1.7 sans-serif;padding:18px">' +
    '<h2 style="margin:0 0 8px">普通窗口 · 层级测试</h2>' +
    '<p>任何篮球都不允许显示在这个窗口上面。</p>' +
    '<p>诊断日志里 <code>球心 → 0x…</code> 必须等于本窗口句柄。</p></body>'));
  // ready-to-show 在本机偶发不触发（窗口始终 visible=false，验收就成了空跑），
  // 所以加一个定时兜底 —— 这是验收工具，能显示出来比优雅更重要。
  const reveal = () => {
    if (!testWin || testWin.isDestroyed() || testWin.isVisible()) return;
    // 桌面模式：夹具自己置顶，于是它比我们的覆盖窗"更高"，用来证明
    //          「球永远不会显示在普通窗口之上」（球心命中必须等于它）。
    // 置顶模式：夹具**不能**置顶 —— 那时要证的是反过来那件事
    //          「球显示在所有普通窗口之上」，所以得留一个真正普通的窗口在下面挨着。
    if (currentZMode() !== 'top') testWin.setAlwaysOnTop(true);
    testWin.show();
    setTimeout(anchorToDesktop, 0);
  };
  testWin.once('ready-to-show', reveal);
  setTimeout(reveal, 900);
}

/** 开发/验收用：把渲染结果抓成 PNG，并 dump 窗口层级与命中区域诊断 */
function startCaptureTools() {
  const shot = findArg('--capture');
  const delay = parseInt(findArg('--capture-delay') || '4000', 10);
  const diag = argv.includes('--diag');
  if (!shot && !diag && !findArg('--screencap') && !argv.includes('--fly-test')) return;

  const dump = () => {
    try {
      const ex = native.getExStyle(hwnd);
      const flags = [];
      if (ex & native.constants.WS_EX_LAYERED) flags.push('LAYERED');
      if (ex & native.constants.WS_EX_TOOLWINDOW) flags.push('TOOLWINDOW(不在Alt+Tab)');
      if (ex & native.constants.WS_EX_NOACTIVATE) flags.push('NOACTIVATE(不抢焦点)');
      if (ex & native.constants.WS_EX_TRANSPARENT) flags.push('TRANSPARENT(整窗穿透)');
      if (ex & native.constants.WS_EX_TOPMOST) flags.push('TOPMOST(置顶)');
      log('DIAG exstyle=0x' + (ex >>> 0).toString(16), flags.join('|') || '(none)',
          'visible=' + win.isVisible(), 'alwaysOnTop=' + win.isAlwaysOnTop(),
          'zMode=' + currentZMode(), 'wantTopmost=' + (currentZMode() === 'top'),
          'focused=' + win.isFocused(),
          'bounds=' + JSON.stringify(win.getBounds()),
          'region=' + JSON.stringify(native.getRegionBox(hwnd)));
      const z = native.zInfo(hwnd);
      if (z) {
        // 判据随 zMode 走，两者正好相反：
        //  · desktop：上面压着的是"某个可见窗口"（谁都可以，只要不是桌面），
        //             下面紧邻的必须是桌面锚点。中间不许再夹任何可见窗口。
        //  · top    ：上面**不该有普通窗口**。要点是"普通"——Windows 不允许非置顶窗口
        //             盖住置顶窗口，所以上面要么空着，要么是别的 TOPMOST（典型的
        //             零面积幽灵窗口 Internet Explorer_Hidden 就常驻 z 序顶端）。
        const isTop = currentZMode() === 'top';
        const aboveNote = isTop
          ? (z.above === 0 ? ' <置顶生效 ✓ 上方无可见窗口>'
             : z.aboveIsTopmost
               ? (z.aboveArea <= 0 ? ' <置顶生效 ✓ 上方只有零面积幽灵窗口>'
                                   : ' <置顶生效 ✓ 上方是另一个置顶窗口>')
               : ' <!! 上方有普通窗口压着 ✗>')
          : '';
        log('DIAG zorder', 'zMode=' + currentZMode(),
            'above=0x' + z.above.toString(16) + z.aboveLabel +
              (z.aboveIsTopmostAnchor ? ' (任务栏)' : '') +
              (z.above ? ' topmost=' + z.aboveIsTopmost + ' area=' + z.aboveArea : '') + aboveNote,
            'below=0x' + z.below.toString(16) + z.belowLabel +
              (isTop ? ' <置顶带·below 不必是桌面锚点>'
                     : !z.belowVisible ? ' <不可见·略>'
                     : (z.belowIsProgman ? ' <桌面锚点 ✓>' : ' <!! 不是桌面锚点 ✗>')),
            'belowVisible=' + z.belowVisible,
            'anchor=0x' + z.progman.toString(16) + z.progmanLabel,
            'inZ=' + z.found);
      }
      win.webContents.executeJavaScript(
        'JSON.stringify(window.__pbDiag? window.__pbDiag(): null)'
      ).then(async (s) => {
        log('DIAG renderer', s);
        try {
          const d = JSON.parse(s);
          const me = hwnd;
          const sy = scaleFactor || 1;
          const rows = [];
          // 命中测试的"自己"是谁先摆出来 —— 只用一串 0x… 时，`ball0→0x104d8`
          // 到底是"漏到桌面"还是"命中了我们但 me 过期"，完全看不出来。
          rows.push('me=0x' + me.toString(16) + native.windowLabel(me));
          // 层级验收的靶子：把球**摆进**测试窗口再判命中。
          // 球在窗口矩形之外时，"球心命中谁"说明不了任何问题 —— 之前是拿窗口中心去
          // 测的（那里根本没有球），于是置顶模式恒报"球没能盖住普通窗口"，是假警报。
          // 测试窗口的句柄与矩形**只在这里取一次**：下面判据直接复用，
          // 免得两次 `testWin` 检查之间窗口状态变了导致判据整段被跳过（踩过一次）。
          let tb = null;
          let th = 0;
          if (testWin && !testWin.isDestroyed()) {
            th = native.hwndOf(testWin);
            tb = testWin.getBounds();
            const cx = Math.round(tb.x - workArea.x + tb.width / 2);
            const cy = Math.round(tb.y - workArea.y + tb.height / 2);
            try {
              await win.webContents.executeJavaScript(
                'window.__pbPlace&&window.__pbPlace(0,' + cx + ',' + cy + ',0,0),1');
              await new Promise((r) => setTimeout(r, 200));
              const s2 = await win.webContents.executeJavaScript(
                'JSON.stringify(window.__pbDiag? window.__pbDiag(): null)');
              const d2 = JSON.parse(s2);
              if (d2 && d2.pos && d2.pos.length) d.pos = d2.pos;
            } catch (e) { log('DIAG 摆球失败', e.message); }
          }
          // 球心：命中测试**应当**落到本窗口 —— 但只在球上方没有普通窗口时才成立。
          // desktop 档下球本来就在所有普通窗口之下，桌面上随便开个微信/浏览器，
          // 只要它盖住球心，命中就会是那个窗口。这和"漏到桌面"是两件完全不同的事，
          // 所以这里按命中对象分三档，并把窗口标题打出来（否则一串 0x… 分不清）。
          const progman = native.findProgman();
          for (let i = 0; i < Math.min(3, (d.pos || []).length); i++) {
            const p = d.pos[i];
            const h = native.hitTest(p[0] * sy, p[1] * sy);
            rows.push('ball' + i + '@' + p[0] + ',' + p[1] + ' sleep=' + p[2] + '→' +
              (h === me ? 'OURS ✓'
                : h === progman ? '0x' + h.toString(16) + ' <!! 漏到桌面>' 
                : '0x' + h.toString(16) + native.windowLabel(h) + ' <被前台窗口盖住·desktop 档正常>'));
          }
          // 桌面空白处：必须不是本窗口（否则就是挡住了桌面）
          const disp = screen.getPrimaryDisplay().bounds;
          const blanks = [];
          blanks.push([Math.round(disp.width * 0.5), Math.round(disp.height * 0.35)]);
          blanks.push([Math.round(disp.width * 0.08), Math.round(disp.height * 0.55)]);
          rows.push('progman=0x' + progman.toString(16) + '(z序下方邻居)');
          // 层级验收：只看**落在测试窗口矩形内**的球（上面已经把它们摆进去了）。
          //  · desktop：这些球必须被窗口盖住 —— 球心命中 testWin，不是我们
          //  · top    ：这些球必须盖住窗口 —— 球心命中的是我们，不是 testWin
          // 没有球落在窗内就明说"无法判定"，不要拿一个恒真的条件冒充通过。
          if (tb) {
            const wantOurs = currentZMode() === 'top';
            const inWin = [];
            // 只收"球盘**完全落**在窗口内"的球：球心离边界至少一个球盘半径。
            // 球心骑在边界上时（实测踩过一次：球心 y 正好等于窗口下边 y），
            // 球盘有一半在窗外，该点命中谁取决于 z 序之外的像素细节，判据会假失败。
            const pad = 60;   // 球盘半径 46 + 余量
            for (let i = 0; i < (d.pos || []).length; i++) {
              const p = d.pos[i];
              if (p[0] >= tb.x + pad && p[0] <= tb.x + tb.width - pad &&
                  p[1] >= tb.y + pad && p[1] <= tb.y + tb.height - pad) inWin.push([i, p]);
            }
            if (!inWin.length) {
              rows.push('testWin=0x' + th.toString(16) + ' <无法判定：没有球落在测试窗口内 ✗>');
            } else {
              let ok = 0;
              const det = [];
              for (const [i, p] of inWin) {
                const h = native.hitTest(Math.round(p[0] * sy), Math.round(p[1] * sy));
                const pass = wantOurs ? (h === me) : (h !== me);
                if (pass) ok++;
                det.push('ball' + i + '@' + p[0] + ',' + p[1] + '→' + (h === me ? 'OURS' : '0x' + h.toString(16)) + (pass ? '✓' : '✗'));
              }
              rows.push('testWin=0x' + th.toString(16) + '(普通窗口) ' + JSON.stringify(tb) +
                ' visible=' + testWin.isVisible() + ' 球在窗内 ' + ok + '/' + inWin.length +
                (ok === inWin.length
                  ? (wantOurs ? ' 全 →OURS <球盖住了普通窗口 ✓>' : ' 全 →testWin <窗口盖住了球 ✓>')
                  : ' <!! 判据不满足: ' + det.join(' ') + '>'));
            }
          }
          // 任务栏区域：本窗口根本不该覆盖
          const thb = native.hitTest(10 * sy, (workArea.height + 20) * sy);
          rows.push('taskbar→0x' + thb.toString(16) + (thb === me ? ' !!覆盖了任务栏' : ' (未被覆盖 ok)'));
          // 桌面空白处：必须不是本窗口（否则就是挡住了桌面）。
          // 例外：拖拽 / 右键菜单期间窗口区域被有意撑成整窗（保证 pointermove 不丢，
          // 见 renderer 的 sendShape），此时命中本窗口是**预期**，不该报错。
          const locked = d.shapeLocked === 'locked';
          for (const b of blanks) {
            const h = native.hitTest(b[0] * sy, b[1] * sy);
            rows.push('blank@' + b[0] + ',' + b[1] + '→' +
              (h === me ? (locked ? 'OURS(拖拽/菜单锁定中·预期)' : '!!OURS(挡住了桌面)')
                        : '0x' + h.toString(16) + native.windowLabel(h)));
          }
          // 篮球架的窗口区域：每块矩形的中心都必须命中本窗口。
          // 命中到 **Progman** = 被 SetWindowRgn 裁掉了 = 真实屏幕上"篮球架不见了"
          // （capturePage 截图看不出来，所以必须靠打点，见 tools/region-probe.ps1）。
          // 命中到**别的窗口**是另一回事 —— desktop 档下那是正常的（同上面球心那段），
          // 之前一律标"✗被裁"，把"被 WPS 盖住"误报成"被区域裁掉"。
          const hr = d.hoopRects || [];
          for (let i = 0; i < hr.length; i++) {
            const q = hr[i];
            const qx = Math.round(q[0] + q[2] / 2);
            const qy = Math.round(q[1] + q[3] / 2);
            const h = native.hitTest(qx * sy, qy * sy);
            rows.push('hoopR' + i + '@' + qx + ',' + qy + '→' +
              (h === me ? 'OURS ✓'
                : h === progman ? '0x' + h.toString(16) + ' <!! 被区域裁掉>'
                : '0x' + h.toString(16) + native.windowLabel(h) + ' <被前台窗口盖住·desktop 档正常>'));
          }
          log('DIAG hittest', rows.join(' | '));
        } catch (err) {
          log('DIAG hittest 失败', err.message);
        }
      }).catch((e) => log('DIAG renderer fail', e.message));
    } catch (e) {
      log('DIAG error', e.message);
    }
  };

  const script = findArg('--eval');
  if (script) {
    setTimeout(() => {
      win.webContents.executeJavaScript('(' + script + ')')
        .then((r) => log('EVAL ok', JSON.stringify(r)))
        .catch((e) => log('EVAL fail', e.message));
    }, Math.max(1200, delay - 2200));
  }

  // 层级验收：在诊断 dump 之前先把"普通窗口"摆出来
  if (argv.includes('--test-normal-window')) {
    setTimeout(openTestNormalWindow, Math.max(1200, delay - 3000));
  }

  setTimeout(dump, Math.max(1500, delay - 800));
  if (shot) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(shot), { recursive: true });
        fs.writeFileSync(shot, img.toPNG());
        log('CAPTURED', shot, img.getSize().width + 'x' + img.getSize().height);
      } catch (e) {
        log('CAPTURE FAIL', e.message);
      }
      if (!diag) setTimeout(() => quitApp(), 400);
    }, delay);
  }
  // --exit-after=<ms>：常驻诊断（--diag）调试时也能自动收尾，
  // 避免脚本里忘了带 --capture 导致命令行被永久挂住。
  const exitAfter = parseInt(findArg('--exit-after') || '0', 10);
  if (exitAfter > 0) setTimeout(() => quitApp(), exitAfter);

  // --screencap=<png>：抓**真实屏幕**（不是 webContents.capturePage）。
  // 验证层级/透明通道必须用这个 —— capturePage 只读渲染进程的合成结果，
  // 看不见"窗口到底有没有被别的窗口盖住"。
  const screenShot = findArg('--screencap');
  if (screenShot) {
    const at = parseInt(findArg('--screencap-at') || '0', 10);
    const grab = async () => {
      try {
        const disp = screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: disp.size.width, height: disp.size.height },
        });
        if (!sources.length) { log('SCREENCAP 没有可用源'); return; }
        const img = sources[0].thumbnail;
        fs.mkdirSync(path.dirname(screenShot), { recursive: true });
        fs.writeFileSync(screenShot, img.toPNG());
        log('SCREENCAP', screenShot, img.getSize().width + 'x' + img.getSize().height);
      } catch (e) {
        log('SCREENCAP FAIL', e.message);
      }
    };
    setTimeout(grab, at > 0 ? at : Math.max(1500, delay - 300));
  }

  /**
   * --fly-test —— 「球在空中快速移动时被裁掉一块」的验收夹具。
   *
   * 让 0 号球在窗口中部匀速绕椭圆轨道飞。走的是**不拖拽**的「逐球圆盘」上报路径 ——
   * 拖拽期间窗口区域是整窗，裁不到球，反而复现不出来。球一直在跑，所以随便什么时候
   * 取样都拍得到它，不用去赌"恰好抓到抛出那一瞬"。
   *
   * 截图**不在进程内做**。本机的 `desktopCapturer.getSources()` 每次都返回同一张陈旧
   * 位图（连拍 8 张、乃至跨进程重启，字节完全一致），根本拍不到正在飞的那颗球。
   * 能拍到实时画面的只有外部 src/tools/screencap.ps1（GDI+ CopyFromScreen），
   * 所以这里只负责"把球飞起来 + 按固定间隔把球的位置写进日志"，配合作业：
   *   1) 后台起本进程；
   *   2) 另开一条链路跑 tools\screencap.ps1 连拍；
   *   3) 用日志里的 FLYSTATE 对齐每一张截图拍到了哪个位置。
   *
   * 参数：--fly-hold=<持续毫秒，默认 14000> --fly-out=<capturePage 落盘目录>
   *       --fly-ab=<每个前瞻档位停留毫秒，默认 1500；0 = 不切换、全程用当前档>
   *       --fly-leads=<前瞻档位列表，默认 0,1,2,3,4（单位：物理步长）>
   *       --fly-flat  把球换成纯洋红圆盘，便于从截图中精确量出球的跨度
   *       --fly-probe 把洋红盘半径放到 400（远大于区域圆）—— 可见的洋红块就等于
   *                   区域圆本身，用它直接量出区域的位置与滞后
   */
  if (argv.includes('--fly-test')) {
    const hold = parseInt(findArg('--fly-hold') || '14000', 10);
    const outDir = findArg('--fly-out') || 'tools/shots/burst';
    const flyCap = argv.includes('--fly-cap');
    // 剂量-反应实验：同一次飞行里按固定节拍把球盘前瞻量（LEAD_S）在几个值之间
    // 轮换。别的条件一概不动，于是各组帧之间唯一的差别就是那点外扩半径 ——
    // 这才拿得出"0 帧 → 半月、n 帧 → 整圆"的配对曲线，而不是拿几次不同飞行比
    // （会受遮挡、主进程负载、GC 影响，前后对不上）。
    // 默认扫 0/1/2/3/4 帧；--fly-leads=0,3 可以只看两头。
    const abMs = parseInt(findArg('--fly-ab') || '1500', 10);
    const leads = (findArg('--fly-leads') || '0,1,2,3,4')
      .split(',').map((s) => parseInt(s, 10)).filter((n) => isFinite(n) && n >= 0);
    const begin = Math.max(1500, delay - 1200);
    setTimeout(async () => {
      const js = (src) => win.webContents.executeJavaScript(src);
      // 验收期间把覆盖窗临时抬到最上层，并停掉 1.2s 一次的锚定校正。
      // 为什么必须这样：覆盖窗的正常层级是"桌面之上、所有普通窗口之下"，只要前台
      // 开着任意一个窗口（比如你现在看的这个 IDE），它就被整个盖住 —— 截到的是别人的
      // 界面，打点也全落在别人的窗口上。抬层只影响 z 序，与 SetWindowRgn 的裁剪逻辑无关。
      if (zKeeperTimer) { clearInterval(zKeeperTimer); zKeeperTimer = null; }
      zFrozen = true;
      win.setAlwaysOnTop(true);
      try {
        // --fly-om=<rad/s>：轨道角速度。默认轨道的线速度约 1376px/s，而扔球上限是
        // 2200px/s —— "被削一块"的露出量与球速成正比，所以量滞后时必须能把速度
        // 打到上限附近（om ≈ 5.1），否则低速度会把最坏情况盖过去。
        const flyOm = Number(findArg('--fly-om') || '0');
        log('FLYTEST', await js('JSON.stringify(window.__pbFlyRunner("orbit",0' +
            (flyOm > 0 ? ',' + flyOm : '') + '))'));
        // 打开区域滞后采样：数据由主进程聚合，每 2s 一行 LAGSTAT 写进 runtime.log。
        log('FLYTEST', await js('JSON.stringify(window.__pbFlyRunner("lagprobe",1))'));
        // --fly-flat：把球换成纯洋红圆盘。截图里的球因此能被精确分割，量出来的
        // 跨度就是球的真跨度（橙色篮球的缝线会把像素切碎，桌面上的红字还会被并进来，
        // 见 render.js 构造函数与 README §6.6）。
        if (argv.includes('--fly-flat') || argv.includes('--fly-probe')) {
          // --fly-probe：洋红盘半径取 400，远大于任何一个区域圆，于是可见的洋红块
          // 就是区域圆本身 —— 直接量出区域此刻的位置与半径（见 render.js flatBallR）。
          const pr = argv.includes('--fly-probe') ? ',400' : '';
          log('FLYTEST', await js('JSON.stringify(window.__pbFlyRunner("flat",1' + pr + '))'));
        }
      } catch (e) { log('FLYTEST FAIL', e.message); }
      const t0 = Date.now();
      let capN = 0, iter = 0;
      let leadIdx = -1, lastAbT = t0 - (abMs + 1);
      while (Date.now() - t0 < hold) {
        // 100ms 一次：外部连拍的每张图都要能对上一个球位置，才好量"画面比区域落后多少"。
        // 另外每行 FLYSTATE 都带上当前前瞻量，截图按时间就近配对即可知道它是哪一组。
        await new Promise((r) => setTimeout(r, 100));
        if (abMs > 0 && leads.length > 1 && Date.now() - lastAbT >= abMs) {
          leadIdx = (leadIdx + 1) % leads.length;
          lastAbT = Date.now();
          try {
            log('FLYLEAD', await js('JSON.stringify(window.__pbFlyRunner("lead",' + leads[leadIdx] + '))'));
          } catch (e) { /* 切换失败就维持原状，下一拍再试 */ }
        }
        try { log('FLYSTATE', await js('JSON.stringify(window.__pbFlyRunner("state"))')); }
        catch (e) { break; }
        // 顺带按下 webContents.capturePage()：它拍的是**渲染进程自己的合成结果**，
        // 看得到 canvas 的每一个像素，但**完全看不见 SetWindowRgn 的裁剪**。拿它和真实
        // 屏幕截图对照，是判定"该怪区域还是该怪脏块"的关键一步 —— 已经跑过一轮，43/43
        // 帧都是完整球，结论是 canvas 没问题、被削的只有区域那一层。
        // 但它很贵（软件合成下拍一张 1440x852 透明窗要几十毫秒）且占住主进程，
        // 正好会污染"区域跟不跟得上"这件事本身。所以默认关，只在 --fly-cap 时开。
        if (!flyCap || iter++ % 3) continue;
        try {
          const img = await win.webContents.capturePage();
          const cp = path.join(outDir, 'cap_' + String(capN).padStart(2, '0') + '.png');
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(cp, img.toPNG());
          log('FLYCAP', cp);
        } catch (e) { log('FLYCAP FAIL', e.message); }
        capN++;
      }
      try { await js('window.__pbFlyRunner("stop")'); } catch (e) { /* 收尾失败无所谓 */ }
      // 交还层级：先解冻，摘掉 TOPMOST，再按惯例锚回桌面之上，最后恢复 z 序校正
      zFrozen = false;
      win.setAlwaysOnTop(false);
      anchorToDesktop();
      startZKeeper();
      quitApp();
    }, begin);
  }
}

// ------------------------------------------------------------------ CPU 性能验收
/**
 * --cpu-test=<球数>,<活跃秒>,<静置秒>
 * 在真实透明覆盖窗里跑满 N 个篮球，用 app.getAppMetrics() 逐秒采样 Electron
 * 每一个子进程的 CPU 占比，分「活跃（持续给冲量，永不休眠）」与「静置（自然休眠）」
 * 两段统计，最后落盘 assets/cpu-test.json + 控制台 Markdown。
 *
 * 为什么不用外部工具（tasklist/Get-Process）测：
 * 后台启动的本进程与测量工具可能处在不同的会话/沙箱里，拿不到进程句柄。
 * 进程自己上报的数字更准（还带 Browser/Renderer/GPU 的分项）。
 */
// ------------------------------------------------------------------ 拖拽性能验收
/**
 * --drag-test=<球数>
 *
 * 回答一个具体问题：**"球多时拖球为什么卡，松手为什么立刻流畅？"**
 *
 * 场景（全部在真实覆盖窗里跑，拖拽由渲染进程内部定时器驱动，不动系统鼠标）：
 *   settle         球全部落地休眠                            —— 基线
 *   probe-raf      主循环停到 160ms 巡检，只留一个空转 rAF   —— 量 rAF 回调本身的成本
 *   probe-rafdraw  同上，但每轮都整帧重绘                    —— 量"绘制/合成"的成本
 *   <tag>-hold     在某颗球上挂起拖拽但不移动
 *   <tag>-drag     以 200Hz 绕圈拖（等价于用户报的那个场景）
 *   <tag>-after    松手
 *
 * <tag> 跑两遍做 A/B：`corridor`（拖拽区域跟着指针每帧变）与 `full`（整窗、形状恒定）。
 * 每段的 CPU 用 app.getAppMetrics() 自采（带 Browser / Tab 分项），同时取渲染进程的
 * 计数器（iters / draws / tiles / awake），算出各自的实际频率，落盘
 * assets/drag-test.json + .md。
 */
function startDragTest() {
  const raw = findArg('--drag-test');
  if (!raw) return;

  const spec = String(raw).split(',');
  const ballCount = parseInt(spec[0] || '60', 10);
  const holdSec = parseInt(spec[1] || '4', 10);
  const dragSec = parseInt(spec[2] || '8', 10);
  const afterSec = parseInt(spec[3] || '4', 10);
  const settleSec = 9;
  const warmSec = 6;
  const cores = os.cpus().length;

  const started = Date.now();
  const samples = [];
  let phase = 'warm';

  const sampler = setInterval(() => {
    let total = 0, wake = 0;
    const by = {};
    let procs = 0;
    for (const p of app.getAppMetrics()) {
      const c = (p.cpu && p.cpu.percentCPUUsage) || 0;
      by[p.type] = Math.round(((by[p.type] || 0) + c) * 100) / 100;
      wake += (p.cpu && p.cpu.idleWakeupsPerSecond) || 0;
      total += c;
      procs++;
    }
    samples.push({
      t: Math.round((Date.now() - started) / 1000),
      phase: phase,
      total: Math.round(total * 100) / 100,
      by: by,
      procs: procs,
      wakeups: Math.round(wake * 10) / 10,
    });
  }, 1000);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => ({ error: e.message }));

  // 每个阶段的计数器快照：用来把 CPU 数字换算成"每秒画了多少帧"
  const segs = [];
  let seg = null;
  const enter = async (name) => {
    if (seg) {
      seg.s1 = await js('JSON.stringify(window.__pbDragRunner("state"))');
      seg.endAt = Date.now();
      segs.push(seg);
    }
    phase = name;
    seg = { name: name, startAt: Date.now(), s0: await js('JSON.stringify(window.__pbDragRunner("state"))') };
  };

  (async () => {
    for (let i = 0; i < 40; i++) {
      const ok = await js('typeof window.__pbDragRunner === "function"');
      if (ok === true) break;
      await sleep(250);
    }

    log('DRAGTEST 场景准备：球数=' + ballCount + ' hoop=on');
    await js(
      '(function(){window.__pbSetBalls(' + ballCount + ');' +
      'window.__pbPerf(true);' +
      'if(!window.__pbDiag().hoop)window.__pbToggleHoop();' +
      'return window.__pbDiag().balls;})()'
    );

    phase = 'warm';
    await sleep(warmSec * 1000);
    samples.length = 0;                 // 丢掉预热期的采样

    await enter('settle');
    await sleep(settleSec * 1000);

    // 隔离探针：主循环停到 160ms 巡检，只留探针自己的 rAF 跑。
    // 这样能把「rAF 回调本身的成本」和「renderer.frame 的成本」分开量。
    for (const p of ['raf', 'rafdraw']) {
      await enter('probe-' + p);
      await js('window.__pbDragRunner("probe","' + p + '",4500)');
      await sleep(5000);
    }
    await js('window.__pbDragRunner("probe","end")');
    await sleep(1200);

    // 两个回合只差一处：拖拽期间窗口区域是**整窗放开**还是只报一条**窄走廊**。
    //   full     = 现行实现。整窗矩形在拖拽开始时上报一次，形状字符串恒定 →
    //              SetWindowRgn 被去重掉，主进程零成本。
    //   corridor = 曾经的实现。区域跟着指针每帧变 → 去重永远失效 →
    //              主进程每帧重建区域并重定向窗口表面。
    // corridor 放在前面跑，是为了让可能存在的"越跑越贵"的顺序效应对 full 不利 ——
    // 这样若 full 仍然更省，结论就只会更硬。
    const rounds = [
      { tag: 'corridor', region: 'corridor', cap: 1000 / 62 },
      { tag: 'full', region: 'full', cap: 1000 / 62 },
    ];
    // 记住 0 号球的起始位置：两个回合都从这里起拖，否则第一回合把它丢到哪儿，
    // 第二回合就从哪儿开始 —— 拖到的邻居数量不同，两段根本没法比。
    const startPos = await js('(function(){var p=window.__pbDiag().pos[0];return p?[p[0],p[1]]:null;})()');

    for (const r of rounds) {
      await js('window.__pbDragRunner("end")');
      if (Array.isArray(startPos)) {
        await js('window.__pbPlace(0,' + startPos[0] + ',' + startPos[1] + ',0,0)');
      }
      await js('window.__pbDragRunner("freeze")');
      await js('window.__pbDragRunner("region","' + r.region + '")');
      await js('window.__pbDragRunner("cap",' + r.cap + ')');
      await js('window.__pbDragRunner("begin",0)');
      await js('window.__pbDragRunner("freeze")');

      await enter(r.tag + '-hold');
      await sleep(holdSec * 1000);

      await enter(r.tag + '-drag');
      await js('window.__pbDragRunner("spin",200)');
      await sleep(dragSec * 1000);

      await enter(r.tag + '-after');
      await js('window.__pbDragRunner("end")');
      await sleep(afterSec * 1000);
    }

    await enter('done');
    clearInterval(sampler);

    const stat = (ph) => {
      const xs = samples.filter((s) => s.phase === ph);
      if (!xs.length) return null;
      let sum = 0, max = 0, wake = 0;
      const by = {};
      for (const s of xs) {
        sum += s.total;
        if (s.total > max) max = s.total;
        wake += s.wakeups;
        for (const k in s.by) by[k] = (by[k] || 0) + s.by[k];
      }
      const n = xs.length;
      const byType = {};
      for (const k in by) byType[k] = Math.round((by[k] / n) * 100) / 100;
      return {
        samples: n,
        avgCorePct: Math.round((sum / n) * 100) / 100,
        maxCorePct: Math.round(max * 100) / 100,
        avgMachinePct: Math.round((sum / n / cores) * 100) / 100,
        wakeups: Math.round((wake / n) * 10) / 10,
        byType: byType,
      };
    };

    const rows = [];
    for (const s of segs) {
      if (!s.s1) continue;
      const a = typeof s.s0 === 'string' ? JSON.parse(s.s0) : {};
      const b = typeof s.s1 === 'string' ? JSON.parse(s.s1) : {};
      if (a.error || b.error) continue;
      const secs = Math.max(0.001, (s.endAt - s.startAt) / 1000);
      rows.push({
        phase: s.name,
        sec: Math.round(secs * 10) / 10,
        capMs: b.cap,
        cpu: stat(s.name),
        drawsPerSec: Math.round(((b.draws - a.draws) || 0) / secs),
        itersPerSec: Math.round(((b.iters - a.iters) || 0) / secs),
        loopMsPerSec: Math.round((((b.loopMs - a.loopMs) || 0) / secs) * 10) / 10,
        loopMsAvg: b.iters > a.iters
          ? Math.round(((b.loopMs - a.loopMs) / (b.iters - a.iters)) * 1000) / 1000 : 0,
        drawMsAvg: b.draws > a.draws
          ? Math.round(((b.drawMs - a.drawMs) / (b.draws - a.draws)) * 1000) / 1000 : 0,
        physMs: b.physMs, physMaxMs: b.physMaxMs,
        tiles: b.tiles, tilesTotal: b.tilesTotal,
        pairs: b.pairs, awake: b.awake, balls: b.balls,
      });
    }

    const result = {
      at: new Date().toISOString(),
      electron: process.versions.electron,
      forceNoGpu: forceNoGpu,
      ballCount: ballCount,
      logicalCores: cores,
      cpuModel: (os.cpus()[0] || {}).model || 'unknown',
      screen: workArea,
      holdSec: holdSec, dragSec: dragSec, afterSec: afterSec, settleSec: settleSec,
      phases: rows,
      samples: samples,
    };

    let md = '## 拖拽性能（' + ballCount + ' 球，' + cores + ' 逻辑核，软件合成=' + forceNoGpu + '）\n\n';
    md += '| 阶段 | 绘制节流 | CPU 平均（单核%） | 重绘/秒 | 单次绘制 ms | 轮次/秒 | 主循环 ms/轮 | 物理 ms | 活跃球 |\n';
    md += '|---|---|---|---|---|---|---|---|---|\n';
    for (const r of rows) {
      md += '| ' + r.phase + ' | ' + (r.capMs ? r.capMs + ' ms' : '关闭(旧行为)') + ' | ' +
        (r.cpu ? r.cpu.avgCorePct + '%' : '-') + ' | ' + r.drawsPerSec + ' | ' +
        r.drawMsAvg + ' | ' + r.itersPerSec + ' | ' + r.loopMsAvg + ' | ' +
        r.physMs + ' | ' + r.awake + '/' + r.balls + ' |\n';
    }
    const pick = (n) => rows.find((r) => r.phase === n);
    const base = pick('settle');
    if (base && base.cpu) {
      md += '\n' + ballCount + ' 球全休眠基线 ' + base.cpu.avgCorePct + '%（单核）。\n';
      for (const tag of ['orig', 'fix']) {
        const h = pick(tag + '-hold'), dg = pick(tag + '-drag'), af = pick(tag + '-after');
        if (!h || !h.cpu) continue;
        md += '- ' + tag + '：挂拖拽不动 ' + h.cpu.avgCorePct + '%（' + h.drawsPerSec +
          ' 重绘/秒）→ 拖动 ' + (dg && dg.cpu ? dg.cpu.avgCorePct + '%' : '-') +
          ' → 松手 ' + (af && af.cpu ? af.cpu.avgCorePct + '%' : '-') + '\n';
      }
    }

    const dir = app.isPackaged
      ? app.getPath('userData')
      : path.join(__dirname, '..', 'assets');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'drag-test.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(dir, 'drag-test.md'), md);
      log('DRAGTEST 已写入 ' + dir);
    } catch (e) { log('DRAGTEST 写文件失败', dir, e.message); }

    for (const r of rows) {
      log('DRAGTEST ' + r.phase + ' cpu=' + (r.cpu ? r.cpu.avgCorePct : '-') +
          '% draws/s=' + r.drawsPerSec + ' drawMs=' + r.drawMsAvg +
          ' iters/s=' + r.itersPerSec + ' loopMs/iter=' + r.loopMsAvg +
          ' loopMs/s=' + r.loopMsPerSec + ' physMs=' + r.physMs + ' awake=' + r.awake);
    }
    log('DRAGTEST done');

    await sleep(400);
    quitApp();
  })().catch((e) => {
    clearInterval(sampler);
    log('DRAGTEST 失败', e && e.stack);
    quitApp();
  });
}


function startCpuTest() {
  const raw = findArg('--cpu-test');
  if (!raw) return;

  const spec = String(raw).split(',');
  const ballCount = parseInt(spec[0] || '20', 10);
  const activeSec = parseInt(spec[1] || '20', 10);
  const idleSec = parseInt(spec[2] || '12', 10);
  const warmSec = 8;
  const settleSec = 6;
  const cores = os.cpus().length;

  const started = Date.now();
  const samples = [];
  let phase = 'warm';

  const sampler = setInterval(() => {
    let total = 0, wake = 0;
    const by = {};
    let procs = 0;
    for (const p of app.getAppMetrics()) {
      const c = (p.cpu && p.cpu.percentCPUUsage) || 0;
      by[p.type] = Math.round(((by[p.type] || 0) + c) * 100) / 100;
      wake += (p.cpu && p.cpu.idleWakeupsPerSecond) || 0;
      total += c;
      procs++;
    }
    samples.push({
      t: Math.round((Date.now() - started) / 1000),
      phase: phase,
      total: Math.round(total * 100) / 100,
      by: by,
      procs: procs,
      wakeups: Math.round(wake * 10) / 10,
    });
  }, 1000);

  const stat = (ph) => {
    const xs = samples.filter((s) => s.phase === ph);
    if (!xs.length) return null;
    let sum = 0, max = 0, wake = 0;
    const by = {};
    for (const s of xs) {
      sum += s.total;
      if (s.total > max) max = s.total;
      wake += s.wakeups;
      for (const k in s.by) by[k] = (by[k] || 0) + s.by[k];
    }
    const avg = sum / xs.length;
    for (const k in by) by[k] = Math.round((by[k] / xs.length) * 100) / 100;
    return {
      samples: xs.length,
      avgCorePct: Math.round(avg * 100) / 100,
      maxCorePct: Math.round(max * 100) / 100,
      avgMachinePct: Math.round((avg / cores) * 100) / 100,
      byType: by,
      avgWakeups: Math.round((wake / xs.length) * 10) / 10,
    };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => ({ error: e.message }));

  (async () => {
    // 等渲染进程把钩子挂上
    for (let i = 0; i < 40; i++) {
      const ok = await js('typeof window.__pbDiag === "function"');
      if (ok === true) break;
      await sleep(250);
    }

    log('CPUTEST 场景准备：球数=' + ballCount + ' hoop=on chaos=700ms');
    await js(
      '(function(){window.__pbSetBalls(' + ballCount + ');' +
      'if(!window.__pbDiag().hoop)window.__pbToggleHoop();' +
      'window.__pbPerf(true);window.__pbChaos(true,700);return window.__pbDiag().balls;})()'
    );

    phase = 'warm';
    await sleep(warmSec * 1000);

    phase = 'active';
    await sleep(activeSec * 1000);
    const activeDiag = await js('JSON.stringify(window.__pbDiag())');

    // 沉降期：撤掉外力后球需要几秒落地并进入 Matter 的休眠判定。
    // 这一段不计入静置统计，否则测到的是"减速过程"而不是稳态。
    phase = 'settle';
    await js('(function(){window.__pbChaos(false);return "chaos-off";})()');
    await sleep(settleSec * 1000);

    phase = 'idle';
    await sleep(idleSec * 1000);
    const idleDiag = await js('JSON.stringify(window.__pbDiag())');

    // 空闲期唤醒延迟（量的是 wake() → 主循环真正开始处理）
    let wakeLat = null;
    try {
      wakeLat = await js('window.__pbWakeLatency(5)');
    } catch (e) { log('CPUTEST 唤醒延迟探测失败', e.message); }

    phase = 'done';
    clearInterval(sampler);

    const result = {
      at: new Date().toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      forceNoGpu: forceNoGpu,
      softwareCompositing: forceNoGpu,
      ballCount: ballCount,
      logicalCores: cores,
      cpuModel: (os.cpus()[0] || {}).model || 'unknown',
      screen: workArea,
      warmSec: warmSec,
      settleSec: settleSec,
      activeSec: activeSec,
      idleSec: idleSec,
      active: stat('active'),
      settle: stat('settle'),
      idle: stat('idle'),
      wakeLatency: wakeLat,
      rendererActive: activeDiag,
      rendererIdle: idleDiag,
      samples: samples.filter((s) => s.phase !== 'warm'),
    };

    let md = '## CPU 占用（' + ballCount + ' 球，' + cores + ' 逻辑核）\n\n';
    md += '| 阶段 | 采样 | 平均 CPU（单核%） | 峰值（单核%） | 整机占用（' + cores + ' 核） |\n';
    md += '|---|---|---|---|---|\n';
    const row = (name, s) => s
      ? '| ' + name + ' | ' + s.samples + 's | ' + s.avgCorePct + '% | ' + s.maxCorePct + '% | ' +
        s.avgMachinePct + '% |\n'
      : '';
    md += row('活跃（20 球持续运动）', result.active);
    md += row('沉降（撤力后落地）', result.settle);
    md += row('静置（全部休眠）', result.idle);
    if (result.active) {
      md += '\n分进程（活跃阶段，单核%）：' +
        Object.keys(result.active.byType).map((k) => k + ' ' + result.active.byType[k] + '%').join(' · ') + '\n';
    }
    if (wakeLat && wakeLat.idle) {
      md += '\n空闲期唤醒延迟：平均 ' + wakeLat.avgMs + ' ms / 中位 ' + wakeLat.p50Ms +
            ' ms / 最大 ' + wakeLat.maxMs + ' ms（' + wakeLat.samples + ' 次采样）\n';
    }

    // 打包后 __dirname 在只读的 app.asar 里，不能往 assets/ 写；改用 userData
    const dir = app.isPackaged
      ? app.getPath('userData')
      : path.join(__dirname, '..', 'assets');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cpu-test.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(dir, 'cpu-test.md'), md);
      log('CPUTEST 已写入 ' + dir);
    } catch (e) { log('CPUTEST 写文件失败', dir, e.message); }

    log('CPUTEST result=' + JSON.stringify({
      balls: ballCount, cores: cores, forceNoGpu: forceNoGpu,
      active: result.active, idle: result.idle,
    }));
    log('CPUTEST diagActive=' + activeDiag);
    log('CPUTEST diagIdle=' + idleDiag);
    log('CPUTEST done');

    await sleep(400);
    quitApp();
  })().catch((e) => {
    clearInterval(sampler);
    log('CPUTEST 失败', e && e.stack);
    quitApp();
  });
}

// ------------------------------------------------------------------ 窗口
function computeWorkArea() {
  const disp = screen.getPrimaryDisplay();
  scaleFactor = disp.scaleFactor || 1;

  // 优先用 Win32 的 SPI_GETWORKAREA（物理像素），它把任务栏、停靠栏都排除了
  const phys = native.getWorkArea();
  if (phys && phys.width > 100 && phys.height > 100) {
    // Electron 的 API 用 DIP；统一换算成 DIP 作为窗口 bounds
    const x = phys.x / scaleFactor;
    const y = phys.y / scaleFactor;
    const width = phys.width / scaleFactor;
    const height = phys.height / scaleFactor;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  const wa = disp.workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}

function createWindow() {
  workArea = computeWorkArea();

  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    acceptFirstMouse: true,
    thickFrame: false,
    enableLargerThanScreen: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
      devTools: argv.includes('--dev'),
    },
  });

  win.setMenuBarVisibility(false);
  win.setIgnoreMouseEvents(false);

  // 渲染进程崩溃/退出时不要让主进程卡死
  win.webContents.on('render-process-gone', (e, details) => {
    log('render-process-gone', JSON.stringify(details));
    setTimeout(() => { if (!app.isQuitting) win.reload(); }, 1200);
  });
  win.webContents.on('console-message', (e, level, message, line, src) => {
    log('[renderer:' + level + ']', message, '(' + String(src).split(/[\\/]/).pop() + ':' + line + ')');
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.webContents.on('preload-error', (e, p, err) => log('preload-error', p, err && err.message));
  win.webContents.on('did-finish-load', () => { mark('did-finish-load'); log('did-finish-load'); });
  win.webContents.on('ready-to-show', () => mark('ready-to-show'));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    // 必须在 show 之后：Windows 会把刚显示的窗口放到普通窗口带最顶，
    // 这一下把它压回 z 序最底（桌面之上、所有普通窗口之下）。
    setTimeout(anchorToDesktop, 0);
    setTimeout(anchorToDesktop, 60);
    setTimeout(anchorToDesktop, 300);
  });
  win.on('show', () => setTimeout(anchorToDesktop, 0));
  win.on('focus', () => setTimeout(anchorToDesktop, 0));

  hwnd = native.hwndOf(win);
  mark('window-created');
  log('window created hwnd=0x' + hwnd.toString(16), 'scale=' + scaleFactor,
      'workArea=' + JSON.stringify(workArea), 'native=' + native.api.available,
      native.api.reason || '', 'stream=' + forceStream, 'noGpu=' + forceNoGpu,
      'dcompOff=' + app.commandLine.hasSwitch('disable-direct-composition'),
      /**
       * 设备画像。2K 希沃白板 / 换显示器那类"就这台机器不对"的问题，
       * 排障第一步就是看这一行：真正的画布像素数 = 分辨率 × scale，
       * 一次整帧绘制的成本正比于它（见 §6.10 ⑤ 与 renderer 的插值补帧预算）。
       */
      'display=' + (() => {
        const d = screen.getPrimaryDisplay();
        const sc = d.scaleFactor || 1;
        // `mpx` 才是"一次整帧绘制成本"对应的量（= 分辨率 × 缩放²），比分辨率本身有用得多：
        // 2560×1440@1 = 3.7Mpx，2K@125% = 5.8Mpx，4K@150% = 18.7Mpx（画布上限会夹到 8.3）
        const mpx = Math.round(d.bounds.width * sc * d.bounds.height * sc / 1e4) / 100;
        return d.bounds.width + 'x' + d.bounds.height + '@' + (d.displayFrequency || 0) + 'Hz' +
               ' scale=' + sc + ' mpx=' + mpx;
      })());
  /**
   * 串流兼容模式专用一行日志。排障时先 grep `STREAM` ——
   *   stream       实际是否生效
   *   src          依据（arg=命令行 / user=配置 / user-off=用户显式关过 / auto=环境检测 / default=默认关）
   *   cfg          配置里写的是什么（与 stream 不一致时能立刻看出是命令行压过的）
   *   remote       是不是远程会话（SM_REMOTESESSION）
   *   virtual      命中关键字的那条设备名（null = 没认出虚拟显示）
   *   sw           本次真正加进 Chromium 命令行的开关
   *   devices      全部显示设备名（确认"这台机器装了什么显示驱动"）
   */
  log('STREAM', 'stream=' + forceStream, 'src=' + streamInfo.source,
      'cfg=' + (cfg.streamMode === true), 'explicit=' + (cfg.streamExplicit === true),
      'remote=' + envInfo.remote, 'virtual=' + JSON.stringify(envInfo.virtual),
      'sw=[' + streamSwitches.join(',') + ']',
      'active=[' + ((displayInfo.activeDevices || []).join(' | ')) + ']',
      'devices=[' + envInfo.devices.join(' | ') + ']');
  log('BOOT', bootLine());

  // 初始命中状态：先整窗不接受点击，等渲染进程上报真实形状
  if (native.api.available) {
    if (cfg.hitTestMode === 'hook') {
      setupHook();
      native.setClickThrough(hwnd, true);
    } else {
      native.applyShape(hwnd, { circles: [], rects: [] }, scaleFactor);
    }
  }

  screen.on('display-metrics-changed', onDisplayChanged);
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);

  startCaptureTools();
  startCpuTest();
  startDragTest();
}

function onDisplayChanged() {
  if (!win || win.isDestroyed()) return;
  workArea = computeWorkArea();
  win.setBounds(workArea);
  const disp = screen.getPrimaryDisplay();
  scaleFactor = disp.scaleFactor || 1;
  lastShapeJson = '';
  win.webContents.send('layout', {
    workArea: workArea,
    scaleFactor: scaleFactor,
    displayHz: disp.displayFrequency || 0,
  });
  setTimeout(anchorToDesktop, 60);

  // 远程控制软件（UU 远程的「超级屏」等）会挂一个虚拟显示驱动，连接/断开时触发这里。
  // 这类环境正是「球整层不见」的高发场景（见 src/stream.js），所以这里要重判一次，
  // 而且这次是**看当前环境**而不是看配置。
  if (forceStream) return;
  const now = native.getDisplayInfo ? native.getDisplayInfo() : { remote: false, virtual: null, devices: [] };
  const again = stream.resolve({
    argv, config: config.get(), remoteSession: now.remote,
    devices: now.activeDevices && now.activeDevices.length ? now.activeDevices : now.devices,
    hints: config.get().streamDisplayHints,
  });
  /**
   * 换屏/插拔投屏时会走到这里。这一行是"换设备之后不对"的第一现场：
   * 分辨率、缩放、刷新率、画布像素数，以及渲染进程接下来会用来定节拍的 displayHz。
   */
  const db = disp.bounds, dsc = disp.scaleFactor || 1;
  log('DISPLAYCHANGE', 'display=' + db.width + 'x' + db.height + '@' + (disp.displayFrequency || 0) + 'Hz',
      'scale=' + dsc, 'mpx=' + (Math.round(db.width * dsc * db.height * dsc / 1e4) / 100),
      'remote=' + now.remote, 'virtual=' + JSON.stringify(now.virtual || null),
      'autoWouldBe=' + again.active, 'src=' + again.source);

  if (again.source === 'auto' && !again.explicit) {
    // 自动档 + 检测到虚拟/远程显示 → **直接带着兼容开关重启**。
    // 必须自动：这个场景的用户正在用手机看屏幕，"去托盘点一下开关"他根本够不着
    // （手机上看到的是没有球的画面）。只做一次（streamRelaunched），且用户显式表态过
    // （explicit）就绝不越权 —— 否则会变成"我明明关了，它又自己开"。
    if (streamRelaunched) return;
    streamRelaunched = true;
    log('DISPLAYCHANGE 检测到虚拟/远程显示（' + (now.virtual || 'remote session') +
        '）→ 自动以串流兼容模式重启');
    try {
      win.webContents.send('action', { type: 'toast', text: '检测到远程/虚拟显示，正在启用串流兼容模式…' });
    } catch (e) { /* ignore */ }
    setTimeout(() => {
      app.isQuitting = true;
      app.relaunch({ args: stream.sanitizeArgs(process.argv.slice(1), 'on') });
      app.exit(0);
    }, 900);
    return;
  }

  if (!streamHinted) {
    streamHinted = true;
    log('DISPLAYCHANGE 显示器拓扑变化 -> 若正在远程串流，请在托盘开启「串流兼容模式」');
    try {
      win.webContents.send('action', {
        type: 'toast',
        text: '显示器已变化：若正在远程/多屏串流，请到托盘开启「串流兼容模式」',
      });
    } catch (e) { /* ignore */ }
  }
}

// ------------------------------------------------------------------ 层级
/**
 * 窗口层级有两种互斥的目标，由 config.zMode 选择（托盘菜单 / 球的右键菜单可即时切换）：
 *
 *  · 'desktop'（默认）—— **浮于桌面图标之上、所有普通窗口之下**。像个桌面挂件：
 *      别的窗口一打开就把它盖住。做法是把窗口插到桌面锚点窗口的正上方，
 *      见 native.anchorAboveDesktop（那里记着两次翻车：锚点取"Progman 上面那一个"
 *      会跳层直达顶端；HWND_BOTTOM 会掉到 Progman 下面被壁纸盖住）。
 *  · 'top' —— **显示在所有普通窗口与任务栏之上**。前台开着浏览器/IDE 也看得见、
 *      摸得到。做法是 setAlwaysOnTop(true, 'screen-saver')（= WS_EX_TOPMOST + 最高 band）。
 *
 * ⚠️ 两者不可叠加：一旦设了 TOPMOST，**绝不能再调 anchorAboveDesktop** ——
 *    SetWindowPos 插到某个非置顶窗口下面，Windows 会顺手把 TOPMOST 属性剥掉，
 *    于是置顶"自己"失效。所以下面每一处 z 序操作都必须先看模式再动手。
 *
 * 逐像素点击穿透（SetWindowRgn）与层级无关，两种模式下都照常生效：
 * 球盘/篮筐之外依旧直接点到桌面，不会因为置顶就挡住整个屏幕。
 */
function currentZMode() {
  if (zModeOverride) return zModeOverride;
  return config.get().zMode === 'top' ? 'top' : 'desktop';
}

/** 按当前 zMode 把窗口摆到位（唯一入口：show / focus / 显示器变化 / 切模式都走它） */
function anchorToDesktop() {
  if (!win || win.isDestroyed()) return;
  // 验收夹具（--fly-test）期间冻结层级：这个 bug 只在真实屏幕上看得到，而覆盖窗的
  // 正常层级（桌面模式）是"桌面之上、所有普通窗口之下"，前台任何窗口都会把它整个盖住。
  // 夹具要临时抬到最上层，就必须同时挡住所有会把它拽回去的路径 —— 除了下面这个
  // 函数（show/focus 事件都会调它），还有 1.2s 一次的 zKeeper。
  if (zFrozen) return;

  if (currentZMode() === 'top') {
    // 置顶：'screen-saver' 是 Windows 上最高的 band，连任务栏一起压住。
    // 重复调用无害（已是 TOPMOST 时 Electron 不会再发 SetWindowPos）。
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
    return;
  }
  win.setAlwaysOnTop(false);
  native.anchorAboveDesktop(hwnd);
}

/**
 * 切换层级模式并**立即生效**（不重启）。
 * 从 top 切回 desktop 时，除了摘掉 TOPMOST，还要手动锚一次 —— 否则窗口会停在
 * "普通带最顶部"，也就是盖住所有普通窗口，与 desktop 语义正好相反。
 */
function setZMode(mode) {
  const next = mode === 'top' ? 'top' : 'desktop';
  config.patch({ zMode: next });
  config.save();
  anchorToDesktop();
  rebuildTray(config.get());
  log('窗口层级切换 ->', next);
  if (win && !win.isDestroyed()) {
    win.webContents.send('action', { type: 'sync-state', zMode: next });
    win.webContents.send('action', {
      type: 'toast',
      text: next === 'top' ? '已置顶：显示在所有窗口之上' : '已贴回桌面层：被普通窗口盖住',
    });
  }
}

function startZKeeper() {
  if (zKeeperTimer) clearInterval(zKeeperTimer);
  // ShowWindow 会把窗口带到普通带最顶部（托盘里重新显示、Win+D 之后都会发生），
  // 别的程序可能也会搅乱 z 序。定时校正比事件驱动更稳，
  // 代价是一次 SetWindowPos（桌面模式）或一次幂等检查（置顶模式），几乎零开销。
  zKeeperTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (zFrozen) return;
    if (currentZMode() === 'top') {
      // 置顶模式下只要被谁挤掉 TOPMOST 就补回来（比每 1.2s 无条件 SetWindowPos 便宜）
      if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
      return;
    }
    native.anchorAboveDesktop(hwnd);
  }, 1200);
}

// ------------------------------------------------------------------ 命中（备用方案：全局低级鼠标钩子）
function setupHook() {
  const ok = native.installMouseHook((msg, x, y) => {
    if (hookState.locked) return;
    const shape = hookState.lastShape;
    if (!shape) return;
    const sx = x / scaleFactor;
    const sy = y / scaleFactor;
    const wa = workArea;
    let inside = false;
    if (sx >= wa.x && sy >= wa.y && sx <= wa.x + wa.width && sy <= wa.y + wa.height) {
      const lx = sx - wa.x, ly = sy - wa.y;
      const circles = shape.circles;
      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        const dx = lx - c[0], dy = ly - c[1];
        if (dx * dx + dy * dy <= c[2] * c[2]) { inside = true; break; }
      }
      if (!inside) {
        const rects = shape.rects;
        for (let i = 0; i < rects.length; i++) {
          const q = rects[i];
          if (lx >= q[0] && ly >= q[1] && lx <= q[0] + q[2] && ly <= q[1] + q[3]) { inside = true; break; }
        }
      }
    }
    if (inside !== hookState.interactive) {
      hookState.interactive = inside;
      native.setClickThrough(hwnd, !inside);
    }
  });
  log('hitTestMode=hook install ->', ok, native.api.reason || '');
}

// ------------------------------------------------------------------ 可交互形状
/**
 * 区域管线的**人为滞后**（只有 --region-lag=<ms> 时才非零，仅验收用）。
 *
 * 存在的理由：`SetWindowRgn` 比画面晚 1~2 帧，是"球飞行时被裁掉一块"的根因，
 * 但要坐实这条因果，必须先有一个**阳性对照** —— 让区域确定地滞后一个已知时长，
 * 看球是不是就按预期缺一块。否则"修复前拍不到、修复后也拍不到"只能得出
 * "这次没复现"，永远区分不出「修好了」和「这次没触发」。
 *
 * 语义刻意做成**队列深度 1**：滞后期内新来的形状直接顶掉还没应用的那个，
 * 于是区域恒定落后 regionLagMs，而不会越堆越久。真实拥塞的管线就是这样：
 * 它不排队重放每一帧，只是永远在用稍旧的那一份数据。
 *
 * 只作用于「逐球圆盘」这条常规路径。拖拽/菜单锁定的整窗矩形不走这里 ——
 * 那条路径漏设一次菜单就会被裁成半圆，不能为了做实验给它加延迟。
 */
const regionLagMs = parseInt(findArg('--region-lag') || '0', 10) || 0;
if (regionLagMs > 0) log('区域管线人为滞后 ' + regionLagMs + 'ms（验收阳性对照，非默认行为）');
let regionLagTimer = null;
let regionLagShape = null;

function applyNativeShape(shape) {
  const ok = native.applyShape(hwnd, shape, scaleFactor);
  if (!ok) {
    regionFailures++;
    log('SetWindowRgn 失败 #' + regionFailures, '形状圆数=' + shape.circles.length,
        'rects=' + shape.rects.length, native.api.reason || '');
    if (regionFailures >= 3) {
      regionDisabled = true;
      log('SetWindowRgn 连续失败，回退到 Electron setIgnoreMouseEvents(forward)');
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  } else {
    if (regionFailures > 0 || !okLoggedRegion) {
      okLoggedRegion = true;
      mark('first-region-ok');
      log('SetWindowRgn OK region=' + JSON.stringify(native.getRegionBox(hwnd)));
      log('BOOT', bootLine());
    }
    regionFailures = 0;
  }
}

function applyShapeMessage(shape, locked) {
  if (!win || win.isDestroyed()) return;
  if (locked) {
    // 拖拽 / 菜单打开期间：整窗可点，保证 pointermove 与菜单点击不丢。
    // 这里不做去重 —— 锁定的窗口区域就是「整块矩形」，重复设置代价极低，
    // 但一旦漏设，菜单就会被上一次的球圆盘区域裁成半圆（踩过这个坑）。
    if (regionLagTimer) { clearTimeout(regionLagTimer); regionLagTimer = null; regionLagShape = null; }
    lastShapeJson = 'LOCKED';
    if (native.api.available && !regionDisabled) {
      native.applyShape(hwnd, { circles: [], rects: [[0, 0, workArea.width, workArea.height]] }, scaleFactor);
    }
    if (cfg.hitTestMode === 'hook') { hookState.locked = true; native.setClickThrough(hwnd, false); }
    return;
  }

  if (cfg.hitTestMode === 'hook') {
    hookState.locked = false;
    hookState.lastShape = shape;
    return;
  }

  const json = JSON.stringify(shape);
  if (json === lastShapeJson) return;
  lastShapeJson = json;
  if (!native.api.available || regionDisabled) return;

  // 采样放在去重之后、真正 SetWindowRgn 之前：这才是"区域生效时刻"。
  noteRegionLag(shape);

  if (regionLagMs > 0) {
    regionLagShape = shape;
    if (!regionLagTimer) {
      regionLagTimer = setTimeout(() => {
        regionLagTimer = null;
        const s = regionLagShape;
        regionLagShape = null;
        if (s && native.api.available && !regionDisabled) applyNativeShape(s);
      }, regionLagMs);
    }
    return;
  }

  applyNativeShape(shape);
}

ipcMain.on('shape', (e, shape, locked) => applyShapeMessage(shape, !!locked));

/**
 * 同步版本：调用方会阻塞到区域真正设定完成。
 * 右键菜单必须走这条 —— 菜单是在 DOM 里显示的，DOM 合成与 SetWindowRgn 是
 * 两条独立的流水线，用异步 IPC 时菜单会先于区域更新露面，
 * 于是出现"菜单被裁成半圆"的一瞬（甚至一直卡着）。
 */
ipcMain.on('shape-sync', (e, shape, locked) => {
  try { applyShapeMessage(shape, !!locked); } catch (err) { log('shape-sync 失败', err.message); }
  e.returnValue = true;
});

// ------------------------------------------------------------------ 状态与配置
ipcMain.on('patch-config', (e, p) => {
  const next = config.patch(p);
  if ('autoStart' in p) applyAutoStart(next.autoStart);
  if ('zMode' in p) { anchorToDesktop(); rebuildTray(next); }
  if ('ballCount' in p || 'hoopEnabled' in p || 'soundEnabled' in p ||
      'showPerf' in p || 'showControlBar' in p ||
      'skin' in p || 'goldenEnabled' in p || 'showHud' in p || 'achievements' in p ||
      'fxBurst' in p || 'trail' in p || 'trailStyle' in p) {
    rebuildTray(next);
  }
  config.save();
});

ipcMain.on('save-balls', (e, states) => {
  config.patch({ ballStates: states });
  config.save();
});

ipcMain.handle('set-autostart', (e, on) => {
  applyAutoStart(!!on);
  config.patch({ autoStart: !!on });
  config.save();
  rebuildTray(config.get());
  return true;
});

ipcMain.on('quit-app', () => quitApp());

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  native: native.api.available,
  nativeReason: native.api.reason || '',
  hook: native.api.hookAvailable,
  hitTestMode: cfg.hitTestMode,
  regionDisabled,
  configPath: config.path(),
  logPath: LOG_FILE,
  workArea,
  scaleFactor,
  /** 主显示器刷新率（Hz）。渲染进程用它把绘制节拍对上屏幕，并在性能面板里显示。 */
  displayHz: screen.getPrimaryDisplay().displayFrequency || 0,
  /**
   * 主显示器的**物理分辨率与缩放**。2K 希沃白板那类"换设备就卡/就缺画面"的问题，
   * 第一眼要看的就是它 —— 因为真正的画布像素数是 `分辨率 × 缩放`，
   * 而一次整帧绘制的成本正比于它（见 §6.10 ⑤）。
   */
  displaySize: (() => {
    const b = screen.getPrimaryDisplay().bounds;
    return { w: b.width, h: b.height };
  })(),
  displayScale: screen.getPrimaryDisplay().scaleFactor || 1,
  packed: app.isPackaged,
  zMode: currentZMode(),
  anchor: currentZMode() === 'top' ? 'topmost' : 'above-desktop',
  /**
   * 串流兼容模式：`streamMode` 是**实际生效**值（不再是配置值），
   * `streamConfigured` / `streamSource` / `streamExplicit` 说明这个结果的来历，
   * 这样"菜单显示的和实际跑的不一致"这类问题从一开始就查不出来（现在能查到）。
   */
  streamMode: forceStream,
  streamConfigured: cfg.streamMode === true,
  streamExplicit: cfg.streamExplicit === true,
  streamSource: streamInfo.source,
  streamSwitches: streamSwitches.slice(),
  streamDetected: envInfo.virtual,
  remoteSession: envInfo.remote,
  displayDevices: envInfo.devices,
  compatFlags: {
    dcompOff: app.commandLine.hasSwitch('disable-direct-composition'),
    gpuCompOff: app.commandLine.hasSwitch('disable-gpu-compositing'),
    zeroCopyOff: app.commandLine.hasSwitch('disable-zero-copy'),
  },
}));

ipcMain.on('open-log', () => shell.openPath(LOG_FILE));
ipcMain.on('open-config-dir', () => shell.openPath(path.dirname(config.path())));

// ------------------------------------------------------------------ 球皮肤素材（按需单张）
/**
 * 球皮肤用的真实照片 / 行星贴图 → data URL。**按需单张**读取（2026-10-07 启动优化）。
 *
 * 旧实现在 preload 里 `readTextures()` 一次性同步读走全部三张（390 KB → 520 KB base64），
 * 由渲染进程 boot() 同步调用。三张图只有西瓜/地球/木星用得上，而默认皮肤 classic
 * 完全不需要素材 —— 于是每次启动都在首帧之前白读 390 KB。
 *
 * 改为 `invoke` + 单张之后，默认皮肤一次 IPC 都不发；素材皮肤切过去时才读。
 * 读盘结果缓存在 `texCache`（key = 素材名），反复切皮肤不重复读、不重复 base64。
 *
 * 为什么必须是 data URL 而不是让页面 `<img src="textures/x.jpg">` 自己拿：页面是
 * `file://`，`file://` 页面里的 `file://` 图片算跨源，画进 canvas 后画布被污染，
 * `getImageData` 抛 SecurityError —— 而球面重投影必须逐像素读源图（render.js::bakeSphere）。
 */
const TEX_FILES = {
  watermelon: 'watermelon.jpg',
  earth: 'earth.jpg',
  jupiter: 'jupiter.jpg',
};
const texCache = new Map();
ipcMain.handle('get-texture', (e, name) => {
  const file = TEX_FILES[name];
  if (!file) return null;                       // 未知键名：不是致命错误，走程序化外观
  if (texCache.has(name)) return texCache.get(name);
  let url = null;
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'renderer', 'textures', file));
    url = 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (err) {
    // 素材缺失不是致命错误：打包时漏掉 / 用户手动删掉都可能走到这里，只警告不抛。
    log('[textures] 缺少 ' + file + '：' + err.message);
  }
  texCache.set(name, url);
  return url;
});

// 渲染进程就绪 → 下发配置（唯一一次批量初始化）
ipcMain.on('renderer-ready', (e) => {
  if (!win || win.isDestroyed()) return;
  mark('renderer-ready');
  log('BOOT', bootLine());
  e.sender.send('init', config.get());
  // 顺带把布局/刷新率发一次：渲染进程要用 displayHz 决定绘制节拍
  // （60/75/120Hz 屏、以及白板投屏切成 30Hz 时都要跟着变，见 app.js::applyDisplayHz）。
  e.sender.send('layout', {
    workArea: workArea,
    scaleFactor: scaleFactor,
    displayHz: screen.getPrimaryDisplay().displayFrequency || 0,
  });
});

function applyAutoStart(on) {
  try {
    const opts = { openAtLogin: !!on, openAsHidden: true };
    if (!app.isPackaged) {
      opts.path = process.execPath;
      opts.args = [app.getAppPath()];
    }
    app.setLoginItemSettings(opts);
  } catch (e) {
    log('setLoginItemSettings 失败', e.message);
  }
}

// ------------------------------------------------------------------ 托盘
function trayImage() {
  const p = path.join(__dirname, '..', 'assets', 'tray.png');
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) {
    // 兜底：16x16 橙色方块，保证托盘图标一定存在
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = 0x2f; buf[i * 4 + 1] = 0x6b; buf[i * 4 + 2] = 0xf0; buf[i * 4 + 3] = 0xff;
    }
    img = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  return img;
}

function rebuildTray(state) {
  const s = state || config.get();
  if (!tray) {
    try {
      tray = new Tray(trayImage());
      tray.setIgnoreDoubleClickEvents(true);
    } catch (e) {
      log('托盘创建失败', e.message);
      return;
    }
  }
  const send = (type) => () => { if (win && !win.isDestroyed()) win.webContents.send('action', { type }); };
  /** 皮肤显示名（与 renderer/render.js 的 SKINS 保持一致；这里只用于菜单文案） */
  const SKIN_LABEL = {
    classic: '经典篮球', neon: '能量球', soccer: '足球', watermelon: '西瓜', planet: '星球',
  };
  const menu = Menu.buildFromTemplate([
    { label: '桌面物理篮球  v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: '增加一颗篮球', accelerator: 'Ctrl+Shift+Up', click: send('add') },
    { label: '减少一颗篮球', accelerator: 'Ctrl+Shift+Down', click: send('remove') },
    { label: '把所有球抛起来', accelerator: 'Ctrl+Shift+Space', click: send('throw-all') },
    { label: '清空重来（得分归零）', accelerator: 'Ctrl+Shift+R', click: send('reset') },
    { type: 'separator' },
    { label: '球皮肤：' + (SKIN_LABEL[s.skin] || SKIN_LABEL.classic), click: send('cycle-skin') },
    { label: '金球彩蛋：' + (s.goldenEnabled !== false ? '开启' : '关闭'), click: send('toggle-golden') },
    { label: '记分板：' + (s.showHud !== false ? '开启' : '关闭'), click: send('toggle-hud') },
    { label: '成就：已解锁 ' + ((s.achievements || []).length) + ' 个', click: send('achievements') },
    { type: 'separator' },
    { label: '篮球框：' + (s.hoopEnabled ? '开启' : '关闭'), click: send('toggle-hoop') },
    { label: '音效：' + (s.soundEnabled ? '开启' : '关闭'), click: send('toggle-sound') },
    {
      label: '开机自启动：' + (s.autoStart ? '开启' : '关闭'),
      click: () => {
        const on = !config.get().autoStart;
        applyAutoStart(on);
        config.patch({ autoStart: on });
        config.save();
        rebuildTray(config.get());
        if (win && !win.isDestroyed()) win.webContents.send('action', { type: 'sync-state', autoStart: on });
      },
    },
    { type: 'separator' },
    {
      label: '窗口层级',
      submenu: [
        { label: '贴在桌面（被普通窗口盖住）', type: 'radio', checked: currentZMode() === 'desktop',
          click: () => setZMode('desktop') },
        { label: '置顶（显示在所有窗口之上）', type: 'radio', checked: currentZMode() === 'top',
          click: () => setZMode('top') },
      ],
    },
    {
      label: '命中方式',
      submenu: [
        { label: '窗口区域（推荐）', type: 'radio', checked: s.hitTestMode === 'region', click: () => setHitMode('region') },
        { label: '全局鼠标钩子（备用）', type: 'radio', checked: s.hitTestMode === 'hook', click: () => setHitMode('hook') },
      ],
    },
    {
      label: '串流兼容模式（UU远程/超级屏）：' + streamLabel(),
      click: () => toggleStreamMode(),
    },
    ...(envInfo.remote || envInfo.virtual
      ? [{ label: '  已检测到：' + (envInfo.virtual || '远程会话（RDP）'), enabled: false }]
      : []),
    {
      // 关掉它 = 恢复 GPU 加速（重启生效）。默认应当**关闭**；开着说明走过 GPU 自愈，
      // 或者曾经有人带 --no-gpu 跑过（见 setSoftwareRendering）。
      label: '软件合成（关闭 GPU 加速）：' + (forceNoGpu ? '开启' : '关闭'),
      click: () => setSoftwareRendering(!forceNoGpu),
    },
    { label: '显示性能信息', type: 'checkbox', checked: !!s.showPerf, click: send('toggle-perf') },
    { label: '显示快捷控制栏', type: 'checkbox', checked: !!s.showControlBar, click: send('toggle-bar') },
    { label: '进球特效（冲击波/火花/彩带）', type: 'checkbox', checked: s.fxBurst !== false, click: send('toggle-burst') },
    { label: '运动拖尾（高速残影）', type: 'checkbox', checked: s.trail !== false, click: send('toggle-trail') },
    {
      label: '拖尾样式：' + (s.trailStyle === 'ghost' ? '残影（原版）' : '火焰'),
      click: send('cycle-trailstyle'),
    },
    { type: 'separator' },
    { label: '打开配置文件目录', click: () => shell.openPath(path.dirname(config.path())) },
    { label: '打开运行日志', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: '退出程序', click: quitApp },
  ]);
  tray.setToolTip('桌面物理篮球 — 左键拖拽/甩球，右键菜单');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (win && !win.isDestroyed()) win.webContents.send('action', { type: 'add' });
  });
}

function setHitMode(mode) {
  config.patch({ hitTestMode: mode });
  config.save();
  const msg = '命中方式已切换为「' + (mode === 'hook' ? '全局鼠标钩子' : '窗口区域') + '」。' +
    '（重启程序后完全生效）';
  if (win && !win.isDestroyed()) {
    win.webContents.send('action', { type: 'toast', text: msg });
  }
  rebuildTray(config.get());
}

/**
 * 托盘里那一行「串流兼容模式」的文案。
 *
 * ⚠️ 读的是 **forceStream（实际生效）**，不是 `config.streamMode`。
 *    读配置会有一个很隐蔽的"开关失效"：`--stream` 启动时配置里是 false，
 *    菜单显示"关闭"，用户点一下 → 写配置 true 并带 `--stream` 重启 → 看起来没变；
 *    再点一下 → 配置 false 但命令行又补 `--no-stream` → 这次才真的关了。
 *    也就是"点第一下没反应、点第二下才对"，与用户报的"开关异常"完全吻合。
 * @returns {string}
 */
function streamLabel() {
  if (!forceStream) return '关闭';
  if (streamInfo.source === 'auto') return '开启（自动：' + (envInfo.virtual || '远程会话') + '）';
  if (streamInfo.source === 'arg') return '开启（命令行）';
  return '开启';
}

/**
 * 切换「串流兼容模式」。它改的是启动参数（Chromium 开关），运行期改不了，
 * 所以落盘配置后自我重启。
 *
 * 三处必须这么写，否则就是"开关异常"：
 *  ① 切换依据是 **forceStream（实际生效状态）**，不是 `cfg.streamMode`（配置）——
 *     两者可以不一致，按配置切会出现"点了没反应"。
 *  ② 落盘时补 `streamExplicit: true`：用户点过就是在表态，此后自动检测不再越权
 *     （见 src/stream.js::resolve 的 ③）。
 *  ③ 重启参数必须经 `stream.sanitizeArgs()` **先摘掉旧的 --stream / --no-stream 再补目标值**。
 *     直接用 `process.argv.slice(1)` + `push` 会同时留下两个互斥开关，
 *     Chromium 只认第一个 —— 于是"关了还是开着的"。
 *  另外顺手把 `lastRunStarted` 置 true：它平时靠启动后 10s 的定时器翻正，
 *  重启太快会留在 false，而 false 会被当成"上次 GPU 崩溃"→ 下次启动被强制软件合成。
 */
function toggleStreamMode() {
  const on = !forceStream;
  config.patch({ streamMode: on, streamExplicit: true, lastRunStarted: true });
  config.save();
  if (win && !win.isDestroyed()) {
    win.webContents.send('action', {
      type: 'toast',
      text: '串流兼容模式已' + (on ? '开启' : '关闭') + '，正在重启…',
    });
  }
  // 立即改内存里的生效状态与文案（重启前的这一小段时间里托盘点开也是对的）
  streamInfo.active = on;
  streamInfo.source = 'user';
  streamSwitches.length = 0;
  if (on) streamSwitches.push.apply(streamSwitches, stream.COMPAT_SWITCHES);
  rebuildTray(config.get());
  setTimeout(() => {
    app.isQuitting = true;
    app.relaunch({ args: stream.sanitizeArgs(process.argv.slice(1), on ? 'on' : 'off') });
    app.exit(0);
  }, 800);
}

/**
 * 切换「软件合成」（= 关掉 GPU 加速）。和串流兼容模式同理：它是启动参数
 * （`app.disableHardwareAcceleration`），运行期改不了，所以落盘后自我重启。
 *
 * ⚠️ 这个开关存在的唯一理由就是**给上面那个粘性状态一条回头路**：GPU 自愈会把
 *    `forceNoGpu=true` 写进配置，之后每次都软件合成，而托盘里原本没有任何入口能关掉它。
 *    命令行对应 `--gpu`（优先级最高，可以直接把配置纠正回来）。
 */
function setSoftwareRendering(on) {
  config.patch({ forceNoGpu: !!on, lastRunStarted: true });
  config.save();
  if (win && !win.isDestroyed()) {
    win.webContents.send('action', {
      type: 'toast',
      text: (on ? '已切换为软件合成' : '已恢复 GPU 加速') + '，正在重启…',
    });
  }
  rebuildTray(config.get());
  setTimeout(() => {
    app.isQuitting = true;
    // 剔掉旧的开关，否则命令行会盖过刚落盘的配置
    const args = process.argv.slice(1).filter((a) => a !== '--no-gpu' && a !== '--gpu');
    args.push(on ? '--no-gpu' : '--gpu');
    app.relaunch({ args });
    app.exit(0);
  }, 800);
}

// ------------------------------------------------------------------ 退出
function quitApp() {
  app.isQuitting = true;
  if (win && !win.isDestroyed()) {
    try {
      // 让渲染进程先落盘球的位置
      win.webContents.send('action', { type: 'before-quit' });
    } catch (e) { /* ignore */ }
  }
  setTimeout(() => {
    if (native.api.available && hwnd) {
      try { native.clearShape(hwnd); } catch (e) { /* ignore */ }
    }
    native.uninstallMouseHook();
    if (tray) { try { tray.destroy(); } catch (e) { /* ignore */ } tray = null; }
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }, 120);
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) win.webContents.send('action', { type: 'add' });
});

app.whenReady().then(() => {
  mark('whenReady');
  createWindow();
  rebuildTray(config.get());
  startZKeeper();
});

app.on('window-all-closed', (e) => {
  if (!app.isQuitting) quitApp();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  native.uninstallMouseHook();
});

// GPU 自愈（快路径）：首次检测到 GPU 进程异常退出，立刻带 --no-gpu 重启自己。
// 慢路径是上面基于 config.lastRunStarted 的判断，两者互为兜底。
let gpuCrashes = 0;
app.on('child-process-gone', (e, details) => {
  if (!details || details.type !== 'GPU') return;
  gpuCrashes++;
  log('GPU 进程异常退出 #' + gpuCrashes, details.reason || '', details.exitCode || '');
  if (!forceNoGpu && gpuCrashes <= 2) {
    log('检测到 GPU 不可用 → 以软件合成模式自动重启');
    config.patch({ forceNoGpu: true });
    config.save();
    try {
      app.relaunch({ args: process.argv.slice(1).concat(['--no-gpu']) });
    } catch (err) {
      log('relaunch 失败', err.message);
    }
    app.exit(0);
  }
});

// 兜底：任何未捕获异常都写日志，不要让进程静默死掉
process.on('uncaughtException', (err) => log('uncaughtException', err && err.stack));
