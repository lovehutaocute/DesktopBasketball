'use strict';
/**
 * stream.js —— 「串流兼容模式」的判定逻辑（**纯函数**，不 require electron / koffi）
 *
 * 为什么单独抽一个模块：这段逻辑原先内联在 main.js 里，是
 *   `argv.includes('--stream') ? true : argv.includes('--no-stream') ? false : cfg.streamMode === true`
 * 一行三目。它有两个被真实踩到的问题（见 README §6.10）：
 *
 *  1) **它算的是"配置里写了什么"，而不是"当前实际生效的是什么"。** 托盘菜单项、
 *     `app-info`、显示器变化提示全都读 `config.streamMode` —— 于是
 *     `--stream` 启动时菜单显示"关闭"、点一下反而还是开着的（表现为"开关失效"）；
 *     反过来 `--no-stream` + 配置 true 时显示"开启"却实际是关的。
 *  2) **重启参数没有清洗。** `process.argv.slice(1)` 原样透传，再用 `push` 追加目标值。
 *     用户带 `--stream` 启动、在托盘里想关掉时会留下两个互斥开关，Chromium 取哪个
 *     取决于内部解析顺序 —— 又一个"点了没反应"。
 *
 * 抽成纯函数之后，`tools/verify-stream.js` 可以用纯 node 把这几条断言跑干净，
 * 不需要起 GUI（本机的 GUI 采样不可信，见 README §4.1.4）。
 */

const ARG_ON = '--stream';
const ARG_OFF = '--no-stream';

/**
 * 判定为「虚拟 / 远程串流显示」的设备名关键字（小写子串匹配）。
 *
 * 判据来自 `EnumDisplayDevicesW` 返回的 DeviceString / 监视器 DeviceString，
 * 典型值：
 *   · UU 远程「超级屏」  → "UU Super Screen" / "UUVirtualDisplay"
 *   · ToDesk             → "ToDesk Virtual Display"
 *   · 向日葵             → "Sunlogin Virtual Display"
 *   · Spacedesk          → "Spacedesk Graphics Adapter"
 *   · Windows 虚拟显示   → "Microsoft Indirect Display Adapter" / "UsbDk ..."
 *   · 无线投屏类         → 名字里带 Mirror / Cast
 *
 * ⚠️ 这些是**厂商字符串**，只能靠子串匹配；宁可漏判（用户还可以去托盘手动开）
 *    也不要误判 —— 误判会让普通机器也被迫走兼容合成（性能变差）。
 *    因此不在列表里放过于通用的词（如 'display' / 'video'）。
 *    `streamDisplayHints` 配置项可以整体覆盖这张表，便于新厂商不改代码。
 */
const DEFAULT_HINTS = [
  'uu',                // UU 远程（超级屏）
  'virtual',
  'idd',               // Indirect Display Driver（Windows 自己的虚拟显示框架）
  'indirect display',
  'todesk',
  'sunlogin',
  'anydesk',
  'parsec',
  'spacedesk',
  'teamviewer',
  'splashtop',
  'rustdesk',
  'airdroid',
  'mirror',
  'gameviewer',        // UU 远程 / GameViewer 的虚拟显示驱动
  'seewo',
  '希沃',
];

/** 这个 argv 元素是不是串流兼容开关（含 `--stream=1` / `--no-stream=` 这类带值写法） */
function isStreamArg(a) {
  if (typeof a !== 'string') return false;
  return a === ARG_ON || a === ARG_OFF ||
         a.indexOf(ARG_ON + '=') === 0 || a.indexOf(ARG_OFF + '=') === 0;
}

/**
 * 从命令行里读串流开关。
 * @returns {'on'|'off'|null} null = 命令行没表态（要么没有，要么只写了 `--stream=` 空值）
 */
function parseArg(argv) {
  if (!Array.isArray(argv)) return null;
  let seen = null;
  for (const a of argv) {
    if (a === ARG_ON) seen = 'on';
    else if (a === ARG_OFF) seen = 'off';
    else if (typeof a === 'string' && a.indexOf(ARG_ON + '=') === 0) seen = 'on';
    else if (typeof a === 'string' && a.indexOf(ARG_OFF + '=') === 0) seen = 'off';
  }
  return seen;
}

/**
 * 清洗重启参数：**先摘掉所有串流开关，再补上唯一的目标值**。
 *
 * 这是「开关点了没反应」的直接修法 —— 不清洗就会出现同时存在
 * `--stream` 与 `--no-stream` 的命令行，而 Chromium 的 `HasSwitch` 只看第一个。
 *
 * @param {string[]} argv  process.argv.slice(1)
 * @param {'on'|'off'|null} target  追加的目标开关；null = 只清洗、不追加
 * @returns {string[]} 新的 argv（不修改入参）
 */
function sanitizeArgs(argv, target) {
  const out = (Array.isArray(argv) ? argv : []).filter((a) => !isStreamArg(a));
  if (target === 'on') out.push(ARG_ON);
  else if (target === 'off') out.push(ARG_OFF);
  return out;
}

