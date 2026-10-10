/**
 * tools/probe-menu.js —— 右键菜单「球皮肤」点击链路自测（渲染进程内）。
 * 用法同 probe-skin.js。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  const dyn = document.getElementById('dyn');
  const g = dyn.getContext('2d');
  const ballPx = () => {
    const d = window.__pbDiag();
    const p = d.pos[0];
    if (!p) return null;
    const x = Math.round(p[0] * d.dpr), y = Math.round(p[1] * d.dpr);
    const t = g.getImageData(x, y, 1, 1).data;
    return [t[0], t[1], t[2], t[3]];
  };

  await wait(400);
  out.skin0 = window.__pbSkin();
  out.px0 = ballPx();

  // 打开右键菜单（真实 DOM）
  window.__pbOpenMenu(700, 300);
  await wait(300);
  const menu = document.getElementById('menu');
  out.menuItems = Array.from(menu.querySelectorAll('.mi')).map((el) => el.getAttribute('data-id'));
  const item = menu.querySelector('.mi[data-id="cycle-skin"]');
  out.itemFound = !!item;
  out.itemRect = item ? (() => { const r = item.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null;

  // 真实派发一次 pointerdown（与用户点击同一条链路）
  if (item) {
    const r = item.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    });
    item.dispatchEvent(ev);
    out.dispatched = true;
    out.defaultPrevented = ev.defaultPrevented;
  }
  await wait(500);
  out.menuOpenAfter = window.__pbDiag().menuOpen;
  out.skin1 = window.__pbSkin();
  out.px1 = ballPx();

  return out;
})()
