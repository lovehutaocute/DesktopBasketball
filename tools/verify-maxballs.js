/**
 * tools/verify-maxballs.js -- 球数上限（config.maxBalls = 200）的验收夹具。
 *
 * WHY THIS EXISTS
 *   "上限"这种东西最典型的坏法不是"数字写错"，而是**限制根本没生效**：
 *   `addBall()` 里那条 `world.balls.length >= cfg.maxBalls` 守卫一旦被绕过
 *   （新加的路径直接 `world.addBall()` 不上限、批量接口漏判……），球就能无限涨。
 *   用户那边表现为"越玩越卡、最后崩"，而日志里什么都没有。
 *   → 判据不能是"读一下 cfg.maxBalls"，必须**真的往里塞超过上限的球，看能不能塞进去**。
 *
 * 判据
 *   1. 上限值 = 200（默认）
 *   2. __pbSetBalls(200) 真的给出 200 颗
 *   3. 再 __pbAddBalls(+20) 仍停在 200（被挡住，不是 220）—— 核心判据
 *   4. 200 球下 diag 自洽（balls=200，主循环没被打死）
 *
 * ⚠️ 结尾**不要写分号**：主进程是 `executeJavaScript('(' + script + ')')`，
 *    **它自己会再套一层括号**。脚本以 IIFE + `;` 结尾时套完变成
 *    `( (function(){...})(); )` → `Uncaught SyntaxError: Unexpected token ';'`。
 *    写成 `})()` 就对了（`verify-fx.js` 也是同一原因不能带结尾分号）。
 *
 * ⚠️ 用法（`--screencap` 会把后面的参数吃掉，不要加）：
 *   unset ELECTRON_RUN_AS_NODE
 *   cp "$APPDATA/DesktopBasketball/config.json" "$T/config.json"   # 见 README §7.9 告警
 *   ./dist/DesktopBasketball-win32-x64/DesktopBasketball.exe --no-gpu \
 *     --user-data-dir="$WIN_T" --eval="$(cat tools/verify-maxballs.js)" \
 *     --capture="$WIN_T\\mb.png" --capture-delay=7000 --exit-after=13000
 *   grep '\[MB\]' "$T/runtime.log"
 */
(function () {
  const L = (s) => console.log('[MB] ' + s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  (async function () {
    let pass = 0, fail = 0;
    const check = (ok, name, extra) => {
      (ok ? pass++ : fail++);
      L((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    };

    const d0 = window.__pbDiag();
    const max = d0.maxBalls;
    check(max === 200, '上限=200', 'maxBalls=' + max);

    const n = window.__pbSetBalls(200);
    check(n === 200, 'setBalls(200) 给出 200 颗', 'balls=' + n);

    // 核心：直接试着塞第 201 颗。涨上去就说明守卫没生效。
    const over = window.__pbAddBalls(20);
    check(over === 200, '超出上限被挡住', '塞 +20 后 balls=' + over +
          (over === 200 ? ' OK' : ' !! 涨到 ' + over));

    await wait(700);
    const d = window.__pbDiag();
    check(d.balls === 200, '200 球下 diag 自洽', 'balls=' + d.balls +
          ' draws=' + d.draws + ' drawMs=' + d.drawMs + ' fps=' + d.fps);

    L('汇总 pass=' + pass + ' fail=' + fail);
    L('done');
  })();
})()
