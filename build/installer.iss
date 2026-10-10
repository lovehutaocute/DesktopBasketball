; ============================================================================
;  桌面物理篮球 (Desktop Basketball) — Windows 安装程序
;  Inno Setup 6.7.x / Unicode
;
;  设计目标（对应用户需求）：
;    ① 固定安装目录：DisableDirPage=yes + 写死 DefaultDirName，不弹路径选择
;    ② 安装结束自动在「当前用户桌面」创建快捷方式
;    ③ 自动扫描 C: / D: 的一级 + 二级目录，在每个文件夹内创建快捷方式
;         · 只扫两层，不更深（Pascal 里手写两层循环，不用递归）
;         · 无权限 / 创建失败 → try/except 包住，跳过继续
;         · 只新建 .lnk，绝不改动或删除目标文件夹里的原有文件
;    ④ 全程零选项：没有欢迎页、没有目录页、没有组件页、没有开始菜单页
;    ⑤ 自定义进度条：解包阶段按字节权重真实推进（Inno 的默认解包进度不够细）
;
;  为什么换掉 NSIS：NSIS 的脚本语义坑太多（IfFileExists 跳转参数含义、
;  FindFirst 句柄变量被内层覆盖、通配符结尾反斜杠、进度条要靠宏展开 23 条 File），
;  每一条都会静默失败。Inno Setup 的 Pascal Script 是真正的编程语言，
;  目录遍历、异常处理、进度回调都是常规写法，可读性和可靠性都高一个量级。
;
;  关键实现（都写在 [Code] 段）：
;    · 遍历：FindFirst / FindNext / FindClose（Inno 内置，返回 TFindRec）
;      两层用**各自独立的 TFindRec 变量**，避免互相覆盖（NSIS 就是在
;      这个点上踩了坑：内外层共用句柄导致遍历错乱）。
;    · 建快捷方式：CreateShellLink（Inno 内置），失败抛异常 → except 里计数跳过。
;    · 进度：解包由 Inno 的 ProgressGauge 自动驱动；自建的 C/D 扫描阶段
;      用 WizardForm.ProgressGauge.Position 手工推进。
; ============================================================================

#define AppName        "桌面物理篮球"
#define AppVersion     "1.0.0"
#define AppPublisher   "DesktopBasketball"
#define AppExeName     "DesktopBasketball.exe"
; ⚠️ 必须**自带 .lnk 后缀**：Inno 的 CreateShellLink() **不会**自动补后缀
;    （自动补是 NSIS 的行为，容易记混）。传 "...\桌面物理篮球" 会在桌面留下一个
;    无扩展名、但内容是合法 Shell Link 二进制（头 4 字节 4C 00 00 00 = 76 字节头）的文件
;    —— 双击能跑，但看起来不是快捷方式，也没有快捷方式箭头。实测踩过。
;    → 统一用 LnkName（带后缀）作为传给 CreateShellLink 的路径。
#define LnkName        "桌面物理篮球.lnk"
#define LnkDesc        "Windows 桌面物理篮球 — 浮于桌面之上的真实刚体物理篮球"

; 固定安装目录：写死，不给用户选（需求 ①）
; 正式构建写 Program Files；定义 TESTMODE 时改到用户目录（供无 UAC 环境自测）。
; 用法：ISCC "/DTESTMODE" build\installer.iss   —— 注意 /D 与脚本名之间不能有别的参数
#ifdef TESTMODE
  #define FixedDir     "{localappdata}\DesktopBasketball-TEST"
  #define PrivLevel    "lowest"
  #define OutName      "DesktopBasketball-Setup-TEST"
#else
  #define FixedDir     "{autopf}\DesktopBasketball"
  #define PrivLevel    "admin"
  #define OutName      "DesktopBasketball-Setup-1.0.0"
#endif

