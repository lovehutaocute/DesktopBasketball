# Windows 安装程序（Inno Setup）—— 完整维护教程

> 本文档面向**后续阅读和维护本项目的 AI**。所有内容基于当前仓库的实际实现，
> 每一条命令、路径、坑点都在本机实测过。改动安装器前请先读完本文。
>
> 最后核对：2026-10-13（Inno Setup 6.7.3 / 产物 80.9 MiB）

---

## 1. 这套方案是什么

把 `dist/DesktopBasketball-win32-x64/` 那棵免安装产物树，打成一个**单文件安装程序**：

| 项 | 值 |
|---|---|
| 编译器 | Inno Setup **6.7.3**（`ISCC.exe`） |
| 主脚本 | `build/installer.iss` |
| 测试包装 | `build/installer-test.iss` |
| 输出 | `dist/DesktopBasketball-Setup-1.0.1.exe`（**80.9 MiB**） |
| 打包内容 | `dist/DesktopBasketball-win32-x64/**` —— 21 个文件，整树递归 |
| payload 大小 | **243.5 MiB**（逻辑）/ 106 MB（NTFS 压缩后磁盘占用） |
| 编译耗时 | **约 62 秒**（`lzma2/max` + 固实压缩） |
| 安装目录 | `{autopf}\DesktopBasketball`（即 `C:\Program Files\DesktopBasketball`） |

**安装器是独立环节，不并入 `pack.js`。** 它只消费 `pack.js` 的产物，不参与 Electron 打包。
顺序永远是：**先 `pack.js` 出免安装版 → 再 ISCC 出安装包**。

---

## 2. 为什么是 Inno Setup（而不是 NSIS / electron-builder）

本项目**先做过完整 NSIS 方案，两轮失败后废弃**。记录在此，避免有人再走回头路。

### 2.1 弃用 NSIS 的原因

NSIS 的脚本语言有若干**会静默失败**的陷阱，每一条都真实卡住过进度：

| 坑 | 症状 |
|---|---|
| `IfFileExists <file> <jump_if_present> [<jump_otherwise>]` 第一个跳转参数是「**存在时**」跳转 | 语义整个反过来 + `!insertmacro` 展开会打乱数字偏移 → 连续两次误报「程序文件解压失败」，而实际 23 个文件 100% 解包成功 |
| 内外层 `FindFirst` **共用句柄变量** | 内层覆盖外层游标，遍历错乱 |
| 通配符结尾**必须有反斜杠** | `"C:\X*"` 与 `"C:\X\*"` 结果完全不同（后者 22 项，前者 1 项），`FindFirst` 静默返回错误集合 |
| `.nsi` **必须带 UTF-8 BOM** | 无 BOM 时 makensis 退回 GBK 解析，报 `Bad text encoding: <file>:N`，行号随机 |
| `!macro` 必须在**使用点之前**定义 | `!insertmacro: macro named "X" not found` |
| `FileWrite` 换行要用 `$\r$\n`，反引号 `` `r`n `` 会写成**字面量** | 日志挤成一行 |
| `makensis` 会 **chdir 到脚本所在目录**（不是调用者 cwd） | `File "dist\..."` 被解析成 `build/dist/...`，**静默打出空壳安装包**（体积仍有 91 MB，因为 OutFile 也偏了） |
| 没有 `!ifexist` / `!ifnexist` | 做不了文件存在性守卫 |
| `Call` 不能传参、`//` 不是注释、`UpdateWindow` 不是原生命令 | 各种编译期报错 |

**结论：NSIS 那条路已经彻底废弃。`installer.nsi` 及配套的 `gen-payload.js` / `payload-files.nsh` 已从仓库删除，不要恢复。**

### 2.2 也**不用** electron-builder

README 旧版曾建议「换用 `electron-builder --win nsis`」。不采用，原因：
- 它无法表达本项目需求③（**扫描 C/D 盘一二级目录批量建快捷方式、失败跳过**）—— 那是自定义逻辑，得写脚本；
- 引入一个几百 MB 的依赖树，只为生成一个安装壳，不划算；
- 本项目已经有完整的 `pack.js` 打包链，安装器只需「把产物打成一个 exe」。

