'use strict';
/**
 * native.js —— 通过 koffi (N-API) 直连 Win32，提供三件 Electron 无法直接做的事：
 *
 *  1) 逐像素点击穿透：SetWindowRgn —— 把窗口区域限制为「篮球圆盘 + 控件」的并集。
 *     区域之外的窗口"不存在"，鼠标/触摸完全落到下层（跨进程也有效、零延迟、无全局钩子）。
 *  2) 桌面层级：SetWindowPos(hwnd, 桌面锚点窗口) —— 把窗口插在承载桌面图标的那一层
 *     的正上方，即「浮于桌面图标之上、所有普通窗口之下」。
 *     悬停时由主进程按 1.2s 周期重新锚定（ShowWindow 之类会把它抬到普通带顶部）。
 *  3) 备用命中方案：WH_MOUSE_LL 全局低级鼠标钩子 + WS_EX_TRANSPARENT 动态切换
 *     （当 SetWindowRgn 在个别驱动/环境下失效时使用，见 config.hitTestMode）。
 *
 * 所有调用都做了容错：koffi 不可用或任一 API 失败时，模块降级为 no-op，
 * 主进程会退回 Electron 自带的 setIgnoreMouseEvents 方案。
 */

const api = {
  available: false,
  reason: '',
  hookAvailable: false,
};

let koffi = null;
try {
  koffi = require('koffi');
} catch (e) {
  api.reason = 'koffi 未安装 (' + e.message + ')';
}

// ---------------------------------------------------------------- 常量
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TOPMOST = 0x00000008;
const GWL_EXSTYLE = -20;

const RGN_OR = 2;
const RGN_DIFF = 4;
const RGN_COPY = 5;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_NOSENDCHANGING = 0x0400;

const WH_MOUSE_LL = 14;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;

const GW_HWNDNEXT = 2;

// ---------------------------------------------------------------- 绑定
let LIBS = {};
let F = {};
const bindErrors = [];

function tryFn(lib, name, proto) {
  try {
    const l = LIBS[lib];
    if (!l) throw new Error('库未加载: ' + lib);
    return l.func(proto);
  } catch (e) {
    bindErrors.push(name + ': ' + e.message);
    return null;
  }
}