/**
 * 设备名列表里有没有「虚拟 / 远程显示」。
 * @param {string[]} devices 设备名前缀串（适配器名 + 监视器名）
 * @param {string[]} [hints] 关键字表，缺省用 DEFAULT_HINTS
 * @returns {string|null} 命中的那条设备名（便于写进日志追溯），没命中返回 null
 */
function matchVirtualDisplay(devices, hints) {
  const list = (hints && hints.length) ? hints : DEFAULT_HINTS;
  const arr = Array.isArray(devices) ? devices : [];
  for (const raw of arr) {
    if (typeof raw !== 'string' || !raw) continue;
    const s = raw.toLowerCase();
    for (const h of list) {
      if (!h) continue;
      if (s.indexOf(String(h).toLowerCase()) >= 0) return raw;
    }
  }
  return null;
}

/**
 * 求「本次进程实际要不要走串流兼容模式」。优先级：
 *
 *   ① 命令行 `--stream` / `--no-stream`   —— 最高，便于 A/B 与排障
 *   ② 配置 `streamMode: true`             —— 用户（或旧版本）显式开过
 *   ③ 配置 `streamExplicit: true` 且 mode≠true —— 用户**显式关过**，此后不再自动开
 *   ④ 自动检测：远程会话（RDP）或虚拟/串流显示 → 自动开
 *   ⑤ 都没有 → 关
 *
 * ⚠️ ③ 的存在是为了让「自动检测」不会跟用户对着干：一旦用户在托盘里点过开关，
 *    他就是在明确表态，之后插拔显示器不再自动改回来。
 *
 * @param {{argv?:string[], config?:object, remoteSession?:boolean,
 *          devices?:string[], hints?:string[]}} opts
 * @returns {{active:boolean, source:'arg'|'user'|'user-off'|'auto'|'default',
 *            configured:boolean, explicit:boolean, detected:string|null, remote:boolean}}
 */
function resolve(opts) {
  const o = opts || {};
  const argv = o.argv || [];
  const cfg = o.config || {};
  const remote = !!o.remoteSession;

  const arg = parseArg(argv);
  if (arg) {
    return { active: arg === 'on', source: 'arg', configured: arg === 'on',
             explicit: true, detected: null, remote };
  }
  if (cfg.streamMode === true) {
    return { active: true, source: 'user', configured: true,
             explicit: true, detected: null, remote };
  }
  if (cfg.streamExplicit === true) {
    return { active: false, source: 'user-off', configured: false,
             explicit: true, detected: null, remote };
  }
  const detected = matchVirtualDisplay(o.devices, o.hints);
  if (remote || detected) {
    return { active: true, source: 'auto', configured: false,
             explicit: false, detected: detected, remote };
  }
  return { active: false, source: 'default', configured: false,
           explicit: false, detected: null, remote: false };
}

/**
 * 兼容模式下要追加的 Chromium 开关（**顺序无关**，都会 appendSwitch）。
 *
 * 为什么不止 `--disable-direct-composition` 一个：
 * 远程串流软件（UU「超级屏」等）靠**虚拟显示驱动**抓桌面，抓不到的是
 * 「独立提交的合成层」—— 而这件事有两个来源，只关掉一个够不着另一个：
 *
 *   1) `disable-direct-composition`
 *      关掉 DirectComposition —— 透明窗内容不再以独立 DComp visual 提交，
 *      回到 DWM 常规合成。这是**必要**的一步（原实现只有它）。
 *   2) `disable-gpu-compositing`
 *      让**页面合成**在渲染进程里用软件光栅完成、结果写进窗口的后备缓冲。
 *      只关 DComp 时，Chromium 仍可能把每帧变化的 `#dyn` canvas 交给 GPU 进程
 *      单独提交（overlay plane）—— 那同样是捕获端拿不到的一层。
 *      关掉它之后，任何走窗口 DC / GDI BitBlt 的捕获方式（虚拟显示驱动正是这类）
 *      都能拿到完整内容。
 *   3) `disable-zero-copy`
 *      关掉零拷贝纹理直通，避免捕获/合成链上出现"DMA-BUF 直采"的旁路。
 *
 * ⚠️ 这三条**不降低帧率**：物理步长、绘制调用次数、脏块策略一概不变，
 *    改的只是"谁把画面提交给系统"。渲染进程的 Canvas2D 光栅化仍然走 GPU，
 *    所以 `drawImage` / 文字仍然快 —— 这正是本模块坚持不用
 *    `app.disableHardwareAcceleration()`（整机软件渲染，会真的变卡）的原因。
 */
const COMPAT_SWITCHES = [
  'disable-direct-composition',
  'disable-gpu-compositing',
  'disable-zero-copy',
];

module.exports = {
  ARG_ON,
  ARG_OFF,
  DEFAULT_HINTS,
  COMPAT_SWITCHES,
  isStreamArg,
  parseArg,
  sanitizeArgs,
  matchVirtualDisplay,
  resolve,
};
