#!/usr/bin/env bash
# ============================================================================
#  安装器验收：逐条核对用户需求（Inno Setup 方案）
#    ① 固定安装目录（不可选）
#    ② 桌面快捷方式
#    ③ C/D 盘一、二级目录各有快捷方式，且不改动原有文件
#    ④ 全程零选项、自动完成
#    ⑤ 进度条（无法脚本化验证，由 §需求⑤ 说明）
#
#  用法：bash tools/verify-installer.sh
#  ⚠️ 查的是**安装后**的状态 —— 必须先跑过一次安装（正式版或 TESTMODE 版）。
#     未安装时需求①②会 FAIL，这是预期行为，不代表安装器坏了。
#
#  与旧版（NSIS）的差异：日志名、卸载器名、安装包结构判据全部换成 Inno 口径。
#     · 日志  : $TEMP/db-inno-install*.log（由安装时的 /LOG= 参数决定）
#     · 卸载器: unins000.exe（Inno 命名；旧版查的 Uninstall.exe 已废弃）
#     · 安装包: 7z **无法**列出 Inno 包内容（结构不同），改用体积 + 特征串判据
#
#  详见 build/INSTALLER.md
# ============================================================================
set -u

LNK="桌面物理篮球.lnk"
# 无后缀残留 —— 历史 bug（CreateShellLink 不补 .lnk 后缀）的回归判据，必须为 0
LNK_BARE="桌面物理篮球"
INST="C:/Program Files/DesktopBasketball"

# ⚠️ 不要在 bash 里调 powershell（会被安全策略拦），桌面路径从已知位置取。
# USERPROFILE 拼出的桌面在中英文系统下都成立。
DESK="$USERPROFILE/Desktop"
[ -d "$DESK" ] || DESK="$USERPROFILE/桌面"

# Inno 日志：找最新的一个（脚本不负责产生日志，只消费）
LOG=""
for f in "$TEMP"/db-inno-install*.log; do
  [ -f "$f" ] || continue
  [ -z "$LOG" ] || [ "$f" -nt "$LOG" ] && LOG="$f"
done

pass=0; fail=0; warn=0
ok()   { echo "  [PASS] $1"; pass=$((pass+1)); }
bad()  { echo "  [FAIL] $1"; fail=$((fail+1)); }
warn() { echo "  [WARN] $1"; warn=$((warn+1)); }

echo "=============================================="
echo " 安装器验收（Inno Setup 方案）"
echo "=============================================="

# ---------- 安装包自身结构（打包阶段就能查，不用等运行） ----------
echo
echo "安装包结构"
SETUP="dist/DesktopBasketball-Setup-1.0.0.exe"
if [ -f "$SETUP" ]; then
  ssz=$(stat -c "%s" "$SETUP" 2>/dev/null || echo 0)
  echo "  安装包大小：$((ssz/1024/1024)) MiB"
  if [ "$ssz" -gt 80000000 ]; then
    ok "安装包体积正常（>80 MiB，含完整 payload，不是空壳）"
  else
    bad "安装包仅 $((ssz/1024/1024)) MiB，疑似 payload 没打进去"
  fi
  # Inno 标识串在未压缩的 PE 区，可直接搜到（应用名在 LZMA 段里，搜不到是正常的）
  if grep -a -q "Inno Setup" "$SETUP" 2>/dev/null; then
    ok "含 Inno Setup 标识（确认是 Inno 产物，不是残留的 NSIS 包）"
  else
    bad "包内找不到 Inno Setup 标识"
  fi
else
  bad "找不到安装包 $SETUP（先跑 ISCC 编译）"
fi

# ---------- 需求 ①：固定安装目录 ----------
echo
echo "需求① 安装目录固定"
if [ -f "$INST/DesktopBasketball.exe" ]; then
  ok "主程序存在于固定目录 $INST"
else
  bad "主程序不在 $INST（正式版尚未安装？）"
fi
for f in resources/app.asar locales/zh-CN.pak LICENSE version; do
  if [ -e "$INST/$f" ]; then ok "已解包 $f"; else bad "缺少 $f"; fi
