/**
 * tools/verify-barsettings.js —— 控制栏「设置」按钮（⚙）的一次性自测（用 --eval 注入渲染进程）。
 *
 * 用法（⚠️ 必须带 --diag，否则 startCaptureTools 在守卫处 return，--eval / --exit-after 都不生效；
 * ⚠️ 脚本结尾不能带分号 —— 主进程会再套一层括号，IIFE 后面跟 `;` 会变成语法错误、一条断言都不输出）：
 *
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir=/tmp/dbb-cfg --exit-after=6000 \
 *     --eval="$(cat tools/verify-barsettings.js)"
 *
 * 结果写在 %APPDATA%\<user-data-dir>\... 对应 runtime.log 的 `EVAL ok {...}` 一行。
 *
 * 断言覆盖四件事：
 *   ① 两侧控制栏都有 ⚙，且它排在 ＋ 之前（＋/－ 相对底角的位置与旧版一致）
 *   ② ⚙ 落在 window 区域里（barRects 量的是整条 .bar 的外接矩形）+ 尺寸/对齐与 ＋ 一致
 *   ③ 点 ⚙ 能开设置菜单，菜单在窗口内、且**不遮挡它自己的按钮**（preferAbove 上翻）
 *   ④ 点 ＋ 只加球、不开菜单（stopPropagation 生效，没被当成"挑选篮球/开菜单"）
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { ok: [], bad: [] };
  const T = (name, cond, info) => (cond ? out.ok : out.bad).push(name + (info !== undefined ? ' | ' + info : ''));
  const press = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    pointerId: 7, button: 0, buttons: 1,
  }));
  const mid = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2, r];
  };

  await wait(320);
  const L = document.getElementById('barL');
  const R = document.getElementById('barR');
  const lc = L.querySelector('.cfg'), rc = R.querySelector('.cfg');
  const la = L.querySelector('.add');

  T('两侧控制栏都有 ⚙', !!lc && !!rc);
  T('⚙ 在列首：+/− 位置未变',
    L.children[0] === lc &&
    L.children[1].classList.contains('add') && L.children[2].classList.contains('del'),
    Array.prototype.map.call(L.children, (c) => c.className).join(','));

  const [, , lr] = mid(lc);
  T('⚙ 尺寸与 +/− 一致（32×32）', Math.round(lr.width) === 32 && Math.round(lr.height) === 32,
    lr.width + 'x' + lr.height);
  T('⚙ 与 + 同列（左边缘对齐）', Math.abs(lr.left - la.getBoundingClientRect().left) < 0.6);
  T('⚙ 在 +/− 上方', lr.bottom <= la.getBoundingClientRect().top + 0.6);

  // ② 区域覆盖：bars[] 是整条控制栏的外接矩形，必须把 ⚙ 也框进去
  const d0 = window.__pbDiag();
  const covered = (d0.bars || []).some((b) =>
    b[0] <= lr.left && b[1] <= lr.top && b[0] + b[2] >= lr.right && b[1] + b[3] >= lr.bottom);
  T('窗口区域覆盖 ⚙（barRects 已含新按钮）', covered, JSON.stringify(d0.bars));

  // ③ 点 ⚙ → 设置菜单
  const [lcx, lcy] = mid(lc);
  press(lc, lcx, lcy);
  await wait(140);
  const d1 = window.__pbDiag();
  T('点 ⚙ 打开设置菜单', d1.menuOpen === true);
  const m = d1.menu;
  T('菜单完整落在窗口内',
    !!m && m[0] >= 0 && m[1] >= 0 && m[0] + m[2] <= d1.w && m[1] + m[3] <= d1.h,
    JSON.stringify(m) + ' win=' + d1.w + 'x' + d1.h);
  // ⚠️ diag.menu / diag.bars 都是**外扩 4px** 的窗口区域矩形（menuRect/barRects 的
  //    上报口径），比真实可见框大一圈 —— 判"不遮挡"要按真实框比，否则差 4px 就误报。
  const MENU_PAD = 4;
  T('菜单不遮挡 ⚙ 按钮（向上展开）',
    !!m && m[1] + m[3] - MENU_PAD <= lr.top + 1,
    'menuBottom=' + (m ? m[1] + m[3] - MENU_PAD : '?') + ' ⚙top=' + Math.round(lr.top));
  T('菜单项齐全（设置清单与右键同一份）',
    document.querySelectorAll('#menu .mi').length >= 15,
    document.querySelectorAll('#menu .mi').length + ' 项');

  // 点空白处：关菜单，且不因此抓起篮球
  press(document.body, d1.w / 2, d1.h / 2);
  await wait(120);
  T('点空白关闭菜单', window.__pbDiag().menuOpen === false);

  // ④ 右侧 ⚙ 同样可用，且不越界
  const [rcx, rcy] = mid(rc);
  press(rc, rcx, rcy);
  await wait(140);
  const d2 = window.__pbDiag();
  const m2 = d2.menu;
  T('右下角 ⚙ 同样打开菜单', d2.menuOpen === true);
  T('右侧菜单不越左右边界',
    !!m2 && m2[0] >= 0 && m2[0] + m2[2] <= d2.w, JSON.stringify(m2));
  press(document.body, d2.w / 2, d2.h / 2);
  await wait(120);

  // ⑤ 点 ＋：只加球，不开菜单
  // ⚠️ 必须对**球数上限**免疫：用户真实配置里 `ballCount` 可能正好顶在 `maxBalls = 200`
  //    （球数上限，不是推荐值，见 README §2.12.1）—— 此时 ＋ 本来就不该加进去，
  //    断言写成"必须 +1"会把夹具的脆读成代码回归（本会话踩过一次：200 → 200 报 FAIL）。
  const d0b = window.__pbDiag();
  const balls0 = d0b.balls, capBalls = d0b.maxBalls;
  const [ax, ay] = mid(la);
  press(la, ax, ay);
  await wait(140);
  const d3 = window.__pbDiag();
  T('点 ＋ 加一颗球（已在上限则保持不变）', d3.balls === Math.min(balls0 + 1, capBalls),
    balls0 + ' → ' + d3.balls + '（上限 ' + capBalls + '）');
  T('点 ＋ 不会顺带打开菜单', d3.menuOpen === false);
  T('点 ＋ 不会顺带抓起球', d3.dragging === false);

  // ⑥ 回归：右键那条路径仍必须"向下展开"（preferAbove 默认关，旧行为不能被改掉）
  window.__pbOpenMenu(600, 80);
  await wait(120);
  const d4 = window.__pbDiag();
  T('右键路径仍向下展开（旧行为未变）',
    !!d4.menu && Math.abs(d4.menu[1] - (80 - MENU_PAD + 2)) <= 2,
    'menuTop=' + (d4.menu ? d4.menu[1] : '?') + ' 期望≈' + (80 - MENU_PAD + 2));
  press(document.body, d4.w / 2, d4.h / 2);
  await wait(100);

  out.pass = out.bad.length === 0;
  return out;
})()