function bind() {
  LIBS.user32 = koffi.load('user32.dll');
  LIBS.gdi32 = koffi.load('gdi32.dll');
  LIBS.kernel32 = koffi.load('kernel32.dll');

  // --- user32
  F.SetWindowRgn = tryFn('user32', 'SetWindowRgn', 'int SetWindowRgn(uintptr_t hWnd, uintptr_t hRgn, int bRedraw)');
  F.FindWindowW = tryFn('user32', 'FindWindowW', 'uintptr_t FindWindowW(const char16_t *cls, const char16_t *win)');
  F.FindWindowExW = tryFn('user32', 'FindWindowExW', 'uintptr_t FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t *cls, const char16_t *win)');
  F.GetTopWindow = tryFn('user32', 'GetTopWindow', 'uintptr_t GetTopWindow(uintptr_t hWnd)');
  F.GetWindow = tryFn('user32', 'GetWindow', 'uintptr_t GetWindow(uintptr_t hWnd, uint32_t uCmd)');
  F.IsWindowVisible = tryFn('user32', 'IsWindowVisible', 'int IsWindowVisible(uintptr_t hWnd)');
  F.GetWindowLongPtrW = tryFn('user32', 'GetWindowLongPtrW', 'intptr_t GetWindowLongPtrW(uintptr_t hWnd, int nIndex)');
  F.SetWindowLongPtrW = tryFn('user32', 'SetWindowLongPtrW', 'intptr_t SetWindowLongPtrW(uintptr_t hWnd, int nIndex, intptr_t dwNewLong)');
  F.SetWindowPos = tryFn('user32', 'SetWindowPos', 'int SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)');
  F.SystemParametersInfoW = tryFn('user32', 'SystemParametersInfoW', 'int SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, void *pvParam, uint32_t fWinIni)');
  F.GetSystemMetrics = tryFn('user32', 'GetSystemMetrics', 'int GetSystemMetrics(int nIndex)');
  F.SetWindowsHookExW = tryFn('user32', 'SetWindowsHookExW', 'uintptr_t SetWindowsHookExW(int idHook, void *lpfn, uintptr_t hMod, uint32_t dwThreadId)');
  F.UnhookWindowsHookEx = tryFn('user32', 'UnhookWindowsHookEx', 'int UnhookWindowsHookEx(uintptr_t hhk)');
  F.CallNextHookEx = tryFn('user32', 'CallNextHookEx', 'intptr_t CallNextHookEx(uintptr_t hhk, int nCode, uintptr_t wParam, intptr_t lParam)');

  // --- gdi32
  F.CreateRectRgn = tryFn('gdi32', 'CreateRectRgn', 'uintptr_t CreateRectRgn(int x1, int y1, int x2, int y2)');
  F.CreateEllipticRgn = tryFn('gdi32', 'CreateEllipticRgn', 'uintptr_t CreateEllipticRgn(int x1, int y1, int x2, int y2)');
  F.CombineRgn = tryFn('gdi32', 'CombineRgn', 'int CombineRgn(uintptr_t hrgnDst, uintptr_t hrgnSrc1, uintptr_t hrgnSrc2, int iMode)');
  F.DeleteObject = tryFn('gdi32', 'DeleteObject', 'int DeleteObject(uintptr_t hObject)');

  // --- kernel32
  F.GetModuleHandleW = tryFn('kernel32', 'GetModuleHandleW', 'uintptr_t GetModuleHandleW(const char16_t *name)');

  // --- 环境探测（串流兼容模式用，见 native.getDisplayInfo）
  // EnumDisplayDevicesW 在 user32 里（不是 gdi32）：枚举适配器与监视器，
  // 靠返回的 DeviceString 认出「UU 超级屏 / ToDesk / 虚拟显示驱动」这类名字。
  F.EnumDisplayDevicesW = tryFn('user32', 'EnumDisplayDevicesW',
    'int EnumDisplayDevicesW(const char16_t *lpDevice, uint32_t iDevNum, void *lpDisplayDevice, uint32_t dwFlags)');

  // --- 诊断用
  F.GetWindowRgn = tryFn('user32', 'GetWindowRgn', 'int GetWindowRgn(uintptr_t hWnd, uintptr_t hRgn)');
  F.GetAncestor = tryFn('user32', 'GetAncestor', 'uintptr_t GetAncestor(uintptr_t hWnd, uint32_t gaFlags)');
  F.GetRgnBox = tryFn('gdi32', 'GetRgnBox', 'int GetRgnBox(uintptr_t hrgn, void *lprc)');
  // 诊断用：给 z 序邻居打上「类名 + 标题」，否则日志里只有一串 0x… 没法判读
  F.GetClassNameW = tryFn('user32', 'GetClassNameW', 'int GetClassNameW(uintptr_t hWnd, void *lpClassName, int nMaxCount)');
  F.GetWindowTextW = tryFn('user32', 'GetWindowTextW', 'int GetWindowTextW(uintptr_t hWnd, void *lpString, int cchMax)');
  // 层级诊断用：判断"压在上面的那个窗口"是不是零尺寸的幽灵窗口（例如 IEFrame 的
  // Internet Explorer_Hidden —— 它有 WS_VISIBLE 但没有面积，实际不显示任何东西，
  // 光看 IsWindowVisible 会把它当成"有窗口盖着"而误报）
  F.GetWindowRect = tryFn('user32', 'GetWindowRect', 'int GetWindowRect(uintptr_t hWnd, void *lprc)');
  try {
    LIBS.POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
    F.WindowFromPoint = LIBS.user32.func('uintptr_t WindowFromPoint(POINT pt)');
  } catch (e) {
    bindErrors.push('WindowFromPoint: ' + e.message);
  }

  const critical = ['SetWindowRgn', 'CreateRectRgn', 'CreateEllipticRgn', 'CombineRgn', 'DeleteObject'];
  const missing = critical.filter((k) => !F[k]);
  api.available = missing.length === 0;
  if (!api.available) api.reason = '缺少关键 API: ' + missing.join(',') + ' | ' + bindErrors.join(' ; ');
  else if (bindErrors.length) api.reason = '部分可选 API 不可用: ' + bindErrors.join(' ; ');
}