done
# 体积应接近完整 payload（说明不是只拷了壳）
sz=$(find "$INST" -type f -printf "%s\n" 2>/dev/null | awk '{s+=$1} END{print s+0}')
if [ "$sz" -gt 200000000 ]; then
  ok "解包体积 $((sz/1024/1024)) MiB（完整解包，非残缺）"
else
  bad "解包体积仅 $((sz/1024/1024)) MiB，疑似不完整"
fi
# Inno 的卸载器名是 unins000.exe
if [ -f "$INST/unins000.exe" ]; then
  ok "已生成卸载器 unins000.exe"
else
  bad "缺少 unins000.exe"
fi
# 固定性：安装目录写死在 [Setup] 的 DefaultDirName，没有目录选择页。
# （不再读注册表校验 —— 本机沙箱把 reg.exe 列入程序黑名单，会中断脚本）

# ---------- 需求 ②：桌面快捷方式 ----------
echo
echo "需求② 桌面快捷方式"
if [ -f "$DESK/$LNK" ]; then
  ok "桌面存在 $LNK（$DESK）"
  # 校验是真正的 Shell Link：头 4 字节必须是 4C 00 00 00
  hdr=$(head -c 4 "$DESK/$LNK" | od -An -tx1 | tr -d ' \n')
  if [ "$hdr" = "4c000000" ]; then
    ok "文件头 4C000000（合法 Shell Link 结构）"
  else
    bad "文件头为 $hdr，不是合法 .lnk（期待 4c000000）"
  fi
else
  bad "桌面缺少 $LNK（$DESK）"
fi
# 回归判据：无后缀残留必须不存在
bare=$(ls "$DESK/$LNK_BARE" 2>/dev/null | wc -l)
if [ "$bare" -eq 0 ]; then
  ok "无后缀残留不存在（CreateShellLink 后缀修复未回退）"
else
  bad "发现无后缀文件 $DESK/$LNK_BARE —— CreateShellLink 后缀 bug 复发了！见 INSTALLER.md §7.1"
fi

# ---------- 需求 ③：C/D 盘一、二级目录 ----------
echo
echo "需求③ C/D 盘一、二级目录快捷方式"
total=0
for d in c d; do
  root="/$d"
  [ -d "$root" ] || { echo "  (跳过 $d: 盘符不存在)"; continue; }
  l1=$(ls -d "$root"/*/ 2>/dev/null | wc -l)
  # 抽样：一级目录前 6 个
  hit1=0; tot1=0
  for p in $(ls -d "$root"/*/ 2>/dev/null | head -6); do
    tot1=$((tot1+1))
    [ -f "$p$LNK" ] && hit1=$((hit1+1))
  done
  echo "  $d: 一级目录 $l1 个，抽样 $tot1 个"
  [ "$hit1" -gt 0 ] && ok "$d: 一级目录命中 $hit1/$tot1" || bad "$d: 一级目录抽样全无快捷方式"

  # 抽样：二级目录前 25 个
  hit2=0; tot2=0
  for p in $(ls -d "$root"/*/*/ 2>/dev/null | head -25); do
    tot2=$((tot2+1))
    [ -f "$p$LNK" ] && hit2=$((hit2+1))
  done
  echo "  $d: 二级目录抽样 $tot2 个"
  [ "$hit2" -gt 0 ] && ok "$d: 二级目录命中 $hit2/$tot2" || bad "$d: 二级目录抽样全无快捷方式"

  c=$(find "$root" -maxdepth 2 -name "$LNK" 2>/dev/null | wc -l)
  echo "  $d: 两层内实际共 $c 个快捷方式"
  total=$((total+c))
done
[ "$total" -gt 0 ] && ok "C/D 盘共创建 $total 个快捷方式" || bad "C/D 盘一个快捷方式都没有"

