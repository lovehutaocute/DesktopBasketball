(function () {
  const mk = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    // 覆盖 index.html 里的 canvas{position:fixed}
    c.style.cssText = 'position:static;left:auto;top:auto;display:block;background:#eef1f6';
    return c;
  };

  const stat = mk(900, 520), dyn = mk(900, 520);
  const R = new PB.Renderer(dyn, stat);

  function ballAt(g, cx, cy, r, angle, shadow) {
    if (shadow) {
      g.globalAlpha = 0.92;
      g.drawImage(R.shadowTex, cx + 5 - r * 1.15, cy + 7 - r * 0.975, r * 2.30, r * 1.95);
      g.globalAlpha = 1;
    }
    g.save();
    g.translate(cx, cy);
    g.drawImage(R.ballBase, -r, -r, r * 2, r * 2);
    g.save(); g.rotate(angle); g.translate(-r, -r); g.drawImage(R.ballSeam, 0, 0, r * 2, r * 2); g.restore();
    g.drawImage(R.ballHi, -r, -r, r * 2, r * 2);
    g.restore();
  }

  // ---- 球放大
  const balls = mk(640, 640);
  const bg = balls.getContext('2d');
  bg.imageSmoothingQuality = 'high';
  ballAt(bg, 170, 170, 140, 0, true);
  ballAt(bg, 470, 470, 140, 1.9, true);

  // ---- 真实尺寸
  const sizes = mk(340, 150);
  const sg = sizes.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  [[26, 46], [38, 150], [54, 258]].forEach(([r, x]) => ballAt(sg, x, 76, r, 0.35, true));

  // ---- 篮球架：按 physics.js 的公式在 900x520 上重建，再裁切放大
  const w = 900, h = 520;
  const tube = 7, openW = 102, span = openW + tube * 2;
  const boardW = 120, boardH = 94;
  const boardRight = w - 24;
  const boardLeft = boardRight - boardW;
  const rimY = Math.max(180, h - 322);
  const boardY = rimY + 10 - boardH / 2;
  const cx = boardLeft + 4 - span / 2;
  const hoop = {
    enabled: true, cx, rimY, openW, span, tube,
    boardX: boardLeft + boardW / 2, boardY, boardW, boardH, boardLeft,
    boardRight: boardLeft + boardW, netLen: 82, netT: 0, netAnim: 0, flash: 0,
  };

  R.resize(w, h, 1);
  R.drawHoopStatic(hoop);
  const dg = R.dctx;
  dg.clearRect(0, 0, w, h);
  R.drawNet(dg, hoop, 0, 0);
  R.drawRimFront(dg, hoop);
  R.drawBall(dg, { r: 34, body: { position: { x: cx, y: rimY - 66 }, angle: 0.4, velocity: { x: 0, y: 0 } } }, R);
  R.drawBall(dg, { r: 34, body: { position: { x: cx - 26, y: rimY - 190 }, angle: 1.1, velocity: { x: 0, y: 0 } } }, R);

  const comb = mk(w, h);
  const cg = comb.getContext('2d');
  cg.drawImage(R.stat, 0, 0);
  cg.drawImage(R.dyn, 0, 0);

  const sx = cx - span / 2 - 60, sy = boardY - boardH / 2 - 40;
  const sw = (boardRight + 40) - sx, sh = (rimY + hoop.netLen + 50) - sy;
  const hw = 700, hh = Math.round(hw * sh / sw);
  const hc = mk(hw, hh);
  const hg = hc.getContext('2d');
  hg.imageSmoothingQuality = 'high';
  hg.drawImage(comb, sx, sy, sw, sh, 0, 0, hw, hh);

  // ---- 铺到页面上
  const old = document.getElementById('__preview');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = '__preview';
  host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;' +
    'background:#eef1f6;font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#222;' +
    'overflow:hidden;display:flex;gap:10px;padding:10px;align-items:flex-start';

  const card = (label, cv) => {
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:6px';
    const cap = document.createElement('div');
    cap.textContent = label;
    cap.style.cssText = 'font-size:12px;color:#555';
    box.appendChild(cap); box.appendChild(cv);
    return box;
  };

  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  col.appendChild(card('真实尺寸对照 52 / 76 / 108 px 直径', sizes));
  col.appendChild(card('篮球架放大 ' + (hw / sw).toFixed(2) + 'x（含球穿过篮圈的关系）', hc));

  host.appendChild(card('篮球放大（左：缝线朝上　右：旋转 109°）', balls));
  host.appendChild(col);
  document.body.appendChild(host);
  return 'preview-ok';
})()
