/**
 * tools/verify-fx.js —— 视觉特效（进球特效 / 运动拖尾）的验收夹具。
 *
 * 用法（打包版 exe；`--capture` 必须给，否则 startCaptureTools 开头那个守卫会直接 return，
 * `--eval` / `--capture-delay` / `--exit-after` 全都不生效 —— 本机踩过两次）：
 *
 *   EVAL="$(cat tools/verify-fx.js)"
 *   ./dist/DesktopBasketball-win32-x64/DesktopBasketball.exe --no-gpu \
 *     --user-data-dir="$TMP" --eval="$EVAL" \
 *     --capture="$TMP\\fx.png" --capture-delay=7000 --exit-after=13000
 *
 * ⚠️ 脚本**必须自带调用括号**（结尾的 `)()`）—— main.js 只做 `'(' + script + ')'` 包裹，
 * 传 `()=>{...}` 得到的是一个函数对象、函数体一行都不执行，而报错是误导性的
 * `An object could not be cloned`（见 README §7.9）。
 *
 * 判据全部走 `console.log`（渲染进程 console 会被主进程转写进 runtime.log，
 * 前缀 `[renderer:1]`），**不依赖返回值** —— 返回值里塞活对象同样会被结构化克隆拒绝。
 *
 * ⚠️ **时间窗口只有 2200ms**：`--eval` 在 `max(1200, capture-delay-2200)` 才开始跑，
 * 截图在 capture-delay 发生，而进程**截完图就退出**（实测 `--exit-after` 不会把它拖住）。
 * 所以夹具的全部检查必须挤进这 2200ms —— 早先我把收尾检查排在 +2900ms，
 * 结果汇总一行都没打出来，看着像夹具坏了，其实是跑在进程退出之后。
 *
 * 时序（t0 = 脚本开始执行）：
 *   +100ms  读开关、把 0 号球以 1500px/s 抛出（验拖尾）
 *   +500ms  查残影
 *   +600ms  触发一次进球（__pbScore 把球摆到篮筐上方 130px 处下落，入网约需 1.4s）
 *   +2000ms 汇总（此时截图刚发生，彩带还在飞）
 */
(() => {
  const L = (m) => console.log('[VERIFY] ' + m);
  const t0 = Date.now();
  let pass = 0, fail = 0;
  const chk = (name, cond, detail) => {
    if (cond) { pass++; L('PASS ' + name + (detail ? '  ' + detail : '')); }
    else { fail++; L('FAIL ' + name + (detail ? '  ' + detail : '')); }
  };

  let trailPeak = 0, ringPeak = 0, partPeak = 0;
  /**
   * ⚠️ 用独立变量做"只触发一次"的闸门，**不能**往 `setInterval` 的返回值上挂属性 ——
   * 浏览器里它是个数字（不是对象），赋值静默失效，于是每 100ms 触发一次进球。
   * 本轮就踩了这个：日志里刷了十几行 `score-trigger=ok`，球被反复瞬移回篮筐上方。
   */
  let trailChecked = false, scored = false, done = false;

  setTimeout(() => {
    const d = window.__pbDiag();
    chk('开关-进球特效默认开', d.fxBurst === true, 'fxBurst=' + d.fxBurst);
    chk('开关-拖尾默认开', d.trailOn === true, 'trailOn=' + d.trailOn);
    chk('开关-拖尾样式默认火焰', d.trailStyle === 'fire', 'trailStyle=' + d.trailStyle);
    // 金球专用多层烘焙：bakeLayers('gold') 必须走 bakeGold（base / hi 都是 320²，seam 透明）
    try {
      const gt = window.__pbTexFor('gold');
      chk('金球-多层已烘焙', !!gt && !!gt.base && gt.base.width === 320,
        'base=' + (gt && gt.base && gt.base.width) + 'x' + (gt && gt.base && gt.base.width));
      chk('金球-base≠hi（独立两层）', !!gt && !!gt.hi && gt.base !== gt.hi);
    } catch (e) { chk('金球-多层已烘焙', false, e.message); }
    // 高速抛出：|v| = 1500px/s = 25px/步，远高于 TRAIL_MIN_SPEED(7px/步)
    L('throw=' + window.__pbPlace(0, 200, 320, 1500, -60));
  }, 100);

  const iv = setInterval(() => {
    const d = window.__pbDiag();
    const t = Date.now() - t0;
    if (d.trailBalls > trailPeak) trailPeak = d.trailBalls;
    if (d.fxRings > ringPeak) ringPeak = d.fxRings;
    if (d.fxParts > partPeak) partPeak = d.fxParts;

    if (!trailChecked && t > 500) {
      trailChecked = true;
      chk('拖尾-飞行球留下残影', trailPeak >= 1, 'trailBalls峰值=' + trailPeak);
    }
    if (!scored && t > 600) {
      scored = true;
      L('score-trigger=' + window.__pbScore());
    }
    if (!done && t > 2000) {
      done = true;
      clearInterval(iv);
      chk('进球-有光环生成', ringPeak >= 1, 'fxRings峰值=' + ringPeak);
      chk('进球-有粒子生成', partPeak >= 20, 'fxParts峰值=' + partPeak);
      chk('进球-计分生效', d.score >= 2, 'score=' + d.score);
      L('运行时 drawCalls=' + d.drawCalls + ' fxCalls=' + d.fxCalls + ' idle=' + d.idle);
      L('汇总 pass=' + pass + ' fail=' + fail + '  (+' + t + 'ms)');
      L('done');
    }
  }, 100);
})()