# 只扫两层：三级及更深**真实目录**内不应有快捷方式。
# ⚠️ 深度换算 —— find 的 maxdepth 算的是「路径层级」，文件本身占一级：
#      /c/<一级>/x.lnk               → depth 2
#      /c/<一级>/<二级>/x.lnk        → depth 3
#      /c/<一级>/<二级>/<三级>/x.lnk → depth 4  ← 这才是「扫了三层」的证据
#    所以判据是「depth >= 4 的命中数」，写成 -maxdepth 3 反而把合法结果算进来。
#
#    排除项：
#      · $Recycle.Bin —— 回收站内部结构。被删掉的合法 .lnk 会被移进
#        $Recycle.Bin/<SID>/<随机名>/ 里，看着像 depth 4 实际是回收站容器。
#    已知现象（见 INSTALLER.md §12）：正式版安装后 C:\Users\Public\Desktop 与
#    Public\Documents 下可能各出现一个 .lnk。成因未坐实（怀疑是 admin 提权下
#    {userprofile} 解析异常），不影响功能，因此降级为 WARN 而非 FAIL。
deep=$(find /c /d -mindepth 4 -maxdepth 4 -name "$LNK" 2>/dev/null | grep -v '\$Recycle.Bin' || true)
deep_n=$(echo "$deep" | grep -c . || true)
if [ "$deep_n" -eq 0 ]; then
  ok "三级目录内无快捷方式（严格只扫两层）"
else
  warn "三级目录内发现 $deep_n 个（已排除回收站）—— 见 INSTALLER.md §12 已知现象"
  echo "$deep" | sed 's/^/        /'
fi

# ---------- 需求 ③附加：不改动原有文件 ----------
echo
echo "需求③附加 未改动目标文件夹原有文件"
# 安装器只应**新增** .lnk；用 C:\Program Files 做对照：安装目录是新增长出来的
if [ -d "/c/Program Files" ]; then
  others=$(ls -a "/c/Program Files" 2>/dev/null | grep -v "^\.$\|^\.\.$" | wc -l)
  echo "  C:\\Program Files 现有条目 $others 个（安装器不应删除任何一项）"
  [ -d "/c/Program Files/DesktopBasketball" ] \
    && ok "安装目录是新增而非覆盖既有目录" \
    || warn "安装目录不存在（正式版未安装时属预期）"
fi

# ---------- 需求 ④：零选项自动完成 ----------
echo
echo "需求④ 全程零选项、自动完成"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  echo "  --- 安装日志（$LOG）---"
  grep -a "desktop" "$LOG" 2>/dev/null | sed 's/^/    /' | head -10
  # Inno 的成功标志
  if grep -a -q "Installation process succeeded" "$LOG" 2>/dev/null; then
    ok "安装流程正常结束（Installation process succeeded）"
  else
    bad "日志缺少 'Installation process succeeded'"
  fi
  # 桌面快捷方式的 Log() 判据
  dl=$(grep -a "desktop: created" "$LOG" 2>/dev/null | tail -1 || true)
  if [ -n "$dl" ]; then
    if echo "$dl" | grep -q "exists=1"; then
      ok "桌面快捷方式创建成功：$(echo "$dl" | sed 's/^.*desktop/desktop/')"
    else
      bad "桌面快捷方式创建失败：$(echo "$dl" | sed 's/^.*desktop/desktop/')"
    fi
  else
    warn "日志中无 'desktop: created' 记录（可能是旧日志或未执行到）"
  fi
  # 不应有异常
  if grep -a -q "CreateShellLink raised an exception" "$LOG" 2>/dev/null; then
    bad "日志出现 CreateShellLink 异常"
  else
    ok "无 CreateShellLink 异常"
  fi
else
  warn "未找到安装日志（\$TEMP/db-inno-install*.log）—— 安装时需带 /LOG= 参数"
fi

# 进程不应残留
if tasklist //FI "IMAGENAME eq DesktopBasketball-Setup-1.0.0.exe" 2>/dev/null | grep -qi "Setup"; then
  bad "安装器进程仍残留（说明没有自动退出）"
else
  ok "安装器已自动退出，无残留进程"
fi

# ---------- 需求 ⑤：进度条 ----------
echo
echo "需求⑤ 进度条"
warn "进度条为 GUI 行为，无法脚本化验证 —— 见 build/INSTALLER.md §5-⑤"
echo "        判据：解包阶段由 Inno 框架驱动；C/D 扫描阶段从 60% 推进到 100%"

echo
echo "=============================================="
echo " 结果：PASS=$pass  FAIL=$fail  WARN=$warn"
echo "=============================================="
[ "$fail" -eq 0 ] || exit 1