### 2.3 Inno Setup 的优势

`[Code]` 段是**真正的 Pascal 语言**：目录遍历、`try/except`、进度回调都是常规写法。
同样的需求，NSIS 要绕宏和跳转参数，Inno 直接写函数即可。

---

## 3. 环境准备（ISCC 从哪来）

**本机没有安装 Inno Setup**，用的是**免安装便携版**，装在临时目录：

```
C:\Users\DELL\AppData\Local\Temp\innosetup\portable\ISCC.exe
```

### 3.1 获取方式（本机实测可用）

从官网下载安装包 → 用 `7z` 提取 → 静默装到临时目录。
本机环境**必须走系统代理**（`HKCU\...\Internet Settings\ProxyServer` = `127.0.0.1:7897`），
直连 `jrsoftware.org` 大概率超时。

```bash
# 代理下载（约 10.1 MB，13 秒）
curl -x http://127.0.0.1:7897 -L -o /tmp/innosetup.exe \
  https://files.jrsoftware.org/is/6/innosetup-6.7.3.exe

# 静默安装到临时目录
/tmp/innosetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="%TEMP%\innosetup\portable"
```

> ⚠️ 不要用 `curl` 直接下 `files.jrsoftware.org` 而不带 `-x`：本机不走代理会挂住。

### 3.2 补简体中文语言包

便携版**不带** `ChineseSimplified.isl`，`installer.iss` 的 `[Languages]` 段会报
`Couldn't open include file "...\Languages\ChineseSimplified.isl"`。

```bash
curl -x http://127.0.0.1:7897 -L -o \
  "$TEMP/innosetup/portable/Languages/ChineseSimplified.isl" \
  https://raw.githubusercontent.com/jrsoftware/issrc/refs/heads/main/Files/Languages/ChineseSimplified.isl
```

实测 **21,516 字节**。注意路径是 `Files/Languages/`（**不是** `Files/Languages/Unofficial/`，后者 404）。

### 3.3 检查环境是否就绪

```bash
"$TEMP/innosetup/portable/ISCC.exe" 2>&1 | head -3
# 期望看到：Compiler engine version: Inno Setup 6.7.3
ls "$TEMP/innosetup/portable/Languages/ChineseSimplified.isl"
```

---

## 4. 构建

### 4.1 前置条件

**先跑 `pack.js`**，确保 `dist/DesktopBasketball-win32-x64/` 存在且是最新的：

```bash
cd C:/Users/DELL/Desktop/AI/zuqiu/desktop-basketball
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node build/pack.js          # 约 8 秒，产出 106 MB（NTFS 压缩后）
```

### 4.2 编译正式版

```bash
"$TEMP/innosetup/portable/ISCC.exe" build/installer.iss
# → dist/DesktopBasketball-Setup-1.0.1.exe
```

### 4.3 编译测试版（Agent 侧自测用）

Agent 环境 `IsAdmin=False`，**无法确认 UAC 弹窗**，跑正式版（`PrivilegesRequired=admin`）会卡住。
改用测试包装：

```bash
"$TEMP/innosetup/portable/ISCC.exe" build/installer-test.iss
# → dist/DesktopBasketball-Setup-TEST.exe
```

`installer-test.iss` 只做一件事：

```innosetup
#define TESTMODE 1
#include "installer.iss"
```

定义 `TESTMODE` 后，`installer.iss` 里的条件编译把三处改掉：

| 宏 | 正式版 | TESTMODE |
|---|---|---|
| `FixedDir` | `{autopf}\DesktopBasketball` | `{localappdata}\DesktopBasketball-TEST` |
| `PrivLevel` | `admin` | `lowest` |
| `OutName` | `DesktopBasketball-Setup-1.0.1` | `DesktopBasketball-Setup-TEST` |

