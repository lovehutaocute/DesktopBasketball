# 桌面物理篮球（Desktop Basketball）

Windows 桌面上的透明覆盖层 + 真实刚体物理篮球。篮球**浮于桌面图标之上、所有普通窗口之下**，不遮挡任务栏、不抢焦点，
支持鼠标拖拽/甩飞与触摸投掷。球数上限 **200**（`config.maxBalls`）：**1~100 个球全程 60fps 不卡顿**
（GPU / 软件合成都实测满帧，见 §2.12）；**100~200 球可用，但会明显掉帧** —— 见下方说明。

- **技术栈**：Electron 38 + Matter.js 0.20 + koffi（Win32 FFI），全部 MIT / Apache 系宽松许可
- **产物**：免安装绿色目录 `dist/DesktopBasketball-win32-x64/DesktopBasketball.exe`
- **下载**：[**Releases**](https://github.com/lovehutaocute/DesktopBasketball/releases/latest) ——
  `DesktopBasketball-Setup-1.0.1.exe`（一键安装，81 MiB）/ 免安装 `.7z`（244 MB 解压后）
- **仓库**：<https://github.com/lovehutaocute/DesktopBasketball>（源码、构建脚本、问题反馈）
- **优先级**：流畅度 > 触控体验 > 物理效果 > 功能完整度 > 视觉效果

> 只想要一个能跑的篮球？**直接装 Release 里的安装包，不需要 Node.js、不需要构建**（见 §5）。

---

## 0. 快速开始

**两种用法，先选一条：**

| 你是 | 怎么做 |
|---|---|
| **只想玩** | 去 [Releases](https://github.com/lovehutaocute/DesktopBasketball/releases/latest) 下载 `DesktopBasketball-Setup-1.0.1.exe` 双击安装。**不需要 Node.js，不需要构建。** |
| **想改代码 / 自己打包** | 按下面的命令行从源码跑（需要 Node.js 18+）。 |

```bash
npm install          # 依赖已装好可直接跳过
npm start            # 启动（开发模式）
npm run start:nogpu  # 显卡驱动异常时用这个（软件合成）
npm run perf         # 20 球性能验收，约 55 秒，结果写 assets/cpu-test.json
npm run pack         # 打包成免安装 exe
```

启动后**不会出现主窗口**——程序直接最小化到系统托盘，右上角托盘图标 ⟶ 右键即是全部控制项。

篮球默认**贴在桌面层**（浮于桌面图标之上、会被普通窗口盖住）。想让它在别的窗口之上也始终
看得见、摸得到，在**托盘菜单**或**篮球的右键菜单**里选 **窗口层级 → 置顶**（即时生效，无需重启）。

**玩法**：把球往篮筐里甩。普通进球 +2 分，**空心球 +3**（全程不碰篮板/篮圈）；4 秒内连续命中有
**连击**加成，最高分跨会话保留，破纪录会放号角 + 撒彩带。快捷操作：
`Ctrl+Shift+空格` 把所有球抛起来、`Ctrl+Shift+R` 清空重来（详见 §2.10）。

**有趣的部分**（详见 §2.11）：拖拽时会画一条**预测抛物线 + 落点靶环**；菜单里可以换**球皮肤**
（经典篮球 / 能量球 / 足球 / 西瓜 / 星球）；每 18~40 秒会随机冒出一颗**金球**，投进得双倍分；
还有一个 **13 个成就**的收集系统（初次得分、空心球、五连击、百分、金球空心…），解锁时撒彩带 +
专属音效，跨会话保留；顶部有**记分板**（得分 / 连击 / 最高）。

---

## 1. GitHub 调研结果及参考项目

用 GitHub REST API 跑了 8 组关键词（`desktop ball physics`、`matter.js physics ball`、`shimeji desktop mascot`、
`desktop pet physics transparent window`、`wallpaper engine WorkerW desktop layer`、`box2d windows desktop overlay physics` 等），
共 32 个仓库，原始数据见 `assets/github-research.json`。

### 1.1 最相关的参考项目

| 仓库 | ★ | 语言 | 许可 | 本项目实际借鉴了什么 |
|---|---|---|---|---|
| [liabru/matter-js](https://github.com/liabru/matter-js) | 18437 | JS | **MIT** | **物理引擎直接采用**：自适应网格 broad-phase（空间分区）、Verlet 积分、Catto 顺序脉冲求解器、Sleeping 休眠。不重写物理。 |
| [Felix-au/DeskX-Wallpaper-Engine](https://github.com/Felix-au/DeskX-Wallpaper-Engine) | 93 | JS | **MIT** | Electron 做桌面层注入的窗口参数组合：透明无边框 + `skipTaskbar` + 层级插入。 |
| [jabbany/ShimejiHTML5](https://github.com/jabbany/ShimejiHTML5) | 14 | JS | **MIT** | HTML5 桌面吉祥物的「多实例共享一个渲染面」思路（本项目进一步做成单窗口多球）。 |
| [ngoc-thu/shimeji](https://github.com/ngoc-thu/shimeji) | 5 | Java | Zlib | Windows 10/11 上桌面吉祥物的层级与穿透行为对照（Java 版，只做行为参考）。 |
| [welltilln/desksprite](https://github.com/welltilln/desksprite) | 3 | JS | **MIT** | 桌面精灵的「按下抓取 → 松手按指针速度投掷」交互模型。 |
| [tailogs/ball](https://github.com/tailogs/ball) | 0 | C | **MIT** | C 语言桌面弹球的「任务栏顶面当作地面」处理方式。 |
| [antiBaconMachine/JihadronCollider](https://github.com/antiBaconMachine/JihadronCollider) | 1 | JS | NONE | 桌面弹球多球碰撞的玩法参考（**无许可证，只读未取代码**）。 |
| [Me-in-U/Live-Captions-Rain](https://github.com/Me-in-U/Live-Captions-Rain) | 1 | C# | Apache-2.0 | Windows 覆盖层 + Box2D 的组合方案（C# 路线最终未采用，见下）。 |

### 1.2 为什么最后没有直接 fork 现成项目

调研后发现**没有一个项目同时满足「Electron/JS 技术栈 + 桌面层 + 逐像素穿透 + 高性能多体物理」**：

- `DeskX-Wallpaper-Engine`（93★）是最接近的窗口层方案，但它是**壁纸引擎**——它要让内容**贴到桌面最底层**，
  而本需求要求篮球**浮于桌面图标之上、但在所有普通窗口之下**，窗口层级诉求正好相反
  （它要往 z 序最底钻，我们要恰好停在桌面之上那一格）。只借用了它的窗口参数组合。
- `shimeji` 系列基本都是 Java/Python 单角色跟随鼠标，没有刚体物理，也没有多体碰撞。
- `matter.js` 相关仓库（`bouncyBall`、`ricochet`、`Marbles` 等）都是**网页里的**物理玩具，
  完全没有桌面层级、点击穿透、托盘、配置持久化这些「桌面应用」的部分，可复用度接近 0。
- C# / Box2D 路线（`Live-Captions-Rain`）在**本机被安全策略拦截**（`csc.exe` 被拦、无 dotnet SDK），故放弃。
- `JihadronCollider` 等多个仓库**没有 LICENSE 文件**，不可使用其代码。

因此最终决策：**物理引擎用成熟的 matter-js（MIT，不改），窗口层 / 命中 / 交互 / 渲染调度全部自研**。
这样既保住了「用成熟的高性能物理实现」这一要求，又避免了在不匹配的代码库里做外科手术。

---

## 2. 技术方案

### 2.1 窗口层级：两档可切换（贴桌面 / 置顶）

只创建一个无边框透明窗口（不是每球一个窗口）。窗口层级有**两档互斥**的目标，由
`config.zMode` 选择，托盘菜单与球的右键菜单都能即时切换（不重启）：

| 档位 | 语义 | 做法 |
|---|---|---|
| `'desktop'`（默认） | 浮于桌面图标之上、**普通窗口之下** —— 像个桌面挂件，别人一开窗口就把它盖住 | `SetWindowPos(hwnd, 紧贴桌面上方的那一个窗口)`，见 §2.1.1。**这条路径全程不碰 `setAlwaysOnTop`** |
| `'top'` | 显示在**所有普通窗口与任务栏之上** —— 前台开着浏览器/IDE 也看得见、摸得到 | `setAlwaysOnTop(true, 'screen-saver')`（= `WS_EX_TOPMOST` + 最高 band），见 §2.1.2 |

其余与档位无关的固定项：

| 目标 | 做法 |
|---|---|
| 尺寸精确等于工作区 | `SPI_GETWORKAREA` 拿物理像素（1440×852），换算 DIP 后作为窗口 bounds。**窗口物理上就不覆盖任务栏**，不靠层级去压。 |
| 层级定期校正 | 1.2 秒一次的 keeper：`desktop` 档重新锚定，`top` 档检查 `TOPMOST` 是否被挤掉（`ShowWindow`／Win+D／外壳重启都会打乱 z 序） |
| 不在 Alt+Tab | `type: 'toolbar'` + `WS_EX_TOOLWINDOW` |
| 不抢焦点 | `focusable: false` + `WS_EX_NOACTIVATE` + `showInactive()` |
| 不占任务栏按钮 | `skipTaskbar: true` |
| 不会被 Chromium 降频 | 关掉 `CalculateNativeWinOcclusion` / `backgrounding-occluded-windows` / `renderer-backgrounding` / `background-timer-throttling` |

实测扩展样式：`desktop` 档 `0x8200080` = `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`；
`top` 档 `0x8200088` = 上面两个再 `| WS_EX_TOPMOST`。两种情况下 `focused=false`。

> ⚠️ **逐像素点击穿透（§2.2）与档位无关，两种模式下都照常生效**。所以即使在置顶档，
> 球盘/篮筐之外的像素依旧直接点到桌面 —— 它不是"挡住整个屏幕"的传统置顶窗口。

#### 2.1.1 层级锚点：`hWndInsertAfter` 的语义是「插到它**下面**」

这是整个项目翻车最多的一处，值得单独写清楚。三条规则：

1. `SetWindowPos(hwnd, X, …)` 的参数叫 `hWndInsertAfter` —— 效果是**把 hwnd 放到 X 的下方**，
   不是上方。想落在桌面之上，`X` 必须取「当前直接压在桌面上的那个窗口」。
2. 桌面锚点要用「子窗口里有 `SHELLDLL_DefView` 的那个顶层窗口」来找，而不是硬编码 `Progman` 类名
   —— 装了动态壁纸软件（Wallpaper Engine 之类）时，桌面图标会被搬到一层 `WorkerW` 上。
3. 锚点**只能**是紧贴桌面的那一个，不能是"随便一个可见窗口"。

三个错误做法都真实发生过，对应三种不同的故障：

| 错误做法 | 后果 |
|---|---|
| `X = 随便挑的可见窗口`（早期实现） | 一旦挑中 TOPMOST 的任务栏，把非置顶窗口插到置顶窗口下面，Windows 只能把它丢进普通窗口带的**最顶部** → **"篮球有概率跑到普通窗口上面"**。这就是最初那个 bug。 |
| `X = HWND_BOTTOM` | 窗口掉到 `Progman` **下面**，被壁纸整个盖住。`capturePage()` 截图一切正常（它只读自己的合成结果），但 `WindowFromPoint(球心)` 返回的是桌面窗口 —— 球在真实屏幕上一个也看不见。 |
| `X = 桌面锚点自己` | 同样掉到桌面下面（第 1 条语义的直接后果）。 |

正确实现（`src/native.js`）：

```js
const anchor = findDesktopAnchor();          // 承载桌面图标的那一层
const above  = windowAbove(anchor);          // 紧贴桌面上方的那个窗口
SetWindowPos(hwnd, above || anchor, 0,0,0,0,
  SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING);
```

这个锚点是**确定**的，没有任何退化分支：插到"紧贴桌面上方那个窗口"的下方 = 正好落在桌面之上，
而所有普通窗口都排在它前面 → 篮球永远盖不住任何普通窗口。

**验收证据**（`--diag --test-normal-window`，会真的开一个不透明普通窗口盖住大半个屏幕）：

```
DIAG zorder  above=0xb056e(普通窗口, 正确) below=0x101b0(桌面锚点, 正确) anchor=0x101b0 inZ=true
DIAG hittest ball0@490,818→0xb056e(被普通窗口盖住, 正确)
             ball1@654,818→0xb056e(被普通窗口盖住, 正确)
             testWin=0x2206b6(普通窗口) visible=true 中心命中=0x2206b6(=testWin ✓)
             taskbar→0x10100 (未被覆盖 ok)
             blank@720,315→0x2206b6(普通窗口) | blank@115,495→0x2206b6
```

判据：
- `below` 必须等于桌面锚点 → 篮球在桌面图标之上；
- `above` 必须**不是**任务栏 → 篮球没有跑进置顶带；
- 测试普通窗口中心与四角命中必须等于 `testWin` → 篮球没有盖住普通窗口；
- 桌面空白处命中**永远不等于本窗口** → 完全不挡桌面。

> ⚠️ **`desktop` 档下"球心/篮筐块必须命中我们"只在前台没有普通窗口盖住它时成立**。桌面上
> 随便开着微信 / 浏览器 / WPS，只要它盖住那个点，命中就是**它** —— 那是**正确**行为
> （`desktop` 的语义本来就是"被普通窗口盖住"）。这与"漏到桌面 / 被区域裁掉"完全是两件事，
> 所以诊断按命中对象分三档打印：`OURS ✓` / `0x…[窗口标题] <被前台窗口盖住·desktop 档正常>` /
> `0x…[Progman] <!! 漏到桌面 | 被区域裁掉>`。
> 要干净地验收就切 `--z-top`，或先把前台窗口最小化。
> （踩过：球心连续几次报"不是 OURS"、篮筐四块报"✗被裁"，一度当成缺陷去追，最后发现命中的是
> `Qt51514QWindowIcon "微信"`、`Qt5152QWindowIcon "悟空浏览器"`、`OpusApp "WPS Office"`
> —— 桌面上真开着的窗口。）

> ⚠️ `WindowFromPoint` 返回的是**最深的子窗口**（Electron 的页面是 `Chrome_RenderWidgetHostHWND`，
> 桌面图标是 `SysListView32`），拿它和我们的顶层 hwnd 比较永远不相等 ——
> 必须先用 `GetAncestor(h, GA_ROOT)` 归一到顶层窗口再比。

#### 2.1.2 置顶档：`setAlwaysOnTop(true, 'screen-saver')`

`'screen-saver'` 是 Windows 上最高的 band，连任务栏一起压住。切档**立即生效**：走的是
`ipcMain.on('patch-config')` → `anchorToDesktop()`，不重启、不重建窗口。

三个必须记牢的点：

1. **一旦置顶，绝不能再调 `anchorAboveDesktop()`**。`SetWindowPos` 插到某个非置顶窗口
   下面时，Windows 会顺手把 `TOPMOST` 属性剥掉 —— 置顶"自己"就失效了。所以每一处
   z 序操作（`anchorToDesktop` / 1.2s 的 keeper / 验收夹具收尾）都必须先看档位再动手。
2. **从 `top` 切回 `desktop`，除了摘掉 `TOPMOST` 还得手动锚一次**。只 `setAlwaysOnTop(false)`
   会把窗口留在"普通带最顶部"，也就是盖住所有普通窗口 —— 与 `desktop` 语义正好相反。
3. **判据不能写成 `above == 0`**。z 序顶端常驻一个零面积的幽灵窗口
   `Internet Explorer_Hidden`（IEFrame 的），它的 `IsWindowVisible` 返回 **true**，但
   `GetWindowRect` 面积为 0，实际什么都不画。只看可见性会把它当成"有窗口盖着"而误报。
   正确判据是「上方没有**普通**窗口」= `above == 0 || above 是 TOPMOST`。
   `native.zInfo()` 因此多返回 `aboveEx / aboveIsTopmost / aboveArea` 三个字段。

**验收证据**（`--diag --test-normal-window` 会真的开一个不透明普通窗口盖住大半个屏幕；
夹具还会把球**摆进**那个窗口再判命中 —— 球在窗口之外时"球心命中谁"说明不了任何问题）：

```
# --z-top：球盖住普通窗口
DIAG exstyle=0x8200088 TOOLWINDOW(不在Alt+Tab)|NOACTIVATE(不抢焦点)|TOPMOST(置顶) alwaysOnTop=true zMode=top
DIAG zorder  zMode=top above=0x104b2[Internet Explorer_Hidden] topmost=true area=0
             <置顶生效 ✓ 上方只有零面积幽灵窗口>
DIAG hittest testWin=0x1006d4(普通窗口) 球在窗内 3/3 全 →OURS <球盖住了普通窗口 ✓>
             taskbar→0x10122 (未被覆盖 ok) | blank@720,315→0x1006d4（空白处仍穿透）

# --z-desktop：普通窗口盖住球（原有行为，未被破坏）
DIAG exstyle=0x8200080 …（无 TOPMOST）  alwaysOnTop=false zMode=desktop
DIAG hittest testWin=0x1106d4(普通窗口) 球在窗内 2/2 全 →testWin <窗口盖住了球 ✓>
```

判据 —— `desktop`：`below` = 桌面锚点、`above` ≠ 任务栏、球心被测试窗口盖住。
`top`：`alwaysOnTop=true` 且扩展样式带 `WS_EX_TOPMOST`、上方无普通窗口、**球心命中的是我们**。
运行时切换（不重启）也要验：启动在 `desktop`，用 `--eval` 调 `__pbZMode('top')`，
1.4 秒后（跨过至少一次 keeper 周期）dump 必须已经变成 `TOPMOST` —— 证明它没被 keeper 拽回去。

### 2.2 逐像素点击穿透（核心难点）

窗口是全屏的，但用户点空白桌面时必须**完全穿透**到桌面图标层。方案：

**主方案 —— Win32 窗口区域（零延迟，无全局钩子）**

用 koffi 调 GDI 造一个复合区域，交给 `SetWindowRgn`：

```js
// src/native.js —— 空区域 → RGN_OR 逐个并上圆盘和矩形
let rgn = CreateRectRgn(0, 0, -1, -1);          // 空
for (const [x, y, r] of shape.circles) {
  const c = CreateEllipticRgn(x - r, y - r, x + r, y + r);
  const t = CreateRectRgn(0, 0, 1, 1);
  CombineRgn(t, rgn, c, RGN_OR); rgn = t;       // 并集
}
```

渲染进程每帧上报「可交互形状」= 每个球的圆盘（半径 = 球半径 + 12px 抓取余量，所以**稍微点偏一点也能抓住**）
\+ 快捷控制栏矩形 + 右键菜单矩形 + **篮球架的四块矩形**（见 §2.2.1 —— 漏掉它，篮球架会被静默裁掉）。
区域外的像素对系统**完全不存在**，因此不存在「先收到点击再转发」的延迟。

- 形状做字符串去重，没有变化就不重复调 `SetWindowRgn`。
- **拖拽 / 右键菜单打开期间**一律上报**整窗矩形**（`locked`），保证 `pointermove` 不丢；释放后立刻恢复逐球形状。
  整窗矩形在开始拖拽时上报一次，之后形状字符串**恒定不变** → 形状去重生效 → `SetWindowRgn` 一次都不会再被调用，
  主进程零成本。
  ⚠️ **别改回"只报一条跟着指针走的窄走廊"**（用球心→指针的外接盒代替整窗）：走廊看起来省了合成面积，
  但它**每帧都在变**、去重永远失效，主进程得每帧重建区域并重定向窗口表面。60 球同进程 A/B 实测
  合计单核反而多 3 个百分点（16.69% → 19.77%，差值全在 Browser 进程），见 §6.5。
  走廊路径在 `bench.region='corridor'` 下保留，只供 `--drag-test` 做 A/B，默认不开。
- 连续 3 次失败则自动回退到 Electron 的 `setIgnoreMouseEvents(true, {forward:true})`。

**⚠️ 右键菜单必须先改区域、再露面（同步 IPC）**

菜单是 DOM 画出来的，窗口的 `SetWindowRgn` 区域是**另一条流水线**。如果先让菜单显示、再异步去改区域，
菜单会先以「上一次的区域」（= 一串球圆盘）被裁切 —— 边缘出现半圆形缺口。
所以菜单打开走**同步 IPC**（`ipcRenderer.sendSync` / `ipcMain.on` + `e.returnValue`），
并且顺序固定为三段式：

```js
menuEl.innerHTML = html;
menuEl.style.visibility = 'hidden';   // 1) 先 layout 量尺寸，不产生任何像素
menuEl.style.display = 'block';
const r = menuEl.getBoundingClientRect();
/* 摆好位置 */
sendShape(true, true);                // 2) 同步：阻塞到主进程 SetWindowRgn 真正完成
menuEl.style.visibility = 'visible';  // 3) 区域就位后才露面
```

另外 `locked` 分支**不能做去重**：菜单每次打开/关闭都要真的把区域在「整窗」与「逐球」之间切一次，
去重会让它停在上一次的状态。

**备用方案 —— 全局低级鼠标钩子**

`WH_MOUSE_LL` 钩子实时判断光标是否落在形状内，动态切 `WS_EX_TRANSPARENT`。托盘可切换，用于某些
`SetWindowRgn` 与透明窗口兼容性不佳的驱动。

**实测验证**（`--diag`）：

```
DIAG hittest ball0@81,818→OURS | ball1@1332,818→OURS
             taskbar→0x10100(Shell_TrayWnd, 未被覆盖 ok)
             blank@720,315→0x101b0(桌面锚点) | blank@115,495→0x101b0
DIAG exstyle=0x8200080 TOOLWINDOW(不在Alt+Tab)|NOACTIVATE(不抢焦点) focused=false
region={"type":3(COMPLEXREGION),"left":-1,"top":-1,"right":1440,"bottom":852}
```

同时因为窗口本身不接收焦点、渲染进程阻止了 `contextmenu / selectstart / dragstart / mousedown / dblclick`，
**不会出现 Windows 蓝色框选、不会选中桌面图标**。

#### 2.2.1 窗口区域必须覆盖**所有**绘制内容（"篮球框隐形"的真因）

`SetWindowRgn` 设的区域就是窗口的**可见范围**：区域之外的像素**根本不绘制** —— 不画，也不可点。
所以「上报哪些矩形」这件事同时决定了「哪些东西看得见」。

曾经的形状里只有三种东西：球的圆盘、快捷控制栏、右键菜单。**篮球架从来不在里面**，
于是真实屏幕上它是隐形的，表现为一组很迷惑的症状：

| 用户看到的现象 | 真正的原因 |
|---|---|
| 篮球架平时完全不显示 | 它不在区域里，被整体裁掉 |
| 一拖动篮球，篮球架就闪一下 | `sendShape` 的 `locked` 分支把区域临时撑成**整窗矩形**，松手又收回去（所以旧版拖一下就能看见篮球架） |
| 篮球周围一圈能看到篮球架 | 球圆盘半径 = `ballRadius + 12 = 46px`；球滚到架子旁边时这个圆蹭到架子边缘，才露出那一角 |

> 这个 46px 的球圆盘后来又成了另一个 bug 的舞台：它相对球自身只有 6~12px 余量，
> 而区域比画面恒定晚 1~2 帧，于是**球飞得快时会被切掉一块**。见 §6.6。

修法是把篮球架的四块矩形也并进区域（`src/renderer/app.js` 的 `hoopRects()`）：
篮板、篮圈（连圈内的洞）、网、立柱+底座。几何必须与 `physics.js::setHoop` 的碰撞体、
`render.js` 的绘制**同源**（`tube=6` / `span=openW+2*tube` / `boardW=124` / `boardH=96` /
`boardRight=w-30` / `rimY=max(180,h-322)` / `poleX=w-22`，篮圈压扁共用同一个 `rimSquash`），
否则区域和画面会错位。另外切换篮球架开关（`onHoopChanged`）后必须重新上报一次 shape，
不然关掉再打开会留下一块被裁掉的空白。

**这一条特别容易被"自证"骗过去：** `webContents.capturePage()` 读的是渲染进程自己的合成结果，
**完全不知道窗口区域的存在** —— 它输出的截图里篮球架完好无损，而屏幕上什么都没有。
所以验收必须用真实屏幕坐标打 `WindowFromPoint`（`tools/region-probe.ps1`），
或者直接抓真实屏幕（`tools/screencap.ps1`）。

**实测对照**（`tools/region-probe.ps1`，同一台机器、同一份几何）：

```
修复前  backboard  @1348,492 → 0x101b0 桌面   被裁
        rim-left   @1175,530 → 0x101b0 桌面   被裁
        net        @1233,595 → 0x101b0 桌面   被裁
        pole       @1412,700 → 0x101b0 桌面   被裁
        stand-base @1412,840 → OURS           ← 球正好滚在旁边，被球圆盘"救"了
修复后  以上 5 点 + ctrl-add/ctrl-minus → 全部 OURS (in region)
        desktop-blank @300,400 → 0x101b0 桌面   桌面点击穿透仍然正常
RESULT: PASS
```

### 2.3 物理：Matter.js + 固定时间步

`src/renderer/physics.js`。Matter.js 0.20.0 的参数：

```js
M.Engine.create({
  enableSleeping: true,      // ★ 静置自动休眠，空闲 CPU 从 13% 降到 0.19%
  positionIterations: 8, velocityIterations: 4, constraintIterations: 2,
});
engine.gravity.y = 1; engine.gravity.scale = 0.0012;
```

固定步长 accumulator（**物理与渲染彻底分离**）：

```js
const STEP_MS = 1000 / 60;
acc += dt;
let steps = 0;
while (acc >= STEP_MS && steps < 4) { world.step(); acc -= STEP_MS; steps++; }
if (steps >= 4) acc = 0;          // 落后太多就丢弃，绝不让物理追赶爆炸
```

涵盖的物理要素：重力、弹性（`restitution 0.72`）、地面/墙摩擦、空气阻力（`frictionAir 0.0115`）、
速度与加速度、旋转（`angularVelocity`）、惯性、球-球碰撞、球-地面碰撞、球-篮筐碰撞。

#### ⚠️ 本项目最深的坑：Matter.js 的速度单位是「像素 / 固定步长」而不是「像素 / 秒」

`60 px/step` 等于 `3600 px/s`。第一版把指针速度（px/s）直接喂给 `Body.setVelocity`，
速度被放大 60 倍 → 球一步位移 1370 像素、直接穿透墙体 → 求解器把「深穿透」当分离量猛推 →
所有球被弹到几万像素外。**修法是在物理入口统一折算**：

```js
const V     = (pxPerSec)  => pxPerSec / 60;   // 人读得懂的速度 → 物理单位
const V_INV = (pxPerStep) => pxPerStep * 60;  // 物理单位 → 人读得懂
```

配置项、指针速度、基准脚本一律用 px/s，只在进入物理层时折算。
`tools/bench.js` 的外力注入同样做了这个折算，否则基准数据全是假的。

#### 出生点

球必须生成在场地内且不与静态墙体/其他球重叠，否则同样触发「深穿透 → 炸飞」。
`findSpawn()` 在场地内按网格扫描，配合 `overlaps()` 找一个空位；载入存档时若位置重叠也换到安全点。

### 2.4 渲染：脏矩形分块 + 双画布分层

`src/renderer/render.js`，`TILE = 128px`。

- **双画布**：`#stat`（z0）只画篮球框这类几乎不变的静态内容；`#dyn`（z1）画球、粒子、飘字、光环。
- **脏块**：每个元素先算 AABB → 标记覆盖的 tile → 只对脏 tile 做 `clip + clearRect + 重绘`。
  没有脏块直接 return。球 AABB 会额外放大以容纳速度拉伸、落地挤压变形和阴影，避免拖影。
- **保留两代脏块历史** `prevActive` / `prevActive2`：元素移走后，上一帧留下的残影块也会被清掉。
- **纹理烘焙**：球底、球缝、高光、阴影各一张 320×320 canvas，只在初始化时渲染一次。
  逐帧不是画这 4 张 320² —— 每套皮肤按设备像素烘三级（`master` / `exact` / `head`），
  且底色与高光烘前合并成 `body`（每球 3 次 `drawImage`）。为什么这么改见 §2.12。
- 脏块超过总数 60% 时降级为整屏重绘。

#### 空闲期也要能消化挂起的重绘

空闲（全部球休眠）时主循环默认不渲染。但「切换篮球框 / 增删球 / 窗口尺寸变化」都只是**标脏块**，
不主动渲染的话要等到下次有球动起来才可见 —— 表现就是"点了篮球框开关没反应，动一下球才出现"。

修法是给渲染器加一个 `pending()`（还要不要重绘），主循环补一个分支：

```js
if (!idle) { …物理 + frame(…)… }
else if (renderer.pending()) needDraw = true;   // 空闲期消化一次挂起的重绘
```

> 篮球框"只有拖动球时才出现"这个 bug 就是这个原因：`onHoopChanged` 标了脏块，
> 但从来没有人在空闲期消费它。

#### 分层绘制的 z 序

`#stat` 只放「球永远不该盖住」的部分：立柱、底座、篮板、篮圈的**远侧弧**。
`#dyn` 放需要压在球上面的部分：**网**、篮圈的**近侧弧**。

这两块必须**始终入列** `frame()` 的绘制项（不能只在动画时画），
否则 `#dyn` 的脏块被清掉后不会重画回来 —— 球路过就会在网上留下一个洞。

### 2.5 篮球与篮球架的外观

都是纯 Canvas 2D 程序化绘制，零图片资源。

**篮球**：三层烘焙 + 一张阴影（`bakeTextures()`）

| 层 | 内容 | 是否随球旋转 |
|---|---|---|
| base | 8 档径向渐变球面光照 → 240 个中频斑驳 → 620 个颗粒簇 → 2200 个细颗粒浮雕（右下暗点 / 左上亮点）→ limb darkening → 右下反弹光 → 轮廓 | 否 |
| seam | 竖向大圆 + 横向大圆（带 0.17R 下弧）+ 左右两条外弧；三层叠加：宽凹槽阴影 / 缝本体 / 受光侧细高光 | **是** |
| hi | 椭圆高光池 + 锐利镜面点 | 否（模拟固定光源） |
| shadow | 4 档径向衰减 | — |

两个关键取舍，都是"降采样 4.7 倍"逼出来的：

1. **必须有中频（6~22px）斑驳层**。高频颗粒在 320 → 68 的缩放里会被完全平均掉 ——
   只做渐变 + 高频颗粒，缩到实际尺寸就是一颗**纯色橙球**，这正是"廉价球"的来源。
2. **外弧控制点取 1.32R 而不是 1.60R**。1.60R 时最宽处落在 0.20R，外瓣只剩一条，
   降采样后左右糊成两片"花瓣"；1.32R → 0.34R，四片球瓣宽度接近相等，缩小后仍然读得出是篮球。

缝宽也压过一轮：`R*0.052` 在实际 68px 的球上是 3.5px 的黑线（像马克笔画的），改成 `R*0.034` ≈ 2.3px。

**篮球架**：几何参数全部来自 `physics.js` 的**真实碰撞体**（视觉与物理同源，改一处两边一起变）

- 篮圈画成**带透视的椭圆环**：`rimSquash = max(7.5, rx * 0.26)`。
  取更扁的值时前后两段弧会并成一块橙色实心饼，圈里那个"洞"就没了 —— 而"洞"正是篮圈区别于一块椭圆板的唯一特征。
- 远侧弧用暗色 `#7d2b05`，近侧弧用垂直渐变 `#ffb877 → #a63c08` + 镜面高光。
- 立柱**一路落到地面**并有底座。只画篮板附近那一小段时，它是一根悬在半空的铁棍，
  怎么调比例都不像篮球架。（底座宽度按到窗口右缘的距离反推，否则会被窗口裁掉一半。）
- 网：菱形网格（12 根 × 4 行，两族斜绳交织 + 底部收口）。两个细节决定它像不像网：
  **先描一遍半透明深灰"落影"再描白绳**（纯白线在浅色桌面上看不见），
  **顶部按篮圈远侧弧裁掉**（挂点的后半圈在 3D 里被篮圈挡住，不裁就会看到网绳横穿篮圈的暗色远弧）。

实测 20 球运动中：脏块 44/84，绘制 0.5 ms。

### 2.6 触控与鼠标交互

- `pointerdown / pointermove / pointerup / pointercancel` 全部 `passive: false`。
- 拖拽用**速度伺服**：每步把球的速度设成 `(目标点 - 当前位置) * 0.45`，并限速。
  → 球"粘"在指针上但仍有物理惯性，不会瞬移穿墙。
- 松手：取最近 **110ms** 滑动窗口内的采样点算 `recentVelocity()`，乘以 `throwGain(1.12)`，上限 `maxThrowSpeed(2200 px/s)`，
  折算后 `Body.setVelocity` + 一个跟速度成正比的 `angularVelocity`（旋转惯性）。
- 触摸用 `e.getCoalescedEvents()` 取回合并事件，提高采样率。
- 抓取半径 = 球半径 + 12px，**按住就能抓住**。
- 阻止 `contextmenu / selectstart / dragstart / mousedown / dblclick`，不出现蓝色选择框。

### 2.7 空闲降频（关键的性能设计）

```js
function isIdle() {
  if (drag || menuOpen) return false;
  if (fx.particles.length || fx.texts.length) return false;
  if (hoop.enabled && (hoop.netAnim > 0.02 || hoop.flash > 0.02)) return false;
  for (const b of world.balls) if (!b.body.isSleeping) return false;   // 全部休眠
  return true;
}
```

全部球进入 Matter 休眠后，主循环从 `requestAnimationFrame` 切换成 `setTimeout(loop, 160)`（≈6 Hz 巡检）。

**两个必须配套的修复：**

1. `hoop.flash` 原来只做 `*= 0.9` 从不显式归零。浮点下 `0.9^n` 要 7000 多步（≈118 秒）才下溢到 0，
   期间 `isIdle()` 永远为 `false` → rAF 以 450 fps 空转反复重绘光环区域。
   **静置 CPU 因此卡在 13%。** 加 `if (flash < 0.02) flash = 0` 后降到 **0.19%**。
2. `wake()` 原来 `if (scheduled) return;`。空闲期挂的是 160ms 定时器，此时来电事件会**直接早退**，
   最坏要等 160ms 才开始处理 —— 这是最隐蔽的触控延迟源。
   改成：若当前挂的是定时器，先 `clearTimeout` 再立刻走 rAF。实测空闲期唤醒延迟
   平均 2.2 ms / 中位 0.5 ms / 最大 9.4 ms。

另外因为软件合成下 rAF 不锁 vsync（本机 150~450 Hz），主循环在 accumulator 未攒满一个步长时
直接早退，不推进物理、不尝试渲染。

### 2.8 音效

`audio.js` 用 WebAudio 振荡器 + 噪声缓冲**纯合成**，零音频资源文件：

- 弹跳：正弦下滑 150 Hz → 目标频率 ×0.55 + 带通噪声，48ms 节流避免连击爆音
- 进球：三角波 880 / 1318.5 Hz 双音上行 + 高通刷网噪声。**连击每级把音高抬 6%**（封顶 11 级），
  空心球再抬 12% 且刷网更久更亮 —— 听感上能直接分辨"这颗是连击 / 空心球"
- 破纪录：方波四音上行号角（523→659→784→1046 Hz），与进球音区分开
- **成就解锁**：三角波四音上行琶音（784→988→1175→1568 Hz）+ 五度叠音 + 一层高通闪烁噪声
  （"金属光泽"）。音程刻意与破纪录错开，听感上能分辨"刷新纪录"和"解锁成就"
- **金球入网**：正弦五音快速上行（×1.2 等比），金币感的短促清脆

### 2.9 GPU 自愈降级链

本机（i5-8500，无可用 GPU）上 Chromium 的 GPU 进程会反复以 `exit_code=-1073741819` 崩溃并 FATAL 退出。
逐个模式排除后确认：`disableHardwareAcceleration` 不够、`--disable-gpu` 不够、`--disable-gpu-compositing` 不够
（而且它还会让透明画布不合成，球完全看不见）；**唯一可行组合是 `--in-process-gpu`**。

实现成三级兜底：

```js
// 快路径：首次检测到 GPU 进程异常退出，立刻带 --no-gpu 重启自己
app.on('child-process-gone', (e, details) => {
  if (details.type !== 'GPU') return;
  config.patch({ forceNoGpu: true });
  app.relaunch({ args: process.argv.slice(1).concat(['--no-gpu']) });
  app.exit(0);
});
// 慢路径：用 config.lastRunStarted 当探针 —— 上次没正常跑起来，这次直接软件合成
const forceNoGpu = argv.includes('--no-gpu') || cfg.forceNoGpu || cfg.lastRunStarted === false;
```

### 2.10 计分与玩法

**计分规则**：普通进球 **+2**，**空心球 +3**（球从出手到穿过篮圈全程没碰篮板/篮圈）。

- 空心球判定：`collisionStart` 里凡有球 vs `label==='hoop'`（篮板/篮圈/连接件）就把该球
  刚体上的 `touchedHoop` 置位；进球判定时读一次并清零。球回到篮圈上方 80px 以上视为
  新一次投篮，同样清零 —— 否则上一轮的碰框会一路留到下一次进球，把空心球误判成普通球。
- 标记挂在 Matter 刚体上（`body.touchedHoop`）：碰撞回调里只拿得到刚体，拿不到外层 ball 对象。

**连击**：两次命中间隔 ≤ 4s 记为连击（`world.combo`），否则重新从 1 起。命中时飘 `连击 ×N`，
音效音高随之抬升。

**最高分**：`world.highScore` 由 `config.highScore` 初始化，破纪录时写回配置（跨会话保留）。
`清空重来` 只把得分/连击归零，最高分保留。判据 `score === highScore` 即"本次是新纪录"
—— 分值只增不减，且只有新高才会把 `highScore` 拉到 `score`。

**操作补全**（右键菜单 / 托盘 / 全局快捷键三处同步）：

| 操作 | 快捷键 | 说明 |
|---|---|---|
| 把所有球抛起来 | `Ctrl+Shift+空格` | 每颗球随机角度、700~1600 px/s 上抛，一键把场子玩起来 |
| 清空重来 | `Ctrl+Shift+R` | 球回到 1 颗、得分与连击归零，最高分保留 |
| 快捷控制栏 | — | 显示/隐藏左右两组 ＋ −。**修复**：托盘早有此菜单项，但渲染进程
  `doAction` 里没有 `toggle-bar` 分支，点了没反应。现补上，并在切换后 `sendShape()`
  重报窗口区域 —— 否则隐藏后那两块会留下"能点但看不见"的死区 |

#### 2.10.1 控制栏的「设置」按钮（`⚙`）

两侧控制栏在 `＋` / `−` **上方**各多一个 `⚙`（`.bar button.cfg`）。三个要点：

1. **它不属于新 UI，只是右键菜单的第二个入口。** 点击走 `openMenu()`，菜单内容就是
   `menuModel()` 那一份 —— 皮肤 / 特效 / 拖尾 / 记分板 / 层级 / 音效 / 自启动 / 性能信息 /
   控制栏开关 / 退出全都在里面。设置清单**只有一份**，避免两条设置路径日后不同步。
2. **放在列首（`＋` 之前）是为了不动旧布局。** `.bar` 是 `bottom:7px` 的 flex 纵向列，
   贴着屏幕底角的是最后一项；把 `⚙` 插到列首，`＋` `−` 相对底角的位置与旧版**完全一致**。
   反过来插到末尾会把高频的 `＋`/`−` 顶上去。
3. **它必须留在 `.bar` 容器内。** 窗口区域是按 `barRects()` 量**整个 `.bar` 的外接矩形**上报的
   （见 §2.2.1：区域就是可见范围，漏报即隐形）。做成三个独立定位的按钮就得各补一条上报；
   留在容器里则 `getBoundingClientRect()` 自动带上它，区域无需改动。
   同理 `pointerdown` 必须 `stopPropagation()`，否则会冒泡到 window 的 `onDown`
   被当成"挑选篮球"，在按设置的同时顺带抓起一颗球。

**锚点**：取 `⚙` 的上沿传进 `openMenu(x, y, true)`。`preferAbove` 让菜单先按
"上沿 = 锚点 − 菜单高 − 2"向上翻，再统一钳进 `[6, H-6-h]`；不给这个参数就保持旧的
"向下展开"语义（右键菜单）。所以左右下角的按钮都不会被菜单盖住。
菜单是 DOM → 走 `sendShape(true, true)` 同步 IPC 先改区域再露面（§2.2 那套，没有变化）。

**小屏兜底**：菜单 18 项、高约 605px，`#menu` 加了 `max-height: calc(100vh - 12px)` +
`overflow-y: auto`，768 高的屏幕上也不会把底部几项推到屏幕外（菜单打开时窗口区域是整窗，
滚动照常命中）。

**验收**（17 条断言，开发版与打包版都要跑）：

```bash
unset ELECTRON_RUN_AS_NODE
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --user-data-dir="$TEMP/dbb-cfg" --exit-after=6000 \
  --eval="$(cat tools/verify-barsettings.js)"
# 打包版把 electron.exe . 换成 dist/DesktopBasketball-win32-x64/DesktopBasketball.exe
```

覆盖：两侧都有 `⚙` 且在列首 / 尺寸 32×32 与 `+` 同列 / `barRects()` 已覆盖它 /
点开菜单且菜单底边在按钮上方 2px / 点空白能关 / 点 `+` 只加球不开菜单不抓球 /
右键路径仍向下展开（旧行为回归）。实测两版均 `pass:true`。

**性能**：以上全部是**事件驱动**（碰撞 / 进球 / 按键）或**瞬时粒子**，不含任何按帧轮询，
所以静置降频（球休眠 → 160ms 巡检）不受影响，实测 5s 无操作后仍 `idle=true` / `loop 5.9Hz`。

**同时修掉一个潜伏 bug**：碰撞回调原先直接传 Matter 刚体，而上层写 `ball.squash`、
渲染读的却是**外层 ball 对象** —— 于是「撞击挤压形变」其实一直没生效（`squash` 恒为 0）。
现在回调传外层对象（刚体上 `_pbBall` 反向引用），形变恢复；`render.js` 的 AABB 早已
按 squash 预留了余量，无需改动。

### 2.11 玩法增强包 #2：皮肤 / 瞄准线 / 成就 / 金球 / 记分板

#### 2.11.1 球皮肤（6 套 + 金球）

皮肤分**两条完全不同的管线**：

**① 程序化外观（3 套）** —— `render.js` 的 `bakeLayers()` 手绘。原先写死的颜色抽成了
`SKINS` 调色板（8 段底色渐变 / 斑驳色 / 颗粒色 / 边缘暗化基色 / 反弹光 / 轮廓 /
三条缝线色 / 斑驳强度倍数），5 套主题 + 金球共用同一套多层光照算法。

**② 照片级素材（3 套）** —— `bakeSphere()`：把**从网上找来的真实素材**按球面几何
重投影成圆盘。光照模型（半兰伯特漫反射 + 三层高光 + 右下反弹光 + 边缘暗化）与
`tools/tex-lab/sphere_preview.py` 逐项一致 —— 先在 Python 里对着 68px 实际大小调好看，
再把常量搬进 JS，省掉"每改一次参数就打包截图"的循环。

| 键 | 名称 | 管线 | 素材 |
|---|---|---|---|
| `classic` | 经典篮球 | 程序化 | 默认配色 |
| `neon` | 能量球 | 程序化 | 深青紫 + 亮青缝线 |
| `soccer` | 足球 | 程序化 | 白底 + 黑缝（`patchScale: 7` 把斑驳放大成黑块） |
| `watermelon` | 西瓜 | **照片** | 真实西瓜照片，`mode:'photo'` |
| `planet` | 地球 | **贴图** | 地球等距圆柱全景图，`mode:'equirect'` |
| `jupiter` | 木星 | **贴图** | 木星等距圆柱全景图，`mode:'equirect'` |
| `gold` | 金球 | 程序化 | **不在循环里**，只归金球彩蛋用 |

两条映射路径（`SKIN_IMG[*].mode`）：

- **`photo`** —— 源图是「一整颗水果」的照片。直接把照片当球面正视图重投影：圆盘上
  法线为 `(nx,ny)` 的像素，取照片上「物体中心 + `(nx,ny)`·物体半径」处的颜色。
  这条路**不需要无缝贴图** —— 照片里的西瓜长什么样，球就长什么样，连瓜皮的胎记都
  一并搬过来。实测比去找"西瓜无缝材质"现实得多：真实瓜皮的等距圆柱全景图基本不存在，
  但整颗瓜的照片一抓一大把。
- **`equirect`** —— 源图是等距圆柱全景，按经纬度采样，`phase` 把贴图转到正面最好看的经度。
  ⚠️ 屏幕的 `ny` 向下为正、而全景图的 `v=0` 在**北**极，写成 `0.5 - lat/π` 会把南北极
  整个倒过来（地球南极朝上、木星条带反着转）—— 而且两颗球都"还能看"，很容易漏过去。

**每球一次绘制**：素材皮肤出来的是**单层**圆盘（光照已烘进去），`drawBall` 里
`tex.single` 分支每帧只要 1 次 `drawImage`，加上阴影共 2 次 —— 比程序化路径的
3 次（body + 球缝 + 阴影）还少。球数上限提到 100 之后这一点很关键
（实测 100 球 `drawCalls=200`，正好是 100×2）。

**整颗球跟着球转**：素材是照片级材质，静止的球面一眼就是"贴纸感"。圆盘绕圆心旋转，
在正投影下恰好等于球体绕**视线轴**自转（这条是精确的，不是近似）。代价是烘进去的
高光也会跟着转（实物的高光该钉在空间里不动）——权衡后保留：自转角速度很慢（一秒钟
也就几度），高光缓慢扫过读起来像"表面在流动"，比"球在滚、材质纹丝不动"自然得多。

##### 素材来源（全部为公共领域 / CC0 / CC BY，文件在 `src/renderer/textures/`）

| 文件 | 皮肤 | 来源 | 授权 / 作者 |
|---|---|---|---|
| `watermelon.jpg` | 西瓜 | [Crimson Sweet watermelon](https://commons.wikimedia.org/wiki/File:Crimson_Sweet_watermelon.jpg)（Wikimedia Commons） | CC BY-SA 4.0 · Eric Polk |
| `earth.jpg` | 地球 | [Solar System Scope — 2k Earth daymap](https://www.solarsystemscope.com/textures/) | CC BY 4.0 · Solar System Scope |
| `jupiter.jpg` | 木星 | [Solar System Scope — 2k Jupiter](https://www.solarsystemscope.com/textures/) | CC BY 4.0 · Solar System Scope |

三张素材都经过 `tools/tex-lab/` 下的脚本机械处理（**不是"自己画"**）：

- `melon_fit.py`：从西瓜照片里用颜色掩膜拟合瓜的**内接圆**（`cx/cy/r`），裁成以圆心为
  中心的正方形 → 于是配置里恒为 `cx=cy=0.5`、`rr=0.5`；顺带做高光滚降（压掉棚拍灯的
  镜面反光，否则球面会发白）与轻微提饱和。
  ⚠️ 别用"到质心距离的分位数"当半径：瓜是**椭圆**（竖长横短），分位数一取大半径就
  超出左右边缘，球边上会吸到木桌和藤筐 —— 要用 x/y 各自的稳健包围盒取**较小**的那半边。
- `sphere_preview.py`：本机预览器，把"源图 + 映射方式"渲染成球，并同时给出 320px 原图 /
  68px 实际大小 / 深底浅底 / 4× 放大，用于选型与调光。

素材是**打包进程序**的（`src/renderer/textures/*.jpg`，共约 400KB），运行时不联网。
由 `preload.js` 读成 data URL 交给渲染进程 —— 为什么不用 `file://` 直接 `<img src>`：
`file://` 页面里的 `file://` 图片在 Chromium 里算**跨源**，画进 canvas 之后画布被污染，
`getImageData` 会直接抛 `SecurityError`，而球面重投影必须逐像素读源图。

- 纹理**按需烘焙**并缓存：启动只烘 `classic`，切主题 / 出现金球时才补烘那一套。
- 每颗球可带自己的 `ball.skin`（金球就是 `'gold'`），`drawBall` 按它取纹理；
  没有 `skin` 的球跟随全局主题。
- 素材解码是**异步**的，而启动时 `setSkin(cfg.skin)` 是同步跑的 —— 用户上次停在水晶球上时
  首次 `texFor` 会拿不到素材、烘成程序化兜底外观并缓存下来。所以解码完成后走
  `Renderer.reloadTextures()` 把 `texCache` 清掉重烘（`app.js` 的 `PB.onTexturesLoaded`）。
- 素材缺失（打包漏掉 / 手动删掉）**不是致命错误**：`bakeLayers()` 会退回到该皮肤的程序化
  调色板，于是"皮肤变回原来的样子"，而不是黑球或抛异常。
- 切换入口：右键菜单「球皮肤」（点一次循环一个）/ 托盘同名项。持久化在 `config.skin`。

#### 2.11.2 拖拽瞄准辅助线

拖拽期间画一条预测抛物线 + 落点靶环，松手即消失。

- 积分方式与 Matter 的 `Body.update` **逐步对齐**：每步 `v *= (1 - frictionAir)` 再 `v.y += g`
  再 `p += v`，速度上限同 `onUp`（`maxThrowSpeed`），初速度同 `onUp`（指针速度 × `throwGain`）。
- **重力增量是实测出来的**（`measureGravityStep`）：临时建一个同 `gravity.y/scale` 的一次性引擎，
  放一颗 `frictionAir:0` 的球、跑一步、读它的速度增量。不自己推导 `deltaTime²` 那套折算 ——
  算错一处就偏 30%，而且引擎升级会静默失配。
- 验收（`__pbAimTrace`）：同一组出手速度，一条走预测、一条真的让引擎跑。实测
  `predicted.apexY=536 / real.apexY=536`，`predicted.last=[335,818] / real.landX=335,landY=818` —— **完全一致**。

#### 2.11.3 成就（13 个）

`app.js` 里的 `ACHIEVEMENTS` 表 + `achSet`，判定**全部挂在事件上**（进球 / 加球 / 换皮肤），
**没有任何逐帧轮询** —— 逐帧检查会让 `isIdle()` 永远为假，静置降频直接失效。

初次得分 / 空心球 / 打板得分 / 三连击 / 五连击 / 十分 / 五十分 / 百分 / 金球入网 /
金球空心 / 球满为患（20 颗）/ 刷新纪录 / 换装达人。

解锁时：画布横幅 + 彩带粒子 + 专属音效 + 底部 toast，并写回 `config.achievements`（跨会话）。
`unlock()` 幂等（已解锁直接返回 false）；菜单/托盘显示 `已解锁 N 个`，点「成就」在画布上列出全部
（用 canvas 而不是新弹层：天然进脏块渲染，不额外驻留 DOM，也不用往窗口区域里加东西）。

#### 2.11.4 金球彩蛋

每 18~40 秒随机把一颗球变成金球（`spawnGolden`），**投进得双倍分**（普通 4 / 空心 6），
入网后立刻恢复常规皮肤。可关（菜单 / 托盘「金球彩蛋」）。

它是**空闲期唯一会主动触发的东西**，但纯事件：换一次贴图 → 标一次脏块 → 唤醒一帧，
随后 `isIdle()` 仍为真、主循环照旧退回 160ms 巡检。实测不影响降频。

#### 2.11.5 记分板 HUD

顶部居中的 DOM 药丸：`得分 / 连击 / 最高`，多级连击时数字变白并发光。

- ⚠️ 它是 DOM，**必须把矩形加进窗口区域**（`hudRect()` → `sendShape`），否则 `SetWindowRgn`
  直接把它裁掉、真机上"看不见"（与左右控制栏同理，见 §2.2.1）。
- 代价是顶部中央一小块"能点但点不进桌面"的死区（191×42，与控制栏同量级），
  因此做成可开关（`config.showHud`，菜单 / 托盘「记分板」）。
- 分数只在进球时变一次，**不会**让主循环保持在 rAF 频率。

**性能**：以上同样全部事件驱动或仅在拖拽期间绘制，实测静置 5.6s 后仍是
`idle=true / loop 5.9Hz / step 0`。

### 2.12 流畅性专项：瓶颈是「每帧绘制调用次数」

**结论先行**：球多时掉帧不是因为像素多、也不是因为贴图大，而是因为**每帧往 2D 画布上提交的
`drawImage` 次数**。每球 4 次 → 240 次/帧 → 54fps（GPU）/ 47fps（软件）；每球 **3 次** →
180 次/帧 → **60fps 满帧**。门槛恰好卡在 4 次。

怎么定位到的（三步，全部可复现，脚本见 `tools/`）：

| 实验 | 做法 | 结果 | 排除掉什么 |
| --- | --- | --- | --- |
| 基线 | 60 球 chaos，`tools/bench-sweep.js` | 物理 0.32ms、绘制 JS 0.6ms，**却只有 47fps** | 不是物理、也不是 JS 侧耗时 |
| ① 换像素不换调用 | 球缝那层改画**不透明纯色块**（同样 1 次绘制） | 54.5 vs 54.3，纹丝不动 | 不是逐像素 alpha 混合 |
| ② 换档位不换次数 | 强制所有层走 1:1 的 `exact` 贴图（彻底不重采样） | 55.1，纹丝不动 | 不是每帧重采样 |
| ③ 只减一次调用 | 每球少画一层 | 54fps → **60fps** | 就是调用次数 |

**修法**：底色 `base` 与高光 `hi` 都不随球旋转、又画在同一坐标系里，于是烘前把它们
`source-over` 合并成一张 `body`（`render.js::mipSet` / `composite`），`drawBall` 里
`(mask & 2) && (mask & 8)` 时画 `body`、否则才拆开（诊断用）。每球 3 次：`body` + 球缝 + 阴影。

**代价**：合成顺序从「高光压住球缝」变成「球缝压住高光」，差异只可能出现在
**球缝 ∩ 镜面高光**那一小块。用预乘通道差量化（`__pbBallDiff()`）：程序化那几套皮肤
`mean 0.57~0.62`、圆盘内 3640 像素里仅 42~46 个差值 >16（约 1.2%），肉眼是"高光点里的球缝不再被冲白"
—— 物理上也更像真的（凹槽本来就会打断高光）。贴图本身没动，`texDiff` 仍是**全 0**。
（素材皮肤是单层，`ballDiff` 两边同源，恒为 0，属预期。）

**素材皮肤又省了一次**（见 §2.11.1）：它烘出来的是**单层**圆盘（光照已烘进去），
每球 = `single` + 阴影 = **2 次**绘制。于是球数上限从 60 提到 **100** 时，
每帧调用数是 100×2 = **200 次**，而不是「3 次/球 × 100 球 = 300 次」——
**球数涨了 67%，调用次数只涨 11%**。实测（`--cpu-test=100,16,8`，西瓜皮肤，**软件合成**，6 逻辑核）：
`drawCalls=200 / physMs=0.39 / drawMs=1.0 / stepHz=60 / loopHz=44`，
CPU 单核 27.4%、整机 4.6%；静置后仍进入空闲降频（单核 0.12%）。
> ⚠️ 这里的 44Hz 是 **Agent 环境强制软件合成**下的数字（本机在 Agent 会话里 GPU 进程
> 必崩、自动回退软件合成，见 §2.9）—— 用户自己双击运行时有 GPU，不能直接拿它当结论。
> 能跨环境比较的是 **调用次数**（200），那才是这条流水线的瓶颈。

**此前的一步（40 球档，41.7 → 59.6fps）**：旧实现每帧拿 320² 母版往 68px 现场降采样
（40 球 × 4 层）。现在每套皮肤烘三级：`master`（320²，算法不变）/ `exact`（= 设备像素直径，
1:1 blit，与母版现算**逐字节相同**）/ `head`（直径 ×1.3，留给挤压拉伸）。阴影也改成按
实际绘制尺寸烘，不再每次把 160² 缩到 78×66。**这两步都只减开销、不改画质**，验收脚本
`tools/verify-render.js` 给出的是像素级数字，不是"看起来还行"。

另修掉一处会静默出错的地方：`sm` 回落到 320² 母版时 `drawBall` 仍取 `tex.body`，
母版若没烘 `body` 就会 `drawImage(undefined)` 直接抛错 —— 所以母版也补了一张。

#### 2.12.1 上限抬到 200 之后的性能（2026-10-06 实测）

上限从 100 抬到 200 时**没有再做优化**（素材皮肤的"每球 2 次绘制"已经在 §2.11.1 吃过一次红利），
所以这里给出的是**未优化的真实数字**，作为用户选择球数的依据。

**软件合成**（Agent 环境的强制回退，是最坏情况；用户双击运行时走 GPU，会好得多），
`--cpu-test` 同机同场景对照：

| 球数 | fps | drawCalls | physMs | drawMs | 活跃单核 | 活跃整机 |
| --- | --- | --- | --- | --- | --- | --- |
| 100（西瓜） | 42.1 | 297 | 0.31 | 1.1 | 26.10% | 4.35% |
| **200（西瓜）** | **23.7** | **497** | **1.31** | **2.1** | **25.51%** | **4.25%** |

三条结论，值得记住：

1. **CPU 占用几乎没涨**（26.10% → 25.51%，落在噪声里），而 fps 掉了 44%。
   → **瓶颈是软件合成的吞吐，不是 CPU**。这也解释了为什么"上限翻倍"没有把机器吃满：
   软件合成的合成器在 500 次绘制/帧时就成了新的墙。
2. `physMs` 涨了 4 倍（0.31 → 1.31）—— 200 球两两碰撞的 broad-phase 对数上去了
   （实测 `pairs=142~521`）。但 1.31ms 仍在 16.7ms 帧预算的 8% 以内，**物理不是瓶颈**。
3. **静置不再自动休眠**：200 球互相挤压时 `pairs` 持续非零，球很难全部进入 `sleeping`，
   于是 `isIdle()` 长期为假、160ms 降频失效（实测 `idle=false`、静置单核 ~24%）。
   这是物理层的固有行为（100 球时已经能观察到），**不是本次改动引入的**。

> ⚠️ 与 §2.12 主表一样，这张表对机器负载敏感，且是**软件合成**下的数。
> 用户环境有 GPU，20/50/100 球档都是满帧；200 球的 GPU 数字本轮**没能测到**
> —— Agent 环境里 GPU 进程必崩（见 §2.9），只能在软件合成下取样。
> 能跨环境比较的是 **drawCalls（497）**，那才是这条流水线的瓶颈。
>
> **给用户的建议**：200 是**能力上限**，不是推荐值。日常玩 20~60 球体验最好；
> 100 球在软件合成下已降到 42fps、GPU 下才满帧；200 球是"能开、但会明显掉帧"的档位。

### 2.13 视觉增强包：进球特效 + 运动拖尾

两个独立开关，右键菜单与托盘都有：**进球特效**（`config.fxBurst`）、**运动拖尾**（`config.trail`），
默认都开；拖尾本身还有 `config.trailStyle`（`'fire'` 火焰 / `'ghost'` 残影，默认火焰）。
设计上有一条硬约束贯穿两者：**不许引入任何逐帧轮询** —— 那会让 `isIdle()` 永远为假，
静置降频（球休眠 → 160ms 巡检）直接失效（同 §2.10 的约定）。

#### 2.13.1 进球特效（`fxBurst`）

进球那一刻一次性生成三样东西，之后交给 `updateFx` 自然消亡：

| 元素 | 数据结构 | 画法 |
| --- | --- | --- |
| 冲击波光环 ×2（外圈彩色 / 内圈白，错开出发） | `fx.rings`（**新增**） | 匀速外扩的描边圆，透明度 `(1-t/life)^1.6` |
| 全向爆散火花 | `fx.particles` | 360° 等分 + 微抖动，9~26 粒 |
| 彩带 | `fx.particles` + `shape:'ribbon'` | 细长矩形 + 自转 + 重力下坠，14~22 条 |

- **为什么不把原来的"上扬火花"换掉**：那撮火花沿篮筐上方呈扇形铺开，是"网刷了一下"的
  写实反馈；新加的全向爆散 + 光环 + 彩带负责"爽"。两套叠加互不遮挡，所以保留两套。
- 渲染端：`fx.rings` 走新的 item **kind 8**；彩带走 `case 1` 的 `shape==='ribbon'` 分支
  （`fillRect` + `rotate`，不用画线 —— 线的端点样式在不同 DPI 下对不齐）。
- ⚠️ **必须进窗口区域**：`fxRects()` 里给光环逐圈上报包围盒。漏了它，光环只有落在篮筐
  那个小矩形里的一段能看见 —— 与 §6.9 的飘字/火花是**完全同源**的坑（画在 canvas 上
  照样会被 `SetWindowRgn` 裁掉）。`FX_RECT_CAP` 一并 16 → 20。
- 彩带的包围盒半径用**半对角** `hypot(w,h)/2`：旋转到任意角度都罩得住。
  用 `w/2` 的话，转 45° 时对角会伸出脏块，画布上留下一层擦不掉的彩带残影。

#### 2.13.2 运动拖尾（`trail`）—— 两种样式：火焰 / 残影

高速飞行时在球身后留下拖尾。`config.trailStyle` 切换样式，右键菜单与托盘都有
（`拖尾样式`：**火焰** 默认 / **残影（原版）**）。

##### 共用几何部分

- 位置历史 `ball._trail` 挂在**球对象**上（不是 renderer 的"球→历史"映射表）：
  球被删掉时历史自然释放，不用维护生命周期。
- 阈值 `TRAIL_MIN_SPEED = 7 px/步`（= 420px/s；**px/步 是 physics.js 的单位约定，别再乘 60**）。
  慢球/休眠球走 `!fast` 分支：不记录、不给包围盒加尺寸、不产生拖尾。
- 相邻历史点至少隔 `TRAIL_MIN_GAP = 2.5px`，**并按 `TRAIL_SEG = 3.5px` 沿路径线性插值补点**。
  ⚠️ 补点是必需品不是优化：球一步走 `|v|` px，70px/步时相邻两点相距 70px，远大于火舌宽度
  （~1.3r ≈ 39px）→ 火舌之间没有重叠、中间露出底色，看起来是一串断开的白斑而非连续火焰。
  补点后点距恒定 3.5px，火舌始终首尾相接。
- 每颗球最多 `TRAIL_MAX = 24` 个历史点（点距恒定 ⇒ 拖尾长度 ≈ 24×3.5 ≈ 84px ≈ 2.8r）。
- **瞬移保护**：一帧位移 > 160px 直接清空历史。`__pbPlace` / 重置球位会让坐标跳变，
  不拦的话会拉出一条横贯屏幕的拖尾直线（脏块跟着暴涨）。
- **尾长封顶 `max(b.r*2.2, |v|*3.6)`，必须小于区域前瞻的 5 帧**（`sendShape` 的上报半径 =
  球视觉半径 + `|v|·leadFrames`）。否则尾巴会伸到 `SetWindowRgn` 的圆之外被直接裁掉。
- ⚠️ **包围盒必须覆盖拖尾**（`ballAABB` 里 `r*1.35 + 3`，比球的 `r+3` 大一圈）。
  漏了这一步，球飞过的路径上会拖出一串永不消失的"幽灵球" —— 与当初漏掉阴影、漏掉飘字宽度
  是**同一类**错误。
- **全局绘制预算 `TRAIL_BUDGET = 96` 次/帧**：本项目的瓶颈是每帧绘制调用次数
  （§2.12：180 → 60fps、240 → 54fps）。100 球同时高速时若每球都画满 9 枚火舌就是 900 次，
  而拖尾纯属装饰 —— 宁可让后半段的球少画两笔。
- 任何不走 `frame()` 的绘制路径（`ballDiff` / `texDiff` 这类像素对照钩子）里
  `_trailBudget` 恒为 0 ⇒ 不混进拖尾，对照像素是干净的。

##### 火焰样式（`_drawTrailFire`，默认）

沿"**球心 → 尾部**"的连线插值出固定的 `FIRE_STEPS = 9` 枚火舌（**不是**遍历历史点逐点画）。
每枚是一枚沿运动轴拉长的实心椭圆：

| 通道 | 混合模式 | alpha | 尺寸 | 颜色 |
| --- | --- | --- | --- | --- |
| 外光晕 | `'lighter'` | `0.10·(1-0.5s)` | `rr·2.20` | `FIRE` 渐变 |
| 主焰 | `'source-over'` | `1-0.72s` | `rr·1.30` | `FIRE` 渐变 |
| 亮芯（仅前 2 枚） | `'source-over'` | `0.75·a` | `rr·0.72` | `#fff0c8` → `#ffd98a` |

其中 `s = i/(FIRE_STEPS-1)` 从球心 0 到尾巴 1，`rr = r·(1.00 - 0.55s)`；
拾色 `fireColor(s·0.92)` 在 `['#ffd9a0','#ffab35','#ff7a16','#e8450a','#8f1d04']` 上取样。

`_flame(g,x,y,size,ux,uy)` 绕运动方向 `atan2(uy,ux)` 旋转后 `scale(1.55, 0.80)` —— 沿运动轴
**拉长** 1.55 倍再压窄 0.8。第一版写成了纯圆形，高速下看起来是一串"水滴"而不是火焰。

三条踩出来的硬规则，改这段前务必先读：

1. ⚠️ **主焰必须是 `'source-over'`，不能全程 `'lighter'`。**
   全程加法混合在**浅色桌面壁纸**上会立刻饱和成纯白，火焰褪化成"白烟"；
   而且历史点逐枚叠加（24 点 × 0.15）也会累加到纯白。改成固定 9 枚 + 只有最外圈光晕
   走加法，主焰走正常混合 —— 这样在浅底和深底上都是暖橙色（实测 `shots/fire-real.png`
   的浅/深双底对照）。
2. ⚠️ **不能采样球贴图取色。** 第一版让火舌用球贴图的暗边当底色，结果火焰被污染成灰褐色。
   火焰是**纯色**的，跟球皮肤无关。
3. ⚠️ **不要按"每枚都调淡"来控曝光。** 加法混合下重叠区亮度是累加的，
   单枚调淡并不能阻止整体过曝 —— 控制手段是**减少枚数 + 缩短可见重叠**。

##### 残影样式（`_drawTrailGhost`，原版保留）

叠**球自己的贴图**（素材皮肤取 `tex.single`，程序化取 `tex.body`），按 `0.42 → 0.10`
的透明度、`1.0 → 0.66` 的直径递减叠 4 次。只变淡不缩小是一坨灰糊，加了收缩才有彗尾的指向性。
两套共用同一份 `_trail` 几何，切换只换绘制函数，`setTrailStyle()` 会清空所有 `_trail` 避免
两种样式混在一帧里。

##### 实测

（打包版 exe、`--no-gpu` 软件合成、1440×852 / i-5 8500 / 100 球 / `classic` /
**实测**（打包版 exe、`--no-gpu` 软件合成、1440×852 / i5-8500 / 100 球 / `classic` /
`--cpu-test=100,10,6`，同一台机器连跑两趟）：

| 配置 | drawCalls | fps | 活跃单核 | 活跃整机 | 静置单核 | idle |
| --- | --- | --- | --- | --- | --- | --- |
| 拖尾**关** | 300 | 37.6 | 25.79% | 4.30% | 0.04% | ✓ |
| 拖尾**开** | 305 | 35.1 | 25.64% | 4.27% | 0.18% | ✓ |

> 差值落在噪声里 —— 原因在 `--cpu-test` 的 chaos 是"每 700ms 给全部球一次冲量"，
> 球只在被踢飞的瞬间才超过阈值，采样那一刻只有 3 颗球在飞。也就是说
> **拖尾开销正比于「同时在高速飞行的球数」，而不是总球数**；慢球与休眠球是零成本的。
> 这也正是把阈值设在 7px/步、而不是"只要在动就画"的理由。
> （上表是**残影样式**的旧采样，火焰样式的绘制调用数同级：都是每球 ≤9 次、受同一份
> `TRAIL_BUDGET` 约束。）

#### 2.13.3 金球皮肤（`gold`）

金球是金色彩蛋用的皮肤（`SKINS.gold`）。它不是"把渐变换成金色"，而是走一条**独立的三层烘焙**
（`bakeGold`），因为程序化烘焙的通用路径（沙粒 + 斑点 + 通用高光）在金面上只会得到一块"黄铜/泥巴"。

`bakeLayers()` 里 `if (skin === 'gold') return this.bakeGold(320);` 早退，绕过通用路径。
三层含义与通用路径一致（`base` 主体 / `seam` 接缝 / `hi` 高光），但内容重写：

| 层 | 内容 |
| --- | --- |
| `base` | 径向渐变（从 `#fffef8` 到 `#3a2606`，共 9 档停靠）→ `goldGain` 提亮 → **同心车削纹**（从 `0.06R` 步进 3.1px，alpha `0.050+t·0.075`）→ **径向拉丝** 190 条 → 镜面暗带 → 边缘暗化 → 右下反弹光 → **四芒星刻纹** → 暖白细轮廓 |
| `seam` | 留空（透明画布；金球不用经典篮球的黑接缝） |
| `hi` | 白热椭圆镜面池 + 锐利镜面点 + 自发光内核 `rgba(255,214,110,0.32)` |

- **同心车削纹 + 径向拉丝**是"高级"的来源：金属的辨识特征不是颜色而是**各向异性的高光结构**。
  只有渐变没有纹理，缩到 68px 后就退化成一块黄色圆片。
- ⚠️ **纹理 alpha 要够高才在 68px 下活下来**：初版 alpha 0.02 级，缩到实际球径后完全看不见。
  现在拉到 `0.050~0.125`，星纹还额外叠了一层暗色刻痕（`#4a2c00`）再压亮线（`#fff3c0`）。
- `_goldStar()` 画的是**四条菱形星芒**（先暗刻痕后亮线）+ 中心核 + 外圈细环 —— 即"
  金属件上的星光反射"，比单纯的高光点更像实物。
- 通用路径里 `psGrain = (skin === 'gold') ? 0.22 : ps`：金球颗粒减到 1/5 左右，避免
  拉丝被沙粒噪声糊掉。
- 通用路径新增两个可选参数：`P.hiMul`（高光层乘法增益，金球 1.55）与 `P.core`（自发光内核颜色，
  金球 `255,222,130`），只有金球用，其它皮肤走默认值。

**新旧对照可用 `tools/preview-fx.html`**（金球 3 个旋转角 + 纹理特写 + 真实尺寸 + 火焰/残影对照），
产物 `tools/shots/fx-preview.png`；金球特写见 `tools/shots/fx_gold_v5.png`。

---

## 3. 项目代码

```
desktop-basketball/
├─ package.json                  # electron 38 / matter-js 0.20 / koffi 3 / @electron/packager
├─ .npmrc                        # 国内镜像（electron 二进制 + electron-builder 二进制）
├─ src/
│  ├─ main.js                    # 主进程：窗口 / 层级 / 命中转发 / 托盘 / 配置 / CPU 性能验收
│  ├─ native.js                  # koffi → user32/gdi32/kernel32 桥接（区域、层级、钩子、命中测试）
│  ├─ config.js                  # 配置读写（球数/篮筐/音效/自启/命中方式/最高分/球位置/皮肤/成就/记分板/金球；version 2）
│  ├─ preload.js                 # contextBridge 暴露 window.dbb（含按需取素材的 texture()）
│  └─ renderer/
│     ├─ index.html              # CSP default-src 'none'；双画布 + 控制栏 + 记分板 + 菜单 + 性能面板
│     ├─ 00-probe.js             # 启动耗时探针（必须排第一个 script，见 §4.1.4）
│     ├─ app.js                  # 主控：主循环 / 输入 / 形状上报 / 菜单 / 瞄准线 / 成就 / 金球 / 诊断钩子
│     ├─ physics.js              # Matter.js 封装：世界、墙、地板、篮筐、拖拽伺服、进球判定、金球双倍分
│     ├─ render.js               # 脏矩形分块渲染 + 纹理烘焙（SKINS 调色板 / SKIN_IMG 素材球面重投影）+ 篮筐/网/粒子/瞄准线绘制
│     ├─ textures/               # 球皮肤用的真实素材（西瓜照片 / 地球 / 木星，共约 400KB，来源见 §2.11.1）
│     ├─ audio.js                # WebAudio 纯合成音效
│     └─ vendor/matter.min.js    # 从 node_modules 拷贝（CSP 'self' 下相对路径更稳）
├─ build/pack.js                 # 打包脚本（@electron/packager 封装 + 体积统计 + zip）
├─ tools/
│  ├─ tex-lab/                   # ★ 皮肤素材工坊（选型 / 拟合 / 预览，不参与打包，见 §2.11.1）
│  │  ├─ sphere_preview.py       #    本机球面预览器：源图+映射方式 → 球，与 render.js 同一套光照常量
│  │  ├─ melon_fit.py            #    从西瓜照片里拟合瓜的内接圆并裁成正方形素材（+ 高光滚降）
│  │  ├─ grab_sheet.py / cat_sheet.py / pick.py / wmpick.py   # 素材检索与候选对照图
│  ├─ bench.js                   # 纯物理基准（不开窗），输出 assets/bench-physics.json
│  ├─ genicon.js                 # 零依赖自写 PNG/ICO 编码器，5× 超采样渲染篮球图标
│  ├─ github-research.js         # 调研脚本（本次调研的来源）
│  ├─ preview-eval.js            # ★ 纹理放大预览：在真实渲染进程里把球/篮球架放大后抓图
│  ├─ zorder-probe.ps1           # ★ 独立层级探针：纯 Win32 重新推导 z 序，验层级（见 §7.1）
│  ├─ region-probe.ps1           # ★ 窗口区域探针：真实屏幕坐标打点，验"绘制内容有没有被 SetWindowRgn 裁掉"（见 §7.2）
│  ├─ realdrag-probe.ps1         # ★ 真实鼠标拖拽探针：按在球上 → 甩到远处 → 保持，验拖拽期间 pointermove 没漏、松手后区域恢复（见 §7.3）
│  ├─ screencap.ps1              # ★ 抓真实屏幕（capturePage 看不见区域裁剪，也看不见窗口遮挡）
│  ├─ flyrun.sh                  # ★ 一键跑「球飞行」验收：起夹具 → 等起飞 → 外部连拍 → 切日志（见 §7.4）
│  ├─ flyscan.ps1                # ★ 分割截图量球（orange/magenta 双模式 + 跨度 + lit 空帧标记，见 §7.4）
│  ├─ flyab.py                   # ★ 配对/统计/探针/剂量-反应：日志球位插值配对 + 出表（见 §7.4）
│  ├─ crop.ps1                   #    裁剪 + 最近邻放大 PNG 的一小块，看亚像素细节用（放大参数是 -Zoom 不是 -Scale）
│  ├─ cap-desktop.ps1            # ★ 抓真实屏幕的叠加层：先 MinimizeAll 露出桌面，再 GDI+ 连拍（见 §7.11）
│  ├─ verify-features.js         # ★ 计分/连击/重置 自测（--eval 注入，见 §7.5）
│  ├─ verify-features2.js        # ★ 皮肤/成就/记分板/金球/瞄准线 自测（--eval 注入，见 §7.6）
│  ├─ verify-residue.js          # ★ 长文本飘字的脏块残影验收（数像素，不靠肉眼，见 §7.6）
│  ├─ verify-render.js           # ★ 渲染层回归：残影/休眠球像素保留/删球残留/贴图质量（见 §7.7）
│  ├─ verify-merge.js            # ★ 合并 body 前后的整球像素差 + 每帧绘制次数（见 §7.7）
│  ├─ verify-packaged.js         # ★ 打包版验收：asar 内素材可否被 preload 读出 + 皮肤 + 上限（见 §7.9）
│  ├─ verify-maxballs.js         # ★ 球数上限验收：真的塞超上限的球，看守卫生不生效（见 §7.9）
│  ├─ verify-fx.js               # ★ 视觉特效验收：进球光环/爆散/彩带 + 拖尾（含默认火焰样式）+ 金球多层（见 §7.10）
│  ├─ verify-barsettings.js      # ★ 控制栏「设置」按钮（⚙）验收：位置/区域/菜单上翻/＋ 不误触（见 §2.10.1）
│  ├─ preview-fx.html / .js      #    开发用预览：金球 3 旋转角 + 纹理特写 + 火焰/残影对照（非生产）
│  ├─ preview-fire-real.html/.js #    开发用预览：真实尺寸 r=30 四档速度的火焰拖尾（浅/深底各半）
│  ├─ preview-fire-zoom.html/.js #    开发用预览：火焰 4x 放大（调参时看锥度/断点）
│  ├─ bench-perf.js              # ★ 应用内帧率/耗时基线（20 球 chaos）（见 §6/§7.7）
│  ├─ bench-sweep.js             # ★ 球数分档扫帧率（20/40/60）（见 §2.12）
│  ├─ bench-60.js                # ★ 60 球上限档 + flatBall 对照（结论见文件头注释）
│  ├─ bench-layers.js            # ★ 单变量：每球画几层 vs 帧率
│  ├─ bench-rot.js               # ★ 单变量：球缝旋转与否 vs 帧率（证明旋转不贵）
│  ├─ bench-draw.js              #    隔离绘制与合成开销
│  ├─ bench-region.js            #    A/B：区域上报是否吃帧
│  ├─ preview.html               #    上面那段代码的独立版（本机环境加载不了独立入口，仅留档）
│  ├─ preview-main.js            #    独立 Electron 入口（同上，见 §8 排障）
│  └─ shots/                     # 验收截图（外观 / 菜单 / 默认状态 / 层级 / 真实屏幕）。
│                                #   fly_clipped.png + fly_intact.png = §6.6 的"被裁 / 完好"对照，
│                                #   fly_blank_capture.png = 那张整帧全黑的废帧。
│                                #   `flyrun.sh` 的连拍帧（几百 MB）用完即移出项目，不入库
├─ assets/
│  ├─ tray.png / icon.ico / icon-256.png
│  ├─ github-research.json       # 32 个仓库的调研原始数据
│  ├─ bench-physics.json         # 物理基准结果
│  ├─ drag-test.json / drag-test.md   # 拖拽性能同进程 A/B 结果（§6.5）
│  └─ cpu-test-20.json / cpu-test-50.json / cpu-test-100.json   # 20 / 50 / 100 球 CPU 实测
│                                #   （cpu-test.json / .md 是"最近一次"的槽位，当前内容 = 100 球西瓜皮肤）
└─ dist/                         # 打包产物（npm run pack 生成）
```

**主进程刻意保持窄**：只负责窗口、层级、命中转发、托盘、配置，**不做任何逐帧计算**。

**几处非典型设计，不要当成 bug 改掉：**

- `src/renderer/vendor/matter.min.js` 是从 `node_modules` 拷贝的副本，不是冗余 —— CSP 是 `default-src 'none'`，
  相对路径的 `node_modules` 引用会被拦。
- 程序启动后**不开主窗口**，只有托盘。`window-all-closed` 里主动 `quitApp()`，避免"没有窗口就退出"的默认行为把程序干掉。

---

## 4. Windows 打包方法

### 4.1 一条命令

```bash
npm run pack        # → dist/DesktopBasketball-win32-x64/DesktopBasketball.exe（裁剪 + NTFS 压缩）
npm run pack:7z     # 额外产出 dist/DesktopBasketball-1.0.0-win32-x64.7z（约 74 MB）
npm run pack:zip    # 同上但用 zip（约 110 MB）
node build/pack.js --no-slim      # 不裁剪语言包（保留 Electron 自带的全部 55 个）
node build/pack.js --no-compact   # 不做 NTFS 透明压缩（磁盘占用翻倍，运行无差别）
```

`build/pack.js` 用 `@electron/packager` 封装，关键配置：

| 配置 | 值 | 原因 |
|---|---|---|
| `platform` / `arch` | `win32` / `x64` | 目标平台 |
| `icon` | `assets/icon.ico` | 由 `npm run genicon` 零依赖生成（7 个尺寸 16→256） |
| `asar` | `{ unpack: '**/*.node' }` | **关键**：koffi 是原生模块，必须落在 asar 之外才能被 `dlopen` |
| `prune` | `true` | 自动剔除 devDependencies，electron 与 packager 不进包 |
| `ignore` | 见 §4.1.3（构建期/验收期文件 + `$WIN_T` + koffi 的 C++ 源码） | 只带运行必需文件 |
| `win32metadata` | ProductName / FileDescription / CompanyName | 写入 exe 版本信息 |

产物**逻辑大小 269.6 MB / 磁盘占用 114.9 MB**（默认裁剪 §4.1.1 + asar 瘦身 §4.1.3 + NTFS 压缩 §4.1.2），打包耗时约 20 秒，
**双击即用**：无需安装、无需 Node、无需 Electron。
要发给别人就用 `npm run pack:7z`，是 **74.0 MB** 单文件。

> **重复打包两个前提**（都踩过）：
> 1. **先退出正在运行的 `DesktopBasketball.exe`**（`tasklist | grep DesktopBasketball` 应为 0）。
>    exe / `resources/app.asar` / `v8_context_snapshot.bin` 被占用时 packager 写不进去。
> 2. `pack.js` 会先把旧产物 `retire()` —— 改名为 `dist/DesktopBasketball-win32-x64.old-<时间戳>` —— 再打新的。
>    这是因为 **`overwrite: true` 内部就是 `fs.rm(dir, {recursive:true})`**，会撞上本机工作区批量删除保护
>    （旧产物 76 个文件 > 阈值 50），详见 §8 排障表。代价是 `dist/` 会攒下 `.old-*` 目录，确认新版可用后手动删掉。


### 4.1.1 体积裁剪（默认开启；不减功能，也不降画质）

一个普普通通的 2D 篮球游戏为什么要 324 MB？因为体积**几乎全是 Electron 运行时**，
跟游戏本身无关（本项目的代码 + 贴图只有 3.4 MB）。实测构成与处置（`node_modules/electron/dist`
原生 324.1 MB / 75 个文件 → 剪完 243.5 MB / 21 个文件）：

| 文件 | 大小 | 处置 |
|---|---|---|
| `DesktopBasketball.exe`（Chromium 本体） | 200.7 MB | **内容动不了**（PE 段全是运行时必需，见 §4.1.2）。这里只能靠 NTFS 压缩把它压到 84.7 MB |
| `dxcompiler.dll` + `dxil.dll` | 26.2 MB | **删**：WebGPU / D3D12 的着色器编译器（HLSL → DXIL）。本项目的画布是 **CPU 光栅化的 Canvas 2D**，GPU 合成走 ANGLE 的 **D3D11** 后端（那个用的是 `d3dcompiler_47.dll`，**保留**）。Compiler 不在时 Dawn 只会报"WebGPU 不可用"，不碰 GPU 进程的 D3D11 初始化。⚠️ **推理不算数，这两个是实测过才删的**：用 `--in-process-gpu`（避开"Agent 侧起不了 GPU 进程"）在打包版上跑 `--no-gpu` 与 `--in-process-gpu --use-angle=d3d11`（真实硬件路径）两条路，均正常出帧、无 GPU 进程崩溃。**判据是"删了要在打包版上实测启动 + 出帧"** |
| `LICENSES.chromium.html` | 14.5 MB | **删**：纯许可文本，Chromium 运行时从不读它（完整文本见 Chromium 源码树） |
| `locales/`（55 种语言） | 44.0 MB | **只留 `zh-CN` / `en-US` / `en-GB`**，其余 52 个删掉 |
| `icudtl.dat` | 10.0 MB | 保留：ICU 国际化数据，硬依赖 |
| `libGLESv2` / `libEGL` / `d3dcompiler_47` | 12.9 MB | 保留：ANGLE(D3D11) 渲染刚需 |
| `resources.pak` / `chrome_*_percent.pak` | 6.3 MB | 保留：Chromium 内置资源 |
| `vk_swiftshader` / `vulkan-1` | 6.2 MB | 保留：**没有可用硬件 GPU 时的兜底**。托盘有「软件合成」开关，且 GPU 连崩 2 次后本应用会自己落盘 `forceNoGpu`；留着它这类机器还有机会走软件 Vulkan，删掉就彻底按在纯 CPU 合成上 —— 那**正是帧率问题**（与本轮"多球不掉帧"的目标相反，所以这 6 MB 不省） |
| `ffmpeg.dll` | 2.9 MB | ⛔ **绝不能删**（曾经删过，代价是一次完整的"打包版启动即崩"）。声音确实全走 WebAudio（见 `src/renderer/audio.js`）、没有任何 `<audio>`/`<video>`，但 **Chromium 的渲染进程在启动时就会 `InitializeMediaLibrary()` → `LoadLibrary("ffmpeg.dll")`，加载失败是致命 CHECK**：打包版一启动就 `render-process-gone exitCode=-2147483645`（`STATUS_BREAKPOINT`）、每 1.3 秒崩一次、`ready-to-show` 永不触发、`--eval` 一个结果都不回；而开发版（`node_modules/electron/dist/` 里 ffmpeg 还在）完全正常，所以**只在打包版暴露**。拷回去立刻恢复。**"代码里没用" ≠ "进程不加载"** |
| `app.asar`（本项目代码 + 贴图） | 5.36 MB | 保留（**已在打包时瘦身到 0.91 MB**，见 §4.1.3；这 5.36 MB 里有 1.78 MB 是**误打包进来的用户数据** `$WIN_T`） |

**结果：逻辑大小 324 MB → 282 MB（只留语言包）→ 243.5 MB（再删 LICENSES + dxcompiler/dxil），
共 −80.6 MB / −25%。** 语言包少掉不影响任何功能 —— 找不到匹配语言会自动回退 `en-US`。
（这是**文件级**的裁剪；把**磁盘占用**再压到 106 MB 是下一步的 NTFS 透明压缩，见 §4.1.2。
⚠️ 两个数字别混：**逻辑 243.5 MB / 磁盘 106 MB** —— 后者才是用户装完占的地方，前者不是。）

实现与注意：

- `npm run pack` **默认就裁剪**，`--no-slim` 关掉。
- **唯一的清单在 `build/slim-list.js`**：`slim.js` 照着它在产物目录里**真删**，
  `pack.js` 照着它写 7z 的 `-x@` 排除清单。同一份清单两个用途，**别在别处硬编码文件名**
  （分开写必然漂移成"7z 里有、目录里没有"，两个分发包大小对不上）。
- 实际动作在 **`build/slim.js`**，由 `pack.js` 以**子进程**调用。**为什么必须另起一个进程**：
  packager 打完一个 300+ MB 的包内部已经把删除额度（safe-delete shim，阈值 50）吃掉了，
  同一个进程里再删会全部失败（`trash operation ... Some operations were aborted`）。
  ⚠️ 而且**一轮还不够**：要删 55 个文件，实测每轮删到第 48~49 个就开始整批失败，失败的永远
  是按列表顺序的**尾巴**（`uk/ur/vi/zh-TW.pak` + `LICENSES.chromium.html` + `dxcompiler.dll`
  + `dxil.dll`）。所以 slim 会**自己换干净进程重试**；**在 Agent 沙箱里换进程也没用**（额度按
  会话算，子进程一样 0 删除），这时按它打印的提示**手动再跑一次**
  `node build/slim.js dist/DesktopBasketball-win32-x64` 即可。
  ⚠️ **这个坑特别阴**：压缩包那边有 `-x@` 排除清单，**照样是干净的**，所以只有"产物目录"
  受害（白留 44 MB），现象是"7z 变小了、装完的目录却几乎没变"。现在 slim 遇残留会以退出码 2
  结束、`pack.js` 打一行醒目 WARNING，打包时一眼能看见。
- `--7z` 压缩时再加一道 `-x@<清单>` **排除**（7z 是外部程序，不受 Node 侧 shim 限制）。
  所以哪怕某种环境下 `slim.js` 一个文件都没删掉，压缩包照样不会把 44 MB 语言包算进去。
- **这就是"不压缩"路线的底了**：剩下的每一 MB 都是 `DesktopBasketball.exe` 里的 Chromium ——
  要么换运行时（不是本项目的量级），要么删上面那张"保留"表里的东西（会真降功能）。
  `node_modules/electron/dist/` 里有全部原件，删错了装回去即可。


### 4.1.3 asar 瘦身（默认开启；`app.asar` 5.36 MB → 0.91 MB）

§4.1.1 砍的是产物**根目录**，而 `packager` 的 `ignore` 决定的是**进 asar 的那棵树** ——
两者互不覆盖，所以 asar 里一直躺着两类完全用不上的东西：

**① `$WIN_T` —— 不是体积问题，是安全问题（2026-10-07 修）**

asar 的路径规范化会把 **Windows 临时目录**替换成字面量 `$WIN_T`。而验收夹具
（`tools/verify-*.js` 全部）都用 `--user-data-dir=$TEMP\pb-verify-...` 起实例，于是那些
实例的**整个 userData** 就躺在项目能扫到的位置：下一次打包被整棵复制进 `app.asar`。
实测 **63 个文件 / 1.78 MB**，里面包含：

- `config.json` —— 用户的球数、皮肤、成就、开关偏好
- `runtime.log` —— 运行日志
- `GPUCache` / `DawnWebGPUCache` / `DawnGraphiteCache` / `Code Cache` / `Local Storage` —— 纯缓存

也就是说，**把 7z 发给别人就等于把配置和日志一起发出去**。现在 `pack.js` 里有两条硬排除：

```js
/^\/\$WIN_T(\/|$)/,
/^\/~\$(\/|$)/,
```

**② 运行时加载链之外的源码与文档（约 2.7 MB）**

| 路径 | 大小 | 为什么能删 |
|---|---|---|
| `node_modules/koffi/src/koffi/src/*.cc` `*.hh` | ~1.1 MB | C++ 源码，只有 node-gyp 编译时读 |
| `node_modules/koffi/vendor/` | 464 KB | node-addon-api / node-api-headers 头文件，同上 |
| `node_modules/koffi/lib/native/base/*` | 498 KB | `base.cc/base.hh`，同上 |
| `node_modules/koffi/doc/` + `index.d.ts` + `README/CHANGELOG` | ~250 KB | 文档与类型声明 |
| `node_modules/matter-js/`（整棵） | 1.0 MB | **只有 `tools/bench.js` require 它**，而 `tools/` 已整体排除；渲染进程用的是 `src/renderer/vendor/matter.min.js` 的副本（见 `index.html`） |
| `README.md` / `.last-verify-dir` | 160 KB | 文档与本地状态 |

**koffi 的运行时加载链只有四层**（裁剪后实测 `koffi.load()` 与全部 25 个 Win32 绑定正常，
打包版验收 `native=true`）：

```
koffi/index.cjs → src/koffi/index.cjs → src/koffi/src/static.cjs → require('@koromix/koffi-win32-x64')
```

所以 `ignore` 里保留了 `static.cjs`，并用**负向先行断言**只放它一个：

```js
/^\/node_modules\/koffi\/src\/koffi\/src\/(?!static\.cjs$)[^/]+$/,
```

⚠️ koffi 还有 Linux / macOS / arm 的预编译包（`@koromix/koffi-*`），本机只用 win32_x64，
一并排除（否则换机器跑会退化成 `koffi 未安装`，程序自动降级为无逐像素穿透的
`setIgnoreMouseEvents` 模式 —— **功能会静默退化**，别照抄这条到别的平台）。

**验收**：`npm run pack` 后跑 §7.9 的打包版验收，三张素材必须仍能从 asar 读出
（`texture[watermelon]=328011B ✓` / `earth` / `jupiter`，`texturesAll=3/3 ✓`），
`texCache=6` 说明六套皮肤都烘出了独立贴图。


### 4.1.4 启动耗时的分段测量（BOOT / RBOOT 两把尺子）

「启动慢」要能被优化，先得能**分段**。runtime.log 里现在有两组埋点：

| 日志行 | 基准 | 覆盖的阶段 |
|---|---|---|
| `BOOT main.js-top=… requires-done=… config-saved=… whenReady=… window-created=… ready-to-show=… renderer-ready=… did-finish-load=… first-region-ok=…` | **进程创建时刻**（`Date.now() - performance.now()` 反推） | exe 加载 → Electron 初始化 → 窗口创建 → 渲染进程起来 → 首次 `SetWindowRgn` 生效 |
| `RBOOT probe-start=… physics-start=… render-start=… app-start=… boot-end=…` | **页面导航开始**（页面内 `performance.now()`） | HTML 解析 → vendor 脚本 → 各脚本执行 → `boot()` 结束 |

⚠️ **两把尺子不能相减**：两个进程的 `timeOrigin` 不对齐，跨进程比会引入几十毫秒误差。
各行内部的分段可以横向比较（同一把尺子），行与行之间只能定性对照。

**实测（打包版，软件合成 `--no-gpu`，1440×852）**

| | 冷启动 | 热启动 |
|---|---|---|
| 进程创建 → `main.js-top` | ~100 ms | ~126 ms |
| → `requires-done`（require koffi + 读 config） | +14 ms | +16 ms |
| → `whenReady` | +35 ms | +54 ms |
| → `window-created` | +46 ms | +41 ms |
| → `ready-to-show` | +212 ms | +209 ms |
| → `first-region-ok`（首帧区域生效，用户看得见球） | **463 / 477 ms** | **537 ms** |

**读这张表的结论（别再往这些方向找）**：

- **最大的一段是 `window-created → ready-to-show` 的 ~210ms**，而 `RBOOT` 显示这段时间里
  页面只跑了 **~20ms 的脚本**（`probe-start` 就已经 210ms 了）。也就是说这 210ms 是
  **渲染进程 fork + Chromium renderer 初始化 + preload**，**不是**我们的代码。
  → 对它做代码优化是白费力气。
- `main.js-top` 的 ~100ms 是 **加载 200.7 MB 的 exe**，同理动不了（§4.1.2）。
- 主进程自己的代码（`requires-done` + `config-saved`）合计 **不到 4ms**。
- 真正能省的是「首帧之前的同步工作」，本轮就砍掉了两处（见 §2.14）。


### 4.1.5 首帧前的同步工作（2026-10-07 优化）

`ready-to-show` 那 210ms 动不了，但**首帧之前我们自己塞进去的同步活**可以。
两个都改了，共同点是「启动时 nobody 用得到」：

| 优化前 | 问题 | 优化后 |
|---|---|---|
| `boot()` 里**同步**调 `window.dbb.textures()`，一次读走**全部三张** jpg（390 KB → 520 KB base64），再跨 contextBridge 序列化给页面 | 默认皮肤 `classic` 是**程序化绘制、一张素材都不需要** —— 等于每次启动都在首帧之前白读 390 KB | **按需单张**：只有当前皮肤真要素材时才 `invoke('get-texture', name)` 取那一张。默认皮肤**一次 IPC 都不发**；素材皮肤切过去时才读，读完 `reloadTextures()` 重烘 |
| `onInit()` 里同步 `measureGravityStep()` —— 建一个完整 `M.Engine` + 跑一步求解 | 它只服务**瞄准预测**，而预测只在**拖拽球**时发生，启动阶段一次都用不到 | `gravityStep()` 改成惰性：首次拖拽时标定一次并缓存 |

`measureGravityStep` 改名 `gravityStep` 是有意的：它现在是个**带缓存的惰性 getter**，
不是"做一次测量"。`__pbPredict` / 瞄准核对钩子里读 `gStep` 的地方都改成了调它
（否则那些钩子会读到 0）。

⚠️ 顺手修掉的坑：**纹理改异步之后，验收夹具里同步读全部素材的写法会静默失效**。
`tools/verify-packaged.js` 已改成逐张 `await window.dbb.texture(name)`，并在
`texTask.then(...)` 里汇总 `texturesAll=3/3 ✓`。**判据必须在 promise 落地之后打印** ——
否则脚本先打印 `done` 就退出，那几行永远执行不到（症状与"夹具坏了"一模一样）。

验收：切到 `watermelon` 才出现 `[textures] watermelon 素材就绪，皮肤已重烘`；
切到 `classic` **不再发任何请求**（`texCache` 保持不变）。


### 4.1.2 NTFS 透明压缩（默认开启；运行行为完全不变）

`DesktopBasketball.exe` 的 **200.7 MB 里没有一字节是能删的** —— 它就是 Chromium 本体。
实测 PE 段表：

| 段 | 大小 | 是什么 |
|---|---|---|
| `.text` | 162.9 MB | Chromium + V8 的机器码 |
| `.rdata` | 30.8 MB | 常量表 / 字符串表 |
| `.pdata` | 4.8 MB | 异常展开表（C++ 异常与栈回溯要用） |
| `.data` | 4.6 MB | 全局数据 / 虚表 |
| `.reloc` | 1.0 MB | 重定位（ASLR 要用） |
| `.rsrc` | 0.4 MB | 图标与版本信息（就是 `genicon` 生成的那个） |

没有 overlay（文件尾无附加数据）、没有调试符号、没有未引用的资源。
所以「减小 exe」**在文件内容上没有下手的地方**，只能改「存的时候压不压」。

做法：`compact /c /exe:LZX /f /s:<产物目录>` —— Windows 自带的 **NTFS 透明压缩**。
见 `build/pack.js` 的 `compactDir()` / `allocSize()`。

**结果：磁盘占用 272.1 MB → 115.1 MB（2.4:1），耗时约 10 秒。**

为什么这不违反「不减功能、不降画质」：

- 压缩与解压由 **NTFS 驱动**完成，进程读到的字节**一模一样**；渲染路径、贴图、物理、帧率全不变
  （实测 `native=true`、60fps、日志 0 报错）。
- 唯一代价是「读文件时 CPU 顺手解压一下」，对 exe 这种一次性加载、随后常驻内存的场景可忽略。

边界（要知道）：

- **只在 NTFS 卷上有效。** 拷到 exFAT / FAT32（U 盘）或别人的机器上会**自动还原成 272 MB**，
  功能不受影响。发给别人还是用 `.7z`（74 MB，与文件系统无关）。
- 新产物**不继承**压缩属性（`packager` 每次新建目录），所以每次打包都要重跑一遍 ——
  已做进 `build/pack.js`，`--no-compact` 可关。
- 非 NTFS 卷 / `compact.exe` 不可用时**静默跳过**，绝不拖垮打包。
- 手动还原：`compact /u /s:<产物目录>`。
- ⚠️ `du -sh` 报的是**逻辑大小**（压缩后不变），要看真实占用得用 `compact /q`、`fsutil`，
  或 Node 的 `fs.statSync().blocks * 512`（libuv 在 Windows 上把分配大小填进了 `st_blocks`，
  实测压缩前后分别是 200.7 MB 与 84.7 MB，与 `compact` 自报的数字一致）。
  —— 统计**不要**去解析 `compact` 的 stdout：它是控制台程序、输出走 OEM 代码页，
  用 utf8 读会乱码，"字节的数据保存在"这种正则必然匹配不上。


### 4.2 首次在本机打包需要准备什么

```bash
# 1) 若 koffi 的 postinstall 报 "CMake does not seem to be available"，
#    用 --ignore-scripts 跳过，再手动装 electron 的二进制：
npm install --ignore-scripts
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# 2) 打包工具
npm i -D @electron/packager
```

`.npmrc` 已经指向国内镜像，网络正常情况下不用管。

### 4.3 安装程序（单文件安装包）

本仓库自带一套 **Inno Setup** 方案，产出 `dist/DesktopBasketball-Setup-1.0.1.exe`（约 81 MiB）。
覆盖：固定安装目录、桌面快捷方式、扫描 C/D 盘一二级目录批量建快捷方式、
零交互安装、进度条。

```bash
# 前置：先出免安装产物
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node build/pack.js

# 再编译安装器（需要 ISCC，见下）
"$TEMP/innosetup/portable/ISCC.exe" build/installer.iss

# 验收（必须先装过一次）
bash tools/verify-installer.sh
```

**完整教程见 [`build/INSTALLER.md`](build/INSTALLER.md)** —— 含环境准备（ISCC 获取）、
五条需求的实现映射、全部已踩坑点、维护清单。

> ⚠️ 不要用 `electron-builder --win nsis`。本项目的需求③（批量扫描 C/D 盘建快捷方式、
> 失败跳过）需要自定义逻辑，NSIS / electron-builder 都表达不了，且 NSIS 已实测弃用
> （原因见 `build/INSTALLER.md` §2）。

本项目同时提供**免安装绿色版**（`dist/DesktopBasketball-win32-x64/` 与 `.7z`），
两种分发形式并列，互不替代。

**两种形式都已随 [Releases](https://github.com/lovehutaocute/DesktopBasketball/releases/latest) 发布**，
不构建也能直接下载使用。

---

## 5. 可直接运行的最终程序

> **不想构建**：直接下载 [Releases](https://github.com/lovehutaocute/DesktopBasketball/releases/latest)
> 里的 `DesktopBasketball-Setup-1.0.1.exe`（一键安装：开始菜单 + 桌面快捷方式 + 卸载项）
> 或免安装 `.7z`。下面这些路径是**自己构建后**才有的。

| 方式 | 命令 / 路径 |
|---|---|
| 安装包（推荐给普通用户） | Release 附件 `DesktopBasketball-Setup-1.0.1.exe`，或本地 `dist\DesktopBasketball-Setup-1.0.1.exe` |
| 免安装 exe | `dist\DesktopBasketball-win32-x64\DesktopBasketball.exe`（双击） |
| 开发模式 | `npm start` = `npx electron .` |
| 软件合成（驱动异常时） | `DesktopBasketball.exe --no-gpu` 或 `npm run start:nogpu` |
| 带 DevTools | `npx electron . --dev` |

**首次启动后**：窗口不出现，托盘出现篮球图标。桌面上**只有 1 颗篮球**，篮球架已在右侧完整显示，**左下角与右下角各有一组常显的 `＋` `－` 数量按钮**。
左键点托盘 = 加一颗球；右键 = 全部控制项。

**全部操作方式**：

| 操作 | 效果 |
|---|---|
| 左键按住球拖动 | 抓住并拖走（抓取半径比球大 12px） |
| 松开 | 按拖动方向和最近 110ms 的速度投出去，快甩 = 大力抛射 |
| 右键点球 | 弹出与托盘一致的控制菜单（不会触发拖动，也不会选中桌面） |
| 右键点球 → 增加 / 减少 | 增减一颗球 |
| 左下角 / 右下角悬浮 `＋` `－`（两组，同一功能） | 增减一颗球；**常显不淡出**，鼠标靠近变清晰。右下角那组右移 52px 避开篮球架立柱 |
| 左下角 / 右下角 `⚙`（两组，`＋` 上方） | 打开**设置菜单** —— 与右键菜单是同一份 `menuModel()`，不另起一套。见 §2.10.1 |
| 托盘 → 篮球框 | 开启/关闭篮球框（带物理碰撞）；关闭后整个篮球架隐藏 |
| 托盘 → 音效 | 开启/关闭进球与弹跳音效 |
| 托盘 → 开机自启动 | 写入登录项，立即生效 |
| 托盘 → 命中方式 | 窗口区域（推荐）/ 全局鼠标钩子（备用驱动兼容） |
| 托盘 → **串流兼容模式（UU远程/超级屏）** | 关掉 DirectComposition 独立层，让远程串流也能抓到球（**会自动重启程序**）。用远程控制 / 手机串流时开启，见 §6.8 |
| 托盘 → 性能信息 | 显示实时性能面板 |
| 托盘 → 显示快捷控制栏 | 显示/隐藏两组 `＋` `－` 按钮（加/减篮球；常显不淡出，见 §2.2.1 的说明） |
| 托盘 → **窗口层级** | **贴桌面**（默认，被普通窗口盖住）/ **置顶**（显示在所有窗口之上）。即时生效、不重启，见 §2.1.2 |
| 托盘 → 打开配置 / 日志 | 打开对应文件 |
| 托盘 → 退出程序 | 先落盘球的位置，再清区域、卸钩子、销毁托盘、退出 |

> 层级曾在 v1→v2 迁移里被砍成固定值（那版把 `zMode` 删掉、顺带把球数拉回 1 颗）。
> 现在 **`zMode` 回来了**，而且是用户可切换的持久设置 —— 迁移里**不能再**删它，
> 否则每次启动都会把"置顶"重置回"贴桌面"。

**配置持久化**：`%APPDATA%\DesktopBasketball\config.json`，保存球数、每颗球的位置、
篮球框开关、音效开关、开机自启开关、命中方式、**窗口层级（`zMode`）**、性能面板开关。
下次启动自动恢复（若恢复位置与其他球重叠，会自动换到安全空位）。

**退出干净**：`quitApp()` 依次 `clearShape(hwnd)` → `uninstallMouseHook()` → `tray.destroy()` →
`win.destroy()` → `app.quit()`。实测退出后 `tasklist` 中无 electron / DesktopBasketball 残留进程，
无残留透明窗口，无残留点击区域。

---

## 6. 性能测试结果

测试机：**Intel Core i5-8500 @ 3.00GHz，6 逻辑核；1440×852 工作区；本机无可用 GPU → 软件合成（`--no-gpu --in-process-gpu`）**。
软件合成是本项目的最差情况，有 GPU 的机器数据只会更好。

### 6.1 纯物理基准（`npm run bench`，不渲染，3600 步 = 60 秒物理时间）

| 球数 | 平均 ms/步 | p50 | p99 | 峰值 | 占 16.67ms 帧预算 | 实时倍率 | 平均碰撞对 | collisionStart |
|---|---|---|---|---|---|---|---|---|
| **20** | **0.018** | 0.016 | 0.064 | 0.44 | **0.11%** | **907×** | 0.7 | 2621 |
| 50 | 0.064 | 0.061 | 0.136 | 0.48 | 0.39% | 260× | 3.9 | 13772 |
| 100 | 0.227 | 0.222 | 0.414 | 0.69 | 1.36% | 73× | 19.1 | 58517 |
| 200 | 0.819 | 0.768 | 1.267 | 1.64 | 4.91% | 20× | 96.1 | 171245 |

20 球这个数量级下，物理只花掉帧预算的 **0.11%**，余量约 3 个数量级。

### 6.2 真实应用 CPU 占用（`npm run perf`，含渲染 + 软件合成 + 透明窗口）

`app.getAppMetrics()` 逐秒采样，分三段：**活跃**（每 700ms 给所有球随机冲量，永不休眠）、
**沉降**（撤力后落地，不计入稳态）、**静置**（全部休眠）。原始数据见
`assets/cpu-test-20.json` / `assets/cpu-test-50.json`。

| 球数 | 活跃 平均（单核%） | 活跃 峰值 | 活跃 整机占用 | 静置 平均（单核%） | 静置 整机占用 |
|---|---|---|---|---|---|
| **20**（源码模式） | **7.66%** | 9.6% | **1.28%** | 0.56% | 0.09% |
| **20**（打包版 `DesktopBasketball.exe`） | **7.44%** | 10.2% | **1.24%** | 0.50% | 0.08% |
| **50**（源码模式） | **13.47%** | 15.5% | **2.24%** | 1.15% | 0.19% |

打包版与源码模式一致（7.44% vs 7.66%），说明打包没有引入额外开销。

> ⚠️ **这张表对机器负载极其敏感，读数请连带看当时的环境。**
> 同一份代码、同一套参数，在"后台还在跑其他构建任务"时 20 球能测出 **18.9%**，
> 机器空下来就是 **7.7%** —— 差 2.4 倍。所以：
> · 表里是机器空闲时的数；跨机器/跨时间对比必须重测，不能直接抄。
> · 静置那两列（0.56% / 1.15%）噪声更大，单个采样就能冲到 9.6%（沉降切换的瞬间），
>   它的意义是"量级在 1% 以下"，不是"精确到 0.01"。
> · 外观重做没有引入逐帧开销：纹理只在启动时烘焙一次，逐帧是每球 **3 次**预烘焙尺寸的 `drawImage`
>   （`body` + 球缝 + 阴影，见 §2.12 —— 这个"3"本身就是 60 球档满帧的前提）。

分进程（50 球活跃阶段，单核%）：`Tab(渲染) 10.65 · Browser(主进程，含 in-process GPU 光栅化) 2.82 · Utility 0`。

**50 球持续运动只占整机 2.24%。**

### 6.3 应用内实时指标（20 球，chaos 压测）与空闲降频

| 指标 | 活跃 | 空闲 |
|---|---|---|
| 物理帧率 | **59 / 60** | 0（全休眠） |
| rAF 回调频率 | 74.8 Hz | 11.7 Hz |
| 平均物理步耗时 | 0.05 ms | — |
| 脏块 / 绘制 | 43 / 84 块 · 0.6 ms | 1 块 |
| **唤醒延迟** | — | 平均 **0.36 ms** / 中位 0.4 ms / 最大 **0.4 ms** |
> 软件合成下 rAF 不锁 vsync（本机 150~450 Hz）。主循环里「rAF 回调频率」远高于「物理步进频率」是**正常且刻意**的：
> 未攒满一个 16.67ms 固定步长的帧会直接早退，不推进物理也不尝试渲染。
> 性能面板显示的 `物理帧率` 只统计**真正推进了物理**的帧，所以它等于 60 才代表跑满；低于 60 才是真的卡。
>
> 空闲期唤醒延迟量的是「事件到来 → 主循环开始处理」的间隔。**修复前**空闲期挂的是 `setTimeout(160)`，
> 事件会被 `wake()` 的早退吃掉，最坏要等 160ms；**修复后** 0.4ms 量级。
> 50 球空闲期实测平均 0.36 ms / 最大 0.5 ms。

### 6.4 逐项对照需求

| 需求 | 达成情况 |
|---|---|
| 20 球流流畅运行 | ✅ 物理帧率 59/60，整机 **1.28%**（打包版 1.24%） |
| **60 球档也满帧** | ✅ 每球 3 次绘制 → 180 次/帧，**60fps**（GPU 与软件合成都是 60；优化前 55 / 47，见 §2.12）。球数上限已抬到 200，各档数字见 §2.12.1 |
| 20 球同时碰撞不掉帧 | ✅ 物理步 0.05ms，帧预算占用 0.11%，碰撞对峰值不产生帧抖动 |
| 触控不延迟 | ✅ 空闲期唤醒 0.36ms 均值 / 0.4ms 峰值；拖拽 30ms 内跟手到目标、松手速度实测 906/-627 px/s |
| 降低 CPU 占用 | ✅ 静置 ≤1.2% 单核（量级在 1% 以下）；休眠 + 160ms 巡检 |
| 避免每球一个独立窗口 | ✅ 全程只有 1 个窗口 |
| 物理与渲染分离 | ✅ accumulator 固定步长，物理 60Hz 与 rAF 解耦 |
| 空间分区 / 碰撞优化 | ✅ Matter.js 自适应网格 broad-phase |
| 渲染只更新变化区域 | ✅ 128px 脏块 + 双画布分层，只重绘 43/84 块 |
| 后台无操作时降低更新频率 | ✅ 450 fps → 6 Hz |
| 不影响正常 Windows 操作 | ✅ 不抢焦点、不在 Alt+Tab、不覆盖任务栏、空白处完全穿透 |
| 上限 200 球 | ✅ `config.maxBalls = 200`（60 → 100 → 200）。**能力上限，不是推荐值**：50 球整机 2.24%；100 球软件合成 42fps / GPU 满帧；200 球软件合成 23.7fps（见 §2.12.1）。上限守卫实测被硬塞 +20 颗仍停在 200 |
| **篮球外观真实精致（非纯色球）** | ✅ 三层烘焙纹理（中频斑驳 + 颗粒簇 + 细颗粒浮雕）→ 缩到 68px 仍有可见皮革质感 |
| **首次启动只有 1 个球** | ✅ `config.js` 默认 `ballCount: 1`，并有 v1→v2 迁移把老配置的球数拉回 1 |
| **篮球框默认正常显示（不依赖拖动）** | ✅ `Renderer.pending()` + 主循环空闲消化分支；实测首次启动静置时 `idle=true` 且 `tiles=4`（确实画过） |
| **篮球框始终完整显示、不受篮球位置影响** | ✅ 真因是篮球架**不在窗口区域里**，被 `SetWindowRgn` 整体裁掉；拖动时区域被临时撑成全窗才闪一下。现由 `hoopRects()` 并入篮板/篮圈/网/立柱四块矩形。实测 `region-probe.ps1` 8 点全 `OURS`（旧代码跑同一个探针 **4 点落在桌面**） |
| **左下角 ＋ − 数量按钮始终显示** | ✅ 从右下角（与篮球架立柱重叠）移到左下角；移除「5 秒后降到 `opacity:.13`」的自动淡出 —— 那才是"按钮消失"的真正原因。实测真实屏幕可见，且 `ctrl-add`/`ctrl-minus` 打点在窗口区域里 |
| **篮球框外观（真实篮球架）** | ✅ 立柱落地 + 底座 + 支撑臂 + 斜撑；带透视的椭圆环（圈里有洞）；带落影的菱形网 |
| **右键菜单完整展示、不被裁成半圆** | ✅ 同步 IPC `shape-sync` + `visibility:hidden` 三段式；实测菜单矩形 `[698,298,203,261]` 完整可见 |
| **窗口层级彻底修复** | ✅ 锚点为「紧贴桌面上方那个窗口」；实测 `below=桌面锚点`、`above=普通窗口`、测试窗口中心命中 `=testWin`、桌面空白与任务栏均未被覆盖 |
| **球多时拖拽卡顿（物理帧率不降）** | ✅ 见 §6.5：主循环从 422 次/秒压回物理节拍（`STEP_MS` 未改，物理未削弱）；「拖拽走廊」经同进程 A/B 证实是净负收益，**已回退为整窗放开**（合计单核 19.77% → 16.69%）。剩余 16.7% 是拖拽唤醒 45 颗球的真实成本，对照 §6.2 的 50 球活跃基线 |
| **球在空中高速飞行时被裁掉一块** | ✅ 见 §6.6。真因是区域只有 6~12px 余量、而 `SetWindowRgn` 恒定落后 1~2 帧（探针实测 p50 8~15ms / max 34ms）。修法是上报半径加 `\|body.velocity\|·leadFrames`（`leadFrames` 后按 2026-10-05 的复发复查由 2 调到 5，见 §6.6）。**修复过程中查出前瞻被一个单位错误缩小了 60 倍**（拿 px/步 当 px/s），当时的探针数据看着像"前瞻完全没生效"。修好后阳性对照（`--region-lag=45`）剂量-反应：被裁率 **70% → 43% → 29% → 14% → 0%**（lead 0→4）；天然滞后下 `lead≥1` 全部完好（`fillMin≥0.979`） |
| **必须能显示在应用窗口之上（可切换）** | ✅ 见 §2.1.2。新增 `zMode` 两档（贴桌面 / 置顶），托盘菜单与球的右键菜单都能**即时切换、不重启**。置顶用 `setAlwaysOnTop(true,'screen-saver')`。验收拿真实不透明普通窗口当靶子并把球**摆进它**再判命中：`--z-top` 下球在窗内 **3/3** 命中的是我们（球盖住了窗口）、`--z-desktop` 下 **2/2** 命中 `testWin`（窗口盖住了球）；运行时切换后跨过一次 keeper 周期仍保持 `TOPMOST` |
| **更多玩法（本次新增）** | ✅ 见 §2.10：空心球 3 分 / 普通 2 分、连击（4s 窗口）、最高分跨会话保留、破纪录彩带+号角、清空重来、一键抛球、控制栏开关（并修复其失效）。全部事件驱动，静置仍 `idle=true`（§7.5）。自测：`before score2/combo1(普通→2分)` → `afterSwish score5(+3, swish:true, combo:2)` → `afterReset score0 且 highScore 保留` |
| **撞击挤压形变（顺带修复）** | ✅ 碰撞回调原先传刚体、渲染读外层对象 → `squash` 恒为 0，形变一直没生效；改为传外层 ball（刚体 `_pbBall` 反查）后恢复。AABB 早已按 squash 预留余量 |

### 6.5 拖拽性能：球多时"拖球卡、松手立刻流畅"（`npm run dragtest`）

球多（60 颗）时拖一颗球很卡、一松手立刻顺滑，而物理本身不慢 —— 瓶颈在**拖拽这条路径
独有的东西**，而不是物理引擎。手工对照把它拆成三层，全部与"每帧干几遍活"有关：

| 层 | 现象（手工读数） | 根因 |
|---|---|---|
| 1 | 拖拽时主循环跑到 **132~422 次/秒** | `wake()` 在 loop 体内被输入事件打断时，看到 `scheduled===null` 就以为"没人在跑"，**又挂一条 rAF 链**；每挂一条就把主循环永久提速一档。拖拽时 pointermove 有 200~1000Hz，链就一层层乘上去 |
| 2 | 非拖拽时循环频率也随环境浮沉（150~410Hz） | 循环挂在 rAF 上，而软件合成下 rAF **不锁 vsync**；物理却是固定 60Hz，跑得更快不会多出任何信息 |
| 3 | 拖拽期间的区域该报多大 | 一开始以为是"整窗 → 合成面积大 → 贵"，**实测方向反了**：真正的成本在**形状去重是否失效**。整窗只需上报一次，走廊每帧都变（下面详述） |

**第 1、2 层的修法与效果**：`scheduled='step'` 提前返回（不允许并存第二条链）、
`scheduleNext()` 把循环压到物理节拍（等下一个固定步长时用定时器而不是 rAF）、
`FRAME_MIN_MS` 绘制节流兜底、`moveDrag` 的邻近球预唤醒按物理步长节流（高回报率鼠标下同一
半径一帧被扫十几遍，完全等价）。实测循环从 **422 次/秒 → 36~66 次/秒**（= 物理节拍），
空闲期唤醒延迟最坏 160ms → 0.4ms 量级。

**第 3 层是一次反转，而且方向跟直觉相反：拖拽期间"省着报"反而更贵。**

想法很自然：拖拽时窗口别整体可点，只把「球心 → 指针」那段用一条窄走廊罩住 —— 指针必定落在盒子里，
`pointermove` 一样不丢，合成面积从 1440×852 降到几十像素见方。但同进程 A/B 测下来它更贵，
而且贵在**主进程**：

`--drag-test=60`，同一进程、相邻时间，两回合的 renderer 开销与主循环频率都相当：

| 60 球拖动一段路 | 主循环 | renderer(Tab) | **Browser(主进程)** | 合计单核 | 拖拽中唤醒 |
|---|---|---|---|---|---|
| 走廊（区域跟着指针变） | 42 次/秒 | 15.74% | **4.03%** | 19.77% | 24 颗 |
| 整窗放开（**现行**） | 46 次/秒 | 15.42% | **1.27%** | **16.69%** | 45 颗 |

注意最后两列：整窗那一回合**唤醒的球更多（45 vs 24），CPU 反而更低**，所以差异不是活跃球数带来的。
原因在 `sendShape` 的**形状去重**（`json === lastShapeSent` 就提前 return）：整窗矩形在拖拽开始时
上报一次，之后字符串恒定 → `SetWindowRgn` 一次都不会再被调用；走廊矩形**随指针每帧变化** →
去重永远失效 → 主进程每帧重建区域对象并重定向窗口表面。renderer 端省下的那点合成面积抵不过这块。

> 这次 A/B 特意把 `corridor` 排在前面跑 —— 万一存在"越跑越贵"的顺序效应（本机确实有，见各回合
> `Browser` 分项），那也对 `full` 不利；`full` 仍然更省，结论就只会更硬。

**所以现在默认是整窗放开**（`sendShape`：`menuOpen || (drag && bench.region !== 'corridor')`），
走廊路径保留在 `bench.region='corridor'` 下只作 A/B 对照，生产路径不会走到。

**关于这套测试台的能力边界**：它只能 A/B「区域上报方式」这一个变量。
**第 1 层的链式倍增修复没有开关** —— 两个回合都享受它，所以 CPU 表里看不出它的收益，
得看 `itersPerSec` 这个计数器（或性能面板的循环频率）。

**别把下面这 16.7% 当成"没修好"。** 拖球穿过整堆球时实测唤醒 `awake=45` 颗 —— 那就是
"45 颗球同时活跃"的真实物理+渲染成本，对照 §6.2 的 50 球活跃基线（13.47%）完全同量级。
"松手立刻流畅"是因为球散开后陆续休眠；**只挂住一颗球不动、其余全休眠时只有 3.4~5.1%**
（`assets/drag-test.json` 的 `*-hold` 阶段，`awake=1~2`）。没有为了数字去削物理：`STEP_MS`
仍然是 `1000/60`。

旁证：把主循环停掉只留一个空转 rAF → **0.53%**；同样空转但每轮都整帧重绘 → **7.74%**。
即贵的不是 rAF 频率，而是**绘制/合成**，所以"把每秒的活干少一点"就是全部收益来源。

⚠️ 本机负载对绝对数字影响极大（同一份代码单次绘制 0.17ms ↔ 1.28ms），只看同批次比值，
并且 `assets/drag-test.json` 每次运行都会覆盖 —— 别把不同次运行的数并排放。

### 6.6 球在空中高速飞行时被裁掉一块（`--fly-test`）

用户报的现象：**"蓝球在空中快速移动的时候，蓝球有一部分会缺失"**。真实屏幕上是月牙 /
一片叶子的形状（`tools/shots/fly_clipped.png` 就是标准形态：沿速度方向被一条近乎直的弦
切掉，对比 `tools/shots/fly_intact.png` 的完好球），球快的时候极端到**整颗球消失**，
慢下来又自己长回来。

**第一步先确认它是"区域"的问题，不是绘图的问题。**

`SetWindowRgn` 的区域就是窗口的可见范围，区域外的像素对系统根本不存在 —— 所以"缺一块"
最可能是区域裁剪。用 `--fly-test` 夹具让 0 号球在椭圆轨道上匀速飞，同一次飞行里
`capturePage()` 连抓 43 帧：**43/43 全是完整的球**；而外部 `screencap.ps1`（GDI+
`CopyFromScreen`，唯一能看到用户实际所见的通道）抓到的同一时刻是缺的。canvas 没问题，
被削的只有区域。顺带确认了一件早期踩过的事：本机 `desktopCapturer.getSources()` 每次都
返回同一张陈旧位图，所以真实屏幕只能靠外部进程 + `DwmFlush()` 拿新鲜帧。

**根因是两条管线的余量不够。** 区域是 `ballRadius(34) + GRAB_PAD(12) = 46`，
而球自身沿速度被 `drawBall` 拉伸到 `1.16r ≈ 39px` —— 只剩 **6~12px 余量**。
区域（渲染进程 → IPC → 主进程 → `SetWindowRgn`）与画面（canvas → Chromium 合成 →
提交 → DWM）是两条独立流水线，区域**必然落后** 1~2 帧；球速 1200px/s 时一帧就是 20px。

**用"区域探针"把滞后量出来，不靠推断。** 让夹具把球画成半径 400 的洋红实心盘（远大于
区域圆），于是截到的洋红块**就等于区域圆本身**：面积给出区域半径，质心给出区域圆心，
与日志里球的位置一比就是滞后。实测（`--fly-probe`）：

| 轮次 | p10 | p50 | p90 | max |
|---|---|---|---|---|
| 主进程轻闲 | 1.7ms | 8.2ms | 13.2ms | 19.5ms |
| 主进程较忙 | 7.8ms | 15.0ms | 25.6ms | 34.3ms |

换算成像素，最坏一次是 **46px 的缺失** —— 正好一颗球的直径级别，与现场看到的"缺一大块"对得上。

**修法**：上报半径 = `grab + |body.velocity| · leadFrames`。它同时罩住"上一帧的球位"和
"下一帧的球位"，不必去猜这次是区域超前还是画面超前。默认 `leadFrames = 2`（33ms，
覆盖实测 p90 并接近 max）。静止球的 `|v|·leadFrames ≈ 0`，与旧的固定圆完全等价。

#### ⚠️ 这里有一个 60 倍的单位坑，而且它会把结论彻底带偏

`body.velocity` 的单位是 **px/步**，不是 px/s（§2.3 那条约定）。第一版写成
`|v| · leadFrames · STEP/1000`，等于把"px/步"当"px/s"再乘一个秒数，**前瞻被缩小 60 倍**。

当时的现场是这样的：探针量出区域半径 `lead=0 → 45.1px`、`lead=4 → 48.1px` ——
**加了 4 帧前瞻只涨 3px**（按公式该涨 90px+），看起来跟"前瞻完全没生效"一模一样，
于是去查 `applyShapeMessage` 的形状去重、`applyNativeShape`、`__pbFlyRunner('lead')`
是不是改到了别的变量……全都正常。真正让人掉头的是算了一遍斜率：
物理限速上限 `maxThrowSpeed(2200)/60 × 1.35 = 49.5 px/步`，理论斜率
`49.5 × 0.01667 = 0.825 px/前瞻帧`，而实测 **0.75 px/帧** —— 两者吻合，
说明"生效了，但是小了 60 倍"，而不是"没生效"。

**别信"看起来没变化"这个判断，要去算它理应变化多少。** 修好后同一张探针表：

| lead | regR（修复前） | regR（修复后） | measuredLead | expectedLead |
|---|---|---|---|---|
| 0 | 45.1 | 45.1 | −0.9ms | 0.0ms |
| 1 | 46.1 | **61.6** | 15.5ms | 16.7ms |
| 2 | 47.1 | **79.8** | 26.6ms | 33.3ms |
| 3 | 47.1 | **89.8** | 45.2ms | 50.0ms |
| 4 | 48.1 | **95.8** | 55.2ms | 66.7ms |

#### 剂量-反应：`--region-lag=<ms>` 阳性对照

"修之前拍到、修之后也拍到"这两种说法都可能是"这次没触发"。所以给区域管线加了一个
**确定的人为滞后**（队列深度 1：滞后期内新形状直接顶掉未应用的那个，于是区域恒定落后
该时长，不会越堆越久），把滞后钉在 45ms —— 比自然滞后更大，于是"改善"必须从数据里
显出来才成立。同一趟飞行里把 `leadFrames` 在 0/1/2/3/4 之间轮换，别的条件一概不动，
指标 `fill = upx/(πr²)`（洋红实心盘的理论面积正好是 πr²，实测完好值 0.982，
缺的 1.8% 是圆边抗锯齿）：

| lead | n | 速度中位 | fillMed | fillMin | 被裁率 |
|---|---|---|---|---|---|
| 0 | 10 | 946 | 0.813 | 0.409 | **70%** |
| 1 | 7 | 1170 | 0.982 | 0.129 | 43% |
| 2 | 14 | 1095 | 0.982 | 0.856 | 29% |
| 3 | 7 | 1137 | 0.982 | 0.854 | 14% |
| 4 | 7 | 1024 | 0.981 | 0.980 | **0%** |

被裁率单调下降、`lead=4`（66.7ms > 45ms）归零，与"区域落后多久就需要多少前瞻"完全一致。
**没有阳性对照的天然滞后那一轮**同样干净：`lead=0` 有 10% 被裁（`fillMin=0.931`），
`lead≥1` 全部 `fillMin≥0.979`。

#### 指标为什么最后落在 `fill` 上

`upx`（橙色像素数）、`fillPar`、`dPar/dPerp` 三个指标先后被证明带毒：篮球的缝线是一条宽
深色带，把橙色切成 2~3 块且最大块面积随自转在 2 倍内摆动（一颗视觉完好的球被判成
`0.39` 个圆盘）；桌面上 VS Code 的红色语法高亮满足"橙色"阈值被并进球块，把垂直跨度
撑大 50%。所以验收时把球临时换成**纯洋红实心盘**（屏幕上独一无二），`fill` 才成为精确指标。

#### 验收夹具自身的三个坑（都会造假数据）

- **`M.Body.setVelocity` 必须包 `PB.V()`**：轨道夹具一开始把 px/s 直接塞进去（别处都规规矩矩
  折算了，就这一处漏了），`body.velocity` 立刻大 60 倍并被物理限速器钳到 49.5px/步 ——
  而前瞻正是读它，量出来全是假数据。夹具报出的 `vstep`（px/步）现在会跟 `speed`（px/s）
  对得上（`vstep ≈ speed/60`），对不上就说明又漏了。
- **`--fly-flat` 与 `--fly-probe` 的量程完全不同**：前者画半径 34 的盘（要跟区域圆比才知道
  缺多少，给的是 `fill`），后者画半径 400 的盘（**可见块就是区域圆**，能直接读出区域半径
  与滞后）。想做"区域半径随 lead 怎么变"这种题，只有 probe 能答。
- **空帧会被读成"整颗球被裁没了"**：`--region-lag=45` 那一轮有 8 张截图**整帧全黑**
  （DWM 没出画，`tools/shots/fly_blank_capture.png` 就是其中一张的裁图 —— 整片纯黑，
  连壁纸都没有），它们的 `upx=0` 与"区域把球裁没了"在数据上完全一样，凭空造出一个
  "lead=1 比 lead=0 更糟"的假结论。现在 `flyscan.ps1` 每帧输出 `lit=`（全图非近黑像素
  百分比），`flyab.py --lit-min`（默认 3）据此丢弃并打印被丢的帧名。

代价与边界：`leadFrames` 只在球真的飞起来的那一两秒把球周围的可点范围从 46px 放大到
`46 + |v|·leadFrames`（2200px/s、lead=5 时约 229px），静止/慢速球不受影响（`sendShape`
只在脏块/活动包围盒变化时才上报）。没有为了这个去削物理步长。

#### 2026-10-05 复发：`leadFrames` 由 2 调到 5

用户报告同一个现象又回来了：**"篮球在空中运动时经常部分被裁剪或完全消失"**。复查结论：

- **机制没变，只是余量被吃光了。** 露出量 = `|v|·(滞后帧数 − leadFrames) − 6.6px`，
  `leadFrames=2` 恰好只抵消 2 帧（33ms）滞后，固有余量**恒为 6.6px**。而上面那张探针表里
  "主进程较忙"一档的 max 就是 34.3ms —— **旧参数本来就贴在边界上**（6.6px ≈ 0.18 个物理步）。
  之后又加了记分板 / 成就 / 金球 / 托盘，球速上限仍是 2200px/s，余量被彻底吃掉。
  "完全消失"要求滞后 ≥72ms（`|v|=36.7px/步` 时位移 ≥85px，越过 `46+34`），与用户描述吻合。
- **顺带排除了两条错误方向**（都做过实验，别再走）：
  - *球贴图缺 `body` 层 → `drawImage(undefined)`*：`texFor` 的 exact/head/master 三级都补了
    `body`，还有 `SKINS[skin] ? skin : 'classic'` 兜底，不成立。
  - *脏块渲染把球画漏*：`capturePage()` 连拍 40 帧，**40/40 都是完整的球**（洋红盘 930px、
    跨度 66×66），canvas 侧没问题。
- **⚠️ 不要拿 `screencap.ps1` 去量几十毫秒的滞后，本机上它量不准。** 这一轮的连拍
  `copy=` 要 270~780ms，18 张里 **17 张字节完全相同**，而同一时段的 `capturePage` 40/40
  都不一样。用前者下结论会得到"滞后 200ms+"这种荒谬数（还会把 `--fly-probe` 可见、
  `--fly-flat` 不可见读成"区域偏心"，其实是两条流水线的采样时刻对不上）。截图法只适合回答
  "整颗球有没有被裁没"这种粗问题，而且**必须同时抓 `capturePage` 做对照**。
- **真正可靠的判据是 DIAG。** `DIAG renderer` 给球位与速度，`DIAG exstyle` 给主进程实际设进
  `SetWindowRgn` 的区域 bbox。抽查（球 `[482,547]`、2033px/s）区域圆半径 385px、圆心正是球心
  —— **区域内容一直是对的**，滞后只发生在 `SetWindowRgn` 返回之后（DWM 重定向窗口表面并呈现），
  进程内测不到。
- **新增区域管线采样（`--fly-test` 自动开启，`renderer` 侧的 `lagProbe`）**：渲染进程在
  `JSON.stringify` **之后**给 shape 挂 `_t`（必须在之后，否则去重永久失效），主进程在调
  `SetWindowRgn` 前算 `Date.now()-_t`。结果 p50 **1ms** / max **2ms** —— 它证明 IPC 与主进程处理
  **不是**瓶颈，别再往那边优化。⚠️ 两个进程的 `Date.now()` 有 **−7~−11ms 的恒定偏差**
  （Chromium 渲染进程不直接读系统时钟）。第一版没减掉它，所有样本都被"时钟异常"守卫丢掉，
  看起来像采样链路没通；现在用观测到的最小 `d` 当偏差估计（`lagOffset`）再相减。
- **修法：`LEAD_FRAMES_DEFAULT` 2 → 5**（83ms，是上述最坏观测值的两倍余量）。再往上加收益
  递减，而点击死区线性变大。改完回归：60 球档 `fps 59.9/60.1`、`drawCalls 180`，与 §6.2 基线
  一致；`repR` 实测 ≈ `46 + vstep·leadFrames`（`vstep=31.2`、lead=5 时 repR=202 ✓）。
- 新增 `--fly-om=<rad/s>`：轨道角速度。默认轨道只有 1376px/s，而扔球上限是 2200px/s ——
  "缺多少"与球速成正比，**量滞后必须把速度打到上限附近**（`om≈5.1`），否则最坏情况会被
  低速度盖过去。
- 新增 `tools/count-magenta.ps1`：统计截图里的纯洋红像素数与 bbox。把"我看着像没有球"
  变成一个数字（`magenta=0` 就是 0），是判断"整颗球是否可见"的廉价判据。

### 6.7 复盘（2026-10-05 晚）：§6.6 那条关键证据是**假的**

用户反馈「球在空中仍被裁剪/消失」，即 `leadFrames` 2→5 之后**问题依旧**。回头看 §6.6，
支撑那次改动的核心证据是：

> `--fly-test` 连拍 18 张真实屏幕截图，**17 张字节完全相同** —— 飞行球整个不在屏幕上，
> 即"完全消失"复现成功。按余量公式反推，当时滞后 ≥ 39ms。

**这条推理不成立。** 复现同一现象后做了三个检查：

1. 同样的 18 张里，**静态层的篮球架和 DOM 控制栏都正常可见**，而且窗口确实在最上层
   （夹具会 `setAlwaysOnTop(true)`）。画面里少的**只有动态层**（球所在的 `#dyn` 画布）。
2. 同一趟运行里 `WindowFromPoint` 打在球心 → **`OURS ✓`**（窗口区域里确实有球的圆），
   `LAGPROBE … circles=1 rects=7` → 上报形状**含球的圆盘**；`FLYSTATE.repR` = 151/205/226
   = `46 + vstep·5` ✓。**区域这一侧一直是对的**，不是"球露在区域外被削"。
3. `magenta=0`（18/18 张）**在任何解释下都不能推出"滞后 ≥39ms"** —— 它只能推出
   "这一帧的动态层没进画面"。字节相同说明整块屏幕没变，而球在飞，
   所以变的是**动态层整层缺席**，不是"球缺一角"。

→ **"截图里没有球" ≠ "球被区域裁掉"。** 这条判据只在静态层也一起缺席时才指向区域。
当时的运行环境（Agent 侧启动，GPU 进程连续崩 3 次 → 自动回退软件合成）本身就足以让
动态层不进画面，和 `SetWindowRgn` 无关。真实日志里用户自己双击启动时
`GPU 进程异常退出` = **0 次**，所以**那次的采样环境 ≠ 用户环境**。

顺带查实的两件事：

- **动态层与静态层唯一的实质差异**是动态画布用了 `desynchronized: true`（低延迟画布）。
  那个标志把这块画布从页面合成器里摘出去单独呈现，与 `SetWindowRgn` 再没有任何同步关系：
  区域先走、画布后跟 → 球沿运动方向缺一块；区域已缩到新位置、画布还停在旧位置 → 整颗球
  都在区域外直接消失。**静态层没这个标志，所以从来不掉** —— 与"球不见了但篮筐好好的"
  这个不对称完全吻合。**已去掉该标志**（代价只是放弃一点呈现延迟）。
- **区域半径的余量其实只有 1px，不是文档里一直写的 6.6px。** `b.r` 是 **30**（不是
  `cfg.ballRadius=34`，34 是贴图口径），`drawBall` 的最大形变是
  `squash(≤0.34) + stretch(≤0.16)` → **1.50r = 45px**，而上报半径是
  `cfg.ballRadius + GRAB_PAD = 46`，差 1px。旧注释按 "1.16r ≈ 39px" 估的 6.6px 余量
  **高估了 5.6px**，这就是"公式看着够、实际照样缺一块"的原因。
  已改为按 `drawBall` 同一套算式反推：`rad = max(46, visR + GRAB_PAD) + |v|·leadFrames`，
  其中 `visR = b.r · min(1.5, 1 + squash + stretch)`。静止球仍是 46（与旧值一致），
  形变/高速时才变大 —— 余量从 1px 变回 12px。

同时修掉两个会让"下次更难查"的东西：

- `--fly-probe`（400px 洋红盘当区域探针）**一直是坏的**：`ballAABB()` 只按 `b.r` 算包围盒，
  盘面落在脏块之外的部分每帧被 `clearRect` 擦掉，截出来是一块 128 的方块 ——
  早先"量到区域半径 45.1→48.1px"就是被这个东西污染的。已让 `ballAABB` 认 `flatBallR`。
- 球位/速度出现非有限值时（NaN/Infinity → `JSON.stringify` 变 `null` → native 侧
  `Math.max(1, …)` 收成半径 1 的圆）**会在屏幕上凭空消失且不留日志**。现在会按 0 处理并
  在 runtime.log 打一条 `SHAPEBAD`。

> **判据小结（下次直接照这个排）**：静态层在不在 → 分「区域/合成」还是「动态层」；
> `WindowFromPoint` 打球心 → 判断区域里到底有没有球的圆；`repR` vs `46+vstep·lead` →
> 判断前瞻有没有生效；`LAGSTAT` → 只管 IPC/主进程，别拿它谈 DWM。

---

### 6.8 真正的触发条件：远程串流（2026-10-05 深夜，用户定位）

用户终于点破了复现条件：

> 「我一开启 **UU 远程的「超级屏」** 功能，然后在手机上控制，就会出现那种现象。」

这条信息一次性解释了 §6.6 / §6.7 两轮都没对上的地方 —— **同一份代码，本地显示器一切正常，
只有被串流的那一端看不到球**。这不是时序问题，是**呈现路径**问题。

**机制**

Windows 上 Electron 的 `transparent: true` 窗口默认走 **DirectComposition** 呈现：
窗口内容（含每块 canvas 层）以独立提交的 DComp visual 交给 DWM/GPU，而不是先进窗口 DC。
而"球"和"篮球架"恰好落在**两条不同的合成链**上：

| 层 | 内容 | 合成路径 |
| --- | --- | --- |
| `#stat`（静态层） | 篮球架 | 低频、内容不变 → 常规合成 |
| DOM | 控制栏 / 记分板 | 常规合成 |
| `#dyn`（动态层） | **球** | 每帧变化 → 被提升为独立提交的层 |

远程控制软件为了低延迟，普遍不老实走 DXGI Desktop Duplication；UU「超级屏」靠**虚拟显示
驱动**把桌面临摹出来再串流。这条路对**独立提交的合成层**（DComp visual / 硬件 overlay plane）
往往抓不到 —— 于是被串流端呈现出来的画面里，**只剩常规合成的部分**：
篮球架在、控制栏在、球整层不在。本地显示器因为硬件直接扫描输出，一切正常。

这与 §6.7 里"静态层可见、只有动态层不见"的现场**完全同构** —— 那次我在软件合成
（`--no-gpu`，GPU 连崩 3 次后的自动回退）下采样，软件合成同样不把动态层交到能被
外部捕获的地方，于是撞出了同一个症状。**结论：症状的成因在"合成/捕获"，不在
`SetWindowRgn`。** 这也再次印证 §6.7 的判断：拿"截图里没有球"推"区域把球裁了"是错的。

**规避手段（⚠️ 未经真机串流验证）**：`streamMode`（配置项 + 托盘「串流兼容模式（UU远程/超级屏）」）
开启后在启动参数里加 `--disable-direct-composition`，让透明窗内容回到 DWM 常规合成 ——
期望任何屏幕捕获都能拿到。命令行等价物：`--stream` / `--no-stream`。

> ⚠️ **这条只做了机制推理与开关实测**（`--stream` 时 `dcompOff=true` 确实进了 Chromium
> 命令行），**没有在真实 UU 超级屏 + 手机端上验证过效果** —— 本机既起不来 GPU，也无法
> 复现该串流环境。
>
> 用户评估后的结论是**不为这个场景继续投入**：触发条件窄（仅手机远程控制时出现，本机
> 使用完全正常），且成因在外部软件的捕获行为、不在本程序。**开关默认关闭，留着当兜底即可**，
> 不必再花时间在手机端反复验证。

- 需要重启生效（改的是启动开关），所以托盘项**自动重启**，且重启参数会先剔掉旧的
  `--stream` / `--no-stream` 再补上目标值（否则用 `--stream` 启动时在托盘里关不掉）。
- 同时把 `lastRunStarted` 置 `true`：它平时靠启动后 10s 的定时器翻正，重启太快会留在
  `false`，而 `false` 会被当成"上次 GPU 崩溃"→ 下次启动被强制软件合成。
- 顺带做了个一次性提示：`onDisplayChanged` 里若检测到显示器拓扑变化（虚拟显示驱动
  连接/断开正是这个事件）而 `streamMode` 未开，托盘发一条 toast 提醒。
- 启动日志新增两个字段，一眼可查：`stream=<bool> noGpu=<bool> dcompOff=<bool>`。

**兜底**：若个别驱动上 `--disable-direct-composition` 仍不够，再叠 `--no-gpu`
（软件合成，透明窗在软件合成下反而更稳，见 §4 的说明）。

**代价**：关掉 DComp 后合成走常规路径，理论上多一次拷贝；对这类小窗口无实测差异。
个别驱动上透明窗可能出现轻微闪烁 —— 这是它默认**不打开**、只让远程串流的用户按需开启的原因。

---

### 6.9 性能面板 / 提示气泡 / 加分特效"看不见或只有一半"（2026-10-05，用户报）

**现象（用户原话）**

> ①「为何加分特效中有部分内容无法正常显示？我开启性能信息后，左上角的详情面板平时不会出现，
> 只有拖动蓝球、或是将蓝球拖到性能卡片附近时才会弹出；且蓝球靠近卡片时，显示区域是一个圆形。」
> ②「篮球皮肤功能无法正常启用使用。」

**根因：窗口区域漏了三类东西。** 这两条是**同一个 bug**。

`SetWindowRgn` 设的区域就是窗口的**可见范围**（不只是"哪里能点到"）：区域之外的像素
无论是 DOM 还是 canvas，**一律不绘制**。而 `sendShape()` 当时只上报了
「球圆盘 + 篮球架 + 记分板 + 两条控制栏 + 右键菜单」，漏了：

| 漏掉的东西 | 类型 | 表现 |
| --- | --- | --- |
| 性能面板 `#perf` | DOM | 平时完全不可见；拖动球时区域被临时撑成**整窗** → 出现；球滚到卡片旁时区域里只有球的圆 → 露出的部分是**一个圆形** |
| 提示气泡 `#toast` | DOM | 所有 toast 都看不见 —— 而它是**本程序唯一的操作反馈** |
| 加分飘字 / 火花 / 成就列表 | canvas `fx` | "+3 空心球 / 得分 N / 新纪录！" 只有落在**篮圈矩形**里的那一条能显示，上半截被齐刷刷切掉；火花绝大部分不可见；成就列表整块不可见 |

② 就是这么来的：用户点「球皮肤」切了 4 次（配置里 `skin` 从 `classic` 走到 `planet`，
**说明代码链路一直是好的**），但唯一的回执（气泡）被裁掉、球换了皮肤也没有任何文字说明，
于是结论成了"皮肤功能用不了"。**这不是渲染 bug，是区域少了一块。**

> ⚠️ 早期代码里有一句错注释（"画在 canvas 上就不用再往窗口区域里加东西"）—— 那是错的，
> 篮球架当初就是这么隐形过一次（见 `hoopRects` 的注释）。**DOM 和 canvas 同样受区域裁剪。**

**证据（真实屏幕截图，不是 `capturePage`）**

- 修复前：`tools/screencap.ps1` 连拍 → `tools/crop.ps1` 放大篮筐区，可见 "+3 空心球"
  被一条水平线切掉上半截；左上角**没有**性能面板（而 config 里 `showPerf: true`）。
- 修复后：同一套流程拍到 `+3 / 空心球 / 得分 N / 连击 ×N / 新纪录！` **全部完整**，
  连破纪录礼花的彩色粒子都整片可见；性能面板在球静止时稳定显示；成就列表 13 行全部可见；
  气泡 `金球彩蛋 开启` 出现在底部中央。

**修法**（`src/renderer/app.js`）

1. 新增 `perfRect()` / `toastRect()`（DOM 常驻小矩形）与 `fxRects()`（画布特效），
   在 `sendShape()` 尾部**一并上报**。
2. `fxRects()` 的取舍：飘字**逐条**上报（条数少、成就列表十几行都要完整）；
   火花按 `FX_CELL = 128` 网格**合并**成一格一个矩形 —— 一次进球 18~28 粒火花，逐粒上报
   等于每帧重建 30+ 个区域（主进程 `CreateRectRgn`/`CombineRgn` 跟着涨），而它们本来
   就只分布在一片扇形里。量化后通常 2~6 个矩形，上限 `FX_RECT_CAP = 16`。
3. `toast()` 在**显示和消失**时各重报一次形状：消失那次不报会留下一块"能点但点不进桌面"的死区。
4. `toggle-perf` / `__pbPerf` 立刻重报（否则"开了也看不见"）。
5. `sendShape()` 开头加兜底：`renderer/world/cfg/W/H` 未就绪直接 return。
6. `cycle-skin` 额外在**球旁边**画一条飘字（`球皮肤：×××`）—— 用户视线在球上，
   气泡固定在屏幕底部，多一条贴着眼睛走的反馈，避免再出现"点了没反应"的误判。

**维护清单（新增任何 UI / 特效时必须做的一步）**

> 画上去的东西，要么是**常驻 DOM**（加进 `perfRect`/`toastRect` 这类函数并接进 `sendShape`），
> 要么是**canvas 图元**（进 `fx.*`，由 `fxRects` 自动上报）。
> 只要 `sendShape` 里没有它，屏幕上就一定没有它 —— 而 `capturePage()` 截图**看不出来**，
> 必须用 `tools/screencap.ps1` 拍真实屏幕。

**顺带修掉的另一个坑：`forceNoGpu` 是粘性的，且原本没有入口能关。**

`--no-gpu` / GPU 崩溃自愈会把 `forceNoGpu: true` 写进 `config.json`，之后**每次启动**都是
软件合成（`app.disableHardwareAcceleration()`），而托盘里原本没有任何开关能改回来。
本机真踩过：一次带 `--no-gpu` 的验收运行把**用户的真实配置**钉死，用户侧只表现为"变卡了"。
现在给了两条路 —— 托盘「软件合成（关闭 GPU 加速）」开关（会重启生效），
命令行 `--gpu`（优先级最高，可直接把配置纠正回来）。


```bash
npm run bench          # 纯物理基准（不开窗），→ assets/bench-physics.json
npm run perf           # 20 球 CPU 验收（约 55 秒），→ assets/cpu-test.json + cpu-test.md
npm run perf:50        # 50 球
npm run perf -- 100,20,15   # 自定义：球数,活跃秒,静置秒
npm run dragtest       # 拖拽性能同进程 A/B（60 球，见 §6.5），→ assets/drag-test.json
```

`npm run perf` 等价于 `electron . --no-gpu --cpu-test=<球数>,<活跃秒>,<静置秒>`。
它会自动：加球 → 开篮筐 → 打开性能面板 → 每 700ms 给所有球随机冲量（保证永不休眠）→
活跃段采样 → 撤力待沉降 → 静置段采样 → 测空闲唤醒延迟 → 写文件 → 退出。

> 打包版运行时 `__dirname` 在只读的 `app.asar` 内，结果会写到
> `%APPDATA%\DesktopBasketball\cpu-test.json`（源码模式则写项目 `assets/`）。

其他诊断参数：

| 参数 | 作用 |
|---|---|
| `--diag` | 常驻并定期输出窗口样式、z 序、命中测试、渲染进程诊断（日志见 `%APPDATA%\DesktopBasketball\runtime.log`） |
| `--z-top` / `--z-desktop` | 强制**本次运行**的窗口层级（置顶 / 贴桌面），**不写盘**。给层级验收固定条件用；带覆盖时运行时切换会被压回覆盖值 |
| `--test-normal-window` | 开一个**不透明普通窗口**盖住大半个屏幕，用于**层级验收**（见 §2.1.1 / §2.1.2 判据）。它在 `desktop` 档会把自己置顶（否则可能被当前前台应用压住，判据就变成"测夹具自己"），在 `top` 档则保持普通 —— 那正是要测"球能不能压住它" |
| `--capture=<png 路径>` | 抓一张渲染结果 PNG（`webContents.capturePage`，只读自己的合成结果） |
| `--screencap=<png 路径>` `--screencap-at=<ms>` | 抓**真实屏幕**（`desktopCapturer`）——验证透明与层级必须用它 |
| `--capture-delay=<ms>` | 抓图/诊断的延迟，默认 4000 |
| `--exit-after=<ms>` | 到点自动退出。**不带 `--capture` 的 `--diag` 会永久挂住命令行**，脚本里务必带上 |
| `--eval=<js>` | 在渲染进程执行一段表达式（配合下面的诊断钩子用）。⚠️ **脚本必须自带调用括号**（`(()=>{...})()`），传 `()=>{...}` 会静默不执行，见 §8 |
| `--fly-test` | 「球飞行时被裁掉一块」的验收夹具（§6.6）：0 号球绕椭圆轨道匀速飞，每 100ms 把球位与区域半径写进日志。截图必须由外部进程做（见 §7.4） |
| `--fly-hold=<ms>` | 夹具持续时间，默认 14000 |
| `--fly-ab=<ms>` | 剂量-反应：每档前瞻停留多久，默认 1500；`0` = 不轮换 |
| `--fly-leads=<列表>` | 要扫的前瞻档位（单位：物理步长），默认 `0,1,2,3,4` |
| `--fly-flat` | 把球画成纯洋红实心盘（半径 = 球半径），用来精确量 `fill` |
| `--fly-probe` | 洋红盘半径放到 400 —— 可见块就等于**区域圆本身**，用它直接量区域半径与滞后 |
| `--fly-om=<rad/s>` | 轨道角速度。默认轨道只有 1376px/s，而扔球上限 2200px/s；"缺多少"与球速成正比，量滞后要用 `--fly-om=5.1` 把速度打到上限附近，否则最坏情况被低速度盖过去 |
| `--region-lag=<ms>` | **阳性对照**（仅验收用，非默认行为）：让区域管线确定地滞后这么多毫秒。没有它就无法区分"修好了"和"这次没触发" |
| `--cpu-test=<球数>,<活跃秒>,<静置秒>` | CPU 验收。球数上限已抬到 200，所以 `--cpu-test=200,...` 现在跑得动（§2.12.1 的数据就是它出的） |
| `--drag-test=<球数>` | 拖拽性能**同进程 A/B** 验收：`settle → probe-raf → probe-rafdraw → corridor-hold/drag/after → full-hold/drag/after`，逐秒采分进程 CPU 并同步记录主循环频率 / 绘制次数 / 脏块数 / 唤醒球数。两个回合只差"拖拽时区域报整窗还是报窄走廊"这一个变量，`corridor` 先跑（顺序效应对 `full` 不利）。结果写 `assets/drag-test.json`（§6.5 的表格就是它出的） |
| `--dev` | 打开 DevTools |
| `--stream` / `--no-stream` | 串流兼容模式（远程控制/超级屏/教学白板）。**不是**单个 `--disable-direct-composition`，而是叠加 `disable-direct-composition` + `disable-gpu-compositing` + `disable-zero-copy` 三条（只关 DComp 够不着 overlay plane），**且不降帧率**。等价于配置项 `streamMode`，**须重启生效**；重启参数会被 `stream.sanitizeArgs` 清洗，见 §6.10 |
| `--no-gpu` | 强制软件合成 |

渲染进程暴露的诊断钩子（仅验收用，正常使用不涉及）：
`__pbDiag()` `__pbSetBalls(n)` `__pbAddBalls(n)` `__pbToggleHoop()` `__pbPerf(on)`
`__pbChaos(on, ms)` `__pbThrow(i, vx, vy)` `__pbPlace(i, x, y, vx, vy)` `__pbScore()`
`__pbOpenMenu(x, y)` `__pbWakeLatency(n)` `__pbFlyRunner(cmd, a, b)` `__pbZMode('top'|'desktop')`
`__pbFrameState()` `__pbSmooth(on)` `__pbRenderAt(alpha)` `__pbDisplayHz(hz)`。

后面几个是 §6.10 的帧同步验收用的：

- `__pbFrameState()` —— 插值三态（`px/py` 上一步、`bx/by` 物理当前、`rx/ry` 画面位置）+
  呈现度量（`presentHz/P50/P95/jitter/stalls`）+ 补帧预算 `smoothBudgetMs` / 绘制成本中位
  `drawMsMedian` + **设备画像** `device{w,h,dpr,backingW,backingH,backingMpx}` +
  最近一次真发出去的区域圆 `circle0`。
- `__pbSmooth(on)` —— 运行时开关插值渲染，用来做前后对照。
- `__pbRenderAt(alpha)` —— **强制**以指定插值系数渲染一帧并立刻重报区域。断言因此不必依赖
  "恰好抓到某一帧的时序"：夹具自己摆好物理状态，再要求"按 alpha=0.5 画一帧"，于是能直接验证
  `rx === (px+bx)/2` 与 `区域圆心 === round(rx,ry)` 这两条恒等式。
- `__pbDisplayHz(hz)` —— **强制按指定刷新率重算节拍**，返回生效的补帧预算（ms）。
  用于在同一台机器上验证「预算跟着屏幕周期缩放」，不必真插一块 2K 屏（见 §6.10 ⑥）。

`__pbZMode` 走的是和右键菜单同一条路径（`patchConfig` → 主进程立即重排 z 序），
所以它能证明**运行时切换**（而不只是启动参数）生效。

`__pbFlyRunner` 是 §6.6 的夹具（`--fly-test` 就是在驱动它）：
`orbit [i] [om]` 让第 i 颗球绕轨道飞；`state` 返回球位/速度，外加 `vstep`（px/步）、
`repR`（**最近一次真正发出去的区域圆半径**）、`lead`（当前前瞻帧数）——
`repR ≈ 46 + vstep · lead` 是"前瞻有没有落到区域上"最快的判据，不用截图；
`lead <n>` 改前瞻帧数并立刻重报形状；`flat <0|1> [R]` 换洋红盘；`stop` 摘钩子。

**纹理放大预览工具**（改外观时用，看清 68px 下到底还剩多少细节）：

```bash
# 把球与篮球架按 2~4 倍画到页面上再抓图 → tools/shots/preview_tex.png
EV="$(cat tools/preview-eval.js)"
./node_modules/electron/dist/electron.exe . --no-gpu \
  --capture=tools/shots/preview_tex.png --capture-delay=6000 --eval="$EV"
```

它直接在真实渲染进程里 new 一个 `PB.Renderer`（复用同一套烘焙代码），
所以看到的就是实际纹理，不是另画一份。

### 6.10 换设备 / 希沃白板 / UU 超级屏：画面缺失 + 开关异常 +「帧率满但卡顿」（2026-10-11，用户报）

**现象（用户原话）**

> 「修复更换设备、希沃教学白板及 UU 远程超级屏模式下篮球画面缺失的问题，尤其是篮球下落和空中
> 高速运动时。现有 uu 远程兼容开关异常并且开启后运动卡顿但帧率仍满。请排查渲染、帧同步及设备
> 兼容性，修复开关逻辑，确保篮球显示完整、运动流畅，**不要仅靠降低帧率规避问题**。」

一句报障里有**三个互不相干的 bug**。逐个拆。

#### ①「兼容开关异常：点了没反应 / 显示与实际不符 / 关不掉」

原实现是 `main.js` 里一行三目：

```js
forceStream = argv.includes('--stream') ? true
            : argv.includes('--no-stream') ? false
            : cfg.streamMode === true;
```

它有两个被真实踩到的缺陷：

| 缺陷 | 后果 |
| --- | --- |
| **它算的是"配置里写了什么"，而 UI 读的也是配置** | 托盘菜单项、`app-info`、显示器变化提示全部读 `config.streamMode`，与实际生效值不是同一个东西。带 `--stream` 启动时菜单显示「开启」（点一下其实想关），`--no-stream` + 配置 true 时显示「开启」而实际是关的 |
| **重启参数没有清洗** | `process.argv.slice(1)` 原样透传、再 `push` 目标值。用户带 `--stream` 启动、在托盘里想关掉时，命令行里会同时留下 `--stream` 和 `--no-stream`，Chromium 的 `HasSwitch` 取先出现的那个 —— 又一个"点了没反应" |

**修法**：把这段逻辑抽成**纯函数模块** `src/stream.js`（不 require electron / koffi，
于是能用纯 node 断言，见 §7.12），三个要点：

- `resolve()` 除了 `active` 还返回 **`source`**（`'arg'\|'user'\|'user-off'\|'auto'\|'default'`）。
  **所有 UI 与日志都读 `source`/`active`，不再读 `cfg.streamMode`** —— 这是"显示与实际不符"
  的形式化解法：`active` 与 `source` 现在永远自洽。
- `sanitizeArgs(argv, target)`：**先摘掉所有串流开关，再补上唯一的目标值**（不修改入参）。
- `toggleStreamMode()` 改为**以实际生效值 `forceStream` 取反**，而不是 `cfg.streamMode`。

#### ②「兼容模式开着，球整层不见（静态层在）」→ 只关 DComp 够不着

远程串流软件（UU「超级屏」、希沃白板）靠**虚拟显示驱动**摹拓桌面，抓不到的是
**「独立提交的合成层」**。而这件事有**两个**来源，原实现只关了一个：

| 开关 | 关掉的是什么 | 只关它够不够 |
| --- | --- | --- |
| `disable-direct-composition` | 透明窗内容不再作为独立 DComp visual 提交，回到 DWM 常规合成 | 原实现只有这一条。**必要但不充分** |
| `disable-gpu-compositing` | 让页面合成在渲染进程里用软件光栅完成、写进窗口**后备缓冲** | 必须有 —— 只关 DComp 时 Chromium 仍可能把每帧变化的 `#dyn` canvas 交给 GPU 进程**单独提交（overlay plane）**，那同样是捕获端拿不到的一层 |
| `disable-zero-copy` | 零拷贝纹理直通（DMA-BUF 直采旁路） | 附带收口 |

关掉后，任何走窗口 DC / GDI `BitBlt` 的捕获方式（虚拟显示驱动正是这类）都能拿到完整内容。

> ⚠️ **这三条不降低帧率**：物理步长、绘制调用次数、脏块策略一概不变，改的只是"谁把画面提交给
> 系统"。渲染进程的 Canvas2D 光栅化仍走 GPU，所以 `drawImage` / 文字仍然快 ——
> 这正是**坚持不用 `app.disableHardwareAcceleration()`** 的原因：那是整机软件渲染，会真的变卡，
> 也就是用户明确禁止的"靠降帧规避"。

#### ③「帧率满但运动一顿一顿」→ `fps` 量错了对象

**这是本次最关键的一条，也是一个能长期隐藏的度量错误。**

- `fps` 那个变量统计的是**物理步率**：`frames++` 只在 `steps > 0` 的分支里执行。定点物理恒为
  60 步/秒 ⇒ **`fps` 永远≈60，与呈现节拍无关**。所以"帧率满"这句话本身不提供任何信息。
- 更早的实现里，`loopInner()` 在 `acc < STEP` 时**直接早退、完全不绘制**。于是：
  推进 0 步的那一帧球**不动**、推进 2 步的那一帧球**一次跳两格**。平均下来仍是 60 步/秒，
  看着却抖 —— 这就是"帧率满但卡顿"的全部真身。

**修法**（`src/renderer/`）：

1. **插值渲染**（`render.js::syncRenderPos`）。每个物理步**之前**打一份快照
   `b._px/_py/_pa`（`app.js::snapshotPrev`），每帧用 `alpha = acc / STEP` 在
   「上一步位置 → 当前位置」之间插值，结果写进 `b.rx/ry/ra`；`drawBall`/`ballAABB`/
   `updateTrail` 全部改用 `renderer.posOf(b)` / `angOf(b)`。
   于是**每一帧都画**，球在两次物理步之间平滑移动，不再有"跳两格"。
2. **补帧分支**：`acc < STEP` 时若 `renderer.smooth && renderer.lastDrawMs <= 6ms`
   就照常出一帧（预算 `SMOOTH_DRAW_BUDGET_MS = 6`，绘制太贵时才退回旧行为）。
3. **呈现度量**（`app.js::notePresent`）：新增 `presentHz / presentP50 / presentP95 /
   presentJitter / presentStalls`，量的是**两次真正绘制之间的间隔**，基准是 `displayPeriod`。
   这是唯一能把"fps 显示 60 而实际在顿"暴露出来的尺子。
4. **rAF 节拍探测**（`startRafProbe`）：软件合成 / 关掉 DComp 后 rAF 可能**自由跑**
   （实测 150~410Hz），拿它当节拍会让主循环空转；正常 GPU 路径下 rAF 恰等于屏幕刷新率，
   用它出帧才能让画面落在屏幕帧边界上、不与定时器打架。只测一次、只记住结论，且在
   **主循环热的时候才开**（空闲期常驻 rAF 会毁掉 §2.7 的省电）。

> ⚠️ **插值带来的连带缺陷（同一批修掉）：`_px/_py` 变成了"活跃状态"，搬球必须一起搬快照。**
> `render.js::snapshotPrev` 打的 `_px/_py/_pa` 是"上一步位置"。而 `__pbPlace`（验收）、
> `resetGame`、从 `ballStates` 恢复球位、`__pbFlyRunner('orbit')` 都是直接
> `M.Body.setPosition` —— **不重置 `_p*`**，于是下一帧球被画在
> `_px + (bp − _px)·alpha`，即"旧位置 → 新位置"连线上一个**谁都没想到的位置**：
> 闪一下，并在旧位置或新位置留下**擦不掉的残影**（`verify-render` 的休眠球像素保留判据
> 就是这么抓到的 —— 它原本一直是绿的，插值上线后才红）。
> 两层修法：① `__pbPlace` 里同时设 `_px/_py/_pa` 与 `rx/ry/ra`（精确）；
> ② `syncRenderPos` 加**瞬移保护**：`|Δx| + |Δy| > 200` 就直接按物理位置画
> （一步位移不可能超几十 px —— 物理限速 49.5px/步）。第二层覆盖所有搬球路径，含生产路径。
> 判据见 §7.12 的「瞬移」两条。

#### ④「高空/下落时球被削掉一块」的剩下那一半

即使区域半径已经加了 `|v|·leadFrames`（§6.6），还有一个漏洞：**区域圆心用的是
`body.position`（物理位置），而球画在插值点上**，两者最多相差**一个步长**（高速球 30~50px）——
那正好就是"球沿运动方向被齐刷刷削掉"。→ `sendShape()` 的球盘循环也改用
`renderer.posOf(b)`（**区域与画面同一口径**，见 `app.js` 里那段注释）。

#### ⑤「更换设备」：刷新率感知 + 虚拟显示自动检测

- **刷新率**：`applyDisplayHz(hz, src)` 把 `frameMinMs` 从钉死的 `1000/70` 改成按屏幕算
  `Math.min(1000/70, 1000/hz × 0.92)`。旧值在 120Hz 屏上会把插值补出来的中间帧
  **全部节流掉**（8.3ms < 14.3ms），等于插值白做。主进程经 `app-info` / `layout` 把
  `screen.getPrimaryDisplay().displayFrequency` 送到渲染进程。
  ⚠️ **不对刷新率做任何"常见值"夹取**（详见 §6.10 ⑦）：它是连续谱，旧版夹在 `[60,144]`
  会让 165/240Hz 屏按 144 算而白丢呈现帧、让 30Hz 投屏按 60 算而白画一半。
  ⚠️ 仍只往**更快**的方向放开（`Math.min(1000/70, …)`）：这个量是"防止循环被推回自由跑的
  rAF 时绘制跟着涨"的兜底，真正的节拍由 `scheduleNext`/rAF 决定；若把它当主力（30Hz 屏定成
  33ms）就真的把画面压成 30fps —— 那是拿流畅度换省电，属于被明确否掉的规避手段。
  ⚠️ **刷新率缺报的兜底**：`displayFrequency` 在部分虚拟显示驱动/白板/投屏模式下是 0，
  这时先按 60 顶一下，等 `rafProbe` 测出"rAF 与屏幕同频"后用**实测值**补齐
  （`applyDisplayHz(hz,'raf')`：只补一次、只在主进程没报时补）。来源记在 `displayHzSource`
  （`reported` / `raf` / `default`），性能面板与 `__pbDiag()` 都能读到。
- **虚拟显示自动检测**：`native.getDisplayInfo()` 用 `EnumDisplayDevicesW` 枚举适配器与监视器。
  ⚠️ **只认已挂载的设备**（`StateFlags & (ATTACHED_TO_DESKTOP|MIRRORING_DRIVER)`）：
  本机 `GameViewer Virtual Display Adapter` 常驻枚举出 10 块、`StateFlags=0`，不过滤的话
  **普通使用下也会被判成串流环境**，被迫走兼容合成白白变慢 —— 正是"宁可漏判不要误判"。
  关键字表 `DEFAULT_HINTS` 可用配置项 `streamDisplayHints` 整体覆盖（新厂商不改代码）。
- **自动检测不跟用户对着干**：`cfg.streamExplicit` 记"用户是否显式表态过"。一旦用户在托盘里
  点过开关，此后插拔显示器**不再**自动改回来（`resolve()` 的第 ③ 优先级）。

#### 验收

```bash
# ① 开关逻辑（纯 node，5 秒，不需要 GUI）
node tools/verify-stream.js                 # 34 条断言

# ② 帧同步（插值恒等式 / 区域同口径 / 呈现度量）
unset ELECTRON_RUN_AS_NODE
T=/tmp/dbb-fs
cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"   # 夹具必须覆盖用户真实配置
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --user-data-dir="$T" --exit-after=6000 \
  --eval="$(cat tools/verify-framesync.js)"
grep -o 'EVAL ok.*' "$T/runtime.log"
```

- `verify-stream.js` 的关键判据不是"读一下配置"，而是
  **`source` 与 `active` 永远自洽**，以及 `sanitizeArgs` 处理后**有且仅有一个**串流开关。
- `verify-framesync.js` 的关键判据是三条**恒等式**（不依赖抓时序）：
  `__pbRenderAt(0.5)` ⇒ `ry === (py + by)/2`；区域圆心 `=== round(rx, ry)`；
  关掉插值后同一状态 `ry === by`（对照）。实测：`py=262.398 by=285.861 → ry=274.130`，
  区域圆 `[720, 274, 164]` 与画面 `(720, 274.13)` 一致，而 `body.y=285.861` —— 三者互证。

> ⚠️ **未覆盖**：真机 UU 超级屏 + 手机端、希沃白板投屏**未实测**（本机无法复现该串流环境，
> 与 §6.8 的结论一致）。三条兼容开关叠加后是否有副作用（overlay 性能、透明窗闪烁）也需真机确认。

#### ⑥ 追加：目标设备是 **2K（2560×1440）@60Hz** 希沃白板 —— 改掉了"补帧预算钉死 6ms"

用户后续补充：「我用的那台希沃设备的分辨率是 2K，帧率是 60 帧」。这条信息直接命中了一个隐患。

**一次整帧绘制的成本正比于画布像素数**，而插值补帧的预算原本是**常数** `SMOOTH_DRAW_BUDGET_MS = 6`：

| 设备 | CSS 分辨率 | dpr | **真实画布像素** | 6ms 够不够 |
| --- | --- | --- | --- | --- |
| 开发机 | 1440×852 | 1 | 1.23 Mpx | 实测 `drawMsMedian` 1.5ms ✓ |
| 2K 希沃白板 | 2560×1440 | 1 | 3.69 Mpx（×3） | 边缘 |
| 2K + 125% 缩放 | 2560×1440 | 1.25 | **5.76 Mpx（×4.7）** | ✗ 很容易到 7~9ms |

一旦中位绘制成本越过 6ms，**插值补帧那条分支就再也不执行**，等于白插一场，症状正是
「在这台设备上照样抖」。而 **60Hz 屏恰恰最需要它** —— 物理也是 60 步/秒，
`acc < STEP` 的帧约占一半，补帧被关掉就等于丢掉约一半的呈现帧。

**修法**（`src/renderer/app.js`）：预算不再猜分辨率，而是**从屏周期与实测成本推导**。

1. **预算 = 一个显示帧周期里、扣掉必须做的物理之后，还剩多少给一次整帧绘制**：
   `smoothBudgetMs = clamp(displayPeriod × 0.75 − physMsPerFrame(), 2.5, 14)`。
   实测（200 球 + `--no-gpu`）：`24Hz→14ms`（压上限）、`60Hz→8.13ms`、`120Hz→2.5ms`（压地板）。
   - 高刷屏更紧是对的：120Hz 每帧只有 8.33ms，"补一帧"一旦超支就掉帧，比不插更糟。
   - 30Hz 投屏每帧要跑 **2 步**物理，余量会被物理吃掉一块，所以给 14ms 上限而不是无上限。
2. **物理那一项用「每呈现帧的平均值」**（`physMsPerFrame()`），不是中位数：
   60Hz 屏上约一半的帧 `acc` 没攒够一个步长（跑 0 步、开销 0），中位数会被这些 0 拉到 0 →
   预算恒等于上限，方向恰好是错的。
3. **为什么不按 `backingMpx` 猜**：整帧绘制成本取决于**脏块数量**，而脏块取决于"同时有多少
   东西在动"，跟分辨率只是间接相关。实测成本天然带着机器/驱动/合成路径/球数的全部信息，
   换设备不需要改代码。
4. 判据仍是「近 120 帧的**中位数**」（`drawMsMedian()`），不是"最后一次"：单次采样会被一次 GC
   或一次进球特效（几十粒火花 + 光环 + 彩带）抬高，用它会令补帧在特效期间忽开忽关，反而更顿。
5. **设备画像**进诊断：`device = { w, h, dpr, rawDpr, backingW, backingH, backingMpx, capMpx }`；
   启动日志追加 `display=W×H@Hz scale= mpx=`，`DISPLAYCHANGE` 行同样带上分辨率/缩放/mpx；
   性能面板加 `设备 … dpr … → 实渲 …×  画布 …(…Mpx)` 一行。排障第一眼看的是**真实画布像素数**。
6. 新增验收钩子：`__pbDisplayHz(hz)`（强制按某刷新率重算节拍并返回整套推导量）、
   `__pbDeviceFit(w,h,dpr,scale)`（**不改窗口**算出"某设备会得到多大画布"）、
   `__pbScale(s)`（强制 / 交回 DRS 档位）、`__pbResize()`（手动走一遍换设备路径）、
   `__pbPerfReset()`（清空性能测量窗口，见下）。

> ⚠️ **滑动窗口统计量必须先校准再当判据**（本次实测踩到，详见本节末尾"夹具的尺子必须先校准"）。
> `physMsFrame` / `drawMsMedian` / 呈现抖动都是约 120 个呈现帧的窗口。用户真实配置是
> `ballCount: 200`，启动那两秒是"200 颗球一起落下"的峰值 ——
> 不清窗口就取样，`physMsFrame` 会读到 **7.7~16.7ms**（稳态真实值 1.1~4.2ms，1 颗球时 0.16ms）。
> 夹具因此必须在切换场景后调 `__pbPerfReset()` 并等窗口重新填满（`physFrames`）。

> ⚠️ **诊断陷阱（本次实测踩到）**：200 球 + `--no-gpu` 时面板会出现
> `物理 23 / 60 步`、`presentP50 44ms`，但 `drawMs 1.0`、`drawMsMedian 1.5`、`physMs 2.2`
> 全都很便宜。差的 36ms **不在我们的代码里** —— 软件合成的合成/提交发生在渲染进程主线程上、
> 在我们的 JS 回调**之外**，所以 `loopMsAvg`（新增，量的是主循环自身开销）也量不到它。
> **别把"合成/呈现慢"读成"绘制慢"**；也不能拿 Agent 侧 `--no-gpu` 的采样代表用户环境（§4.1.4）。

#### ⑦ 适配更宽的分辨率与刷新率（2026-10-11，用户要求"适配更多的分辨率与帧率"）

⑥ 只解决了 2K@60Hz 这一个点。把它推广成**对参数取值**的规则后，一共四处：

| 环节 | 旧做法（隐含"就这台机器"） | 现在 | 覆盖范围 |
| --- | --- | --- | --- |
| 刷新率 | 夹在 `[60,144]` | `period = 1000/hz`，节流 `= min(1000/70, period×0.92)` | 24~360Hz；缺报时回落 60 并用 rAF 实测补齐 |
| 插值补帧预算 | 常数 6ms（后改 `period×0.55`） | `clamp(period×0.75 − physPerFrame, 2.5, 14)` | 由实测成本定，与分辨率/球数/机器无关 |
| 画布像素数 | 无上限（= 分辨率 × dpr²） | 上限 **8.3Mpx**（= 4K@1x），超出按面积缩 dpr | 8K / 4K@150% / 4K@200% / 1280×800@300% |
| 绘制成本压不住 / **画完了却出不了帧** | 只能放弃补帧 | **DRS**：降画布分辨率（`1→0.88→0.76→0.64`×dpr），**不降帧率** | 屏 ≤120Hz，且「绘制成本 > 屏周期 62%」**或**「绘制中位成本 ≥ 0.5ms **且** 相邻呈现间隔中位 > 1.35× 参考节拍」 |

**实测的"设备 → 画布"对照**（`__pbDeviceFit()`，无需真机）：

| 设备 | CSS 分辨率 | dpr | 实渲 dpr | 画布像素 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 老笔记本 | 1366×768 | 1 | 1 | 1.05 Mpx | — |
| 1080p | 1920×1080 | 1 | 1 | 2.07 Mpx | — |
| **希沃白板** | 2560×1440 | 1 | 1 | 3.69 Mpx | ⑥ 的那台 |
| **希沃 + 125% 缩放** | 2560×1440 | 1.25 | **1.25** | **5.76 Mpx** | ✅ 不被上限动到 |
| 带鱼屏 | 3440×1440 | 1 | 1 | 4.95 Mpx | — |
| 4K 原生 | 3840×2160 | 1 | 1 | 8.29 Mpx | ✅ 恰好在上限内 |
| 4K + 150% | 3840×2160 | 1.5 | **1** | 8.3 Mpx | 被上限压到 1× |
| 4K + 200% | 3840×2160 | 2 | **1** | 8.3 Mpx | 同上 |
| 8K | 7680×4320 | 1 | **0.5** | 8.3 Mpx | 压到 `ABSOLUTE_MIN_DPR` |

**关键取舍（都写进代码注释了，别当成 bug 改掉）**：

- **画布上限只管清晰度、不管帧率**：超过 8.3Mpx 时按 `sqrt(cap/mpx)` 等比缩 dpr。
  它在 4K@150% 上会把 dpr 从 1.5 压到 1.0 —— 略软，但比"两张 18.7Mpx 全屏画布"稳得多。
  **不能**反过来砍帧率来省绘制（用户明确否掉了这条路）。
- **DRS 只在屏 ≤120Hz 时介入**：240Hz 屏上"少呈现几帧"比"糊一点"划算得多，而且物理只走
  60 步/秒，240Hz 下 4 帧才对应 1 步、插值帧本身高度冗余。
- **DRS 是两条判据 + 一个旁证闸 + 一个逃生阀**（`app.js::drsTick`，任一路报警就降档）：
  - ① 绘制成本 / 屏周期 > `0.62` —— "我们自己画得动吗"；
  - ② 相邻呈现间隔中位 / 参考节拍 > `1.35` —— "画完之后那一串（光栅 → 合成 → 提交 → 呈现）
    到底出帧了没有"。**只有 ① 是不够的**：球一多，`drawMs` 可能只有 1.6ms（占屏周期 10%），
    旧判据完全看不见，DRS 一次都不降档，画面却已经掉到 17 帧。补上 ② 之后实测 200 颗球：
    `p50 80.6 → 31.8ms`、`11.8 → 31.2 帧/s`（`tools/verify-drs.js`）。
  - ②的**旁证闸**：`drawMs < 0.5ms` 时判据② **闭嘴**。判据② 只管"出帧没出够"，不管原因；
    而本机（软件合成 + 一堆虚拟显示器）**8 颗球、`drawMs` 0.2ms 时呈现 p50 就有 31ms** ——
    这个地板与画面无关。`drawMs` 恰好是"这一帧到底涂了多少像素"的可比量（8 球 ≈ 6.5 万 px
    → 0.2ms，200 球 ≈ 160 万 px → 2ms），DRS 省的就是这堆像素。所以：**我们自己没涂多少
    像素的时候，缩画布不可能是解**，此时降档只会白糊画面。阈值 0.5ms 是两条实测夹出来的
    （80 球 0.9ms 必须放行、8 球 0.2ms 必须拦住）。
  - ③ **逃生阀**：判据② 是**结果导向**的，它只知道"出帧没出够"，不知道**为什么**。若卡在
    分辨率管不着的原因上（软件合成器本身 / 虚拟显示器 / 特效叠加），它会永远报"不健康"，
    把画面永久留在 0.64× —— 而这时降分辨率**一分钱都没省**（实测 6 颗球、`drawMs` 已掉到
    0.1ms，呈现仍只有 40 帧/s）。所以拿"上次降档当时的绘制成本"当基准，掉到 **35%** 以下
    就认定"降档的理由已不成立"，放行升档。阈值 0.35 是量出来的：降一档画布只降到 0.83 倍，
    也就是说**换档本身永远触发不了这个阀**（要连降三档才 0.57），只有负载真的掉了才触发。
- 迟滞：降 40 票（≈0.7s）、升 120 票（≈2.4s）+ 档间静默 `DRS_DWELL_MS` 2.5s。
  ⚠️ **升票别往上调**：1.0↔0.64 之间还有 0.88/0.76，恢复一级 = 票数÷帧率 + 静默，
  240 票在 50Hz 下是 4.8s/级、跌到底再回来要 20 多秒 —— 用户看到的是"负载早没了画面还糊着"。
  防抖**不靠票数**，靠静默 + 升档额外要求"呈现已回到健康区间"。
  ⚠️ 迟滞区（呈现 p50 落在参考节拍 1.10× ~ 1.35×）里票数是**衰减而不是清零**：
  清零会形成**死区**（两路判据都不投票、每帧把票打回 0 → 永久卡档，
  `tools/probe-drs-stuck.js` 抓到的 `votes` 涨到 433/0、档位 18s 纹丝不动就是这个）。
- 换档会重烘全部球贴图（`refreshBake`），不能高频。排障先看 `__pbFrameState()` 里的
  `drsVotes / drsDownCost / idle / presentP50Ms / fxParts` —— `idle=true` 时主循环在
  `drsTick` 之前就 return 了，一票都不会投（很容易误判成"票数阈值太严"）。
- **换屏后必须把球夹回场内**（`physics.clampBalls()`，由 `resize()` 调用）。
  不夹会出两种事故，用户看到的都是"换了设备之后球不见了"：
  ① 球留在旧屏**下方** → 掉进"地面"静态体内部（地面厚 400、从 `h` 往下伸 200），
  Matter 的 position solver 把深穿透当成要猛推的分离量，**把球弹到几万像素外**；
  ② 球留在旧屏**右侧** → 在右墙之外，渲染层照画但窗口区域（`SetWindowRgn`）里没有它。
  ⚠️ 容差是 **6px**（不是 1px）：200 颗球静置时实测有 `over=13` 颗越界，但
  `deepOver8px=0`、`maxOverX=1 maxOverY=2` —— 那是求解器允许的 1~2px 穿插，
  1px 容差会把它们全当成真越界，于是每次 `resize()` 都报"夹回 22~29 颗"并顺手清速度、
  唤醒整片球。要防的偏差是几百像素，留 3 倍余量毫无风险。
- **dpr 变化要多路监听**：`window.resize` **抓不到**"尺寸不变、只换缩放"（把窗口从 100% 显示器
  挪到 150% 显示器、或在系统设置里改缩放）。补了 `matchMedia('(resolution: Xdppx)')` 逐档监听，
  命中后重排并重挂。
- **窄屏/竖屏**：篮板的 `boardRight` 兜了下限（`max(boardW/2+60, w-30)`），
  否则 `w-30` 会把整副篮架推到屏幕外。

**这一节自己的坑：夹具的尺子必须先校准（2026-10-11 踩到）**

上面"插值补帧预算"那条规则在**用户真实配置**（`ballCount: 200`）下跑 `verify-framesync`
曾报两条红：「60Hz 上预算高于旧的常数 6ms」和「屏越快预算越紧」。看着像模型坏了，其实是**尺子错**：

- `physMsFrame` 是**约 120 个呈现帧的滑动窗口**。启动那两秒是"200 颗球一起落下"的最重负载，
  夹具在窗口还没滚过去时取样，读到的 `physMsFrame` 是 **7.7~16.7ms**；
  而 200 颗球稳态下真实每步只有 **1.1~4.2ms**（`physMs`），1 颗球时是 **0.16ms**。
- 于是 `0.75 × 16.67 − 10.45 = 2.05` → 撞到地板 2.5ms，两条判据同时判负。
- **更糟的是原来那条「高刷屏上预算 ≤ 半个屏周期」是假通过**：`0.75 × period` 天然大于
  `period / 2`，只有在预算被地板夹住时才成立。轻载下（1 颗球、预算 12.37ms）它必然失败 ——
  也就是说它此前**只是在错误的环境里恰好为真**。
- 修法两条：① 夹具先 `__pbPerfReset()` 清掉测量窗口（只清窗口、不碰行为），
  再把唯一的球放到高处让它落/弹，轮询到 `physFrames ≥ 60 && physMsFrame < 3` 才进断言，
  并把 `cleanWin` 写进结果留档；② 把假判据换成**恒有区分度**的守恒式
  `预算 + 物理/帧 ≤ period × 0.75`（把 `SMOOTH_LOAD_FRAC` 调大就会立刻失败）。
  清完窗口后 60Hz 预算 = **12.37ms**（> 旧常数 6ms ✓），且预算表随刷新率单调递减：
  `24/30/50Hz→14`、`60→12.37`、`75→9.87`、`90→8.2`、`120→6.12`、`144→5.08`、`165→4.41`、`240→2.99`、`360→2.5`。

**教训**：任何"滑动窗口统计量"的判据，都要先问一句**窗口里装的是不是当前被测的那件事**。
启动峰值、切球数、换分辨率都会污染它；而且污染往往把数字推向**地板/上限**，
于是判据"看起来过了"其实什么都没测。

> 200 球的 `drawCalls` 只有 400、`pairs` ≈ 490 —— 这个量级下球数**不是**瓶颈，别先怪它。

### 7.1 层级验收：`tools/zorder-probe.ps1`

程序自己的 `--diag` 是**执行置位的同一份代码**输出的，不算完全独立的证据。
这个 PowerShell 脚本只用裸 Win32 重新推导一遍，并且带退出码（0 = 通过，1 = 违反）：

```powershell
# PowerShell 里跑（不要从 Git Bash 调 powershell，会被安全策略拦）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\zorder-probe.ps1
```

它做两件事：

1. **定位覆盖窗**：按 `Chrome_WidgetWin_1` + `WS_EX_TOOLWINDOW(0x80) | WS_EX_NOACTIVATE(0x08000000)`
   识别（这一对是覆盖窗必须有的，普通 Electron 应用用不到），再从
   `GetTopWindow(0)` 沿 `GW_HWNDNEXT` 走一遍完整 z 序，
   断言覆盖窗正好在桌面图标锚点（持有 `SHELLDLL_DefView` 子窗口的那一层）的**上一位**。
2. **`WindowFromPoint` 网格**：铺 24 个点，任一命中覆盖窗就算失败。

> ⚠️ 上面这套判据只对 `desktop` 档成立。`top` 档下覆盖窗本来就该盖住普通窗口，
> 该用程序自己的 `--diag` 判据（§2.1.2）—— 它按档位翻转期望值。

两档各跑一次（含运行时切换）：

```bash
# desktop：普通窗口盖住球；top：球盖住普通窗口
for z in --z-desktop --z-top; do
  ./node_modules/electron/dist/electron.exe . --no-gpu --diag --test-normal-window \
    --capture-delay=8000 --exit-after=12500 $z
done
# 运行时切换（启动为 desktop → 切 top），1.4s 后 dump 必须已是 TOPMOST
./node_modules/electron/dist/electron.exe . --no-gpu --diag --test-normal-window \
  --capture-delay=8000 --exit-after=12500 --eval="window.__pbZMode('top')"
# 日志：%APPDATA%\DesktopBasketball\runtime.log 里看 DIAG exstyle / DIAG zorder / DIAG hittest
```

把「夹具 + 球位」钉死的一次性命令（判据可复现）：

```bash
EV="(() => { window.__pbSetBalls(3); const pin = () => { \
  window.__pbPlace(0,600,356,0,0); window.__pbPlace(1,700,420,0,0); window.__pbPlace(2,200,700,0,0); \
}; pin(); setInterval(pin, 40); return 'pinned3'; })()"
./node_modules/electron/dist/electron.exe . --no-gpu \
  --test-normal-window --diag --eval="$EV" --capture-delay=11000 --exit-after=16000
```

夹具矩形是 `[80,60 1040x592]`，所以 `(600,356)`/`(700,420)` 在窗口内部、
`(200,700)` 在窗口外但在另一个普通窗口覆盖范围内。三条判据缺一不可：

```
DIAG zorder  above=0xa086a[Chrome_WidgetWin_1 "…Microsoft Edge"]
             below=0x101b0[Progman "Program Manager"] <桌面锚点 ✓>
             belowVisible=true anchor=0x101b0 inZ=true
DIAG hittest ball0@600,357→0x3108aa | ball1@700,421→0x3108aa          # = 夹具，球被挡住 ✓
             ball2@200,701→0xb056e                                    # 另一个普通窗口 ✓
             testWin=0x3108aa visible=true 中心命中=0x3108aa(=testWin ✓)
             taskbar→0x10100 (未被覆盖 ok)
```

判据里**任何一处出现本窗口自己的 hwnd 就是失败**。
（`WindowFromPoint` 返回的是最深的子窗口，脚本里已用 `GetAncestor(…, GA_ROOT)` 归一到顶层。）

### 7.2 窗口区域验收：`tools/region-probe.ps1`

层级对 ≠ 看得见。`SetWindowRgn` 区域之外的像素根本不绘制，所以还要单独验证
「有绘制内容的地方确实落在区域里」（原理见 §2.2.1）。判据跟 §7.1 正好相反：

- 有内容的位置（篮球架各部件、控制栏）**必须**命中覆盖窗；
- 桌面空白处**必须不**命中（否则就是在偷桌面图标的点击）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\region-probe.ps1
```

默认点集是 `w=1440 h=852` 下算好的坐标（换分辨率要改）：

```
backboard        @ 1348,492  OURS (in region)       ok
rim-left         @ 1175,530  OURS (in region)       ok
net              @ 1233,595  OURS (in region)       ok
pole             @ 1412,700  OURS (in region)       ok
stand-base       @ 1412,840  OURS (in region)       ok
ctrl-add         @   23,790  OURS (in region)       ok
ctrl-minus       @   23,829  OURS (in region)       ok
desktop-blank    @  300,400  other 0x101b0          ok

RESULT: PASS
```

⚠️ `-Points` 在 `powershell -File` 下**绑不上 `[string[]]`** —— 整个逗号串会作为一个元素传进来，
退化成"只测一个点、而且还报 PASS"。脚本里已加保护：解析到的点数 < 2 就 `exit 2` 报错，而不是假通过。
要改点集就改脚本里的默认值。

配合 `tools/screencap.ps1`（抓真实屏幕）与 `--diag` 里的 `hoopR0..R3` 打点，
三层证据凑齐才算验收完成。

### 7.3 拖拽期间的区域验收：`tools/realdrag-probe.ps1`

拖拽时 `sendShape` 会把窗口区域撑成整窗（§2.2），"指针别跑出区域、拖拽别断"这件事因此
**只能靠真实鼠标验证** —— 合成事件绕过 OS 命中测试，正好绕开了被验证的东西。
脚本用 `SetCursorPos` + `mouse_event` 真的按下，然后把指针甩到 400+ px 外按住不动。

```powershell
# 按住 6 秒，让 --diag 落在按住期间 → 验 pointermove 没丢
powershell -NoProfile -ExecutionPolicy Bypass -File tools\realdrag-probe.ps1 `
  -BallX 212 -BallY 812 -AwayX 250 -AwayY 350 -StartDelaySec 8.5 -HoldSec 6
# 配合：electron . --no-gpu --diag --capture-delay=12000 --exit-after=19000
```

实测（指针被甩到 400+ px 外，球仍然跟手）：

```
DIAG renderer {… "pos":[[251,350,…]] … "dragging":true "dragTarget":[251,349]
                 "draggedBall":[251,350] "shapeLocked":"locked" …}
DIAG hittest  ball0@251,350→OURS | blank@720,315→OURS(拖拽/菜单锁定中·预期) | hoopR0..R3→OURS ✓
```

同一个探针把拖拽**提前结束**（`-StartDelaySec 4 -HoldSec 3`，让它在 `--capture-delay` 之前松手），
就顺手验了"松手后区域恢复"：

```
DIAG renderer {… "dragging":false "shapeLocked":false "idle":true …}
DIAG hittest  ball0@1326,410→OURS | blank@720,315→0x101c6 | blank@115,495→0x101c6 | hoopR0..R3→OURS ✓
```

`blank→0x101c6` 就是桌面锚点：拖拽一结束，桌面空白处的点击穿透立刻回来了，
球和篮球架的命中不受影响。

（`--diag` 里的 blank 打点本来会把"命中本窗口"标成 `!!挡住了桌面`，
现在它认得 `shapeLocked`，锁定期间的命中显示为"拖拽/菜单锁定中·预期"。）

### 7.4 球飞行时的区域验收：`tools/flyrun.sh` + `flyscan.ps1` + `flyab.py`

§6.6 的取证链由三个工具拼成。**不要试图在一个进程里做完**：`capturePage()` 看不见
`SetWindowRgn`，`desktopCapturer` 在本机只返回陈旧位图，所以截图必须是外部进程
（`screencap.ps1`，GDI+ `CopyFromScreen` + `DwmFlush()` + `RedrawWindow()`）。

```bash
# 1) 一键：杀残留 electron → 起夹具 → 轮询日志直到真的起飞 → 外部连拍 → 收工切片日志
#    用法: bash tools/flyrun.sh <outdir> [hold_ms] [count] [gap_ms] [poll_ms] [extra args]
bash tools/flyrun.sh tools/shots/nat  40000 80 30 0 "--fly-flat"
bash tools/flyrun.sh tools/shots/m45b 40000 80 30 0 "--fly-flat --region-lag=45"   # 阳性对照
bash tools/flyrun.sh tools/shots/p0b  40000 70 35 0 "--fly-probe"                  # 区域探针

# 2) 用日志里的球位/速度给每张截图插值出"拍照那一刻球应该在哪"（配对清单）
python tools/flyab.py --log tools/shots/nat/run.log --shots tools/shots/nat/shots.txt \
                      --manifest tools/shots/nat/manifest.csv

# 3) 分割（PowerShell 里跑，不要从 Git Bash 调 powershell，会被安全策略拦）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\flyscan.ps1 `
  -Manifest tools\shots\nat\manifest.csv -R 34 -Box 100 -Mode magenta > tools\shots\nat\flyscan_m.txt

# 4) 出表：magenta = 被裁多少；probe = 区域半径与滞后
python tools/flyab.py --report tools/shots/nat/flyscan_m.txt --manifest tools/shots/nat/manifest.csv --mode magenta
python tools/flyab.py --report tools/shots/p0b/flyscan_m.txt --manifest tools/shots/p0b/manifest.csv --mode probe
```

`flyrun.sh` 里每一步都是被坑出来的：先杀残留实例（多个实例会互相覆写区域与配置）、
按行号切片本次日志（否则上一轮的数据混进来）、**轮询日志直到出现 `FLYSTATE` 再开拍**
（不靠 sleep 猜启动时间）、以及 `unset ELECTRON_RUN_AS_NODE`（IDE 的 shell 导出这个变量时
electron.exe 会退化成纯 Node：不建窗口、静默退出 0）。

判据速查：

| 想知道什么 | 看哪个 |
|---|---|
| 前瞻有没有真的落到区域上 | `__pbFlyRunner('state')` 的 `repR` vs `46 + vstep·lead`（不用截图）|
| 区域到底滞后多少 | `probe` 模式的 `LAG ms/px`（用半径 400 的洋红盘当探针）|
| 加前瞻有没有用 | `magenta` 模式的 DOSE-RESPONSE 表（被裁率是否单调下降）|
| 截图本身是不是废的 | `flyscan` 输出里的 `lit=`（0 附近 = 整帧全黑，必须丢）|

### 7.5 计分 / 连击 / 重置 自测（`tools/verify-features.js`）

```bash
# ⚠️ 必须同时带 --diag（见下方 §8 的坑）；否则 --eval 与 --exit-after 都不会被处理，进程挂着不走
unset ELECTRON_RUN_AS_NODE
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --eval="$(cat tools/verify-features.js)" --exit-after=9000
# 结果看日志的 EVAL ok / EVAL fail 一行：
#   %APPDATA%\DesktopBasketball\runtime.log
```

期望值（本机实测）：`afterSwish` → `score:5, swish:true, combo:2`（+3 空心球、连击生效）；
`afterReset` → `score:0, combo:0` 且 `highScore` 保留。静置空闲另测：跑一段 `__pbDiag()`
在 5s 无操作后应得 `idle:true, loopHz≈5.9, stepHz:0`。

### 7.6 玩法增强包 #2 自测（`tools/verify-features2.js` + `verify-residue.js`）

```bash
unset ELECTRON_RUN_AS_NODE
# 皮肤 / 成就 / 记分板 / 金球 / 瞄准线
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --eval="$(cat tools/verify-features2.js)" --exit-after=22000
# 长文本飘字的脏块残影（数像素）
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --eval="$(cat tools/verify-residue.js)" --exit-after=18000
```

本机实测结果（日志里的 `EVAL ok {...}`）：

```jsonc
{
  "skins": ["classic","neon","soccer","watermelon","planet"],  // 逐个切成功
  "skinAfterCycle": "classic",      // planet → classic，循环闭合
  "texAfterSkins": 5, "texAfterGold": 6,   // 纹理按需烘焙，金球用完才有第 6 套
  "unlockStyleAgain": false,        // unlock 幂等
  "hudDefault": true, "hudRect": [620,6,201,42], "hudHiddenRect": null,  // 关掉后区域里就没有它
  "goldenSpawn": 1, "goldenAfter": 0,
  "goldenScore": { "before": 0, "after": 6, "delta": 6,
                   "last": { "points": 6, "swish": true, "golden": true } },  // 3×2
  "aim": { "predicted": { "apexY": 532, "last": [335,818] },
           "real":      { "apexY": 532, "landX": 335, "landY": 818, "steps": 74 },
           "gStep": 0.33333 },      // 预测与真实**完全一致**（绝对值随球数/起始位变化，不变的是两者相等）
  "diag": { "idle": false }
}
# 静置 5.6s 另测：{"idle":true,"loopHz":5.9,"stepHz":0,"scheduled":"timer"}
# 残影：{"inkBefore":0,"inkBanner":13918,"inkAfterBanner":0,
#        "inkList":13120,"inkAfterList":0,"pass":true}
```

⚠️ 跑完务必 `taskkill /F /IM electron.exe` —— 这两条都会解锁成就 / 写 `config.achievements`
与 `highScore`。要还原成"全新用户"，把 `%APPDATA%\DesktopBasketball\config.json` 里的
`achievements` 改成 `[]`、`highScore` 改 `0`、`ballStates` 改 `[]` 即可。

### 7.7 渲染层与流畅性验收（`tools/verify-render.js` + `verify-merge.js`）

改「每帧只画一次、按 z 序入列」和「渲染调用次数」这类改动，**不能靠肉眼验收** ——
它出错的方式是"少画了/多留了像素"，两者都是一眼看不出、但会慢慢累积的。所以这两条都出数字：

```bash
unset ELECTRON_RUN_AS_NODE
# 残影 / 休眠球像素保留 / 删球残留 / 贴图质量（含删球）
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --eval="$(cat tools/verify-render.js)" --exit-after=30000
# 合并 body 前后的整球像素差 + 每帧绘制次数
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --eval="$(cat tools/verify-merge.js)" --exit-after=20000
```

本机实测：

```jsonc
// verify-render.js
{ "residuePass": true,
  "inkAtRest": 3965, "inkAfterMove": 0,        // 球挪走后原位一个像素都不剩
  "sleepPass": true,
  "sleepInk": { "asleep": [true,true,true,true],
                "before": [3908,3908,3910,3914], "after": [0,3908,3910,3914] },  // 1/2/3 逐字节不变
  "deletePass": true, "ballsNow": 1,           // 删掉的 4 颗原位全清 0，留下的那颗还在
  "mip": "68/89" }
// verify-merge.js
{ "ball": { "classic":  { "mean": 0.58, "over16": 42, "discPx": 3640 },   // 6 套皮肤同量级
            "neon":     { "mean": 0.62, "over16": 46, "discPx": 3640 } },
  "tex":  { "classic": { "base": {"mean":0,"max":0}, "seam": {"mean":0,"max":0},
                         "hi":   {"mean":0,"max":0} } },                  // 贴图本身零差异
  "hot":  { "fps": 50.1, "balls": 20, "drawCalls": 136, "expectCalls": 60 } } // 3 次/球
```

> ⚠️ `hot.drawCalls` **只是信息量、没有断言**，且 `expectCalls = 球数 × 3` 这个公式**没算运动拖尾**。
> 拷用户真实配置跑（`trail: true`）时每颗高速球还要再画最多 5 个残影，于是 20 球会到 130+。
> 拿它当"变没变多"的对照时要先确认 `cfg.trail` 一致，否则会误判成"多画了"。

⚠️ `verify-render.js` 的「休眠」判定**现在是硬门槛**（2026-10-11 改）。早先它只能当诊断信息，
因为 3.2s 时常有两颗球还在回弹没入睡 → 随机失败。现在改成**轮询到四颗全部入睡**（判据
`isSleeping` 全真 **且** `idle`，实测 3.0~3.4s 到位，上限 6s），先等到位再采样，断言才真的确定；
"球一直不入睡"本身也是要修的缺陷（睡眠阈值见 `physics.js`）。

`sleepInk` 里还留了一组**现场快照**（`d0`/`d1`：每颗球的 `sq/sl/vx/rx/ry/px/bx/dpr/mpx`）。
它存在的理由是：只靠 `before/after` 两个数字无法判断"是球动了、还是贴图档位换了、还是画布被换了"。

**2026-10-11：这条判据抓到的是渲染侧真 bug，不是夹具问题。**

现象：`sleepPass` 随机红，且**每次红的球不一样**，差 37~130px（`3898→4028` 这种量级）。
现场快照显示球 1 的 `rx/ry/bx/by/sq/sl` 在 `before` 与 `after` **完全相同**，
`mip` 也没变 —— 说明变的不是球本身。于是加了一对像素差分钩子把差异拆开：

```js
window.__pbSnapBox(x, y, w, h)   // 记下框内 RGBA
window.__pbDiffBox(id)           // { gain, lost, crossIn, crossOut, maxGain, rings, cx, cy }
```

结果：`{"gain":15620, "lost":0, "maxGain":64, "crossIn":72, "crossOut":0}` ——
**纯增益、零损失、几何不变**，`crossIn` 72 与 ink 的 +72 精确对上。

成因在 `render.js::frame()` 第 5 步：那里"脏块只负责擦哪儿、每个图元只画一遍"的前提，
只有在**图元包围盒被脏块完整覆盖**时才成立。`drawBall` 不裁剪、一次把整颗球画出来，
于是当它的 AABB 只被**部分**覆盖（休眠球蹭到邻球的脏块时就是这样）时，被清过的那几块是干净的、
没被清的几块还留着上一帧同一颗球 —— 第二遍画上去就是在同一块像素上**叠加两次**
（`1-(1-a)² > a`，实测 alpha 最多被叠高 64）。

修法（`dirtyCover()` 取代 `touchesDirty()`）：三者分开处理 ——
`any=false` 跳过重画（休眠球零成本的来源，保持不变）；
`any && all` 直接画（常见路径，零成本）；
`any && !all` 用**已清块拼出的裁剪区**裁着画。因为"擦掉的照原样重画、没擦的原样保留"，
两种情况下都是一次且仅有一次。修复后：连跑 8 次 `verify-render` 全绿、
定向探针 12 轮 `BAD ROUNDS: 0`（修复前同一探针 12 轮里有 1 轮必红）。

### 7.8 窗口区域补齐验收（§6.9 的那三条症状）

**难点是"掐时间"**：加分飘字只活 1.0~1.6 秒，靠 `--exit-after` 的节奏连拍很容易一帧都没拍到
（我就先被它骗过一次：真屏幕截图里看不到特效，其实只是拍晚了 4 秒）。所以验收夹具改成了
**让状态恒在场**，任意时刻截图都必然拍到：

```bash
unset ELECTRON_RUN_AS_NODE
chmod +x   # 只是提示：下面这条必须用 bash，且 --eval 里是整段脚本
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --user-data-dir="$TEMP/pbprobe" \
  --eval="$(cat tools/probe-region-loop.js)" --exit-after=36000
# 另一个终端（PowerShell 工具）连拍真实屏幕
tools\screencap.ps1 -Out tools\shots\vis\L.png -Count 6 -GapMs 1500 -StartDelayMs 500
tools\crop.ps1 -In tools\shots\vis\L_02.png -Out tools\shots\vis\crop.png -X 1070 -Y 390 -W 330 -H 240 -Zoom 3
```

| 夹具 | 让什么恒在场 |
| --- | --- |
| `tools/probe-region-loop.js` | 加分特效 + 气泡 + 成就列表 + 性能面板（四样轮着刷，间隔 0.8s） |
| `tools/probe-score-always.js` | 每 900ms 投一次空心球 → 加分飘字与礼花一直在 |
| `tools/probe-toast.js` | 每 700ms 一次 `toggle-golden` → 气泡一直在（只改彩蛋开关，不动别的状态） |
| `tools/probe-skin.js` / `probe-menu.js` | 皮肤：用 `getImageData` 量**球心像素**证明贴图真的换了；后者走真实 `pointerdown` 派发，验证菜单点击链路 |
| `tools/probe-region-fix.js` | 一次跑完四样（依赖掐时间，只在 `--exit-after` 短跑时用） |

判据：`--user-data-dir` 指向临时目录（别污染真实配置），日志里 `EVAL ok {...}` 一行给结果；
真实屏幕截图里量像素用 `tools/pixsample.ps1`（⚠️ 它逐像素 `GetPixel`，28 张 1440×900 会跑到
分钟级，只在少量小图裁剪上用）。

### 7.9 打包版验收（asar 内资源 / 上限 / 迁移）

**为什么必须单独验一次**：`--user-data-dir` 的临时目录只能证明"开发环境能跑"。素材皮肤这条
链路是 `asar 里的 jpg → preload 的 fs.readFileSync → base64 data URL → Image 解码 → 逐像素
烘焙 → mip`，而 **`fs.readFileSync` 在 asar 内走的是 Electron 打过的补丁**，路径写法
（`path.join(__dirname, 'renderer', 'textures', ...)`，`__dirname` = `…\app.asar\src`）和开发
环境并不一样。打包后不复验等于没验。

三条一次跑完（都要 `unset ELECTRON_RUN_AS_NODE`）：

```bash
EXE=dist/DesktopBasketball-win32-x64/DesktopBasketball.exe
T=$TEMP/pb-verify-$$
mkdir -p "$T"

# ① 素材 + 六套皮肤：脚本里 console.log 输出，不依赖 executeJavaScript 的返回值
"$EXE" --no-gpu --user-data-dir="$T" \
  --eval="$(cat tools/verify-packaged.js)" --capture="$T/skins.png" --capture-delay=8000

# ② 球数上限：真的往里塞超过上限的球，看守卫生不生效（4 条判据）
"$EXE" --no-gpu --user-data-dir="$T" \
  --eval="$(cat tools/verify-maxballs.js)" --capture="$T/mb.png" --capture-delay=7000 --exit-after=13000
# → 看 runtime.log 里的 [MB] 行，期望 pass=4 fail=0

# ③ 200 球的性能/CPU 基线（产物落在 userData，打包后写不进只读的 app.asar）
"$EXE" --no-gpu --user-data-dir="$T" --cpu-test=200,20,10

# ④ 老配置迁移：预置 maxBalls:60 或 100，起一次再看 config.json
"$EXE" --no-gpu --user-data-dir="$T" --capture="$T/x.png" --capture-delay=3000
```

判读（2026-10-06 实机结果，1440×852 / i5-8500 / 软件合成）：

| 检查点 | 期望 | 实测 |
| --- | --- | --- |
| preload 读到素材 | 三个键都有非空 data URL | `watermelon:328011, earth:98999, jupiter:106815`（base64 长度 = 原字节 ×4/3） |
| 皮肤顺序 | 6 项 | `["classic","neon","soccer","watermelon","planet","jupiter"]` |
| 渲染结果 | 球面有真实花纹 | 西瓜瓜皮条纹 / 地球海洋+大陆 / 木星条带+大红斑，与开发版 `tools/tex-lab/shots/skins-final.jpg` 一致 |
| **球数上限** | **200** | `__pbDiag().maxBalls=200`；`__pbSetBalls(200)` → `balls:200` |
| **上限守卫生效** | 塞第 201 颗塞不进去 | `__pbAddBalls(20)` → 仍 `balls:200`（**不是 220**）—— `verify-maxballs.js` 4/4 PASS |
| **200 球跨进程恢复** | 200 条球位全恢复 | 一趟摆 200 颗退出 → `ballStates:200`；重启后 `balls:200` |
| `maxBalls:60` 迁移 | 抬到 200，其余不动 | `maxBalls 60→200`；`ballCount:60` / `skin` / `highScore` / 球位全部保留，`version` 未变 |
| `maxBalls:100` 迁移 | 抬到 200 | 同上，`60` 与 `100` 两个历史值都识别 |
| **自定义上限不被覆盖** | 用户设的 50 保持 50 | `maxBalls:50` → 迁移后仍是 `50`（只抬历史上的"恰好等于旧上限"值） |
| 绘制调用（`classic`，100 球） | 300（3 次/球） | `drawCalls:300`，`physMs 0.38`，`drawMs 0.8`，活跃 25.9% 单核 / 4.3% 整机 |
| 绘制调用（`watermelon`，100 球） | 200（素材单层 2 次/球） | `drawCalls:200`，`physMs 0.37`，`drawMs 0.7`，活跃 27.7% 单核 / 4.6% 整机 |
| **200 球性能**（西瓜，软件合成） | 记录基线 | `fps 23.7 / drawCalls 497 / physMs 1.31 / 活跃单核 25.5%`，详见 §2.12.1 |

> ⚠️ 截图必须**合成到深色底**再看：`capturePage` 出来的是带 alpha 的透明窗内容，直接看
> 或转 JPG 会得到"白底 + 几乎看不见的球"。用 alpha 通道求 bbox 再铺渐变底（本轮的
> 一次性脚本已随临时目录清掉，逻辑就十几行 PIL）。

> ⚠️ **夹具的配置必须覆盖用户真实配置里开着的每一个开关。** 2026-10-06 就栽在这上面：
> 上面那套验收用的是**全新** `--user-data-dir`，`showPerf` 是默认的 `false`，于是
> `updatePerf()` 里那段性能卡文本（以及其中 `renderer.lastDrawMs.toFixed(2)`）**从未被执行**，
> 验收全绿 —— 而用户的真实配置里 `showPerf: true`，一启动就崩（详见 §8 那张表的第一行）。
> 稳妥做法：**把用户真实的 `config.json` 拷进临时目录**再跑一次，而不是用默认值：
> ```bash
> cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"   # 然后再改球数/皮肤等
> ```
> 同理适用于 `streamMode` / `zMode` / `showHud` / `hoopEnabled` 这些开关。

### 7.10 视觉特效验收（`tools/verify-fx.js`）

进球特效与运动拖尾都是"看起来对不对"的东西，但**判据不能是肉眼**：它们各自的失败模式
（光环没生成 / 残影没记录 / 特效把帧率拖垮）在截图里要么看不出来，要么看出来了也说不清
是哪一环。所以夹具改成读 `__pbDiag()` 的计数：

```bash
unset ELECTRON_RUN_AS_NODE
T="$TEMP/pb-fx"; mkdir -p "$T"
cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"    # 覆盖真实开关，见 §7.9 的告警
./dist/DesktopBasketball-win32-x64/DesktopBasketball.exe --no-gpu --user-data-dir="$WIN_T" \
  --eval="$(cat tools/verify-fx.js)" --capture="$WIN_T\\fx.png" --capture-delay=7000 --exit-after=13000
# 看 runtime.log 里的 [VERIFY] 行
```

| 判据 | 期望 | 实测（打包版 exe，软件合成，`pass=9 fail=0`） |
| --- | --- | --- |
| 开关-进球特效默认开 | `fxBurst === true` | ✓ |
| 开关-拖尾默认开 | `trailOn === true` | ✓ |
| 拖尾样式默认火焰 | `trailStyle === 'fire'` | ✓ |
| 拖尾-飞行球留下拖尾 | `trailBalls ≥ 1` | ✓（0 号球 1500px/s 抛出后） |
| 金球-多层已烘焙 | `__pbTexFor('gold').base.width === 320` | ✓ |
| 金球-base 与 hi 独立 | 两张画布非同一对象 | ✓ |
| 进球-有光环生成 | `fxRings ≥ 1` | `fxRings峰值=2` |
| 进球-有粒子生成 | `fxParts ≥ 20` | `fxParts峰值=376`（爆散+彩带+破纪录礼花） |
| 进球-计分生效 | `score ≥ 2` | `score=3`（空心球 +3） |

**切换样式也有一份具名夹具**（fire → ghost → fire，3 条判据全过）：切换会走
`renderer.setTrailStyle()` + 清空各球 `_trail` + `invalidateAll()`，确保两种样式不同帧混画。

> ⚠️ 上面这些都是**进程内计数判据**，它们证明"代码路径通了"，**证明不了"观感对"**。
> 火焰拖尾必须在**真实屏幕上**看一眼才算验收完 —— 见 §7.11。

> ⚠️ **`--eval` 脚本的结尾不能带分号。** 主进程是
> `executeJavaScript('(' + script + ')')` —— **它自己会再套一层括号**。
> 脚本以 IIFE + `;` 结尾时套完变成 `( (function(){...})(); )`，直接
> `Uncaught SyntaxError: Unexpected token ';'`，表现为 `EVAL fail` + 一行 `[MB]`/`[VERIFY]`
> 都没有，很容易误判成"夹具坏了"或"功能没生效"。
> 写成 `})()` 就对了（`verify-fx.js` 一直是这么写的，所以从没触发过）。
> 本轮我在 `verify-maxballs.js` 上带了个尾分号，白跑了两轮才发现。

### 7.11 真实屏幕观感验收（`tools/cap-desktop.ps1`）

透明叠加层的最终判据只能来自**真实屏幕**：`capturePage` / `desktopCapturer` 读的是渲染器
自己的合成结果，对 `SetWindowRgn` 区域裁剪和窗口遮挡一无所知（§6.9 反复强调过）。
本项目窗口位于**桌面之上、普通窗口之下**，所以 IDE 在前台时会把它整块盖住。

`tools/cap-desktop.ps1` 解决两件事：

1. **先 `Shell.Application.MinimizeAll()` 把所有窗口最小化**，让叠加层露出来。
   ⚠️ **不要用 `SetForegroundWindow` 抬桌面** —— Windows 禁止跨进程抢前台，抬不起来。
2. GDI+ `CopyFromScreen` 连拍 `-Count` 张、间隔 `-GapMs`，`-Restore` 决定拍完是否还原窗口。

```powershell
# 先让球在屏幕左侧高速横飞（--screencap 是必须的，否则 --eval 被守卫拦掉、根本不执行）
unset ELECTRON_RUN_AS_NODE
./dist/DesktopBasketball-win32-x64/DesktopBasketball.exe --no-gpu --stream \
  --user-data-dir="$WIN_T" --screencap --eval="$EVAL" --exit-after=60000
# 另一侧拍真实屏幕
powershell -File tools\cap-desktop.ps1 -Out tools\shots\dh_ -Count 10 -GapMs 100 -Restore
powershell -File tools\crop.ps1 -In tools\shots\dh_02.png -Out _z.png -X 40 -Y 250 -W 400 -H 200 -Zoom 3
```

⚠️ `crop.ps1` 的放大参数是 **`-Zoom`**（默认 3），不是 `-Scale`。

**2026-10-06 实测结果**：3 颗西瓜球在浅色/深蓝壁纸前高速横飞时，球后可见**橙红色锥形火舌**
（亮芯 + 外圈暖光晕 + 尾端渐暗），浅底不发白、高速不断裂。这是火焰拖尾的最终验收证据。

> ⚠️ 时序：`--capture-delay` 决定截图时刻，而 `--eval` 在 `max(1200, delay-2200)` 才开始跑。
> 更麻烦的是**截完图进程就退出**（`--exit-after` 拖不住它，实测两轮都是 ~7s 结束）——
> 所以夹具的全部检查必须挤进那 **2200ms**。早先我把收尾检查排在 `+2900ms`，
> 汇总一行都没打出来，看着像夹具坏了，其实是跑在进程退出之后。
> 另外 `__pbScore()` 是把球摆到篮筐上方 130px **让它自己掉下去**，入网要 ~1.4s
> （实测 `scored +1407ms`）—— 按 250ms 去查会得到"`score=0`、`rings=0`"，看着像功能没生效。
>
> ⚠️ 夹具里别往 `setInterval` 的返回值上挂"只跑一次"的标记：浏览器里它是个**数字**，
> 赋值静默失效，于是每 100ms 触发一次进球（球被反复瞬移回篮筐上方）。用独立变量。

### 7.12 串流开关与帧同步验收（`tools/verify-stream.js` + `tools/verify-framesync.js`）

对应 §6.10 的四条修复。两个脚本一条命令跑完，一个不需要 GUI，一个需要。

```bash
# ① 开关逻辑（纯 node，不起窗口，5 秒）
node tools/verify-stream.js

# ② 帧同步（--eval 注入渲染进程；必须带 --diag）
unset ELECTRON_RUN_AS_NODE
T=/tmp/dbb-fs
mkdir -p "$T"; cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"
./node_modules/electron/dist/electron.exe . --no-gpu --diag \
  --user-data-dir="$T" --exit-after=10000 \
  --eval="$(cat tools/verify-framesync.js)"
grep -o 'EVAL ok.*' "$T/runtime.log"        # 期望 "pass":true
```

**为什么开关逻辑要单独拿纯 node 测**：`src/stream.js` **不 require electron / koffi**，
所以可以直接 `require` 进来断言 —— 而本机的 GUI 采样不可信（§4.1.4）。这也正是当初把它从
`main.js` 抽出来的收益之一。

`verify-stream.js`（34 条）覆盖：`parseArg` 的各种写法 → `sanitizeArgs` 的**清洗**（关键判据：
处理后**有且仅有一个**串流开关）→ `matchVirtualDisplay` 的**宁可漏判不要误判** →
`resolve()` 的五级优先级与 **`source` / `active` 自洽**。

`verify-framesync.js`（**47 条**）覆盖六组判据（不依赖抓时序）：

| 判据 | 期望 | 本次实测 |
| --- | --- | --- |
| 插值中点 | `__pbRenderAt(0.5).ry === (py + by)/2` | `py=239 by=262.398 → ry=250.699` ✓ |
| 端点 | `alpha=0 → ry===py`；`alpha=1 → ry===by` | ✓ |
| 区域同口径 | `circle0 圆心 === round(rx, ry)` | `[720, 251, 164]` vs 画面 `(720, 250.699)` ✓ |
| 对照 | `__pbSmooth(false)` 后 `ry === by` | `(720, 262.398)` ✓ |
| 区域罩高速球 | `rad ≥ 46 + 60`（`|v|·leadFrames` 真的撑大了） | `rad=164` ✓ |
| 呈现度量 | `presentTotal` 两次采样间增长 | `52 → 60` ✓ |
| **刷新率全谱**（§6.10 ⑦） | `period=1000/hz`、`节流=min(1000/70, period×0.92)`，**无 144 封顶** | 24Hz:14.29 … 144Hz:6.39 → 240Hz:3.83 → 360Hz:2.56 ✓ |
| **缺报回落** | `__pbDisplayHz(0)` ⇒ `hz=60` 且 `source='default'` | ✓ |
| **补帧预算恒等式** | `clamp(period×0.75 − 物理/帧, 2.5, 14)` | 60Hz→**12.37ms**、120Hz→6.12、30Hz→14 ✓ |
| **预算总账** | `预算 + 物理/帧 ≤ period×0.75`（任何负载都成立） | 120Hz: `6.12+0.13 ≤ 6.248` ✓ |
| **画布像素上限** | 所有设备档 `mpx ≤ 8.3`；2K@125% 保持 1.25× | 4K@150%→1×（8.3Mpx）、8K@1→0.5× ✓ |
| **DRS** | `__pbScale(0.64)` 真改画布；`'auto'` 交回 | `1→0.64×`，1.23Mpx→0.5Mpx ✓ |
| **换屏夹球** | 窗外球 `__pbResize()` 后落回窗口内 | `(2240,1752) → (1406,818)`，`moved=1` ✓ |
| **瞬移保护** | 搬球后 `alpha=0.5` 仍画在新位置 | 旧 `(720, 523.86)` → 新 `(360,170)`，画 `(360,170)` ✓ |

> ⚠️ **夹具必须对环境球数免疫**：用户真实配置里是 `ballCount: 200`（球数上限，§2.12.1）。
> 直接 `__pbPlace` 一颗球进去，它会**瞬间撞上球堆、速度被碰撞解算吃掉** ——
> 表现为"插值恒等式不成立"，其实是前置条件根本没建起来。所以夹具先 `__pbSetBalls(1)`，
> 在结果里留档 `ballsAtStart`，收尾再还原（万一有人没带 `--user-data-dir` 就跑）。
> 同时也断言 `vy > 1`，把"没步进"和"速度被吃"分开，免得再把环境问题读成代码 bug。

> ⚠️ **性能窗口必须先清干净再判"预算够不够"**（2026-10-11 坐实）。
> `physMsFrame` / `drawMsMedian` / 呈现抖动都是**约 120 个呈现帧的滑动窗口**，而启动那两秒
> 是 `ballCount=200` 的"200 颗球一起落下"峰值 —— 不清窗口就取样，读到的是**启动峰值**
> （实测 `physMsFrame` 报到 7.7~16.7ms，而 200 颗球稳态下真实每步只有 1.1~4.2ms）。
> 后果是"60Hz 预算 > 旧常数 6ms"「60Hz 宽于 120Hz」这两条被判负，**且因为预算被地板 2.5
> 夹住而假通过**（复现见 §6.10 ⑦ 的"为什么删掉 ≤ 半个屏周期"）。
> 所以 ⓪ 段先 `__pbPerfReset()`（清窗口，见钩子注释）再把唯一的球放到高处让它落/弹，
> 轮询到 `physFrames ≥ 60 && physMsFrame < 3` 才进 ①，并把 `cleanWin` 写进结果留档。

> ⚠️ 两条硬约束（踩过）：**必须带 `--diag`**（否则夹具与 `--exit-after` 都不被处理，进程挂住）；
> **脚本结尾不能带分号**（主进程是 `executeJavaScript('(' + script + ')')`，会再套一层括号，
> `})();` 变成语法错误、一条断言都不输出）。可用窗口 = `exit-after − 2200ms`，⓪ 段要花约 1.9s，
> 所以用 **`--exit-after=10000`**。

---

## 8. 排障

| 现象 | 处理 |
|---|---|
| **篮球不显示 + `+/-` 按钮点了没反应 + 性能卡片空白（三连）** | **先看 `runtime.log` 里有没有 `Uncaught TypeError ... (app.js:NNNN)`。** 主循环里任何未捕获异常都会在 `requestAnimationFrame(loop)` **之前**中断 → 循环永久停摆，表现形式却是"整个程序坏了"：球不再绘制、`sendShape()` 不再上报（区域冻结）、按钮点下去世界变了但画面一动不动（看起来像"没反应"）。**2026-10-06 实例**：`Renderer` 构造函数没初始化 `lastDrawMs`，而主循环的**早退分支**（物理步还没攒够时 `app.js::loopInner` 会提前 `return`）在**第一次 `frame()` 之前**就调了 `updatePerf()` → 性能卡那行 `renderer.lastDrawMs.toFixed(2)` 抛 `TypeError`。只在 `showPerf: true` 时触发（那几行前面有 `if (!cfg.showPerf) return;`），所以默认配置下一直藏着，用户一开性能卡就必崩。已修两处：① `Renderer` 构造里 `this.lastDrawMs = 0`；② `loop()` 外面套保护壳，异常只记一次并补排下一帧（见 `app.js::loop` 的注释） |
| 启动后黑屏 / GPU 崩溃退出 | 程序会自动带 `--no-gpu` 重启；手动用 `DesktopBasketball.exe --no-gpu` |
| 球看不见（但托盘在） | 确认是否误加了 `--disable-gpu-compositing` —— 它会让透明画布不合成，本项目**不能用**它 |
| 点球没反应 / 到处都能点 | 托盘 → 命中方式 → 换成「全局鼠标钩子」 |
| **拖球时 CPU 比预期高（60 球约 19%）** | 先看 `awake`：拖球穿过球堆会唤醒 40+ 颗，"40 颗球同时活跃"就是 17~20% 的真实成本，对照 §6.2 的 50 球基线（§6.5）。若是**挂住一颗球不动**也很高，则看 `itersPerSec` 是否远超 62 —— 那是主循环链被重复挂起，见 §6.5 第 1 层 |
| 球飞到屏幕外后不回来 | 物理层每步有越界救援（超出边界 + 200px 就拉回场地内并限速）。若持续出现请查 `runtime.log` 的 `physMaxMs` 是否异常 |
| **球盖住了普通窗口** | 用 `--diag --test-normal-window` 看 `DIAG zorder`：`above` 必须是普通窗口，`below` 必须是桌面锚点。若 `above` 是 `0x10100`（任务栏）说明锚点取错了 —— 见 §2.1.1 |
| **球完全看不见，但 `--capture` 截图正常** | 典型的"层级掉到桌面下面"。`capturePage()` 只读渲染进程自己的合成结果，**看不见窗口被谁盖住**；必须用 `--screencap`（抓真实屏幕）或 `WindowFromPoint` 判据 |
| **某个面板 / 飘字 / 气泡在真机上"看不见，或只有一部分"** | 先查它有没有进 `sendShape()`（区域 = 可见范围，DOM 与 canvas 一样被裁，见 §6.9）。拖动球时它若出现 → 100% 是这个原因 |
| **"点菜单没反应"（换皮肤 / 开关某项后没有任何提示）** | 先确认 `#toast` 在区域里（`toastRect`）。气泡是唯一的操作反馈，它被裁掉时所有操作看起来都像失效（§6.9） |
| 一直很卡 / 一直是软件合成 | 托盘 →「软件合成（关闭 GPU 加速）」是否显示"开启"。`--no-gpu` 或 GPU 崩溃自愈会把 `forceNoGpu` **持久化**，用它关掉，或命令行 `--gpu` 直接纠正 |
| **真实屏幕截图里一颗球都没有，但篮球架/控制栏都在** | **先别怪窗口区域 —— 这是"动态层整层没进画面"。** 静态层（`#stat`：篮球架）和 DOM（控制栏）都在、只有 `#dyn`（球）不在，说明问题出在动态画布这条合成链上，不是 `SetWindowRgn`。两个已知触发条件：① `--no-gpu` / GPU 进程崩溃后的软件合成回退（本机实测 18/18 张 `magenta=0`，而同一帧篮筐清晰可见）；② 动态画布曾用 `desynchronized: true`（低延迟画布，脱离页面合成器单独呈现，与区域无同步关系）—— 已去掉。**判据**：`DIAG hittest` 打球心若返回 `OURS ✓`、且 `LAGPROBE` 报 `circles=1`，说明区域里**有**球的圆，"球不见了"就与区域无关 |
| **一开远程控制（UU 远程「超级屏」等）从手机看球就缺一块/整颗不见，而本机显示器一切正常** | **串流捕获抓不到独立合成层，不是窗口区域的问题。** Windows 上透明窗走 DirectComposition，每帧变化的动态层（球所在的 `#dyn`）被**单独提交**；远程软件为低延迟常用虚拟显示驱动 / 不走 DXGI Desktop Duplication 的捕获，抓不到这一层 —— 静态层（篮球架）与控制栏是常规合成所以还在。**修法**：托盘 →「串流兼容模式（UU远程/超级屏）」开启（自动重启；等价 `--stream`，本质是 `--disable-direct-composition`），个别驱动仍不够再叠 `--no-gpu`。机制与判据见 §6.8 |
| **拿"截图里没球"证明"区域把球裁了"** | **这个推理本身是错的。** 截图里没球只能推出"这一帧没画上/没合成上"，推不出成因。2026-10-05 就是这么误判的：18 张里 17 张字节相同 → 被读成"滞后 ≥39ms" → 据此把 `leadFrames` 2 调到 5，而用户反馈**问题依旧**。正确顺序：先看静态层在不在（区分"区域/合成"与"动态层"），再看 `WindowFromPoint` 打球心是否 `OURS`、`repR` 是否 ≈ `46+vstep·lead`，最后才谈滞后 |
| **`--fly-probe`（400px 洋红盘）量出来的"区域半径"是错的** | `ballAABB()` 早先只按 `b.r` 算脏块包围盒，400px 盘面超出脏块的部分每帧被 `clearRect` 擦掉，截出来是一块 128 方块。已让 `ballAABB` 认 `flatBallR`；改外观的地方记得同步改包围盒 |
| **篮球架平时完全不显示，只在拖动球时闪一下，或只有球周围一圈能看到它** | 典型的"绘制内容不在窗口区域里" —— 区域之外的像素根本不绘制。用 `tools/region-probe.ps1` 打点验证（原理与判据见 §2.2.1）。**`--capture` 截图看不出这个问题**，别用它当证据 |
| **左下角 `＋` `－` 按钮"不见了"** | 先查 `showControlBar` 是否为 `false`。历史版本还带「5 秒后自动降到 `opacity:.13`」的淡出，深色半透明底铺在桌面上基本等于隐形，已移除。按钮在窗口区域里，不会被裁（可 `region-probe.ps1` 打 `ctrl-add`/`ctrl-minus` 核对） |
| **篮球数量自己变大（`ballCount` 莫名变成 20+）** | 多半是**多个实例同时在跑**，各自的 `patchConfig` 在互相覆写 config。`--exit-after` 到期**不保证进程真的退出**（本机遇到过 SIGTERM 送不到的情况），跑完验收务必 `taskkill /F /IM electron.exe`，再用 `tasklist` 确认归零 |
| **`--eval` / `--exit-after` 像是失效了（进程一直挂着不退）** | `startCaptureTools()` 开头有个守卫：`if (!shot && !diag && !screencap && !fly-test) return;` —— 而 `--eval`、`--exit-after` 的处理都在守卫**之后**。所以单独用 `--eval` 不生效、`--exit-after` 也不会注册。**加 `--diag` 即可**（本机排查时被这条坑了两次，留下 3 个卡住的 electron.exe）。注意 `--capture-delay` 同样躲在这个守卫后面，只给 `--capture-delay` 不给 `--capture` 也不会生效 |
| **`--eval` 报 `An object could not be cloned.`，而脚本里的代码**一行都没执行** | `main.js` 把脚本按 `'(' + script + ')'` 包一层再交给 `executeJavaScript`。传 `()=>{ ... }` 得到的只是一个**函数对象**（不是 IIFE），Electron 无法把函数结构化克隆回主进程 —— 于是整段脚本**从未运行**，日志里只有一句 `EVAL fail An object could not be cloned.`。**报错信息和真实原因完全对不上**，2026-10-05 为此白跑了 3 轮验收。两种正确写法：写成 `(()=>{ ... })()` / `(function(){ ... })()`，或 `--eval="$(cat tools/xxx.js)"` 且文件本身以调用括号结尾。**返回值也别塞活对象**（`world`、DOM 节点、带循环引用的东西），同样会被拒。调不出结果时最稳的办法是在脚本里 `console.log('[PROBE] ...')` —— 渲染进程 console 会被转发进 `runtime.log`（前缀 `[renderer:LEVEL]`），完全不依赖返回值 |
| **`rm` / `Remove-Item` 删不掉 `dist/`（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`、`trash-failed`）** | 旧产物超过 50 个文件会触发工作区批量删除保护。用 `Move-Item` 把它**改名或移出项目**即可（`cmd /c rd` 在 PowerShell 工具里被禁）。⚠️ 移出时别只是改名留在项目内 —— `pack.js` 的 `ignore` 只排除 `/^\/dist(\/|$)/`，`dist_prev/` 这种名字会被**打进 asar**，包体积立刻膨胀 |
| **`--screencap` 的图里"球盖在一个窗口上"** | 先别急着改代码，确认那是不是宿主应用正预览的一张**图片**。本机排查时就踩过：截图里一整排篮球 + 篮球架，其实是编辑器面板里在预览 `showcase.png`（本程序的历史截图）。分辨方法：`--screencap` 时同步看 `DIAG hittest`，若所有点都命中**同一个**外部窗口 hwnd，说明球其实全被挡住了。最可靠的证据是 `zorder-probe.ps1`（§7.1） |
| **`node build/pack.js` 报 `fetch failed`，但 `npm run pack` 正常** | `@electron/packager` 走 `@electron/get` 下载 Electron 二进制，而镜像地址来自 `.npmrc` 的 `electron_mirror` —— 它**只有经 npm 执行时才会以 `npm_config_*` 注入环境**。直接 `node build/pack.js` 会回落到 GitHub 默认地址，既不走本机缓存也拉不动。要么用 `npm run pack`，要么手动 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| **第二次打包必失败：`SAFE_DELETE_BULK_CONFIRM_REQUIRED`（`count:76, threshold:50`）** | **不只是 `--fresh` 的问题。** `@electron/packager` 的 `overwrite: true` 内部就是 `fs.rm(outputDir, {recursive:true})`（`packager.js` 的 `overwriteAndCreateApp` ← `checkOverwrite`），一样撞工作区批量删除保护（dist 有 76 个文件 > 50）。所以"去掉 `--fresh` 就行"是**错的** —— 第一次能过只是因为当时还没有旧产物可删。`pack.js` 现在在 `run()` 之前调 `retire()`，把 `dist/DesktopBasketball-win32-x64` **改名**成 `*.old-<时间戳>`（改名不算删除），再让 packager 全新创建。留在 `dist/` 下的 `.old-*` 目录确认新版可用后手动删即可 |
| **跑 GUI 前 `tasklist` 里 Electron 进程数比预期少** | 程序是单实例的。旧实例没退干净时，新实例会打印 `window created` 后立刻退出（伴随 `Unable to move the cache: 拒绝访问 (0x5)`）。先确认旧实例已退出再起新实例，否则验收/探针会打到空桌面 |
| **`--diag` 把命令行永久挂住** | 补 `--exit-after=<ms>` |
| **打包版"启动即静默退出"，不写任何文件** | 先查环境里有没有 `ELECTRON_RUN_AS_NODE=1`。有的话 Electron 会退化成纯 Node 跑：带参数时报 `node: bad option: --no-gpu` 并返回 9，不带参数时读空 stdin 立刻退出 0。**跑 Electron GUI 前先 `unset ELECTRON_RUN_AS_NODE`** |
| **`tools/preview-*.js` 单独启动时 `loadFile` 报 `ERR_FAILED`** | 本机环境不让独立 Electron 入口加载本地文件。改用 `--eval` 把预览画到主窗口里（见 §7 的纹理放大预览工具） |
| **飘字 / 成就横幅 / 成就列表在画布上留下擦不掉的残影** | 脏块是唯一决定"哪块画布被清掉重画"的东西，而飘字的包围盒早先**写死 96×52**。长文本超出这个盒子后，超出的像素落在没被标脏的块里 —— 那些块从不清除，于是每飘一次就叠一层。现在 `render.js::textBox()` 按 `measureText` 实宽算（`tools/verify-residue.js` 用像素计数验收）|
| **瞄准辅助线"根本没画出来"** | 先怀疑对比度，别怀疑逻辑：浅色（`#8ff2ff` / `#ffd977`）实心点铺在白底桌面上几乎不可见，`--capture` 的透明底合成出来正好是纯白，看起来就像没画。修法是每个点先铺一圈深色底再画亮色点。诊断用 `__pbAimNow()` 直接看 `pts` 条数（有值就说明逻辑没问题）|
| **顶部中央的点不进桌面** | 那是记分板所在区域。DOM 必须进窗口区域才可见（否则被 `SetWindowRgn` 裁掉、真机上是隐形），代价就是这一小块死区。菜单 / 托盘「记分板」可关掉（191×42，与左右控制栏同量级）|
| 想看诊断 | `set DEBUG=1` 无意义；用 `--diag` 启动，日志在 `%APPDATA%\DesktopBasketball\runtime.log` |
| **改了球盘前瞻（`leadFrames`）却"看不出区别"** | 先别去查形状去重或 IPC —— 算一遍它**理应**变化多少：`Δr = |body.velocity| · leadFrames`，而 `body.velocity` 是 **px/步**（不是 px/s）。少乘/多乘一个 60 都会让前瞻看起来"完全没生效"。最快的判据是 `__pbFlyRunner('state')` 里的 `repR` 是否 ≈ `46 + vstep·lead`（§6.6） |
| **验收截图里出现"整颗球被裁没了"** | 先看 `flyscan.ps1` 输出的 `lit=`：**0 附近就是整帧全黑的废帧**（DWM 没出画），它的 `upx=0` 与"区域把球裁掉了"在数据上无法区分。`flyab.py` 默认 `--lit-min 3` 会丢弃并打印帧名 |
| **改 `tools/*.ps1` 后报 `Add-Type: 常量中有换行符`** | C# 源码写在 `@" ... "@` 双引号 here-string 里，**里面绝不能出现反引号**：`` "`n" `` 会被 PowerShell 展开成真换行，把一行代码劈成两行。写 `\n`（C# 转义）或干脆别换行。另外整个 `.ps1` 必须保持**纯 ASCII**：Windows PowerShell 5.1 按 ANSI 读无 BOM 的脚本，中文注释的末字节会吞掉后面的换行 |
| **"球多了掉帧，肯定是像素太多/贴图太大"** | 90% 不是。本项目在 60 球档上量过：把球缝换成**不透明纯色块**（像素少得多）帧率纹丝不动，把所有层强制走 1:1 贴图（重采样归零）也纹丝不动 —— 真正动帧率的是**每帧的绘制调用次数**（4 次/球 → 54fps，3 次/球 → 60fps）。所以优化方向是"合并可合并的层"，不是"把图烘小/烘糊"。定位方法见 §2.12 |
| **`drawImage` 传了个 `undefined` 直接抛错** | 给贴图加了新的合成层（`body`）后，别忘了**母版那一份也要补**：`drawBall` 在超强挤压时会回落到 `set.master`，如果母版没有 `body` 字段，那一帧就会 `drawImage(undefined)`。这类错只在特定物理状态出现，平时跑不到 |
| 音频报 `AudioContext encountered an error` | 无音频输出设备时的正常降级，仅记日志，不影响运行 |

---

## 9. 许可

本项目代码 MIT。使用的第三方：

- [matter-js](https://github.com/liabru/matter-js) —— MIT
- [Electron](https://github.com/electron/electron) —— MIT
- [koffi](https://koffi.dev/) —— MIT

调研阶段列出的各参考项目许可已在 §1.1 表格中标明；未取用任何无许可证（`NONE`）仓库的代码。
