/**
 * tools/verify-maxballs-restore.js -- 200 球**存盘 → 重启恢复**的验收夹具。
 *
 * WHY THIS EXISTS
 *   上限改到 200 之后，`ballStates`（上次退出时的球位数组，用于下次恢复）在满配时
 *   会有 200 条。这条链路有两个只在高球数下才暴露的风险：
 *     · 存盘时机在 quitApp 里，200 条 JSON 的写入不该拖慢退出；
 *     · 启动恢复 `spawnBalls()` 是逐颗 addBall()，200 颗不能卡住首帧。
 *   所以判据要**跨进程**：这一趟只负责把 200 颗摆好并落盘，重启后看能不能恢复回来。
 *
 * 用法（两趟）
 *   第一趟（写）：
 *     ./DesktopBasketball.exe --no-gpu --user-data-dir="$T" \
 *       --eval="$(cat tools/verify-maxballs-restore.js)" \
 *       --capture="$T\a.png" --capture-delay=6000 --exit-after=12000
 *   第二趟（读）：同样命令但不带 --eval（或带下文 READ probe 注释里的脚本）
 *     grep '\[MBR\]' "$T/runtime.log"
 *
 * ⚠️ 结尾不带分号（原因见 verify-maxballs.js 头部）。
 */
(function () {
  const L = (s) => console.log('[MBR] ' + s);
  (async function () {
    const n = window.__pbSetBalls(200);
    L('已摆好 ' + n + ' 颗，等退出时落盘');
    L('done');
  })();
})()