try {
  bind();
} catch (e) {
  api.reason = 'Win32 绑定失败: ' + e.message;
}

// ---------------------------------------------------------------- 工具
function hwndOf(browserWindow) {
  const buf = browserWindow.getNativeWindowHandle();
  if (buf.length === 8) return Number(buf.readBigUInt64LE(0));
  return buf.readUInt32LE(0);
}

// ---------------------------------------------------------------- 窗口区域（点击穿透）
/**
 * 用一组圆盘 + 矩形拼出窗口区域。区域外点击完全穿透到下层窗口/桌面。
 * @param {number} hwnd
 * @param {{circles:number[][], rects:number[][]}} shape  circles: [x,y,r]; rects: [x,y,w,h]  (DIP 单位)
 * @param {number} scale  物理像素 / DIP
 */
function applyShape(hwnd, shape, scale) {
  if (!api.available) return false;
  const s = scale || 1;
  let dst = 0;
  try {
    dst = F.CreateRectRgn(0, 0, -1, -1); // 空区域
    if (!dst) return false;
    const tmp = [];

    const circles = shape.circles || [];
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const x = Math.round(c[0] * s);
      const y = Math.round(c[1] * s);
      const r = Math.max(1, Math.round(c[2] * s));
      const er = F.CreateEllipticRgn(x - r, y - r, x + r, y + r);
      if (!er) continue;
      F.CombineRgn(dst, dst, er, RGN_OR);
      tmp.push(er);
    }
    const rects = shape.rects || [];
    for (let i = 0; i < rects.length; i++) {
      const q = rects[i];
      const x = Math.round(q[0] * s);
      const y = Math.round(q[1] * s);
      const w = Math.max(1, Math.round(q[2] * s));
      const h = Math.max(1, Math.round(q[3] * s));
      const rr = F.CreateRectRgn(x, y, x + w, y + h);
      if (!rr) continue;
      F.CombineRgn(dst, dst, rr, RGN_OR);
      tmp.push(rr);
    }
    const ok = F.SetWindowRgn(hwnd, dst, 0) !== 0;
    // SetWindowRgn 成功后区域所有权归系统，不能再删；失败则要自己删
    if (!ok) F.DeleteObject(dst);
    for (const g of tmp) F.DeleteObject(g);
    return ok;
  } catch (e) {
    api.reason = 'SetWindowRgn 失败: ' + e.message;
    return false;
  }
}

