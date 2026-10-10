/**
 * tools/probe-skin.js —— 皮肤/特效/性能面板 的**渲染进程内**自测（不依赖真实截图）。
 *
 * 用法（必须带 --diag，见 verify-features.js 顶部说明）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe . --no-gpu --diag \
 *     --user-data-dir=<临时目录> --eval="$(cat tools/probe-skin.js)" --exit-after=9000
 *
 * 关键判据：**球心像素的颜色分量**。canvas 的 getImageData 读的是渲染进程自己的
 * 合成结果，不受 SetWindowRgn 裁剪影响 —— 于是"皮肤到底换没换"能被直接量出来，
 * 与"窗口区域是否把它裁掉"完全解耦（这两个问题以前老是被混在一起）。
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
    return { at: [p[0], p[1]], rgba: [t[0], t[1], t[2], t[3]] };
  };

  await wait(400);
  out.skin0 = window.__pbSkin();
  out.px0 = ballPx();

  // 直接切（等价于菜单里的「球皮肤」循环切换）
  out.skin1 = window.__pbSkin('next');
  await wait(500);
  out.px1 = ballPx();

  out.skin2 = window.__pbSkin('next');
  await wait(500);
  out.px2 = ballPx();

  out.diag = (() => {
    const d = window.__pbDiag();
    return { w: d.w, h: d.h, dpr: d.dpr, skin: d.skin, texCache: d.texCache,
             hud: d.hud, bars: d.bars, hoopRects: d.hoopRects, hoops: d.hoops };
  })();

  // 性能面板 / toast 的 DOM 几何（用来判断它们是否被算进窗口区域）
  const rectOf = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  out.perfRect = rectOf('perf');
  out.toastRect = rectOf('toast');
  out.perfDisplay = document.getElementById('perf').style.display;

  // 区域里到底有哪些矩形？sendShape 的输入是私有的，这里用「球心圆 + 已知 DOM 矩形」
  // 反推不了，所以直接暴露一次：让 #perf 可见后重报形状，再由主进程日志核对。
  window.__pbPerf(true);
  await wait(400);
  out.inkInPerf = window.__pbInk(out.perfRect[0] + 2, out.perfRect[1] + 2,
                               out.perfRect[2] - 4, out.perfRect[3] - 4);

  return out;
})()
