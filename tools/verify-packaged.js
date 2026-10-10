/**
 * tools/verify-packaged.js —— 打包版验收夹具（见 README §7.9）
 *
 * 回答三个"只在打包后才成立"的问题：
 *   ① preload 能不能从 **asar 内部** 读出球皮肤素材，并转成 data URL？
 *      （开发环境读的是真实目录，asar 走的是 Electron 给 fs 打的补丁，路径行为不同）
 *   ② 渲染进程真的把素材烘成了球面贴图，而不是退回程序化兜底？
 *   ③ 球数上限是不是 100？
 *
 * 用法：
 *   unset ELECTRON_RUN_AS_NODE
 *   EXE --no-gpu --user-data-dir="$TEMP/pb-verify" \
 *       --eval="$(cat tools/verify-packaged.js)" \
 *       --capture="$TEMP/pb-verify/skins.png" --capture-delay=8000
 *
 * ⚠️ 两个必须遵守的写法（都踩过，见 README §8）：
 *   1. **必须是可调用的 IIFE**（末尾的 `)()`）。main.js 只做 `'(' + script + ')'` 包裹，
 *      传裸的 `()=>{...}` 只会得到一个函数对象 → Electron 报
 *      `EVAL fail An object could not be cloned.`，**而且函数体一行都不执行**。
 *   2. **结果用 console.log 输出，不要靠返回值**。返回值里塞了活对象（`world`、DOM 节点）
 *      同样会被判为不可克隆。渲染进程的 console 会被主进程转发进 runtime.log
 *      （前缀 `[renderer:LEVEL]`），比返回值可靠得多。
 */
(() => {
  const L = (m) => console.log('[VERIFY] ' + m);

  // ---- ① 素材是否从 asar 读出来了（**按需单张**，所以逐张请求、逐张等结果）----
  // 素材改成"切到那张皮肤时才取"之后（见 main.js::get-texture），这里不能再一次性
  // window.dbb.textures() 拿全部 —— 那个接口已经不存在了。逐张取，顺便验证异步链路通。
  const texNames = ['watermelon', 'earth', 'jupiter'];
  const texTask = Promise.all(texNames.map(async (n) => {
    try {
      const url = await window.dbb.texture(n);
      // data URL 长度 ≈ 原字节 ×4/3；顺手把前缀也校验一下，免得拿到空串当成成功
      const ok = typeof url === 'string' && url.indexOf('data:image/jpeg;base64,') === 0 && url.length > 1000;
      L('texture[' + n + ']=' + (ok ? url.length + 'B ✓' : (url === null ? 'null ✗ 读不到' : '✗ 格式不对')));
      return ok;
    } catch (e) { L('texture[' + n + '] ✗ ' + e.message); return false; }
  }));

  // ---- ② 皮肤表 ----
  const names = (typeof PB !== 'undefined' && PB.SKIN_ORDER) || null;
  L('skinOrder=' + JSON.stringify(names));
  L('skinImg=' + JSON.stringify(typeof PB !== 'undefined' ? Object.keys(PB.SKIN_IMG) : null));

  // ---- ③ 球数上限 ----
  L('setBalls(0)=' + window.__pbSetBalls(0));
  const n = names ? names.length : 6;
  L('setBalls(' + n + ')=' + window.__pbSetBalls(n));
  L('drawCalls=' + window.__pbDiag().drawCalls + ' texCache=' + window.__pbDiag().texCache);

  // ---- ④ 把每颗球指定成不同皮肤、逐帧钉住位置，让截图里六套并排 ----
  if (names) {
    const W = innerWidth, H = innerHeight;
    const gap = W / (names.length + 1);
    const y = Math.round(H * 0.42);
    const xs = names.map((s, i) => Math.round(gap * (i + 1)));
    names.forEach((s, i) => window.__pbBallSkin(i, s));
    // 每 16ms 把球拉回原位并清零速度：等效于"悬停"，球不再下落/滚动
    setInterval(() => { for (let i = 0; i < names.length; i++) window.__pbPlace(i, xs[i], y, 0, 0); }, 16);
    L('pinned=' + JSON.stringify(xs) + ' y=' + y + ' W=' + W + ' H=' + H);

    setTimeout(() => {
      const d = window.__pbDiag();
      L('after=' + JSON.stringify({ balls: d.balls, drawCalls: d.drawCalls, texCache: d.texCache, mip: d.mip }));
      L('如果 texCache == 皮肤数，说明每套皮肤都烘出了独立贴图（素材生效）；' +
        '若素材缺失会退回程序化兜底，数量一样但截图里看不到真实花纹');
    }, 1500);
  }

  // ---- ⑤ 性能卡 ----
  // 为什么必须验：`renderer.lastDrawMs` 曾经没在 Renderer 构造函数里初始化，而主循环的
  // 早退分支会在第一次 frame() 之前就调 updatePerf() → 性能卡那行 `.toFixed(2)` 抛
  // TypeError → `requestAnimationFrame` 永不执行 → 循环停摆（球不画 / 按钮没反应）。
  // 只在 showPerf 打开时才走到那几行，所以**默认配置的验收永远是绿的**。
  // 见 README §7.9 与 §8。
  if (window.__pbPerf) {
    window.__pbPerf(true);
    setTimeout(() => {
      const el = document.getElementById('perf');
      const txt = el ? String(el.textContent) : '';
      L('perfPanel display=' + (el ? el.style.display : '?') + ' chars=' + txt.length +
        (txt.length > 40 ? ' ✓ 有内容' : ' ✗ 空白 —— 主循环大概率已异常停摆'));
      L('perfText=' + txt.replace(/\n/g, ' | ').slice(0, 200));
      const d = window.__pbDiag();
      L('loopAlive balls=' + d.balls + ' drawCalls=' + d.drawCalls + ' drawMs=' + d.drawMs);
    }, 1500);
  }

  // 素材是异步取的（切皮肤才取），所以判据必须在 promise 落地**之后**再汇总，
  // 否则脚本会先打印 done 就退出，那几条 texture[..] 永远不会被执行到。
  texTask.then((r) => {
    L('texturesAll=' + (r.every(Boolean) ? '3/3 ✓' : r.filter(Boolean).length + '/3 ✗ 有缺失'));
  });

  L('done');
})()