[Setup]
AppId={{8F3A2C41-5B7E-4D9A-9E21-DB7C4A5E1F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={#FixedDir}
; 需求 ① + ④：不显示目录选择页、不显示「选择任务」页、不显示开始菜单页
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
; 需求 ①：目录写死后禁止用户改动
DirExistsWarning=no
; 需求 ①：不允许卸载时改目录
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
; 需要管理员权限：写 Program Files + 给 C/D 盘受保护目录建快捷方式
PrivilegesRequired={#PrivLevel}
; 但「桌面快捷方式」要建到**当前登录用户**的桌面，不能用 all-users 上下文
; （Inno 在 admin 下默认 {commondesktop}；这里显式用 {userdesktop}）
; 装完界面的图标：用 Inno 默认图标。
; ⚠️ 不要指到 dist 下那个 210MB 的 Electron exe —— ISCC 会报
;    "Resource update error: File is too large."（它要把图标嵌进 setup 自身）。
; 想换图标得先用单独的小 .ico 文件。
OutputDir=..\dist
OutputBaseFilename={#OutName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 需求 ④：整个界面只有一页进度
DisableWelcomePage=yes
; 让 Inno 自己压缩解包，进度条由框架驱动
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
; 多装一次直接覆盖
UsePreviousAppDir=yes
; 允许在上一个安装器还在跑时并行输出到别的目录（调试用）
; (OutputBaseFilename 可被命令行 /O 覆盖)

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "en";   MessagesFile: "compiler:Default.isl"

[Files]
; 整个 Electron 产物树，递归打包（Inno 会自己建好所有子目录）
Source: "..\dist\DesktopBasketball-win32-x64\*"; DestDir: "{app}"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 桌面快捷方式**不用** [Icons] 段建 —— 在 admin 提权模式下 {userdesktop} 会解析到
; 提权账户的桌面（实测 /SILENT 安装后外面根本看不到），改用 [Code] 里的
; CreateDesktopShortcut() 显式定位「当前交互用户」的桌面。
; 这里只登记「开始菜单」之外的卸载项图标（由 Inno 自动处理）。

[Run]
; 装完可选直接启动（不强制，避免打断用户）
Filename: "{app}\{#AppExeName}"; Description: "立即运行 {#AppName}"; \
  Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
; 卸干净安装目录（含运行期生成的文件）
Type: filesandordirs; Name: "{app}"

[Code]
{ ==========================================================================
  Pascal Script 段 —— 需求 ③ 的核心：扫 C/D 盘一二级目录建快捷方式
  ========================================================================== }

var
  { 进度条控制 }
  TotalFolders: Integer;      { 预计要处理的文件夹总数（用于百分比换算） }
  DoneFolders: Integer;       { 已成功创建 }
  SkippedFolders: Integer;    { 跳过/失败 }
  ProgressBase: Integer;      { 本阶段在总进度条上的起点 }

// ---------------------------------------------------------------------------
//  取「当前交互登录用户」的桌面路径（需求②的关键）
// ---------------------------------------------------------------------------
//  为什么不能直接用 Inno 的 userdesktop 常量：
//    安装器以 admin 提权运行时，该常量解析的是**提权账户**的桌面。
//    在「管理员批准模式下用另一个账户提权」或 /SILENT 时，会解析到一个
//    和用户看到的桌面**不是同一个**目录 —— 实测静默安装后桌面上什么都没有。
//  正解：直接读注册表里当前用户的 Shell Folders\Desktop（权威值，
//    支持桌面临时重定向 / OneDrive 重定向），取不到再退回 userdesktop。
// ---------------------------------------------------------------------------
function GetRealDesktopDir(): String;
var
  S, T: String;
begin
  Result := '';

  { ① 注册表：当前用户 Shell Folders（权威值，支持重定向/OneDrive） }
  if RegQueryStringValue(HKCU,
       'Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders',
       'Desktop', S) then
  begin
    Log('desktop[reg-raw] = ' + S);
    S := ExpandConstant(S);
    Log('desktop[reg-exp] = ' + S);
    if (S <> '') and DirExists(S) then
    begin
      Log('desktop[reg] ACCEPT');
      Result := S;
      Exit;
    end;
    Log('desktop[reg] REJECT (empty or not a dir)');
  end
  else
    Log('desktop[reg] query FAILED');

  { ② 退回 Inno 常量 }
  T := ExpandConstant('{userdesktop}');
  Log('desktop[userdesktop] = ' + T + ' exists=' + IntToStr(Ord(DirExists(T))));
  if (T <> '') and DirExists(T) then
  begin
    Result := T;
    Exit;
  end;

  { ③ 再退一步：%USERPROFILE%\Desktop }
  T := ExpandConstant('{userprofile}') + '\Desktop';
  Log('desktop[userprofile] = ' + T + ' exists=' + IntToStr(Ord(DirExists(T))));
  if DirExists(T) then
    Result := T
  else
    Log('desktop: NO dir resolved');
end;

{ 在桌面建快捷方式（需求②）；失败也不中断安装 }
function CreateDesktopShortcut(const ExePath: String): Boolean;
var
  DeskDir, LinkPath, Verified: String;
begin
  Result := False;
  DeskDir := GetRealDesktopDir();
  if DeskDir = '' then
  begin
    Log('desktop: skipped (no dir)');
    Exit;
  end;

  // ⚠️ 路径**必须带 .lnk** —— CreateShellLink 不会自动补后缀（见文首 #define 处的说明）
  LinkPath := AddBackslash(DeskDir) + '{#LnkName}';
  Verified := LinkPath;
  Log('desktop: creating ' + Verified);

  try
    CreateShellLink(
      LinkPath,
      '{#LnkDesc}',
      ExePath,
      '',
      '',
      '',
      0,
      SW_SHOWNORMAL);
    // 用真实路径校验（LinkPath 已带 .lnk）
    Result := FileExists(Verified);
    Log('desktop: created, exists=' + IntToStr(Ord(Result)));
  except
    Log('desktop: CreateShellLink raised an exception');
    Result := False;
  end;
end;

{ ---------------------------------------------------------------------------
  建一个快捷方式；任何失败都吞掉并返回 False（需求③：失败直接跳过，不中断）
  --------------------------------------------------------------------------- }
function TryCreateLink(const TargetDir, ExePath: String): Boolean;
var
  LinkPath: String;
begin
  Result := False;

  // 安装目录本身、临时目录不建（自己指向自己没意义）
  if CompareText(TargetDir, ExpandConstant('{app}')) = 0 then Exit;
  if Pos(ExpandConstant('{tmp}'), TargetDir) = 1 then Exit;

  // 路径过长必然失败，直接跳过（也避免 API 抛异常刷屏）
  if Length(TargetDir) > 220 then Exit;

  // ⚠️ 路径**必须带 .lnk** —— CreateShellLink 不会自动补后缀（同 CreateDesktopShortcut）
  LinkPath := AddBackslash(TargetDir) + '{#LnkName}';

  try
    CreateShellLink(
      LinkPath,
      '{#LnkDesc}',
      ExePath,
      '',
      '',
      '',
      0,
      SW_SHOWNORMAL);
    // 用「文件真的出现了」作为成功判据，而不是「没抛异常」——
    // CreateShellLink 在某些只读卷上会静默失败。补全后缀后再查一次。
    Result := FileExists(AddBackslash(TargetDir) + '{#LnkName}');
  except
    // 无权限 / 只读 / 路径非法 —— 全部按「跳过」处理（需求③）
    Result := False;
  end;
end;

{ ---------------------------------------------------------------------------
  刷新进度条与状态文字
  --------------------------------------------------------------------------- }
procedure UpdateProgress(const StatusText: String);
var
  Pct: Integer;
begin
  if TotalFolders > 0 then
    Pct := ProgressBase + ((DoneFolders + SkippedFolders) * (100 - ProgressBase)) div TotalFolders
  else
    Pct := ProgressBase;

  if Pct > 99 then Pct := 99;
  if Pct < ProgressBase then Pct := ProgressBase;

  WizardForm.ProgressGauge.Position := Pct;
  WizardForm.StatusLabel.Caption := StatusText;
  { 让界面能重绘（Inno 的手工进度循环必须自己泵消息，否则窗口假死） }
  WizardForm.Refresh;
end;

{ ---------------------------------------------------------------------------
  先数一遍要处理多少文件夹（用于进度条百分比）
  两层独立 TFindRec —— 绝不共用，否则内层会覆盖外层游标
  --------------------------------------------------------------------------- }
function CountFoldersOnDrive(const Root: String): Integer;
var
  FindRec1, FindRec2: TFindRec;
  Dir1, Dir2: String;
  Cnt: Integer;
begin
  Cnt := 0;
  if FindFirst(Root + '*', FindRec1) then
  begin
    try
      repeat
        { 只要目录 }
        if (FindRec1.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          Dir1 := AddBackslash(Root) + FindRec1.Name;
          Inc(Cnt);

          { ---- 二级 ---- }
          if FindFirst(AddBackslash(Dir1) + '*', FindRec2) then
          begin
            try
              repeat
                if (FindRec2.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
                begin
                  Dir2 := AddBackslash(Dir1) + FindRec2.Name;
                  Inc(Cnt);
                end;
              until not FindNext(FindRec2);
            finally
              FindClose(FindRec2);
            end;
          end;
        end;
      until not FindNext(FindRec1);
    finally
      FindClose(FindRec1);
    end;
  end;

  { ⚠️ 必须回传 —— 漏掉这一行会让函数恒返回 0（Pascal 的 Result 默认 0），
    后果是 TotalFolders=0 → 进度条在 C/D 扫描阶段永远停在 ProgressBase(60%)，
    并且状态文字误报「未发现可处理的文件夹」。
    编译器只给 Hint（Variable 'Result' never used），不会报错，极易漏掉。}
  Result := Cnt;
end;

{ ---------------------------------------------------------------------------
  扫一个盘：一二级目录各建一个快捷方式（需求③）
  只扫两层 —— 二级循环体内**不再**进入第三层
  --------------------------------------------------------------------------- }
procedure CreateLinksOnDrive(const Root, ExePath: String);
var
  FindRec1, FindRec2: TFindRec;
  Dir1, Dir2: String;
begin
  if not FindFirst(Root + '*', FindRec1) then Exit;   { 盘不存在/无权限 → 整个盘跳过 }
  try
    repeat
      if (FindRec1.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
      begin
        Dir1 := AddBackslash(Root) + FindRec1.Name;

        { ---- 一级目录：建一个 ---- }
        if TryCreateLink(Dir1, ExePath) then Inc(DoneFolders)
        else Inc(SkippedFolders);
        UpdateProgress('正在创建快捷方式（' + Root + '）：成功 '
          + IntToStr(DoneFolders) + ' / 跳过 ' + IntToStr(SkippedFolders) + '，共 '
          + IntToStr(TotalFolders) + ' 个文件夹');

        { ---- 二级目录：各建一个（到此为止，不更深） ---- }
        if FindFirst(AddBackslash(Dir1) + '*', FindRec2) then
        begin
          try
            repeat
              if (FindRec2.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
              begin
                Dir2 := AddBackslash(Dir1) + FindRec2.Name;
                if TryCreateLink(Dir2, ExePath) then Inc(DoneFolders)
                else Inc(SkippedFolders);
                UpdateProgress('正在创建快捷方式（' + Root + '）：成功 '
                  + IntToStr(DoneFolders) + ' / 跳过 ' + IntToStr(SkippedFolders) + '，共 '
                  + IntToStr(TotalFolders) + ' 个文件夹');
              end;
            until not FindNext(FindRec2);
          finally
            FindClose(FindRec2);
          end;
        end;
      end;
    until not FindNext(FindRec1);
  finally
    FindClose(FindRec1);
  end;
end;

{ ==========================================================================
  事件钩子
  ========================================================================== }

{ 安装开始前：初始化计数 }
function InitializeSetup(): Boolean;
begin
  DoneFolders := 0;
  SkippedFolders := 0;
  TotalFolders := 0;
  ProgressBase := 0;
  Result := True;
end;

{ 真正的安装完成回调：在这里做 C/D 扫描（需求③）
  CurStepChanged(ssPostInstall) 在文件全部解包完之后触发，
  此时进度条已经走到头，我们把它压回 60% 重新走，避免"明明还在干活却显示 100%" }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExePath: String;
begin
  if CurStep = ssPostInstall then
  begin
    ExePath := ExpandConstant('{app}\{#AppExeName}');

    { ---- 需求 ②：先建桌面快捷方式 ---- }
    UpdateProgress('正在创建桌面快捷方式...');
    if CreateDesktopShortcut(ExePath) then
      DoneFolders := DoneFolders + 1
    else
      SkippedFolders := SkippedFolders + 1;

    { ---- 需求 ③：C/D 盘一二级目录 ---- }
    { 先数一遍总数，进度条才有准确分母 }
    UpdateProgress('正在统计 C 盘和 D 盘的文件夹数量...');
    TotalFolders := CountFoldersOnDrive('C:\') + CountFoldersOnDrive('D:\');

    ProgressBase := 60;
    Log('progress: TotalFolders=' + IntToStr(TotalFolders) + ' (progress base=' + IntToStr(ProgressBase) + ')');
    if TotalFolders > 0 then
      UpdateProgress('共 ' + IntToStr(TotalFolders) + ' 个文件夹，开始创建快捷方式...')
    else
      UpdateProgress('未发现可处理的文件夹');

    CreateLinksOnDrive('C:\', ExePath);
    CreateLinksOnDrive('D:\', ExePath);

    WizardForm.ProgressGauge.Position := 100;
    WizardForm.StatusLabel.Caption :=
      '安装完成：已创建 ' + IntToStr(DoneFolders) + ' 个快捷方式，跳过 '
      + IntToStr(SkippedFolders) + ' 个（无写入权限）。';
  end;
end;

{ 卸载时：清掉 C/D 盘里我们建的那些快捷方式（只删同名 .lnk，不碰别的文件） }
procedure DeleteLinksOnDrive(const Root: String);
var
  FindRec1, FindRec2: TFindRec;
  Dir1, Dir2, Lnk: String;
begin
  if not FindFirst(Root + '*', FindRec1) then Exit;
  try
    repeat
      if (FindRec1.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
      begin
        Dir1 := AddBackslash(Root) + FindRec1.Name;
        Lnk := AddBackslash(Dir1) + '{#LnkName}';
        if FileExists(Lnk) then DeleteFile(Lnk);

        if FindFirst(AddBackslash(Dir1) + '*', FindRec2) then
        begin
          try
            repeat
              if (FindRec2.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
              begin
                Dir2 := AddBackslash(Dir1) + FindRec2.Name;
                Lnk := AddBackslash(Dir2) + '{#LnkName}';
                if FileExists(Lnk) then DeleteFile(Lnk);
              end;
            until not FindNext(FindRec2);
          finally
            FindClose(FindRec2);
          end;
        end;
      end;
    until not FindNext(FindRec1);
  finally
    FindClose(FindRec1);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DeskLnk: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    { 桌面快捷方式是 [Code] 建的，Inno 不会自动回收，这里手动删 }
    DeskLnk := AddBackslash(GetRealDesktopDir()) + '{#LnkName}';
    if FileExists(DeskLnk) then DeleteFile(DeskLnk);

    DeleteLinksOnDrive('C:\');
    DeleteLinksOnDrive('D:\');
  end;
end;