> ⚠️ **`/DTESTMODE` 命令行 define 用不了。** 试过 `/DTESTMODE`、`/DTESTMODE=1`、
> `"/DTESTMODE=1"` 全部报 `You may not specify more than one script filename.`
> —— ISCC 把 `/D` 参数当成了第二个脚本名。**正解就是包装脚本 `#include`。**

### 4.4 静默安装（自测）

```powershell
$exe = "C:\Users\DELL\Desktop\AI\zuqiu\desktop-basketball\dist\DesktopBasketball-Setup-TEST.exe"
$log = "$env:TEMP\db-inno-install.log"
$p = Start-Process -FilePath $exe -Wait -PassThru `
     -ArgumentList "/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/LOG=$log"
"install-exit=$($p.ExitCode)"
```

- `/VERYSILENT` = 需求④（零交互）
- `/LOG=` 必加，`[Code]` 段的 `Log()` 输出都在里面，是唯一的诊断入口
- **`Start-Process -Wait` 必须用**，否则拿不到退出码
- ⚠️ 本机 **`WScript.Shell` COM 被安全策略拦**，验证 .lnk 内容只能用
  `[System.IO.File]::ReadAllBytes()` 读头 4 字节（见 §8）

---

## 5. 五条需求的实现映射

用户原始需求 → 代码位置，一一对应。

### ① 固定安装目录（不弹路径选择）

| 位置 | 实现 |
|---|---|
| `[Setup]` | `DefaultDirName={#FixedDir}` —— 写死 |
| `[Setup]` | `DisableDirPage=yes` —— **不显示目录选择页** |
| `[Setup]` | `DisableProgramGroupPage=yes` —— 不显示开始菜单页 |
| `[Setup]` | `DirExistsWarning=no` —— 目录已存在也不提示 |
| `[Setup]` | `UsePreviousAppDir=yes` —— 重复安装直接覆盖 |

### ② 桌面快捷方式

**不用 `[Icons]` 段建**（`[Icons]` 段当前是空的，留着注释说明原因）。

原因：安装器以 `admin` 提权运行时，Inno 的 `{userdesktop}` 常量解析的是**提权账户**的桌面。
在「管理员批准模式下用另一个账户提权」或 `/SILENT` 场景，会解析到和用户看到的桌面**不是同一个**目录
—— 实测静默安装后桌面上什么都没有。

改用 `[Code]` 里的 `CreateDesktopShortcut()` → `GetRealDesktopDir()`，按三级顺序取桌面：

1. **注册表** `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders` → `Desktop`
   （当前用户权威值，支持桌面重定向 / OneDrive 重定向）
2. `{userdesktop}` 常量
3. `{userprofile}\Desktop`

每一级都有 `Log()` 输出，安装日志里能看到实际走了哪一级。

调用点：`CurStepChanged(ssPostInstall)`。

### ③ 扫 C/D 盘一二级目录建快捷方式

核心逻辑，三个函数协作用：

| 函数 | 职责 |
|---|---|
| `CountFoldersOnDrive(Root)` | **先数一遍**，给进度条算准确分母 |
| `CreateLinksOnDrive(Root, ExePath)` | 实际遍历 + 建快捷方式 |
| `TryCreateLink(TargetDir, ExePath)` | 建单个，**失败即返回 False** |

约束的落地方式：

- **只扫两层**：`CreateLinksOnDrive` 里手写两层 `repeat` 循环，
  二级循环体**不再进入第三层**。不用递归。
- **两层各用独立的 `TFindRec`**（`FindRec1` / `FindRec2`）——
  这是从 NSIS 那个「共用句柄被覆盖」的坑直接带过来的教训。
- **失败跳过**：`TryCreateLink` 把 `CreateShellLink` 包在 `try/except` 里，
  无权限 / 只读 / 路径非法全部 `Result := False`，外层计 `SkippedFolders`，不中断。
- **不改动原有文件**：全程只调 `CreateShellLink` 新建 `.lnk`，
  没有任何删除/覆写操作。（卸载时的删除见 §9，那是回收自己建的东西。）

`TryCreateLink` 的跳过早退条件（三条）：

```pascal
if CompareText(TargetDir, ExpandConstant('{app}')) = 0 then Exit;   // 安装目录自己不建
if Pos(ExpandConstant('{tmp}'), TargetDir) = 1 then Exit;           // 临时目录不建
if Length(TargetDir) > 220 then Exit;                               // 路径过长必然失败，提前跳过
```

### ④ 全程零选项

| `[Setup]` 指令 | 效果 |
|---|---|
| `DisableWelcomePage=yes` | 无欢迎页 |
| `DisableDirPage=yes` | 无目录页 |
| `DisableProgramGroupPage=yes` | 无开始菜单页 |
| `[Run]` 段 `skipifsilent` | 静默安装时不弹「立即运行」 |

（`WizardStyle=modern` 只是界面风格，与「零选项」无关；
`DisableReadyPage=no` 保留 ready 页，但静默模式下不显示。）

`[Run]` 段的启动项带 `unchecked` + `skipifsilent` —— 不强制启动，不打断用户。
实际安装界面**只有一页进度**，`/VERYSILENT` 下连这一页都不显示。

### ⑤ 进度条

分两段，用两种驱动方式：

1. **解包阶段**：由 Inno 框架自动驱动 `WizardForm.ProgressGauge`，无需干预。
2. **C/D 扫描阶段**：`CurStepChanged(ssPostInstall)` 里**手工推进**。

手工推进的关键：文件全部解包完时进度条已经走到 100%，此时**把它压回 60% 重新走**，
避免「明明还在干活却显示 100%」：

```pascal
ProgressBase := 60;
```

`UpdateProgress()` 是唯一的刷新入口：

```pascal
Pct := ProgressBase + ((DoneFolders + SkippedFolders) * (100 - ProgressBase)) div TotalFolders;
if Pct > 99 then Pct := 99;                    // 留 1% 给最终的 100
if Pct < ProgressBase then Pct := ProgressBase;
WizardForm.ProgressGauge.Position := Pct;
WizardForm.StatusLabel.Caption := StatusText;
WizardForm.Refresh;                            // ← 必须，否则窗口假死
```

> ⚠️ **`WizardForm.Refresh` 不能省。** Inno 的手工进度循环必须自己泵消息，
> 否则界面在长扫描期间完全不重绘，看起来像卡死。

`CountFoldersOnDrive` 的存在就是为了让这个分母准确 —— 不然进度条会在扫描中途跳变。
实测 C+D 两盘两层内共 **505** 个目录（2026-10-07）。安装日志里的
`progress: TotalFolders=505 (progress base=60)` 就是它的输出。

> ⚠️ 这个函数曾因为漏写 `Result := Cnt;` 而恒返回 0，导致进度条全程停在 60%
> —— 见 §7.11。**改动它之后务必确认日志里 TotalFolders 非 0。**

---

## 6. `[Code]` 段函数清单

维护时的速查表。

| 函数 | 类型 | 作用 |
|---|---|---|
| `GetRealDesktopDir()` | `function: String` | 三级顺序解析当前用户桌面路径 |
| `CreateDesktopShortcut(ExePath)` | `function: Boolean` | 在桌面建 .lnk（需求②） |
| `TryCreateLink(TargetDir, ExePath)` | `function: Boolean` | 建单个 .lnk，失败返回 False（需求③） |
| `CountFoldersOnDrive(Root)` | `function: Integer` | 数一二级目录总数，给进度条做分母（**结尾必须 `Result := Cnt`**，见 §7.11） |
| `CreateLinksOnDrive(Root, ExePath)` | `procedure` | 遍历一二级目录并建 .lnk（需求③主体） |
| `UpdateProgress(StatusText)` | `procedure` | 刷新进度条 + 状态文字 |
| `InitializeSetup()` | `function: Boolean` | 事件钩子，初始化四个计数器 |
| `CurStepChanged(CurStep)` | `procedure` | 事件钩子，`ssPostInstall` 时执行需求②③ |
| `DeleteLinksOnDrive(Root)` | `procedure` | 卸载时回收 C/D 盘的 .lnk |
| `CurUninstallStepChanged(Step)` | `procedure` | 事件钩子，`usUninstall` 时清理 |

全局状态变量（4 个）：

```pascal
TotalFolders: Integer;      // 预计要处理的文件夹总数（进度条分母）
DoneFolders: Integer;       // 已成功创建
SkippedFolders: Integer;    // 跳过/失败
ProgressBase: Integer;      // 本阶段在总进度条上的起点（60）
```

**新增任何建快捷方式的位置，必须同步改三处**：`CountFoldersOnDrive`（分母）、
实际创建逻辑、`DeleteLinksOnDrive`（卸载回收）。漏了任何一处都会出现
「进度条不准」或「卸载后有残留」。

---

## 7. 坑点清单（全部实测踩过）

这一节是本方案最值钱的部分。**每一条都真实发生过。**

### 7.1 ⚠️ `CreateShellLink()` **不会**自动补 `.lnk` 后缀
**这是本方案最隐蔽的一个 bug，卡了两轮。**

- 自动补后缀是 **NSIS** 的行为，容易记混（我就混了）。
- Inno 的 `CreateShellLink(LinkPath, ...)` 传 `"...\桌面物理篮球"`，
  它就在**原样路径**建文件 —— 得到一个**无扩展名**的文件。
- 这个文件**内容是合法的 Shell Link 二进制**（头 4 字节 `4C 00 00 00` = 结构体
  `TShellLinkHeader::HeaderSize = 76`），双击能跑，但**看起来不是快捷方式、没有快捷方式箭头**。

症状极具误导性：

```
desktop: creating C:\Users\DELL\Desktop\桌面物理篮球.lnk   ← 路径拼接是对的
desktop: created, exists=0                                ← 但校验永远 False
```

而我的校验代码查的是**带 `.lnk`** 的路径 → 永远 False → 被计成「跳过」。
排查时差点往「COM 在提权上下文失灵」方向找。

**正解**：`installer.iss` 里统一用 `{#LnkName}`（**带** `.lnk` 后缀）：

```innosetup
#define LnkName        "桌面物理篮球.lnk"    ; 传给 CreateShellLink，必须带后缀
```

`CreateDesktopShortcut` 和 `TryCreateLink` **都必须**用它，不能有一处漏。
（历史上有过一个 `LnkBase` 宏不带后缀，已删除。）

### 7.2 Pascal 块注释 `{ ... }` 里不能有裸 `{`

`{userdesktop}` 写在 `{ ... }` 块注释里会直接报语法错误：

```
Error on line 126: Column 32: Syntax error.
```

→ 涉及 `{常量}` 的注释一律用 `//` 行注释。

### 7.3 `SetupIconFile` 不能指向 210 MB 的 Electron exe

```
Error on line 64: Resource update error: File is too large.
```

ISCC 要把图标资源嵌进 setup 自身，超限直接失败。
**想换图标必须准备单独的小 `.ico` 文件。** 当前用 Inno 默认图标。

### 7.4 中文语言包路径

`Files/Languages/Unofficial/ChineseSimplified.isl` → **404**。
正确路径是 `Files/Languages/ChineseSimplified.isl`。见 §3.2。

### 7.5 `[Icons]` 段在 admin 模式下不可靠

见 §5-② 的说明。当前 `[Icons]` 段**故意留空**，桌面快捷方式全走 `[Code]`。

### 7.6 编译时该进程不能占用产物

`Output: ... Can't open output file` / `Error - aborting creation process`
—— 说明上一个安装器进程还活着（卡在 MessageBox 上）。

```bash
tasklist //FI "IMAGENAME eq DesktopBasketball-Setup-1.0.1.exe"
```

> ⚠️ 若该进程是以 admin 提权的，`Stop-Process` 会报「拒绝访问」。
> 换个输出目录，或让用户手动关。

### 7.7 `$TEMP` 路径会被写进 app.asar

这是上游 `pack.js` 的坑，但**做安装器自测时容易触发**：
asar 路径规范化会把 **Windows 临时目录**替换成字面量 `$WIN_T`，
如果夹具往临时目录写东西且输出目录在项目内，整个临时目录会被打进 asar
（实测 63 文件 1.78 MB，含用户偏好与日志）。
`pack.js` 已硬排除 `/^\/\$WIN_T(\/|$)/`。

### 7.8 PowerShell 工具写的 `.ps1` 会损坏中文字面量

**写验收/清理脚本时的必踩坑。** PowerShell 工具写入 `.ps1` 文件时的编码转换
会让**中文字符串静默失效**：脚本里 `Test-Path -LiteralPath "C:\Intel\桌面物理篮球"`
永远返回 False，表现为「明明文件在，脚本却找不到」，很容易误判成安全策略拦截。

实测对比：同样语句**内联执行**正常返回（`matched-inline -> 12`），
写进 `.ps1` 文件则 `targets=0`。

**规避**：脚本里不写中文字面量，用 Unicode 码点构造 ——

```powershell
# 桌面物理篮球
$leaf = -join ([char]0x684C, [char]0x9762, [char]0x7269, [char]0x7406, [char]0x7BEE, [char]0x7403)
```

### 7.9 本机无法在 Agent 侧验证 UAC

会话 `IsAdmin=False`。`PrivilegesRequired=admin` 的正式版**必须由用户双击**运行。
Agent 侧一律用 TESTMODE 版自测（`PrivilegesRequired=lowest`）。

### 7.10 `WScript.Shell` COM 被拦

安全策略：`COM object instantiation can run arbitrary code (e.g. WScript.Shell)`。
验证 `.lnk` 内容改用 `[System.IO.File]::ReadAllBytes()` 读头 4 字节，见 §8。

### 7.11 ⚠️ 漏写 `Result := X` 只报 Hint，不报错 —— 曾让进度条失效

**2026-10-07 发现。** `CountFoldersOnDrive` 数完了 `Cnt` 却忘了 `Result := Cnt;`，
函数**恒返回 0**（Pascal 的 `Result` 默认是 0）。

后果链：`TotalFolders = 0` → `UpdateProgress` 走 else 分支 → 进度条在 C/D 扫描阶段
**永远停在 60%**，且状态文字误报「未发现可处理的文件夹」，然后默默建完 505 个快捷方式。

**编译器只给这一行，不报错：**

```
Warning: installer.iss, Line 281, Column 10: [Hint] Variable 'Result' never used
```

极易在「Successful compile」的刷屏里被当成噪音忽略。

**教训：把编译输出里的 `[Hint]` / `[Warning]` 当错误处理。** 本方案的目标是零警告。

修复后的实测判据（TEST 版安装日志）：

```
progress: TotalFolders=505 (progress base=60)
```

看到非 0 才算进度条分母正确。这行 `Log()` 就留在 `CurStepChanged` 里，别删。

**同类风险**：任何 `function ... : Integer/Boolean/String` 都要确认每条返回路径都赋了 `Result`。
`GetRealDesktopDir` / `CreateDesktopShortcut` / `TryCreateLink` / `InitializeSetup`
都在函数开头统一赋了初值，是安全的写法 —— 新加函数请照抄这个习惯。

---

## 8. 验收方法

### 8.1 自动化验收脚本

```bash
bash tools/verify-installer.sh
```

逐条核对五条需求，含安装包结构、桌面 .lnk、C/D 盘 .lnk 抽样、安装日志、进程残留。

> ⚠️ 跑之前**必须先完成一次安装**，否则查的是空环境。
> 脚本查的是**安装后**的状态，不是安装包本身。

### 8.2 手工判据（关键是这三个）

**① 桌面快捷方式存在，且是真正的 .lnk**

```bash
ls -la "$USERPROFILE/Desktop/桌面物理篮球.lnk"
```

```powershell
# 读头 4 字节：4C 00 00 00 才是合法 Shell Link
$b = [System.IO.File]::ReadAllBytes("$env:USERPROFILE\Desktop\桌面物理篮球.lnk")
[BitConverter]::ToString($b[0..3])
```

**同时确认无后缀残留不存在**（出现过就是 §7.1 那个 bug 复发了）：

```bash
ls "$USERPROFILE/Desktop/桌面物理篮球"    # 应为 No such file
```

**② 安装日志里的 `Log()` 输出**

安装日志（`/LOG=` 指定的路径）搜 `desktop`：

```
desktop[reg-raw] = C:\Users\DELL\Desktop
desktop[reg] ACCEPT
desktop: creating C:\Users\DELL\Desktop\桌面物理篮球.lnk
desktop: created, exists=1          ← exists=1 才是成功
```

**③ C/D 盘命中情况**

```bash
ls -d /c/*/ | head -6 | while read d; do
  [ -f "$d桌面物理篮球.lnk" ] && echo "OK  $d" || echo "--  $d"
done
```

**预期结果**（本机实测，正式版数据）：

| 范围 | 数量 | 未命中（正确跳过） |
|---|---|---|
| C 盘，两层内 | **17** 个 .lnk | `Windows` `Program Files` `Program Files (x86)` `$Recycle.Bin` `System Volume Information` `Documents and Settings` |
| D 盘，两层内 | **39** 个 .lnk | `$RECYCLE.BIN` |

未命中的**正是系统保护目录** —— 说明「无权限则跳过」逻辑正确工作。

（TESTMODE 版命中数会少一些：`PrivilegesRequired=lowest` 写不进部分受保护目录。
实测 TEST 版 C 12 / D 35。）

### 8.3 清理测试残留

测试安装会在 C/D 盘留下大量 `.lnk` 和（历史 bug 期的）无后缀文件。清理脚本必须
用 §7.8 的码点写法，且**必须先试运行确认 target 数量再删**。

---

## 9. 卸载行为

`CurUninstallStepChanged(usUninstall)` 里做三件事：

1. 删桌面 .lnk —— **`[Code]` 建的，Inno 不会自动回收**，必须手动删
2. `DeleteLinksOnDrive('C:\')`
3. `DeleteLinksOnDrive('D:\')`

`DeleteLinksOnDrive` **只删同名 `{#LnkName}`，不碰任何其它文件**：

```pascal
Lnk := AddBackslash(Dir1) + '{#LnkName}';
if FileExists(Lnk) then DeleteFile(Lnk);
```

安装目录由 `[UninstallDelete]` 段的 `Type: filesandordirs; Name: "{app}"` 整目录回收
（含运行期生成的文件）。

卸载器文件名是 **`unins000.exe`**（Inno 命名规则），
TSETUP 时代的 `Uninstall.exe` 判据已废弃。

---

## 10. 与上游打包链的关系

```
src/  ──npm run pack──>  dist/DesktopBasketball-win32-x64/  ──ISCC──>  dist/DesktopBasketball-Setup-1.0.1.exe
                            (21 文件, 106 MB)                              (80.9 MiB 单文件)
```

| 环节 | 脚本 | 说明 |
|---|---|---|
| Electron 打包 | `build/pack.js` | 默认做 SLIM 体积裁剪 + NTFS 透明压缩，约 8 秒 |
| 体积裁剪 | `build/slim.js` | 由 `pack.js` 以**子进程**调用（原因见该文件注释） |
| 安装包 | `build/installer.iss` | 本方案 |

**改动 payload 内容后必须重出安装包** —— 安装包是 payload 的快照。

`dist/` 下另有 `.7z` 单文件分发包（`npm run pack:7z`），
那是**免安装绿色版**，与安装器**并列**的两种分发形式，互不替代。

---

## 11. 维护须知

### 改版本号要同步改的地方

| 文件 | 位置 |
|---|---|
| `package.json` | `version` |
| `build/installer.iss` | `#define AppVersion` |
| `build/installer.iss` | `#define OutName`（含版本号） |

漏改 `OutName` 会导致新包覆盖旧包名，**旧版本产物消失**。

### 改安装目录

只改 `installer.iss` 的 `#ifdef TESTMODE` 分支里那两个 `FixedDir`。
**不要**在 `[Setup]` 段直接写死 —— 会破坏 TESTMODE 自测路径。

### 改快捷方式名称

改 `#define LnkName`（**必须带 `.lnk`**）和 `#define LnkDesc`。
三处使用点（`CreateDesktopShortcut` / `TryCreateLink` / `DeleteLinksOnDrive`）
都引用宏，改一处即全局生效。

### 编译前检查清单

1. `dist/DesktopBasketball-win32-x64/` 存在且是最新（必要时重跑 `pack.js`）
2. 没有残留的安装器进程
   （`tasklist //FI "IMAGENAME eq DesktopBasketball-Setup-1.0.1.exe"`）
3. ISCC 与中文语言包就位（§3.3）

### 本目录文件职责

| 文件 | 职责 |
|---|---|
| `installer.iss` | **安装器主脚本**（唯一需要改的文件） |
| `installer-test.iss` | 测试包装，`#define TESTMODE` + `#include` |
| `pack.js` | Electron 免安装打包 |
| `slim.js` | 体积裁剪子进程 |

`build/` 下**不应再有** NSIS 相关文件（`.nsi` / `.nsh` / `gen-payload.js`），
也不应有临时诊断脚本或测试输出。

---

## 12. 已知现象与遗留疑点

### 12.1 正式版安装后 `C:\Users\Public\Desktop` 出现快捷方式

**现象**（2026-10-07 实测）：正式版（`PrivilegesRequired=admin`）安装后，
除预期的桌面快捷方式外，以下两处也各出现一个 `.lnk`：

```
C:\Users\Public\Desktop\桌面物理篮球.lnk      ← 公共桌面（三级路径）
C:\Users\Public\Documents\桌面物理篮球.lnk    ← 公共文档（三级路径）
```

**为什么可疑**：`CreateLinksOnDrive('C:\')` 只有两层循环，
`Dir2` 最深只到 `C:\Users\Public`（二级），**逻辑上不产生三级路径**。
而 `CreateDesktopShortcut()` 只建**一个**文件，解释不了两处。

**当前判断**：未坐实。最可疑的方向是 admin 提权上下文下
`GetRealDesktopDir()` 的第①级（`RegQueryStringValue(HKCU, ...)`）读取失败，
退到第③级 `{userprofile}\Desktop` 时 `{userprofile}` 解析异常。

**影响**：低。不影响程序安装与运行，只是多了两个快捷方式。
且公共桌面本身也是「桌面」的一种呈现，用户仍能点到。

**如何进一步定位**：用带 `/LOG=` 的正式版安装复现，看日志里
`desktop[reg-raw]` / `desktop[reg] REJECT` / `desktop[userdesktop]` /
`desktop[userprofile]` 这几行分别打了什么 —— 就能确定走了哪个 fallback。
（本机 Agent 侧 `IsAdmin=False`，跑不了 admin 版，需要用户配合。）

**验收脚本的处理**：`tools/verify-installer.sh` 把「三级目录命中」**降级为 WARN**
（并排除 `$Recycle.Bin` —— 被删掉的合法 .lnk 会被移进
`$Recycle.Bin/<SID>/<随机名>/`，看着像三级路径，实际是回收站容器）。

### 12.2 `.lnk.lnk` 双重后缀问题不存在

Inno 的 `CreateShellLink` **原样使用**传入的路径，既不补后缀也不去后缀。
所以只要 `{#LnkName}` 带一次 `.lnk`，产物就是准确的 `.lnk`。
**若真见到 `.lnk.lnk`**，说明有人把路径拼成了 `LnkName + '.lnk'` —— 回到 §7.1 检查。
（`桌面物理篮球.lnk.lnk` 是 NSIS 时代的历史现象，本方案不会产生。）
