/**
 * tools/verify-features2.js —— 玩法增强包 #2 的自测脚本（用 --eval 注入渲染进程）。
 *
 * 覆盖：皮肤切换与纹理烘焙 / 成就解锁（幂等）/ 记分板区域上报 / 金球双倍分 /
 *      瞄准预测与真实飞行的一致性。
 *
 * 用法（⚠️ 必须同时带 --diag，否则 startCaptureTools 在守卫处直接 return，
 * --eval 与 --exit-after 都不会被处理，进程会一直挂着）：
 *
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --eval="$(cat tools/verify-features2.js)" --exit-after=20000
 *
 * 结果写在 %APPDATA%\DesktopBasketball\runtime.log 的 `EVAL ok {...}` 一行。
 * 期望：texCache 5（用完金球后 6）；aim.predicted.apexY ≈ real.apexY（±6px）；
 * goldenScore.delta = 6（金球空心）。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  await wait(400);

  // ---------- 1. 皮肤：逐个切一遍，再走一次「循环切换」 ----------
  out.skins = [];
  for (const name of window.PB.SKIN_ORDER) out.skins.push(window.__pbSkin(name));
  out.skinAfterCycle = window.__pbSkin('next');
  out.texAfterSkins = window.__pbDiag().texCache;
  window.__pbSkin('classic');

  // ---------- 2. 成就：switchUnlock 已解锁 → 再解锁应返回 false ----------
  out.achBefore = window.__pbAchievements().filter((a) => a.got).length;
  out.unlockStyleAgain = window.__pbUnlock('style');
  out.achAfter = window.__pbAchievements().filter((a) => a.got).length;

  // ---------- 3. 记分板：区域上报开/关 ----------
  out.hudDefault = window.__pbHud();
  out.hudRect = window.__pbDiag().hud;
  window.__pbHud(false);
  out.hudHiddenRect = window.__pbDiag().hud;
  window.__pbHud(true);

  // ---------- 4. 金球：强制把 0 号球变金，再空心投进 → 3×2 = 6 分 ----------
  window.__pbReset();
  await wait(200);
  out.goldenSpawn = window.__pbGolden('spawn', 0);
  out.goldenInDiag = window.__pbDiag().goldenBalls;
  const s1 = window.__pbScoreState();
  window.__pbScore();                       // 0 号球从圈上方垂直落下（不碰框 = 空心）
  await wait(1600);
  const s2 = window.__pbScoreState();
  out.goldenScore = {
    before: s1.score, after: s2.score, delta: s2.score - s1.score,
    last: s2.last,
  };
  out.goldenAfter = window.__pbGolden();
  out.texAfterGold = window.__pbDiag().texCache;

  // ---------- 5. 瞄准预测 vs 真实飞行（同一组出手速度） ----------
  window.__pbReset();
  await wait(300);
  window.__pbPlace(0, Math.round(window.innerWidth * 0.45), window.innerHeight - 170, 0, 0);
  await wait(80);
  out.aim = await window.__pbAimTrace(-380, -700);

  // ---------- 6. 收尾 ----------
  const d = window.__pbDiag();
  out.diag = {
    skin: d.skin, score: d.score, ach: d.achievements,
    golden: d.goldenBalls, texCache: d.texCache, idle: d.idle,
  };
  window.__pbReset();
  window.__pbGolden('clear');
  window.__pbSkin('classic');
  return out;
})()
