/**
 * tools/verify-residue.js —— 长文本飘字的「脏块残影」验收（--eval 注入渲染进程）。
 *
 * 背景：脏块是唯一决定"哪块画布被清掉重画"的东西。飘字的包围盒早先写死 96×52，
 * 成就横幅 / 成就列表这类长文本会超出这个盒子 —— 超出的像素落在没被标脏的块里，
 * 那些块从不清除，于是每次飘字都往画布上叠一层擦不掉的残影。
 *
 * 判据（用像素说话，不靠肉眼）：
 *   inkBefore ≈ 0        —— 起始该区域是空的
 *   inkDuring > 0        —— 横幅/列表真的画上去了
 *   inkAfter  === 0      —— 特效过期后必须**完全**擦干净（有残影就会 > 0）
 *
 * 用法：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --eval="$(cat tools/verify-residue.js)" --exit-after=16000
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(700);

  // 把仅有的一颗球挪到左上角，免得它污染取样区
  window.__pbSetBalls(1);
  window.__pbPlace(0, 110, 70, 0, 0);
  window.__pbGolden('clear');
  await wait(400);

  const W = window.innerWidth, H = window.innerHeight;
  const y0 = Math.max(96, H * 0.17);
  const box = [Math.round(W / 2 - 210), Math.round(y0 - 30), 420, 350];
  const sample = () => window.__pbInk(box[0], box[1], box[2], box[3]);

  const out = { box: box };
  window.__pbAchievements('reset');     // 必须先清空，否则"已解锁过"不出横幅，测试直接失效
  await wait(150);
  out.inkBefore = sample();

  // 1) 成就横幅（长文本 + 彩带）
  window.__pbUnlock('swish');
  window.__pbUnlock('combo3');
  window.__pbUnlock('record');
  await wait(500);
  out.inkBanner = sample();
  await wait(4600);                     // 横幅 life 2000 + 粒子 life ≤ 2000，留足余量
  out.inkAfterBanner = sample();

  // 2) 成就列表（13 行长文本，最容易越界）
  window.__pbAction('achievements');
  await wait(500);
  out.inkList = sample();
  await wait(4400);                     // 列表 life 3400
  out.inkAfterList = sample();

  out.pass = out.inkBefore === 0 && out.inkBanner > 0 && out.inkAfterBanner === 0 &&
             out.inkList > 0 && out.inkAfterList === 0;
  return out;
})()