/** 清空窗口区域（恢复整窗可点，仅用于退出/调试） */
function clearShape(hwnd) {
  if (!api.available) return false;
  try {
    const r = F.CreateRectRgn(0, 0, 100000, 100000);
    const ok = F.SetWindowRgn(hwnd, r, 1) !== 0;
    if (!ok) F.DeleteObject(r);
    return ok;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- 扩展样式（备用命中方案）
function setClickThrough(hwnd, on) {
  if (!api.available) return false;
  try {
    let ex = Number(F.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    const before = ex;
    if (on) ex |= WS_EX_TRANSPARENT;
    else ex &= ~WS_EX_TRANSPARENT;
    if (ex !== before) F.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    return true;
  } catch (e) {
    return false;
  }
}

function getExStyle(hwnd) {
  if (!api.available) return 0;
  try {
    return Number(F.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  } catch (e) {
    return 0;
  }
}

// ---------------------------------------------------------------- 桌面层级
/**
 * 找出「承载桌面图标的那一层」，它就是层级锚点。
 *
 * 标准 Windows：`Progman` 直接挂着 `SHELLDLL_DefView`，图标在它下面。
 * 装了动态壁纸软件（Wallpaper Engine 之类）时，图标会被搬到一层 `WorkerW` 上，
 * 那时锚点必须是那层 WorkerW，否则我们会被夹在壁纸和图标之间（球全被图标盖住）。
 * 判据统一用「谁的子窗口里有 SHELLDLL_DefView」，不猜类名。
 */
function findDesktopAnchor() {
  if (!api.available) return 0;
  try {
    const hasIconHost = (h) =>
      h && F.FindWindowExW && Number(F.FindWindowExW(h, 0, 'SHELLDLL_DefView', null)) !== 0;

    const progman = Number(F.FindWindowW('Progman', null));
    if (hasIconHost(progman)) return progman;

    // 从 z 序顶部往下找那个挂着 SHELLDLL_DefView 的顶层窗口
    let cur = Number(F.GetTopWindow(0));
    let guard = 0;
    while (cur && guard++ < 4000) {
      if (hasIconHost(cur)) return cur;
      cur = Number(F.GetWindow(cur, GW_HWNDNEXT));
    }
    if (progman) return progman;
    return Number(F.FindWindowW('WorkerW', null));
  } catch (e) {
    return 0;
  }
}

/** 兼容旧调用名 */
function findProgman() { return findDesktopAnchor(); }

/** 沿 z 序从顶往下走，返回「直接压在 h 上面的那个窗口」 */
function windowAbove(h) {
  if (!api.available || !h) return 0;
  try {
    let cur = Number(F.GetTopWindow(0));
    let prev = 0;
    let guard = 0;
    while (cur && guard++ < 6000) {
      if (cur === h) return prev;
      prev = cur;
      cur = Number(F.GetWindow(cur, GW_HWNDNEXT));
    }
  } catch (e) {
    /* ignore */
  }
  return 0;
}

/**
 * 把窗口放到桌面锚点的**正上方** —— 恰好满足「桌面图标之上、所有普通窗口之下」。
 *
 * ⚠️ 这里的关键语义，翻过两次车才记牢：
 *    SetWindowPos(hwnd, X, …) 的参数叫 hWndInsertAfter —— 是「把 hwnd 插到 X **下面**」，
 *    不是上面。所以想落在桌面之上，X 必须取「当前直接压在桌面上的那个窗口」。
 *
 * 两次翻车：
 *   A) X = HWND_BOTTOM。会跑到 Progman **下面**，被壁纸整个盖住：
 *      WindowFromPoint 在球心返回的是桌面窗口而不是我们，球根本看不见。
 *   B) X = 桌面锚点自己。上面那条语义的直接后果 —— 同样掉到桌面下面。
 *
 * 锚点取「桌面正上方那一个窗口」还顺带解决了最初那个"概率跑到普通窗口上面"：
 * 那时锚点是在 z 序里随便挑的一个可见窗口，一旦挑中 TOPMOST 的任务栏，
 * 把一个非置顶窗口插到置顶窗口下面，Windows 只能把它丢进普通窗口带的**最顶部**，
 * 于是篮球就盖住了所有普通窗口。现在锚点永远是"紧贴桌面的那一个"，
 * 插到它下面 = 正好落在桌面之上，位置是确定的，没有任何退化分支。
 */
function anchorAboveDesktop(hwnd) {
  if (!api.available) return false;
  const anchor = findDesktopAnchor();
  if (!anchor) { api.reason = '找不到桌面锚点窗口'; return false; }
  const above = windowAbove(anchor);
  try {
    return F.SetWindowPos(hwnd, above || anchor, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING) !== 0;
  } catch (e) {
    api.reason = 'anchorAboveDesktop 失败: ' + e.message;
    return false;
  }
}

/**
 * 给 hwnd 打一个人类可读的标签："Chrome_WidgetWin_1 \"WorkBuddy\""。
 * 只用于诊断日志 —— 没有它，z 序日志里全是一串 0x…，看不出对面是谁，
 * 我本人就因为这个把「宿主窗口盖住了测试夹具」误读成「层级修复失败」。
 */
function windowLabel(h) {
  if (!h) return '(null)';
  try {
    const cb = Buffer.alloc(512);
    const n = F.GetClassNameW ? Number(F.GetClassNameW(h, cb, 255)) : 0;
    const cls = n > 0 ? cb.toString('utf16le', 0, n * 2) : '?';
    const tb = Buffer.alloc(1024);
    const m = F.GetWindowTextW ? Number(F.GetWindowTextW(h, tb, 511)) : 0;
    const title = m > 0 ? tb.toString('utf16le', 0, m * 2) : '';
    return '[' + cls + (title ? ' "' + title + '"' : '') + ']';
  } catch (e) {
    return '[?]';
  }
}

/**
 * 层级诊断：返回「直接压在本窗口上面的可见窗口」与「本窗口下面紧邻的窗口」。
 * 用来证明篮球确实在普通窗口之下、桌面之上。
 * above 只取"在本窗口之前遇到的最后一个可见窗口" —— 也就是真正的 z 序上邻居，
 * 中间夹着不可见窗口不算，所以它既是"谁盖着我"，也隐含"没有别的可见窗口夹在中间"。
 */
function zInfo(hwnd) {
  if (!api.available) return null;
  try {
    let cur = Number(F.GetTopWindow(0));
    let guard = 0;
    let above = 0;
    let below = 0;
    let found = false;
    while (cur && guard++ < 6000) {
      if (cur === hwnd) {
        below = Number(F.GetWindow(cur, GW_HWNDNEXT));
        found = true;
        break;
      }
      if (Number(F.IsWindowVisible(cur))) above = cur;
      cur = Number(F.GetWindow(cur, GW_HWNDNEXT));
    }
    const progman = findDesktopAnchor();
    let taskbar = 0;
    try { taskbar = Number(F.FindWindowW('Shell_TrayWnd', null)); } catch (e) { /* ignore */ }
    let belowVis = 0;
    try { belowVis = below ? Number(F.IsWindowVisible(below)) : 0; } catch (e) { /* ignore */ }
    // 压在上面那个窗口的"成色"。置顶模式下判据是"上方没有**普通**窗口"，
    // 但 z 序顶端常驻一些带 WS_VISIBLE 却零面积的幽灵窗口（典型是 IEFrame 的
    // Internet Explorer_Hidden），只看 IsWindowVisible 会把它们当成"有窗口盖着"。
    // 因此再取一次扩展样式（是不是 TOPMOST）与窗口面积（是不是幽灵），供调用方区分。
    let aboveEx = 0;
    let aboveArea = 0;
    try {
      if (above) {
        aboveEx = Number(F.GetWindowLongPtrW(above, GWL_EXSTYLE));
        const rc = Buffer.alloc(16);
        if (F.GetWindowRect && F.GetWindowRect(above, rc)) {
          const w = rc.readInt32LE(8) - rc.readInt32LE(0);
          const h = rc.readInt32LE(12) - rc.readInt32LE(4);
          aboveArea = Math.max(0, w) * Math.max(0, h);
        }
      }
    } catch (e) { /* ignore */ }
    return {
      found: found,
      above: above,
      aboveIsTopmostAnchor: above === taskbar,
      aboveLabel: windowLabel(above),
      aboveEx: aboveEx,
      aboveIsTopmost: (aboveEx & WS_EX_TOPMOST) !== 0,
      aboveArea: aboveArea,
      below: below,
      belowIsProgman: !!progman && below === progman,
      belowLabel: windowLabel(below),
      belowVisible: !!belowVis,
      progman: progman,
      progmanLabel: windowLabel(progman),
      taskbar: taskbar,
    };
  } catch (e) {
    return null;
  }
}

/** 工作区（排除任务栏），返回物理像素 */
function getWorkArea() {
  if (!api.available) return null;
  try {
    const rc = Buffer.alloc(16);
    const SPI_GETWORKAREA = 0x0030;
    if (!F.SystemParametersInfoW(SPI_GETWORKAREA, 0, rc, 0)) return null;
    return {
      x: rc.readInt32LE(0),
      y: rc.readInt32LE(4),
      width: rc.readInt32LE(8) - rc.readInt32LE(0),
      height: rc.readInt32LE(12) - rc.readInt32LE(4),
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 环境探测（串流兼容模式）
/**
 * 当前会话是不是**远程会话**（RDP / 远程桌面）？
 *
 * `GetSystemMetrics(SM_REMOTESESSION)`：0 = 本地控制台，非 0 = 被远程控制。
 * ⚠️ 它对 UU 远程「超级屏」这类**自带虚拟显示驱动**的软件通常是 0（它们不是 RDP，
 *    而是在本地会话里挂一块虚拟显示器）—— 所以这只是两条独立判据之一，
 *    另一条是下面的 `listDisplayDevices()` 关键字匹配。两条任一中都进兼容模式。
 */
function isRemoteSession() {
  const SM_REMOTESESSION = 0x1000;
  if (!api.available || !F.GetSystemMetrics) return false;
  try {
    return Number(F.GetSystemMetrics(SM_REMOTESESSION)) !== 0;
  } catch (e) {
    return false;
  }
}

/** 读 DISPLAY_DEVICEW 里的固定长度宽字符串字段（**字节**偏移，长度按字符数给） */
function readWideFixed(buf, offsetBytes, chars) {
  const off = offsetBytes;
  const end = Math.min(buf.length, off + chars * 2);
  if (off >= end) return '';
  const s = buf.toString('utf16le', off, end);
  const z = s.indexOf('\u0000');
  return (z >= 0 ? s.slice(0, z) : s).trim();
}

/**
 * 枚举所有显示适配器 + 每块适配器下的监视器，取它们的**人类可读名字**。
 *
 * DISPLAY_DEVICEW 的布局（宽字符，64 位下也是这个布局，因为它是固定数组不是指针）：
 *   DWORD cb;                // 0    必须填 sizeof
 *   WCHAR DeviceName[32];    // 4    形如 "\\.\DISPLAY1"
 *   WCHAR DeviceString[128]; // 68   形如 "NVIDIA GeForce RTX 4060" / "UU Super Screen"
 *   DWORD StateFlags;        // 324
 *   WCHAR DeviceID[128];     // 328
 *   WCHAR DeviceKey[128];    // 584
 *   → 总长 840 字节
 *
 * 为什么取两层：适配器名（iDevNum 那层）是显卡/虚拟驱动，**监视器名**（把 DeviceName
 * 再传进去那层）才是「UU远程超级屏」这种。串流软件一般两层里至少有一层带关键字。
 *
 * @returns {{name:string, string:string, flags:number, monitor:boolean}[]}
 */
function listDisplayDevices() {
  if (!api.available || !F.EnumDisplayDevicesW) return [];
  const out = [];
  const SIZE = 840;
  const MAX_ADAPTERS = 16;
  const MAX_MONITORS = 8;
  try {
    for (let i = 0; i < MAX_ADAPTERS; i++) {
      const buf = Buffer.alloc(SIZE);          // Buffer.alloc 会清零，cb 单独写
      buf.writeUInt32LE(SIZE, 0);
      if (!Number(F.EnumDisplayDevicesW(null, i, buf, 0))) break;
      const name = readWideFixed(buf, 4, 32);
      const str = readWideFixed(buf, 68, 128);
      const flags = buf.readUInt32LE(324);
      out.push({ name: name, string: str, flags: flags, monitor: false });
      if (!name) continue;
      // 第二层：这块适配器下的监视器；名字才是「XX 屏幕」这种商品名
      for (let m = 0; m < MAX_MONITORS; m++) {
        const mb = Buffer.alloc(SIZE);
        mb.writeUInt32LE(SIZE, 0);
        if (!Number(F.EnumDisplayDevicesW(name, m, mb, 0))) break;
        out.push({
          name: readWideFixed(mb, 4, 32),
          string: readWideFixed(mb, 68, 128),
          flags: mb.readUInt32LE(324),
          monitor: true,
        });
      }
    }
  } catch (e) {
    api.reason = 'EnumDisplayDevicesW 失败: ' + e.message;
  }
  return out;
}

/**
 * 串流兼容模式的判据汇总。
 *
 * ⚠️ **只认「当前挂在桌面上」的设备**（StateFlags 含 ATTACHED_TO_DESKTOP=0x1，
 *    或 MIRRORING_DRIVER=0x8）。这一条是实机踩出来的：
 *    装了 UU 远程的机器上，`GameViewer Virtual Display Adapter` 会**常驻**枚举出
 *    来好几块（本机实测 10 块），但平时 StateFlags 全是 0 —— 它们此时没有驱动任何
 *    屏幕。不加这个过滤，普通使用（没开超级屏）也会被判定成"虚拟显示环境"，
 *    于是每次启动都被迫走兼容合成，性能白白变差 —— 正是"宁可漏判不要误判"。
 *    开启超级屏后这些适配器会被 attach，StateFlags 变成 0x1，这时才命中。
 *
 * @returns {{remote:boolean, virtual:string|null, devices:string[]}}
 *   virtual = 命中的那条设备名（null = 没认出虚拟显示）
 *   devices = 全部设备名（写进日志便于事后追溯"这台机器到底装了什么显示驱动"）
 */
function getDisplayInfo() {
  const devs = listDisplayDevices();
  const names = [];
  const active = [];
  const ATTACHED = 0x1, MIRRORING = 0x8;
  for (const d of devs) {
    if (d.string) names.push(d.string);
    if (d.name) names.push(d.name);
    if (!d.string) continue;
    if (d.flags & (ATTACHED | MIRRORING)) active.push(d.string);
  }
  // 关键字表内联一份最小集，避免 native 反向依赖 stream.js（保持 native 是叶子模块）。
  // 完整表在 stream.js::DEFAULT_HINTS，由 main.js 传进来再复核一次。
  const KEY = ['uu', 'virtual', 'idd', 'todesk', 'sunlogin', 'anydesk', 'parsec',
               'spacedesk', 'teamviewer', 'splashtop', 'rustdesk', 'airdroid',
               'mirror', 'indirect display', 'gameviewer', 'seewo', '希沃'];
  let virtual = null;
  for (const n of active) {
    const s = String(n).toLowerCase();
    for (const k of KEY) {
      if (s.indexOf(k) >= 0) { virtual = n; break; }
    }
    if (virtual) break;
  }
  return { remote: isRemoteSession(), virtual: virtual, devices: names, activeDevices: active };
}

// ---------------------------------------------------------------- 备用：全局低级鼠标钩子
let hookHandle = 0;
let hookCallbackFn = null;
let hookCb = null;

/**
 * 安装 WH_MOUSE_LL。回调在主进程 JS 线程同步执行（同线程，无跨线程投机），
 * 因此可以在事件真正投递到窗口之前完成 WS_EX_TRANSPARENT 的切换。
 * @param {(msg:number, x:number, y:number)=>void} onMouse
 */
function installMouseHook(onMouse) {
  if (!api.available || hookHandle) return false;
  try {
    const proto = koffi.proto('intptr_t __stdcall LowLevelMouseProc(int nCode, uintptr_t wParam, intptr_t lParam)');
    const pt = { x: 0, y: 0 };
    let GetCursorPosSafe = null;
    try {
      const fn = tryFn("user32", "GetCursorPos", "int GetCursorPos(void *pt)");
      const b = Buffer.alloc(8);
      fn(b);
      // 自检：坐标必须落在[-32000,32000] 的合法范围
      const x = b.readInt32LE(0), y = b.readInt32LE(4);
      GetCursorPosSafe = function () {
        fn(b);
        return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
      };
      void x; void y;
    } catch (e) {
      GetCursorPosSafe = null;
    }

    hookCallbackFn = koffi.register(function (nCode, wParam, lParam) {
      try {
        if (nCode === 0) {
          let x = 0, y = 0, got = false;
          if (GetCursorPosSafe) {
            const p = GetCursorPosSafe();
            x = p.x; y = p.y; got = true;
          }
          if (!got) {
            const arr = koffi.decode(lParam, 'int32', 2);
            x = arr[0]; y = arr[1];
          }
          onMouse(Number(wParam), x, y);
        }
      } catch (e) {
        /* 钩子回调内绝不允许抛出 */
      }
      return F.CallNextHookEx(hookHandle, nCode, wParam, lParam);
    }, koffi.pointer(proto));

    const hMod = Number(F.GetModuleHandleW(null));
    hookHandle = Number(F.SetWindowsHookExW(WH_MOUSE_LL, hookCallbackFn, hMod, 0));
    api.hookAvailable = !!hookHandle;
    return api.hookAvailable;
  } catch (e) {
    api.reason = '鼠标钩子安装失败: ' + e.message;
    return false;
  }
}

function uninstallMouseHook() {
  if (hookHandle) {
    try { F.UnhookWindowsHookEx(hookHandle); } catch (e) { /* ignore */ }
    hookHandle = 0;
  }
  if (hookCallbackFn) {
    try { koffi.unregister(hookCallbackFn); } catch (e) { /* ignore */ }
    hookCallbackFn = null;
  }
  api.hookAvailable = false;
}

/** 读回当前窗口区域的包围盒（验证逐像素穿透是否真的生效） */
function getRegionBox(hwnd) {
  if (!api.available || !F.GetWindowRgn || !F.GetRgnBox) return null;
  try {
    const r = F.CreateRectRgn(0, 0, 1, 1);
    const type = F.GetWindowRgn(hwnd, r);
    const buf = Buffer.alloc(16);
    F.GetRgnBox(r, buf);
    F.DeleteObject(r);
    return {
      type: type, // 0=ERROR 1=NULLREGION 2=SIMPLEREGION 3=COMPLEXREGION
      left: buf.readInt32LE(0), top: buf.readInt32LE(4),
      right: buf.readInt32LE(8), bottom: buf.readInt32LE(12),
    };
  } catch (e) {
    return null;
  }
}

/**
 * 命中测试：问系统「物理像素 (x,y) 这一点属于哪个窗口」，返回**顶层窗口**（GA_ROOT）。
 *
 * ⚠️ WindowFromPoint 返回的是最深的子窗口（Electron 的页面是 Chrome_RenderWidgetHostHWND，
 *    桌面图标是 SysListView32），拿它和我们的顶层 hwnd 比较永远不相等 ——
 *    必须用 GetAncestor(GA_ROOT) 归一到顶层窗口再比。
 * 这是验证层级最硬的方法：球上应返回我们的顶层窗口，桌面空白处应返回桌面锚点。
 */
function hitTest(x, y) {
  if (!api.available || !F.WindowFromPoint) return 0;
  try {
    const h = Number(F.WindowFromPoint({ x: Math.round(x), y: Math.round(y) }));
    if (!h || !F.GetAncestor) return h;
    const GA_ROOT = 2;
    return Number(F.GetAncestor(h, GA_ROOT)) || h;
  } catch (e) {
    return -1;
  }
}

module.exports = {
  api,
  hwndOf,
  applyShape,
  clearShape,
  setClickThrough,
  getExStyle,
  anchorAboveDesktop,
  zInfo,
  findProgman,
  findDesktopAnchor,
  getWorkArea,
  isRemoteSession,
  listDisplayDevices,
  getDisplayInfo,
  getRegionBox,
  hitTest,
  windowLabel,
  installMouseHook,
  uninstallMouseHook,
  constants: { WS_EX_TRANSPARENT, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_RBUTTONDOWN },
};
