'use strict';
/**
 * render.js —— 渲染层（脏矩形 + 分层画布）
 *
 * 设计要点：
 *  1) 双画布分层：#static 只画静态的篮球框（开关时重绘一次），#dyn 画球/粒子/特效。
 *     球的重绘永远不会重画篮球框，直接砍掉一大块每帧开销。
 *  2) 脏块渲染：画布切成 TILE×TILE 的块，只有「本帧有活动元素」的块才 clear + 重绘。
 *     所有球都休眠时，一帧的脏块数为 0 → 完全不碰画布。
 *  3) 状态留在画布上：休眠的球不需要每帧重画，它的像素就留在那里。
 */
(function () {
  const PB = (window.PB = window.PB || {});
  window.__pbRMark('render-start');
  const TILE = 128;
  const TAU = Math.PI * 2;
  /**
   * 运动拖尾（见 drawTrail / updateTrail）。
   *
   * `TRAIL_MIN_SPEED` 用 **px/步** 计（与 physics.js 的单位约定一致，别再乘 60）：
   * 8 px/步 = 480 px/s，低于它的球基本是"在角落里慢慢滚"，留残影只会显得脏。
   * 静止/慢球走的是 `!fast` 分支 —— 不记录、不占内存、不给包围盒加尺寸。
   */
  const TRAIL_MIN_SPEED = 7;
  /**
   * 历史点上限。**这个数字直接决定火舌的长度**（点距固定为 TRAIL_SEG）：
   * 火焰跨度 ≈ TRAIL_MAX · TRAIL_SEG = 24 · 3.5 ≈ 84px ≈ 2.8r，与球径同量级 ——
   * 再长就从"拖尾"变成"拖把"了。
   *
   * 早先取 5 / 7 时点距是**变速的**（一步一点），火舌长度随速度线性涨；
   * 现在点距恒定，长度也就恒定了，反而更好控制（见 updateTrail 的补点说明）。
   */
  const TRAIL_MAX = 24;
  const TRAIL_MIN_GAP = 2.5;    // 相邻历史点至少隔这么多像素，避免慢速时堆成一坨
  /**
   * 补点步长（px）：把球这一步的位移切成这么长的小段，逐段记点。
   * 必须**明显小于火舌单段直径**（≈2r=60px，r=30），否则加法混合下相邻火舌不重叠、
   * 拖尾会断成几团白斑 —— 高速时尤其明显。3.5px 在 100 球档也完全够快。
   */
  const TRAIL_SEG = 3.5;
  /**
   * 火舌的**枚数**。位置由"球心 → 历史最外点"线性插值取，与历史点密度解耦。
   *
   * 9 枚是叠加与连续性的折中：太少（<6）火舌在拐弯处会断成段，太多（>14）
   * 则每枚太薄、看不出锥度，且绘制次数白涨。
   */
  const FIRE_STEPS = 9;
  /**
   * 每帧最多画这么多次残影（全局预算，不是每颗球）。
   *
   * 100 球同时在高速飞行时，若每球都画满 4 个残影就是 400 次绘制 —— 而本项目的
   * 瓶颈恰恰是**每帧绘制调用次数**（README §2.12：180 次 → 60fps，240 次 → 54fps）。
   * 拖尾纯属装饰，宁可让排在后半段的球少画两笔，也不能把帧率拖下去。
   */
  const TRAIL_BUDGET = 96;
  /**
   * 火焰拾色（2026-10-06）：残影不再用球贴图，改成按「距球远近」取色的火舌。
   *
   * 关键不是颜色表本身，而是**它是自发光**：`_blob` 上一律 `'lighter'` 叠加。
   * 早先版本靠"球贴图 × 加法"出亮度，结果贴图边缘的暗部把火焰染成灰褐色
   * （照片级皮肤边缘本来就压得很暗）——所以现在**不再采样球贴图**，火舌纯粹由
   * 这几档颜色 + 加法堆出来，跟球皮肤解耦。球贴图只在 `ghost` 样式里用。
   */
  const FIRE = ['#ffd9a0', '#ffab35', '#ff7a16', '#e8450a', '#8f1d04'];
  function fireColor(k) {
    const x = Math.max(0, Math.min(1, k)) * (FIRE.length - 1);
    return FIRE[Math.round(x)];
  }

  /** 可复现的伪随机（避免每次启动颗粒分布跳变） */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { canvas: c, ctx: c.getContext('2d') };
  }

  /**
   * 篮圈椭圆的透视压扁量（半长轴 → 半短轴）。
   * 取 0.26 而不是更扁的值：太扁时前后两段弧会并成一块橙色实心饼，
   * 圈里那个"洞"就没了 —— 而"洞"正是篮圈区别于一块椭圆板的唯一特征。
   */
  const rimSquash = (rx) => Math.max(7.5, rx * 0.26);

  /**
   * 球皮肤调色板。
   *
   * 烘焙流程（bakeTextures）完全不变，只是把原先写死的颜色抽成了字段 ——
   * 于是 5 套主题 + 金球共用同一套多层光照算法，切换主题不需要另一份绘制代码。
   *
   * 字段含义：
   *   grad   底色径向渐变的色标（8 段，左上受光 → 右下入暗）
   *   patA/B 中频斑驳的暗色 / 亮色          grainA/B 颗粒簇的暗色 / 亮色
   *   limb   边缘暗化基色（'r,g,b'）        bounce 右下反弹光
   *   seamA  球缝凹槽阴影  seamB 缝本体  seamC 缝的受光高光
   *   patchScale 斑驳强度倍数（足球靠它把斑块压成显眼的黑五边形块；
   *              西瓜靠它把斑块变成瓜皮条纹；默认 1 = 经典篮球那种若有若无的皮革斑）
   */
  /**
   * 素材皮肤的**球面贴图**配置：材质全部是从网上找来的真实照片/贴图，不再是手画渐变。
   *
   * 两条映射路径（mode）：
   *   'photo'    —— 源图是「一整颗水果」的照片（物体在画面里近似正圆）。
   *                 直接把照片当球面正视图重投影：圆盘上法线为 (nx,ny) 的像素，
   *                 取照片上「物体中心 + (nx,ny)·物体半径」处的颜色。
   *                 这条路径**不需要无缝贴图** —— 照片里的西瓜长什么样，球就长什么样，
   *                 连瓜皮上的划痕和胎记都一并搬过来。实测比找"西瓜无缝材质"现实得多
   *                 （真实西瓜皮的等距圆柱全景图基本找不到，但整颗瓜的照片一抓一大把）。
   *   'equirect' —— 源图是等距圆柱全景（行星贴图），按经纬度采样，可重复平铺。
   *
   * `phase` 是经度相位：把贴图转到"正面朝向最好看"的角度（否则球正面可能是一片海）。
   * 光照参数逐皮肤可调 —— 照片本身已经带了明暗，压太狠会发灰，压太轻又没有球感。
   *
   * ⚠️ 素材文件在 `src/renderer/textures/`，由 preload 读成 data URL 交给渲染进程
   *    （为什么不用 file:// 见 PB.loadSkinTexture 的注释）。
   */
  const SKIN_IMG = {
    watermelon: {
      label: '西瓜',
      tex: 'watermelon', mode: 'photo',
      // 源图已经在 melon_fit.py 里被裁成"以瓜心为中心、边长 = 2×内接圆半径"的正方形，
      // 所以圆心恒在正中间、半径恰好是半宽。rr 取 0.497 再让开一点点，
      // 免得球的最外圈吸到木桌和藤筐。
      cx: 0.500, cy: 0.500, rr: 0.497,
      // 照片自身已经带了明暗（光在左上），所以漫反射压到 0.52、环境光提到 0.52 ——
      // 再加一层强漫反射会在右下叠出第二片阴影，"照片味"立刻变成"塑料味"。
      // sat 1.16 + 高光压到 0.22：照片缩到 68px 会显得比实物淡、且左上那片
      // 自带高光会被我们的镜像高光再叠亮一次，压一压才不发白。
      ambient: 0.52, diffuse: 0.52, spec: 0.22, sheen: 0.05, limb: 0.42, sat: 1.16,
      outline: 'rgba(10,30,8,0.60)',
    },
    planet: {
      label: '地球',
      tex: 'earth', mode: 'equirect', phase: 2.05,
      ambient: 0.40, diffuse: 0.76, spec: 0.50, sheen: 0.14, limb: 0.52,
      outline: 'rgba(4,10,26,0.66)',
    },
    jupiter: {
      label: '木星',
      tex: 'jupiter', mode: 'equirect', phase: 0.60,
      ambient: 0.44, diffuse: 0.70, spec: 0.34, sheen: 0.09, limb: 0.46,
      outline: 'rgba(38,26,14,0.58)',
    },
  };

  /** 已解码的贴图像素：name -> {data:Uint8ClampedArray, w, h}。 */
  const TEXSTORE = new Map();
  /** 正在解码中的素材名，避免重复请求（用户连点托盘「球皮肤」时会撞上）。 */
  const TEX_PENDING = new Set();

  /**
   * **按需**解码一张球皮肤素材。
   *
   * **为什么不用 `file://` 直接 `<img src>`**：`file://` 页面里的 `file://` 图片在
   * Chromium 眼里算**跨源**，画进 canvas 之后画布被污染，`getImageData` 直接抛
   * SecurityError —— 而球面重投影必须逐像素读源图。绕法有三条（自定义协议 /
   * webSecurity:false / data URL），data URL 是同源、且不需要改 main.js 的任何东西，
   * 所以选它。
   *
   * ⚠️ **按需单张，而不是启动时读全部三张**（2026-10-07 启动优化）：旧实现在 boot() 里
   * 一次读走全部素材（390 KB → 520 KB base64），而默认皮肤 classic 是程序化绘制、
   * 一张都不需要 —— 等于每次启动都在首帧之前白读 390 KB。现在只有真正切到素材皮肤
   * 时才请求那一张，其余情况零开销。
   *
   * 解码是异步的；`texFor()` 在它完成前退回该皮肤的程序化调色板，完成后回调
   * `PB.onTexturesLoaded` 把缓存清掉重烘（用户看不到中间态）。
   *
   * @param {string} name 素材键（= SKIN_IMG[*].tex）
   * @returns {Promise<boolean>} 是否成功解码
   */
  PB.loadSkinTexture = function (name) {
    if (!name) return Promise.resolve(false);
    if (TEXSTORE.has(name)) return Promise.resolve(true);
    if (TEX_PENDING.has(name)) return Promise.resolve(false);   // 已在解码中，重复请求忽略
    if (!window.dbb || typeof window.dbb.texture !== 'function') {
      console.warn('[textures] preload 未暴露 texture()，素材皮肤退回程序化外观');
      return Promise.resolve(false);
    }
    TEX_PENDING.add(name);
    return Promise.resolve(window.dbb.texture(name)).then((url) => {
      if (!url) {
        console.warn('[textures] 没拿到素材 ' + name + '，该皮肤退回程序化外观');
        return false;
      }
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const c = mk(img.naturalWidth, img.naturalHeight);
            c.ctx.drawImage(img, 0, 0);
            const d = c.ctx.getImageData(0, 0, c.canvas.width, c.canvas.height);
            TEXSTORE.set(name, { data: d.data, w: d.width, h: d.height });
            if (PB.onTexturesLoaded) PB.onTexturesLoaded(name);
            resolve(true);
          } catch (e) {
            console.warn('[textures] ' + name + ' 解码失败（画布可能被污染）', e);
            resolve(false);
          }
        };
        img.onerror = () => { console.warn('[textures] ' + name + ' 加载失败'); resolve(false); };
        img.src = url;
      });
    }).catch((e) => {
      console.warn('[textures] ' + name + ' 请求失败', e);
      return false;
    }).then((ok) => {
      TEX_PENDING.delete(name);
      return ok;
    });
  };

  /** 这套皮肤需不需要素材（不需要就别去请求，见 loadSkinTexture 的按需说明）。 */
  PB.skinNeedsTexture = function (skin) {
    const p = SKINS[skin];
    return !!(p && p.img && p.img.tex);
  };
  /** 这套皮肤要的是哪张素材（不需要时返回 null）。 */
  PB.skinTextureName = function (skin) {
    const p = SKINS[skin];
    return (p && p.img && p.img.tex) || null;
  };

  const SKINS = {
    classic: {
      label: '经典篮球',
      grad: [[0.00, '#ffe0b8'], [0.07, '#ffc987'], [0.18, '#fba857'], [0.34, '#f08a2c'],
             [0.52, '#dd6d15'], [0.70, '#bd5209'], [0.86, '#93380a'], [1.00, '#5e1f05']],
      patA: '#3a1200', patB: '#ffd8ab',
      grainA: '#4a1a06', grainB: '#ffe3bd',
      limb: '58,18,0', bounce: '#ffb972', outline: 'rgba(58,20,2,0.62)',
      seamA: '#2a0f02', seamB: '#2a0f02', seamC: '#ffe0bb',
      patchScale: 1,
    },
    neon: {
      label: '能量球',
      grad: [[0.00, '#f4fcff'], [0.08, '#a6ecff'], [0.20, '#41c9ff'], [0.36, '#1a8bff'],
             [0.54, '#1250e0'], [0.72, '#0d2f9c'], [0.88, '#081a5c'], [1.00, '#040a26']],
      patA: '#001433', patB: '#d8f8ff',
      grainA: '#021a3a', grainB: '#eaffff',
      limb: '4,10,38', bounce: '#7fe8ff', outline: 'rgba(4,10,38,0.72)',
      seamA: '#021021', seamB: '#021021', seamC: '#a8f4ff',
      patchScale: 1,
    },
    soccer: {
      label: '足球',
      grad: [[0.00, '#ffffff'], [0.10, '#f3f5f8'], [0.28, '#e0e4ea'], [0.50, '#c4cad3'],
             [0.72, '#a3aab5'], [0.88, '#808893'], [1.00, '#575e68']],
      patA: '#171b22', patB: '#ffffff',
      grainA: '#2a303a', grainB: '#ffffff',
      limb: '30,34,42', bounce: '#ffffff', outline: 'rgba(24,28,34,0.72)',
      seamA: '#0f1218', seamB: '#0f1218', seamC: '#ffffff',
      patchScale: 7,
    },
    watermelon: {
      label: '西瓜',
      // 有素材时用真实西瓜照片（见 SKIN_IMG）；下面这套调色板是**素材缺失时的兜底**，
      // 保证贴图没加载出来也还是一颗能看的绿瓜，而不是一颗黑球。
      img: SKIN_IMG.watermelon,
      grad: [[0.00, '#dcffa4'], [0.10, '#aaea6c'], [0.26, '#7bd147'], [0.45, '#51b02d'],
             [0.66, '#318c20'], [0.85, '#1d6616'], [1.00, '#0d3a0c']],
      patA: '#0c3a0d', patB: '#e9ffc0',
      grainA: '#12400f', grainB: '#ebffc6',
      limb: '14,52,12', bounce: '#c8f58a', outline: 'rgba(10,44,10,0.72)',
      seamA: '#0b2f0b', seamB: '#0b2f0b', seamC: '#d8f7a6',
      patchScale: 3.4,
    },
    planet: {
      label: '地球',
      img: SKIN_IMG.planet,
      grad: [[0.00, '#cfeaff'], [0.10, '#8fd0ff'], [0.30, '#3f86d8'], [0.52, '#1c4f9c'],
             [0.72, '#123266'], [0.88, '#0a1d40'], [1.00, '#040c1e']],
      patA: '#1d5a2a', patB: '#eaf6ff',
      grainA: '#123f6b', grainB: '#ffffff',
      limb: '4,12,32', bounce: '#9fd0ff', outline: 'rgba(6,14,34,0.72)',
      seamA: '#061a33', seamB: '#061a33', seamC: '#bfe4ff',
      patchScale: 2.2,
    },
    jupiter: {
      label: '木星',
      img: SKIN_IMG.jupiter,
      grad: [[0.00, '#ffeccd'], [0.08, '#ffd9a0'], [0.22, '#e0a86e'], [0.38, '#c08a5a'],
             [0.54, '#9c6a45'], [0.72, '#6f4834'], [0.88, '#45291f'], [1.00, '#241209']],
      patA: '#6b3f22', patB: '#ffe7c2',
      grainA: '#7a4a28', grainB: '#fff0d4',
      limb: '30,17,8', bounce: '#ffcf94', outline: 'rgba(34,20,10,0.66)',
      seamA: '#2a1508', seamB: '#2a1508', seamC: '#ffe0b4',
      patchScale: 1,
    },
    gold: {
      label: '金球',
      // 三点高光池刻意偏离几何中心 —— 正中的高光是"塑料球"的读法，偏心 + 锐利镜面点才是金属。
      // ⚠️ 暗端别压太狠（早先 0.82 用 #74400a、1.00 用 #2e1a02 → 球下半部读成"黄铜/泥巴"，
      // 金球就剩不下"贵气"了）。金比铜亮、比铜冷，暗端要**亮且偏暖灰**，不是深褐。
      grad: [[0.00, '#fffef8'], [0.05, '#fff9d6'], [0.14, '#ffec9c'], [0.27, '#ffd54a'],
             [0.42, '#f5b400'], [0.58, '#cf8b06'], [0.74, '#9c6207'], [0.88, '#64400c'],
             [1.00, '#3a2606']],
      patA: '#9a6a08', patB: '#fff6c8',
      grainA: '#6b4400', grainB: '#ffeeb0',
      limb: '60,36,0', bounce: '#ffeaa0', outline: 'rgba(52,30,0,0.80)',
      seamA: '#3a2000', seamB: '#3d2400', seamC: '#fff6c8',
      patchScale: 0.30,   // 金面必须**光洁**：斑驳/颗粒按这个系数压掉
      /**
       * 高光强度分级。程序化路径用 `hiMul`（乘在已烘好的高光层上，比换一套贴图省事），
       * 素材/程序化两条路径都读 `sphere`（球面重投影的曝光），`core` 是火心般的自发光内核。
       */
      hiMul: 1.55,
      sphere: 1.05,
      core: '255,222,130',
      /** 金球专用多层烘焙的总曝光（bakeGold 里乘在渐变上）。 */
      goldGain: 1.16,
    },
  };

  class Renderer {
    constructor(dynCanvas, staticCanvas) {
      this.dyn = dynCanvas;
      this.stat = staticCanvas;
      /**
       * ⚠️ 动态层**故意不用** `desynchronized: true`（低延迟画布）。
       *
       * 那个标志让浏览器把这块画布从页面合成器里**摘出去单独呈现**，代价是它和
       * 「窗口区域（SetWindowRgn）」再没有任何同步关系 —— 而本程序的点击穿透完全
       * 依赖区域与画面同步：
       *   · 区域已经跟着球移走、画布还是上一帧 → 球沿运动方向缺一块（露在区域外）；
       *   · 区域已经缩到球当前位置、画布还停在旧位置 → 整颗球都在区域外，直接消失。
       * 静态层（篮球架/控制栏）没这个标志，所以从来不掉 —— 用户报的正是"球不见了
       * 但篮筐好好的"，这个不对称就是线索。
       *
       * 实测：`--no-gpu`（软件合成）下动态层整层都不进画面，18/18 张真实屏幕截图
       * 洋红=0，而同一帧里静态层的篮筐和 DOM 控制栏都在。去掉这个标志不会让那件事
       * 好起来（那是软件合成的另一件事），但**没有理由为了一点呈现延迟，把"球到底
       * 在不在区域里"交给一条不受控的流水线**。改回去之前请先跑
       * `--fly-test --fly-flat` + `tools/screencap.ps1` 证明动态层确实还同步。
       */
      this.dctx = dynCanvas.getContext('2d', { alpha: true });
      this.sctx = staticCanvas.getContext('2d', { alpha: true });
      this.w = 0; this.h = 0; this.dpr = 1;
      this.tw = 0; this.th = 0;
      /**
       * 验收专用：把球画成**纯洋红实心圆盘**（没有缝线、没有高光、没有阴影）。
       *
       * 为什么需要它：要判断"球在空中飞时有没有被 SetWindowRgn 削掉一块"，就得
       * 从真实屏幕截图里量出球的轮廓。实测中这件事被两个噪声源毁掉过：
       *   1) 篮球缝是一条很宽的深色带，把橙色像素切成 2~3 块，最大块面积随球自转
       *      在 2 倍范围内摆动 —— 一颗视觉上完好的球会被量成"只有 0.39 个圆盘"；
       *   2) 桌面上开着代码编辑器，红色/橙色语法高亮的像素同样满足"橙色"阈值，
       *      被并进球的连通块里，把跨度凭空撑大。
       * 纯洋红在整块屏幕上独一无二，于是分割是精确的，量出来的跨度就是球真的跨度。
       *
       * 这不影响结论：窗口区域由 sendShape 用「球心 + 速度 + cfg.ballRadius」算出，
       * 与球长什么样无关，画成洋红盘时被裁的仍是同一个几何形状、同一个像素量。
       * 生产路径里这个开关恒为 false（见 __pbFlyRunner 的 "flat" 命令）。
       */
      this.flatBall = false;
      /**
       * --fly-probe 用：洋红盘的半径（0 = 用球自己的半径 r）。
       *
       * 画一个比区域还大的盘（例如 400）会得到一个反直觉但极好用的效果：
       * 可见的洋红正好是「区域 ∩ 这个盘」，而区域本身就罩在球周围、必然被盘
       * 完整包住 —— 于是**可见洋红块的形状就是区域圆本身**。量它的面积和质心，
       * 就得到了"区域圆此刻在哪、半径多大"，不必再去猜管线的滞后。
       */
      this.flatBallR = 0;
      /**
       * 分层开关（验收用）：bit1 阴影 / bit2 底色 / bit4 球缝 / bit8 高光 / bit16 球缝不旋转。
       * 用来量「每帧每球画几层」与帧率的关系 —— 换层合并方案之前先确认收益有多大。
       * 生产路径恒为 15（全开）→ 每球画 3 次（body + 球缝 + 阴影，见 drawBall）。
       */
      this.layerMask = 15;
      this.dirty = new Uint8Array(0);
      this.needFull = true;
      this.prevActive = [];
      this.prevActive2 = [];
      this.tilesDrawn = 0;
      this.drawCalls = 0;
      /**
       * ⚠️ **必须初始化**。主循环在"物理步还没攒够"的早退分支里就会调 `updatePerf()`
       * （app.js::loop），而那一轮**还没执行过任何一次 frame()** —— 此时 `lastDrawMs`
       * 若为 `undefined`，性能卡那行 `renderer.lastDrawMs.toFixed(2)` 直接抛
       * `TypeError`。异常发生在 `requestAnimationFrame(loop)` 之前，循环从此不再排下一帧：
       * 球不画、区域不再上报、`+/-` 按钮点了没反应 —— 整个程序表现为"坏了"。
       * 2026-10-06 用户报的"篮球没了 / 按钮没反应 / 性能卡片没了"三连就是这个。
       * 只在 `showPerf: true` 时触发（性能卡那几行前面有 `if (!cfg.showPerf) return;`），
       * 所以默认配置下一直藏着没被发现。
       */
      this.lastDrawMs = 0;
      /**
       * 运动拖尾开关（config.trail）。默认开，由 app.js 在 onInit 里按配置覆盖。
       * `_trailBudget` 是**本帧剩余的残影绘制额度**，每帧由 frame() 重置；
       * 构造函数里必须是 0 —— 于是任何不走 frame() 的绘制路径（球面对照 ballDiff、
       * 贴图对照 texDiff 等验收钩子）都不会混进残影，对照像素才是干净的。
       */
      this.trailOn = true;
      /** 拖尾样式：'fire'（默认，见 drawTrail 的火焰路径） / 'ghost'（原版贴图残影）。 */
      this.trailStyle = 'fire';
      this._trailBudget = 0;
      /**
       * 运动平滑（config.smooth）：**定点物理 + 插值渲染**。
       *
       * 物理永远固定 60Hz（见 app.js 的累加器），但"屏幕多久刷一次"是另一件事：
       * 60 / 75 / 120Hz 的屏、投屏切成 30Hz 的白板、以及软件合成下不锁 vsync 的
       * 环境，都会让"一帧里推进了几步"在 0/1/2 之间跳。以前球严格画在
       * `body.position` 上 —— 于是推进 0 步的那一帧球纹丝不动、推进 2 步的那一帧
       * 球瞬间跳两格，读起来就是"帧率显示满的、但动起来一顿一顿"。
       *
       * 打开后：`frame()` 按 `alpha = 未消耗时间 / 步长` 把球画在
       * 「上一步位置 → 当前位置」之间的插值点上（`posOf`），
       * 于是**每个显示帧的位移都均等**，与"这一帧推进了几步"无关。
       *
       * ⚠️ 插值位置必须成为**唯一口径**：绘制、脏块包围盒、拖尾、以及
       *    app.js 的窗口区域上报全都读 `posOf()`。只改绘制不改区域的话，
       *    球画在插值点上、而区域圆还罩在物理位置上 —— 那正是"球被削掉一角"。
       */
      this.smooth = true;
      /** 本帧用的插值系数（0..1）。smooth 关掉时恒为 1，等价于"直接画物理位置"。 */
      this.alpha = 1;
      /** 每个球上缓存的插值渲染位置/角度（见 frame 的写入、posOf/angOf 的读取）。 */
      this._pos = { x: 0, y: 0 };
      /**
       * 皮肤：`skin` 是当前全局主题（config.skin），`texCache` 按需烘焙。
       * 只有真正用到的皮肤才烘 —— 启动时只烘一次 classic，切主题/出现金球时才补烘那一套。
       *
       * ⚠️ 每套皮肤烘三级，这是 40 球帧率的关键：
       *   master —— 320² 多层光照母版（算法完全不变，只烘一次）
       *   exact  —— 按**球静止时的设备像素直径**缩出来的一级：每帧 drawImage 严格 1:1，
       *            像素与「用母版现算」逐字节相同（同一台 Skia、同一次降采样，只是提前做了）
       *   head   —— 直径 × 1.3，留给挤压/拉伸；超过它才回落到母版
       * 旧实现每帧都拿 320² 母版往 68px 现场降采样，40 颗球 × 4 层 ≈ 每帧上千万源像素的重采样 ——
       * 这件事在 JS 里根本量不出来（能测到的只有 1.2ms），却是帧率卡在 45 的唯一原因：
       * 实测把球换成纯色圆盘（1 次 fill 代替 4 次 drawImage）帧率立刻回到 60。
       */
      this.skin = 'classic';
      this.texCache = new Map();
      this.ballR = 34;
      this.mipExact = 64;
      this.mipHead = 64;
      this.syncMips();
      this.tex = this.texFor('classic');
      this.shadowTex = this.bakeShadow();
    }

    /**
     * 两级 mip 的目标边长（**设备像素**）：
     *   exact —— 2·r·dpr，恰好等于球画在屏幕上的直径；球不变形时 drawImage 是 1:1。
     *   head  —— ceil(2·r·dpr·MIP_HEAD)，MIP_HEAD = 1.3 覆盖「挤压 ≤0.34 + 速度拉伸 ≤0.16」
     *            中的绝大多数帧。上限 320（= 母版尺寸）。
     */
    syncMips() {
      const r = this.ballR || 34, d = this.dpr || 1;
      this.mipExact = Math.max(16, Math.round(2 * r * d));
      this.mipHead = Math.max(this.mipExact,
        Math.min(320, Math.ceil(2 * r * d * Renderer.MIP_HEAD)));
    }

    /**
     * 球半径由 app.js 在 resize 之前告知 —— 烘焙尺寸依赖它。
     * 变了就整套作废重烘（正常只在启动时发生一次；改 DPI 缩放会再来一次）。
     */
    setBallRadius(r) {
      const v = Number(r);
      if (isFinite(v) && v > 0 && v !== this.ballR) { this.ballR = v; this.refreshBake(); }
    }

    /** dpr / 球半径变化 → 缩略图与阴影全部重烘（母版不含尺寸信息，可以留用） */
    refreshBake() {
      const pe = this.mipExact, ph = this.mipHead;
      this.syncMips();
      if (this.mipExact === pe && this.mipHead === ph && this.shadowTex) return;
      this.texCache.clear();
      this.tex = this.texFor(this.skin);
      this.shadowTex = this.bakeShadow();
    }

    /** 一次性把母版降采样到指定边长（imageSmoothingQuality='high'，等价于原先每帧做的那一步） */
    downscale(src, size) {
      const c = mk(size, size);
      c.ctx.imageSmoothingEnabled = true;
      c.ctx.imageSmoothingQuality = 'high';
      c.ctx.drawImage(src, 0, 0, size, size);
      return c.canvas;
    }

    /**
     * 把母版的三层缩成一组可直接 drawImage 的贴图。
     *
     * 另外多烘一张 `body` = base ∘ hi（source-over）。
     * **这是 60 球档的最后一块拼图**：三步单变量实测（`tools/bench-60.js` 头部有结论）表明瓶颈既不是
     * 逐像素 alpha 混合（把球缝换成不透明纯色块，帧率纹丝不动），也不是每帧重采样
     * （强制全部走 1:1 的 exact 档，同样纹丝不动），而是**每帧的绘制调用次数**：
     * 每球 4 次 → 240 次/帧 → 54fps；每球 3 次 → 180 次/帧 → 60fps，门槛正好卡在 4 次。
     * base 与 hi 都不随球旋转、又画在同一坐标系里，于是可以烘前合并成一张，
     * 直接把每球 4 次降到 3 次。合成顺序的差异只有「高光压不压住球缝」这一处（见 ballDiff）。
     */
    mipSet(master, size) {
      // 素材皮肤出来的是**单层**圆盘（光照已经烘进去），四个字段全指向同一张 ——
      // 于是 drawBall 那条 `tex.single` 分支每帧只要 1 次 drawImage，
      // 比 body+球缝+阴影 的 3 次还省。降采样也只做一次。
      if (master.single) {
        const s = this.downscale(master.single, size);
        return { size: size, single: s, base: s, seam: s, hi: s, body: s };
      }
      return {
        size: size,
        base: this.downscale(master.base, size),
        seam: this.downscale(master.seam, size),
        hi: this.downscale(master.hi, size),
        body: this.composite(this.downscale(master.base, size), this.downscale(master.hi, size)),
      };
    }

    /** 把两层按 source-over 叠成一张（尺寸相同，直接整幅 drawImage） */
    composite(under, over) {
      const c = mk(under.width, under.height);
      c.ctx.drawImage(under, 0, 0);
      c.ctx.drawImage(over, 0, 0);
      return c.canvas;
    }

    /**
     * 验收：合并 body 前后，**整颗球叠出来的样子**是否一致。
     *
     * 旧顺序 base → seam → hi（高光压住球缝），新顺序 body(base+hi) → seam（球缝压住高光）。
     * 差异只可能出现在「球缝 ∩ 高光」那一小块，用预乘通道差量化，而不是靠肉眼说"差不多"。
     * @returns {{size:number, mean:number, max:number, over16:number, changedPx:number, discPx:number}}
     */
    ballDiff(skin) {
      const set = this.texFor(skin || this.skin);
      const d = Math.max(8, Math.round(this.ballR * 2 * this.dpr));
      const a = mk(d, d), b = mk(d, d);
      a.ctx.imageSmoothingQuality = 'high';
      b.ctx.imageSmoothingQuality = 'high';
      // 旧：base → seam → hi
      a.ctx.drawImage(set.base, 0, 0, d, d);
      a.ctx.drawImage(set.seam, 0, 0, d, d);
      a.ctx.drawImage(set.hi, 0, 0, d, d);
      // 新：body(base+hi) → seam
      b.ctx.drawImage(set.body, 0, 0, d, d);
      b.ctx.drawImage(set.seam, 0, 0, d, d);
      const da = a.ctx.getImageData(0, 0, d, d).data;
      const db = b.ctx.getImageData(0, 0, d, d).data;
      let sum = 0, max = 0, n = 0, over16 = 0, changedPx = 0, discPx = 0;
      const rr = d / 2;
      for (let i = 0; i < da.length; i += 4) {
        const px = (i / 4) % d, py = ((i / 4) / d) | 0;
        const dx = px + 0.5 - rr, dy = py + 0.5 - rr;
        if (dx * dx + dy * dy <= rr * rr) discPx++;
        const aa = da[i + 3], ba = db[i + 3];
        const r1 = da[i] * aa / 255, r2 = db[i] * ba / 255;
        const g1 = da[i + 1] * aa / 255, g2 = db[i + 1] * ba / 255;
        const b1 = da[i + 2] * aa / 255, b2 = db[i + 2] * ba / 255;
        let e = Math.abs(r1 - r2);
        const eg = Math.abs(g1 - g2); if (eg > e) e = eg;
        const eb = Math.abs(b1 - b2); if (eb > e) e = eb;
        sum += e;
        if (e > max) max = e;
        if (e > 16) over16++;
        if (e > 1) changedPx++;
        n++;
      }
      return {
        size: d, mean: Math.round((sum / n) * 100) / 100, max: Math.round(max * 10) / 10,
        over16: over16, changedPx: changedPx, discPx: discPx,
      };
    }

    /**
     * 验收：把预烘焙的贴图与「320² 母版现算」各画成球的实际尺寸，逐像素比对。
     *
     * 这是为「优化流畅性」做的质量回归 —— 省下来的重采样不能靠肉眼"看起来还行"来验收，
     * 得给出数字。统计量用**预乘**后的通道差：alpha≈0 的像素 RGB 再大也看不见，
     * 直接比裸 RGBA 会被那圈"几乎全透明的边缘像素"夸大（max 动辄 255，mean 却只有 2）。
     *   premulMax / premulMean —— 视觉上真实的通道差（0..255）
     *   over16 —— 预乘差 > 16 的像素个数（分母是球面圆盘平方像素数）
     * @param {string} [skin]
     */
    texDiff(skin) {
      const set = this.texFor(skin || this.skin);
      const d = Math.max(8, Math.round(this.ballR * 2 * this.dpr));
      const a = mk(d, d), b = mk(d, d);
      a.ctx.imageSmoothingQuality = 'high';
      b.ctx.imageSmoothingQuality = 'high';
      const out = { exact: set.size, head: set.head.size, size: d, layers: {} };
      const levels = [['exact', set], ['head', set.head]];
      for (const [name, lv] of levels) {
        const res = {};
        for (const layer of ['base', 'seam', 'hi']) {
          a.ctx.clearRect(0, 0, d, d);
          b.ctx.clearRect(0, 0, d, d);
          a.ctx.drawImage(lv[layer], 0, 0, d, d);
          b.ctx.drawImage(set.master[layer], 0, 0, d, d);
          const da = a.ctx.getImageData(0, 0, d, d).data;
          const db = b.ctx.getImageData(0, 0, d, d).data;
          let sum = 0, max = 0, n = 0, over16 = 0, aMax = 0;
          for (let i = 0; i < da.length; i += 4) {
            const aa = da[i + 3], ba = db[i + 3];
            // 预乘：把 alpha 折进 RGB，得到"叠在任意背景上"的真实可见差
            const r1 = da[i] * aa / 255, r2 = db[i] * ba / 255;
            const g1 = da[i + 1] * aa / 255, g2 = db[i + 1] * ba / 255;
            const b1 = da[i + 2] * aa / 255, b2 = db[i + 2] * ba / 255;
            let e = Math.abs(r1 - r2);
            const eg = Math.abs(g1 - g2); if (eg > e) e = eg;
            const eb = Math.abs(b1 - b2); if (eb > e) e = eb;
            sum += e;
            if (e > max) max = e;
            if (e > 16) over16++;
            const ea = Math.abs(aa - ba); if (ea > aMax) aMax = ea;
            n++;
          }
          res[layer] = {
            mean: Math.round((sum / n) * 100) / 100,
            max: Math.round(max * 10) / 10,
            over16: over16, aMax: aMax,
          };
        }
        out.layers[name] = res;
      }
      return out;
    }

    /**
     * 取（必要时先烘焙）某套皮肤的纹理。
     * @returns {{size,base,seam,hi,head,master}}
     *   顶层 = exact（球不变形时 1:1）；head = 留 1.3 倍余量那级；master = 320² 母版
     */
    texFor(skin) {
      const key = SKINS[skin] ? skin : 'classic';
      let t = this.texCache.get(key);
      if (!t) {
        const mat = this.bakeLayers(key);
        // 素材皮肤：只有一张图，不用再叠 body（mipSet 也会走单层分支）
        const master = mat.single
          ? { single: mat.single, base: mat.single, seam: mat.single, hi: mat.single }
          : {
            base: mat.base, seam: mat.seam, hi: mat.hi,
            body: this.composite(mat.base, mat.hi),
          };
        t = this.mipSet(master, this.mipExact);
        t.master = master;
        t.head = this.mipSet(master, this.mipHead);
        this.texCache.set(key, t);
      }
      return t;
    }

    /**
     * 切换全局皮肤主题。只标脏不主动重绘 —— 调用方负责 invalidateAll + wake
     * （见 app.js 的 'cycle-skin' 动作）。
     */
    setSkin(name) {
      this.skin = SKINS[name] ? name : 'classic';
      this.tex = this.texFor(this.skin);
      this.needFull = true;
      return this.skin;
    }

    /**
     * 运动拖尾开关。关掉只是不再记录/绘制 —— 已经存在的位置历史会在下一次
     * frame() 的 updateTrail 里被清空，残影像素随脏块一起被擦掉（见 ballAABB）。
     */
    setTrail(on) {
      this.trailOn = !!on;
      return this.trailOn;
    }

    /** 拖尾样式：'fire'（火焰，默认） / 'ghost'（残影）。见 drawTrail。 */
    setTrailStyle(style) {
      this.trailStyle = (style === 'ghost') ? 'ghost' : 'fire';
      return this.trailStyle;
    }

    /** 运动平滑开关（config.smooth）。关掉 = 球严格画在物理位置上（旧行为）。 */
    setSmooth(on) {
      this.smooth = !!on;
      if (!this.smooth) this.alpha = 1;
      return this.smooth;
    }

    /**
     * 把每个球的**插值渲染位置/角度**算出来，缓存到 `b.rx / b.ry / b.ra`。
     *
     * 输入是 app.js 在**每个物理步之前**打的快照 `b._px / b._py / b._pa`
     * （见 app.js::snapshotPrev）。于是一步之内：
     *   `_p*` = 这一步开始时的位置，`body.position` = 这一步结束时的位置，
     * 而 `alpha` = 本帧还没被消耗掉的时间占比 —— 三者插值就得到"此刻屏幕上应该在哪"。
     *
     * 为什么快照要打在每个步之前（而不是每帧一次）：一帧可能推进 0~4 步。
     * 每帧只打一次快照的话，推进 2 步的那一帧里 `_p*` 与 `body.position` 会跨两个步长，
     * 插值点就跑到两步的中间去了（位置超前/滞后各一半）。打在每步之前，
     * `_p* → body.position` 恒定只跨**一步**，插值才是精确的。
     *
     * @param {Array} balls
     * @param {number} alpha 0..1；smooth 关掉时忽略（等价 alpha=1）
     */
    syncRenderPos(balls, alpha) {
      const a = this.smooth ? Math.max(0, Math.min(1, alpha)) : 1;
      this.alpha = a;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const bp = b.body.position;
        // `_px` 未定义 = 这颗球本帧还没走过物理步（刚 add 出来 / 刚 restore），
        // 这时没有"上一步"可插值，直接落在物理位置上。
        if (a >= 1 || b._px === undefined) {
          b.rx = bp.x; b.ry = bp.y; b.ra = b.body.angle;
          continue;
        }
        /**
         * ⚠️ 瞬移保护：一步的位移**不可能**超过几十 px（物理限速 49.5px/步，
         * 见 physics 里的 maxThrowSpeed·1.35），所以 `|Δ| > 200` 只可能意味着
         * 这颗球是被**搬**过去的，而不是走过去的 —— `__pbPlace`（验收）、
         * `resetGame` / 从 `ballStates` 恢复球位、以及 `__pbFlyRunner('orbit')` 都算。
         *
         * 不拦的后果：插值会把球画在「旧位置 → 新位置」的连线上，
         * 那是一个**谁都没想到的位置**。`ballAABB` 罩的是这个错位点，
         * 于是球会闪一下、并在旧位置或新位置留下擦不掉的残影。
         * 验收夹具（`verify-render` 的休眠球像素保留判据）正是这样抓到的。
         */
        if (Math.abs(bp.x - b._px) + Math.abs(bp.y - b._py) > 200) {
          b.rx = bp.x; b.ry = bp.y; b.ra = b.body.angle;
          continue;
        }
        b.rx = b._px + (bp.x - b._px) * a;
        b.ry = b._py + (bp.y - b._py) * a;
        b.ra = b._pa + (b.body.angle - b._pa) * a;
      }
      return a;
    }

    /**
     * 取一颗球**画面上的**位置（插值后的），而不是物理位置。
     *
     * ⚠️ 返回值是一个**复用**的暂存对象：只能立即读取 p.x / p.y，
     *    不要保存引用、不要跨调用持有（下一颗球就会把它覆盖掉）。
     *    这样写是为了避免每帧每球分配一个对象 —— 200 球 × 60Hz 的 GC 压力不小。
     */
    posOf(b) {
      const p = this._pos;
      const bp = b.body.position;
      if (b.rx !== undefined && isFinite(b.rx) && isFinite(b.ry)) {
        p.x = b.rx; p.y = b.ry;
      } else {
        p.x = bp.x; p.y = bp.y;
      }
      return p;
    }

    /** 取一颗球画面上的自转角（插值后的）。 */
    angOf(b) {
      return (b.ra !== undefined && isFinite(b.ra)) ? b.ra : b.body.angle;
    }

    /**
     * 素材贴图刚刚解码完成时调用：把已经烘过的皮肤全部作废重烘。
     *
     * 存在的理由是这个顺序问题 —— 贴图是**异步**解码的，而切换到素材皮肤时
     * `setSkin()` 是同步跑的，第一次 texFor 会拿不到素材、烘成程序化的兜底外观，
     * 然后一直缓存在 texCache 里；等贴图到位时缓存已经是"错的"了。这里清掉重烘即可，
     * 用户看不到中间态（切换动作本身就是一次重绘）。
     *
     * ⚠️ 只作废**当前皮肤**的缓存：texCache 是按皮肤分键的，切走了的皮肤那份
     * 烘焙结果依然有效，没必要连坐重烘（每套皮肤烘一张 320² 母版 + 两级 mip）。
     */
    reloadTextures() {
      this.texCache.delete(this.skin);
      this.tex = this.texFor(this.skin);
      this.needFull = true;
      return this.skin;
    }

    // ------------------------------------------------------------ 素材球面烘焙
    /**
     * 把网上下来的真实贴图按球面几何重投影成一张 320² 的圆盘。
     *
     * 与 bakeLayers 的程序化路径**互斥**：素材就绪就走这条，没就绪就退回程序化。
     * 出来的是**一张**贴图（`single`），光照一并烘进去，每帧只要一次 drawImage——
     * 素材皮肤因此比原来那套三层管线还少一次绘制调用（球数上限提到 200 之后这点很关键）。
     *
     * 光照模型与 `tools/tex-lab/sphere_preview.py` 逐项一致（先在 Python 那边调好看，
     * 再把常量搬过来，省掉"每改一次参数就要打包截图"的循环）：
     *   半兰伯特漫反射 + 三层高光（锐镜面点 / 中等光泽 / 大面积柔光）+ 右下反弹光 + 边缘暗化。
     *   直接 clamp 的漫反射会在球上留一条硬邦邦的明暗界线，照片皮肤上尤其出戏，
     *   所以用 (dot+0.22)/1.22 压软。
     *
     * 逐像素用乘法而不是 Math.pow 展开幂次 —— 一条皮肤 320²=10 万像素、每个像素三次幂，
     * 用 pow 会让切换皮肤时多卡十几毫秒。
     *
     * @param {string} name 皮肤键（SKINS）
     * @returns {HTMLCanvasElement|null} 烘焙好的圆盘；素材未就绪时返回 null
     */
    bakeSphere(name) {
      const P = SKINS[name];
      const M = P && P.img;
      if (!M) return null;
      const src = TEXSTORE.get(M.tex);
      if (!src) return null;

      const S = 320, R = S / 2;
      const out = mk(S, S);
      const img = out.ctx.createImageData(S, S);
      const px = img.data;
      const sd = src.data, sw = src.w, sh = src.h;

      // ---- 光照常量（与 Python 预览器一致）
      const Lx = -0.42, Ly = -0.52, Lz = 0.74;      // 主光：左上偏内、略朝观察者
      const ln = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
      const lx = Lx / ln, ly = Ly / ln, lz = Lz / ln;
      const hx0 = lx, hy0 = ly, hz0 = lz + 1;       // H = normalize(L + V)
      const hn = Math.sqrt(hx0 * hx0 + hy0 * hy0 + hz0 * hz0);
      const hx = hx0 / hn, hy = hy0 / hn, hz = hz0 / hn;
      const rx0 = 0.56, ry0 = 0.60, rz0 = 0.57;     // 右下反弹光
      const rn = Math.sqrt(rx0 * rx0 + ry0 * ry0 + rz0 * rz0);
      const rxb = rx0 / rn, ryb = ry0 / rn, rzb = rz0 / rn;

      const ambient = M.ambient != null ? M.ambient : 0.42;
      const diffuse = M.diffuse != null ? M.diffuse : 0.72;
      const specW = M.spec != null ? M.spec : 0.50;
      const sheenW = M.sheen != null ? M.sheen : 0.14;
      const limbW = M.limb != null ? M.limb : 0.50;
      const sat = M.sat != null ? M.sat : 1;

      const photo = M.mode === 'photo';
      const phase = M.phase || 0;
      const repU = M.repU || 1, repV = M.repV || 1;
      const unit = Math.min(sw, sh);
      const pcx = (M.cx != null ? M.cx : 0.5) * sw;
      const pcy = (M.cy != null ? M.cy : 0.5) * sh;
      const prr = (M.rr != null ? M.rr : 0.45) * unit;
      const INV = 1 / R;

      for (let y = 0; y < S; y++) {
        const ny = (y + 0.5 - R) * INV;
        for (let x = 0; x < S; x++) {
          const o = (y * S + x) << 2;
          const nx = (x + 0.5 - R) * INV;
          const r2 = nx * nx + ny * ny;
          if (r2 >= 1) { px[o + 3] = 0; continue; }
          const nz = Math.sqrt(1 - r2);

          // ---------------- 采样 ----------------
          let sx, sy;
          if (photo) {
            sx = pcx + nx * prr;
            sy = pcy + ny * prr;
            if (sx < 0) sx = 0; else if (sx > sw - 1) sx = sw - 1;
            if (sy < 0) sy = 0; else if (sy > sh - 1) sy = sh - 1;
          } else {
            const lon = Math.atan2(nx, nz) + phase;
            const lat = Math.asin(ny);
            let u = lon / TAU + 0.5;
            u *= repU;
            u -= Math.floor(u);
            let v = (0.5 + lat / Math.PI) * repV;
            // ⚠️ 屏幕的 ny 向下为正，等距圆柱贴图的 v=0 却在**北**极。
            // 用 0.5 - lat/π 会把南北极整个倒过来（地球变成南极朝上、木星条带反着转），
            // 而且因为两颗球都还"能看"，很容易一路漏到交付。
            if (v < 0) v = 0; else if (v > 0.999999) v = 0.999999;
            sx = u * sw;
            sy = v * (sh - 1);
          }

          // 双线性：x 环绕（全景图左右是接上的）、y 夹取
          const ix = Math.floor(sx), iy = Math.floor(sy);
          const fx = sx - ix, fy = sy - iy;
          let x0 = ix, x1 = ix + 1;
          if (photo) {
            if (x0 < 0) x0 = 0; else if (x0 > sw - 1) x0 = sw - 1;
            if (x1 < 0) x1 = 0; else if (x1 > sw - 1) x1 = sw - 1;
          } else {
            x0 = ((x0 % sw) + sw) % sw;
            x1 = ((x1 % sw) + sw) % sw;
          }
          let y0 = iy, y1 = iy + 1;
          if (y0 < 0) y0 = 0; else if (y0 > sh - 1) y0 = sh - 1;
          if (y1 < 0) y1 = 0; else if (y1 > sh - 1) y1 = sh - 1;

          const a0 = (y0 * sw + x0) << 2, a1 = (y0 * sw + x1) << 2;
          const b0 = (y1 * sw + x0) << 2, b1 = (y1 * sw + x1) << 2;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy, w11 = fx * fy;
          let cr = sd[a0] * w00 + sd[a1] * w10 + sd[b0] * w01 + sd[b1] * w11;
          let cg = sd[a0 + 1] * w00 + sd[a1 + 1] * w10 + sd[b0 + 1] * w01 + sd[b1 + 1] * w11;
          let cb = sd[a0 + 2] * w00 + sd[a1 + 2] * w10 + sd[b0 + 2] * w01 + sd[b1 + 2] * w11;

          if (sat !== 1) {
            // 绕灰度轴推饱和度：照片缩到 68px 之后会显得比实物"淡"，
            // 这一步把它拉回真实果皮那种浓绿，代价只有三次乘加。
            const gray = (cr + cg + cb) * 0.3333333;
            cr = gray + (cr - gray) * sat;
            cg = gray + (cg - gray) * sat;
            cb = gray + (cb - gray) * sat;
          }

          // ---------------- 光照 ----------------
          const ndl0 = nx * lx + ny * ly + nz * lz;
          const ndl = ndl0 > 0 ? ndl0 : 0;
          const ndh0 = nx * hx + ny * hy + nz * hz;
          const ndh = ndh0 > 0 ? ndh0 : 0;

          // 幂次全用乘法展开：ndh^2 → ^4 → ^8 → ^16 → ^32 → ^64 → ^128
          const h2 = ndh * ndh, h4 = h2 * h2, h8 = h4 * h4, h16 = h8 * h8;
          const h32 = h16 * h16, h64 = h32 * h32, h128 = h64 * h64;
          const s1 = h128 * h64 * h16 * h8 * h4 * specW;        // ndh^220 锐镜面点
          const s2 = h16 * h8 * h2 * sheenW;                     // ndh^26 中等光泽
          const g4 = (ndl * ndl) * (ndl * ndl);
          const glow = g4 * ndl * 0.05;                          // ndl^5 大面积柔光

          const shade = ambient + diffuse * ((ndl + 0.22) / 1.22);
          const hi = (s1 + s2 + glow) * 255;

          let R8 = cr * shade + hi;
          let G8 = cg * shade + hi * 0.985;
          let B8 = cb * shade + hi * 0.95;

          // 右下反弹光：让暗部不死黑，同时暗示球面曲率
          const rd = nx * rxb + ny * ryb + nz * rzb;
          const rim = rd > 0 ? rd * rd * 0.10 : 0;
          if (rim > 0) {
            const k = 1 - rim;
            R8 = R8 * k + rim * 255;
            G8 = G8 * k + rim * 255 * 0.87;
            B8 = B8 * k + rim * 255 * 0.68;
          }

          // 边缘暗化：球体最外圈必须沉下去才有体积
          const lm = 1 - nz;
          const limb = 1 - limbW * lm * lm;
          R8 *= limb; G8 *= limb; B8 *= limb;

          // 圆边抗锯齿（putImageData 不经过路径裁剪，只能自己算 alpha）
          const dist = Math.sqrt(r2);
          let al = (1 - dist) * R / 1.2 + 0.5;
          if (al > 1) al = 1; else if (al < 0) al = 0;

          px[o] = R8 < 0 ? 0 : R8 > 255 ? 255 : R8;
          px[o + 1] = G8 < 0 ? 0 : G8 > 255 ? 255 : G8;
          px[o + 2] = B8 < 0 ? 0 : B8 > 255 ? 255 : B8;
          px[o + 3] = (al * 255) | 0;
        }
      }
      out.ctx.putImageData(img, 0, 0);

      // 轮廓：浅色桌面上也要能勾出球形（与程序化路径同一个理由）。putImageData 是
      // "覆盖像素"，不会合成，所以必须画在它之后。
      const oc = M.outline || 'rgba(20,14,8,0.62)';
      out.ctx.strokeStyle = oc;
      out.ctx.lineWidth = Math.max(2.2, R * 0.030);
      out.ctx.beginPath();
      out.ctx.arc(R, R, R - R * 0.011, 0, TAU);
      out.ctx.stroke();

      return out.canvas;
    }

    // ------------------------------------------------------------ 纹理烘焙
    /**
     * 球外观分四层烘成三张图（底色 / 球缝 / 高光）：
     *   base —— 多层径向渐变（球面光照）+ 低频斑驳 + 颗粒浮雕 + 边缘暗化 + 反弹光 + 轮廓
     *   seam —— 四条球缝，带凹槽阴影与受光侧高光（随球旋转）
     *   hi   —— 椭圆高光池 + 锐利镜面点（不随旋转，模拟固定光源）
     * 尺寸固定 320：球最终画成 68px，约 4.7 倍超采样；颗粒刻意做粗，
     * 否则降采样后会被滤成一片纯色 —— 那正是"廉价纯色球"的来源。
     * 显示尺寸的那一份由 texFor 从这张母版缩出来（见 downscale），算法本身不做任何让步。
     *
     * 所有颜色取自 SKINS[skin]，几何与算法与经典篮球完全一致。
     * @param {string} skin 调色板键（SKINS）
     * @returns {{base: HTMLCanvasElement, seam: HTMLCanvasElement, hi: HTMLCanvasElement}}
     */
    bakeLayers(skin) {
      const P = SKINS[skin] || SKINS.classic;
      // 素材皮肤：贴图就绪 → 走球面重投影那一条，出来就是**单层**（光照已烘进去）。
      // 缺素材时继续往下走程序化路径，于是"素材没加载出来"退化成"皮肤变回原来的样子"，
      // 而不会变成黑球或抛异常。
      if (P.img) {
        const disc = this.bakeSphere(skin);
        if (disc) return { single: disc, base: disc, seam: disc, hi: disc };
      }
      if (skin === 'gold') return this.bakeGold(320);     // 金球：拉丝 + 星纹 + 自发光内核
      const S = 320, R = S / 2;
      const rnd = mulberry32(0x5eed1234);
      const ps = Math.min(1, P.patchScale || 1);

      // ================= 1. 底色 =================
      const base = mk(S, S);
      const g = base.ctx;
      g.save();
      g.beginPath(); g.arc(R, R, R, 0, TAU); g.clip();

      // 球面光照：光源在左上偏内，高光池略微偏离圆心
      const lx = R * 0.60, ly = R * 0.52;
      const grad = g.createRadialGradient(lx, ly, R * 0.015, R * 0.76, R * 0.86, R * 1.46);
      for (const [stop, color] of P.grad) grad.addColorStop(stop, color);
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);

      // 中频斑驳 —— 小尺寸下唯一能存活的细节层次。
      // 高频颗粒在 320 → 68 的降采样里会被平均成一片纯色（那正是"廉价球"的来源），
      // 只有 6~22px 量级的斑块能在缩到 1/4.7 之后留下肉眼可见的皮革纹理。
      for (let i = 0; i < 240; i++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * R * 1.0;
        const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr;
        g.globalAlpha = (0.05 + rnd() * 0.065) * ps;
        g.fillStyle = rnd() > 0.52 ? P.patA : P.patB;
        g.beginPath(); g.arc(x, y, 6 + rnd() * 16, 0, TAU); g.fill();
      }

      // 颗粒簇：成团的小凸起。比孤立的单点更容易在降采样后留下"磨砂皮革"观感。
      const psGrain = (skin === 'gold') ? 0.22 : ps;   // 金面不做磨砂
      for (let i = 0; i < 620; i++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * R * 1.0;
        const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr;
        g.globalAlpha = (0.05 + rnd() * 0.06) * psGrain;
        g.fillStyle = rnd() > 0.5 ? P.grainA : P.grainB;
        g.beginPath(); g.arc(x, y, 2.4 + rnd() * 4.6, 0, TAU); g.fill();
      }

      // 细颗粒浮雕：只有把球放大（或高 DPI 屏）才看得见，是前两层的"赠品"
      for (let i = 0; i < 2200; i++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * R * 1.02;
        const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr;
        const rad = 1.0 + rnd() * 2.0;
        g.globalAlpha = (0.045 + rnd() * 0.05) * psGrain;
        g.fillStyle = P.grainA;
        g.beginPath(); g.arc(x + 0.9, y + 1.0, rad, 0, TAU); g.fill();
        g.globalAlpha = (0.05 + rnd() * 0.06) * psGrain;
        g.fillStyle = P.grainB;
        g.beginPath(); g.arc(x - 0.8, y - 0.9, rad * 0.8, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;

      // 边缘暗化（limb darkening）：球体最外圈必须沉下去才有体积
      const limb = g.createRadialGradient(R * 0.86, R * 0.86, R * 0.28, R, R, R * 1.01);
      limb.addColorStop(0.00, 'rgba(' + P.limb + ',0)');
      limb.addColorStop(0.55, 'rgba(' + P.limb + ',0.10)');
      limb.addColorStop(0.78, 'rgba(' + P.limb + ',0.38)');
      limb.addColorStop(0.93, 'rgba(' + P.limb + ',0.60)');
      limb.addColorStop(1.00, 'rgba(' + P.limb + ',0.80)');
      g.fillStyle = limb;
      g.fillRect(0, 0, S, S);

      // 右下反弹光：让暗部不死黑，同时暗示球面曲率
      g.globalAlpha = 0.20;
      g.strokeStyle = P.bounce;
      g.lineWidth = R * 0.13;
      g.beginPath();
      g.arc(R, R, R * 0.93, Math.PI * 0.10, Math.PI * 0.70);
      g.stroke();

      // 轮廓：浅色桌面上也要能勾出球形（R*0.035 → 实际 68px 时约 1.2px）
      g.globalAlpha = 1;
      g.strokeStyle = P.outline;
      g.lineWidth = Math.max(2.2, R * 0.035);
      g.beginPath(); g.arc(R, R, R - R * 0.013, 0, TAU); g.stroke();
      g.restore();

      // ================= 2. 球缝（随球旋转） =================
      const seam = mk(S, S);
      const sg = seam.ctx;
      sg.save();
      sg.beginPath(); sg.arc(R, R, R - 0.5, 0, TAU); sg.clip();
      sg.lineCap = 'round';
      sg.lineJoin = 'round';

      // 经典 8 片球缝的 2D 投影：竖向大圆 + 横向大圆 + 左右两条外弧。
      // 外弧控制点取 1.32R，最宽处落在 0.34R —— 四片球瓣宽度大致相等。
      // （取 1.60R 时外瓣只剩 0.20R，降采样后左右会糊成两片"花瓣"，很廉价。）
      // 横缝给一点点下弧，让中线看起来贴在球面上而不是一条直尺。
      const seams = (w) => {
        sg.lineWidth = w;
        sg.beginPath(); sg.moveTo(R, R - R); sg.lineTo(R, R + R); sg.stroke();
        sg.beginPath();
        sg.moveTo(R - R, R);
        sg.quadraticCurveTo(R, R + R * 0.17, R + R, R);
        sg.stroke();
        sg.beginPath();
        sg.moveTo(R, R - R * 0.995);
        sg.quadraticCurveTo(R - R * 1.32, R, R, R + R * 0.995);
        sg.stroke();
        sg.beginPath();
        sg.moveTo(R, R - R * 0.995);
        sg.quadraticCurveTo(R + R * 1.32, R, R, R + R * 0.995);
        sg.stroke();
      };

      // 缝宽也压过一轮：R*0.052 在 68px 的球上是 3.5px 宽的黑线，像马克笔画的；
      // R*0.034 → 约 2.3px，接近真实球缝的视觉重量。
      sg.globalAlpha = 0.20;          // 凹槽两侧的宽阴影
      sg.strokeStyle = P.seamA;
      seams(R * 0.086);
      sg.globalAlpha = 1;
      sg.strokeStyle = P.seamB;       // 缝本体
      seams(R * 0.034);
      sg.save();                      // 缝的受光侧：整体往左上挪一点点再描细高光
      sg.globalAlpha = 0.34;
      sg.strokeStyle = P.seamC;
      sg.translate(-R * 0.010, -R * 0.012);
      seams(R * 0.012);
      sg.restore();
      sg.restore();

      // ================= 3. 高光（不随旋转，模拟固定光源） =================
      const hi = mk(S, S);
      const hg = hi.ctx;
      hg.save();
      hg.beginPath(); hg.arc(R, R, R, 0, TAU); hg.clip();
      hg.save();
      hg.translate(R * 0.60, R * 0.50);
      hg.rotate(-0.52);
      hg.scale(1.28, 0.86);
      const hgr = hg.createRadialGradient(0, 0, 0, 0, 0, R * 0.46);
      hgr.addColorStop(0.00, 'rgba(255,255,255,0.58)');
      hgr.addColorStop(0.32, 'rgba(255,245,232,0.24)');
      hgr.addColorStop(0.70, 'rgba(255,238,215,0.06)');
      hgr.addColorStop(1.00, 'rgba(255,235,210,0)');
      hg.fillStyle = hgr;
      hg.beginPath(); hg.arc(0, 0, R * 0.46, 0, TAU); hg.fill();
      hg.restore();
      const sp = hg.createRadialGradient(R * 0.545, R * 0.415, 0, R * 0.545, R * 0.415, R * 0.13);
      sp.addColorStop(0.00, 'rgba(255,255,255,0.86)');
      sp.addColorStop(0.40, 'rgba(255,255,255,0.22)');
      sp.addColorStop(1.00, 'rgba(255,255,255,0)');
      hg.fillStyle = sp;
      hg.fillRect(0, 0, S, S);
      /**
       * 金球（`hiMul`）：整套高光乘一个系数。金属的亮部比皮革亮得多，但几何形状
       * 不该跟着变 —— 所以乘在这里，而不是另写一套高光几何。
       */
      if (P.hiMul && P.hiMul !== 1) {
        hg.globalCompositeOperation = 'lighter';
        hg.globalAlpha = P.hiMul - 1;
        hg.drawImage(hi.canvas, 0, 0);
        hg.globalAlpha = 1;
        hg.globalCompositeOperation = 'source-over';
      }
      /**
       * 自发光内核（`core`）：正中心一团温暖的光，压住金属球"中心发死"的问题。
       * 实心金球最暗的地方仍在球心附近，而实物金球会被环境反弹光照亮中心。
       */
      if (P.core) {
        const cg = hg.createRadialGradient(R * 0.50, R * 0.46, 0, R * 0.50, R * 0.46, R * 0.62);
        cg.addColorStop(0.00, 'rgba(' + P.core + ',0.34)');
        cg.addColorStop(0.45, 'rgba(' + P.core + ',0.13)');
        cg.addColorStop(1.00, 'rgba(' + P.core + ',0)');
        hg.fillStyle = cg;
        hg.fillRect(0, 0, S, S);
      }
      hg.restore();

      return { base: base.canvas, seam: seam.canvas, hi: hi.canvas };
    }

    /**
     * 阴影与皮肤无关，只烘一次。
     * 尺寸直接按「球实际画出来的阴影盒」定（r*2.30 × r*1.95，含 dpr）——
     * 于是每帧 drawImage 是 1:1，不再把 160² 降到 78×66（那也是一次每球每帧的重采样）。
     */
    bakeShadow() {
      const r = this.ballR || 34;
      const d = this.dpr || 1;
      const W0 = Math.max(8, Math.round(r * 2.30 * d));
      const H0 = Math.max(8, Math.round(r * 1.95 * d));
      const sh = mk(W0, H0);
      const sgc = sh.ctx;
      const cw = W0 / 2, ch = H0 / 2;
      const sgr = sgc.createRadialGradient(cw, ch, Math.max(1.5, ch * 0.064), cw, ch, ch * 0.975);
      sgr.addColorStop(0.00, 'rgba(18,10,4,0.50)');
      sgr.addColorStop(0.35, 'rgba(18,10,4,0.34)');
      sgr.addColorStop(0.66, 'rgba(18,10,4,0.15)');
      sgr.addColorStop(1.00, 'rgba(18,10,4,0)');
      sgc.fillStyle = sgr;
      sgc.fillRect(0, 0, W0, H0);
      return sh.canvas;
    }

    /**
     * 金球专用多层烘焙（2026-10-06）。
     *
     * 走程序化路径的金球如果直接沿用通用算法，出来是一颗"黄色的篮球"—— 因为通用调色板
     * 是为**皮革**调的：中频斑驳 + 成簇颗粒模拟材质。金面是光洁的，这两层叠上去只会
     * 变成铜锈。所以金球单独烘三层：
     *
     *   base —— 球面渐变 + **同心车削拉丝**（加工面的同心圆纹）+ 径向拉丝 + 镜面暗带
     *           + 星形刻纹（四芒星贴花，随球旋转）+ 边缘暗化 + 左上镜面点
     *   seam —— 完全空（金球不画球缝；`mipSet` 仍会返回一张透明贴图，
     *           于是 `layerMask` 的球缝层照旧是一次无害的 drawImage）
     *   hi   —— 更强的白热镜面池 + 中心自发光内核（比通用路径亮一档）
     *
     * 只有 `layerMask=15` 的**验收对照**路径会分别用到 seam / hi；生产路径会把
     * base + hi 复合成一张 `body`，所以星纹与高光在这条路径上是烘在一起的。
     * 金球本来就是事件性的（一次只有一颗），一次 drawImage 很划算。
     */
    bakeGold(S) {
      const R = S / 2;
      const P = SKINS.gold;
      const gain = P.goldGain || 1;
      const rnd = mulberry32(0x9e3779b9);
      const mk2 = () => { const c = document.createElement('canvas'); c.width = S; c.height = S; return { canvas: c, ctx: c.getContext('2d') }; };

      // ================= 1. 底材：拉丝金 =================
      const base = mk2();
      const g = base.ctx;
      g.save();
      g.beginPath(); g.arc(R, R, R, 0, TAU); g.clip();

      const lx = R * 0.56, ly = R * 0.46;
      const grad = g.createRadialGradient(lx, ly, R * 0.012, R * 0.80, R * 0.90, R * 1.40);
      for (const [stop, color] of P.grad) grad.addColorStop(stop, color);
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      /**
       * 总曝光：整颗球乘一层暖白。渐变本身已经定好了明暗结构，这里只是把它整体提亮 ——
       * 金球在桌面上是**点缀**，暗一点就不像金子了（实测压暗版读起来像铜球）。
       */
      if (gain !== 1) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = Math.max(0, gain - 1);
        g.fillStyle = '#ffe9a8';
        g.fillRect(0, 0, S, S);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
      }

      // 同心车削纹：半径从 0.06R 到 0.99R 的细环，亮暗交替 —— 金属加工面的标志性特征。
      // ⚠️ alpha 太小时（0.03）缩到 68px 后整层消失，白烘一遍；0.05~0.10 才能在球面上留下"金有纹路"的暗示。
      g.lineWidth = 1.8;
      for (let rr = R * 0.06; rr < R * 0.99; rr += 3.1) {
        const t = rnd();
        g.globalAlpha = 0.050 + t * 0.075;
        g.strokeStyle = t > 0.46 ? '#fff6cf' : '#5c3808';
        g.beginPath(); g.arc(R, R, rr, 0, TAU); g.stroke();
      }
      // 径向拉丝：从中心向外的细射线，破掉同心纹的"同心圆太整齐"感
      g.lineWidth = 1.3;
      for (let i = 0; i < 190; i++) {
        const a = rnd() * TAU;
        const r0 = R * (0.10 + rnd() * 0.42);
        const r1 = r0 + R * (0.20 + rnd() * 0.52);
        g.globalAlpha = 0.035 + rnd() * 0.055;
        g.strokeStyle = rnd() > 0.5 ? '#fff6cf' : '#6b4410';
        g.beginPath();
        g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0);
        g.lineTo(R + Math.cos(a) * r1, R + Math.sin(a) * r1);
        g.stroke();
      }
      g.globalAlpha = 1;

      // 镜面暗带：高光池靠上，金属下缘会有一圈**很暗但很窄**的过渡（不是渐变的暗）。
      // ⚠️ 别压太黑 —— 这一层是"黄铜感"的主要来源，早先 alpha 到 0.62 时球下半部发闷。
      const dark = g.createRadialGradient(R * 0.62, R * 0.54, R * 0.22, R * 1.02, R * 1.04, R * 1.28);
      dark.addColorStop(0.00, 'rgba(52,30,0,0)');
      dark.addColorStop(0.62, 'rgba(52,30,0,0.30)');
      dark.addColorStop(0.86, 'rgba(40,22,0,0.46)');
      dark.addColorStop(1.00, 'rgba(28,15,0,0.24)');
      g.fillStyle = dark;
      g.fillRect(0, 0, S, S);

      // 边缘暗化：与通用路径同一套（球体最外圈必须沉下去才有体积），但暗端更浅
      const limb = g.createRadialGradient(R * 0.86, R * 0.86, R * 0.30, R, R, R * 1.01);
      limb.addColorStop(0.00, 'rgba(60,36,0,0)');
      limb.addColorStop(0.55, 'rgba(60,36,0,0.08)');
      limb.addColorStop(0.78, 'rgba(60,36,0,0.28)');
      limb.addColorStop(0.93, 'rgba(60,36,0,0.48)');
      limb.addColorStop(1.00, 'rgba(44,24,0,0.70)');
      g.fillStyle = limb;
      g.fillRect(0, 0, S, S);

      // 右下反弹光：金属的反弹光比皮革强，否则暗部读成"黑球"
      g.globalAlpha = 0.40;
      g.strokeStyle = '#ffebac';
      g.lineWidth = R * 0.17;
      g.beginPath();
      g.arc(R, R, R * 0.92, Math.PI * 0.16, Math.PI * 0.76);
      g.stroke();
      g.globalAlpha = 1;

      // 星形刻纹：四芒星贴花，压在高光池左下的"空地"上避开镜面点
      this._goldStar(g, R * 1.20, R * 1.22, R * 0.26, 0.46);

      // 轮廓：金球用**暖白细边**而不是深褐 —— 深边在金面上会读成"描了黑边的卡通球"
      g.strokeStyle = 'rgba(92,58,0,0.66)';
      g.lineWidth = Math.max(1.8, R * 0.024);
      g.beginPath(); g.arc(R, R, R - R * 0.010, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,240,190,0.50)';
      g.lineWidth = Math.max(1.2, R * 0.016);
      g.beginPath(); g.arc(R, R, R - R * 0.030, Math.PI * 1.05, Math.PI * 1.85); g.stroke();
      g.restore();

      // ================= 2. 球缝：金球没有缝 =================
      const seam = mk2();   // 留空的透明画布（见方法注释）

      // ================= 3. 高光：白热镜面 + 自发光内核 =================
      const hi = mk2();
      const hg = hi.ctx;
      hg.save();
      hg.beginPath(); hg.arc(R, R, R, 0, TAU); hg.clip();
      hg.translate(R * 0.58, R * 0.46);
      hg.rotate(-0.54);
      hg.scale(1.34, 0.80);
      const hgr = hg.createRadialGradient(0, 0, 0, 0, 0, R * 0.44);
      hgr.addColorStop(0.00, 'rgba(255,255,255,0.66)');
      hgr.addColorStop(0.30, 'rgba(255,248,214,0.28)');
      hgr.addColorStop(0.70, 'rgba(255,236,180,0.07)');
      hgr.addColorStop(1.00, 'rgba(255,230,168,0)');
      hg.fillStyle = hgr;
      hg.beginPath(); hg.arc(0, 0, R * 0.44, 0, TAU); hg.fill();
      hg.restore();
      const sp = hg.createRadialGradient(R * 0.515, R * 0.375, 0, R * 0.515, R * 0.375, R * 0.125);
      sp.addColorStop(0.00, 'rgba(255,255,255,0.95)');
      sp.addColorStop(0.36, 'rgba(255,252,232,0.30)');
      sp.addColorStop(1.00, 'rgba(255,250,220,0)');
      hg.fillStyle = sp;
      hg.fillRect(0, 0, S, S);
      const core = hg.createRadialGradient(R * 0.50, R * 0.46, 0, R * 0.50, R * 0.46, R * 0.60);
      core.addColorStop(0.00, 'rgba(255,214,110,0.32)');
      core.addColorStop(0.45, 'rgba(255,206,96,0.12)');
      core.addColorStop(1.00, 'rgba(255,200,90,0)');
      hg.fillStyle = core;
      hg.fillRect(0, 0, S, S);
      hg.restore();

      return { base: base.canvas, seam: seam.canvas, hi: hi.canvas };
    }

    /** 四芒星刻纹：交点处一个亮核 + 四条菱形星芒（金球的身份标记）。 */
    _goldStar(g, cx, cy, r, alpha) {
      g.save();
      g.translate(cx, cy);
      // 刻痕：先在星芒位置压一圈暗色，制造"凹进去"的读法 —— 只有亮线时读起来像贴纸
      g.globalAlpha = alpha * 0.55;
      g.fillStyle = '#4a2c00';
      for (let i = 0; i < 4; i++) {
        g.save();
        g.rotate(i * Math.PI / 2);
        g.beginPath();
        g.moveTo(0, -r * 1.14);
        g.lineTo(r * 0.20, 0);
        g.lineTo(0, r * 0.16);
        g.lineTo(-r * 0.20, 0);
        g.closePath();
        g.fill();
        g.restore();
      }
      g.globalAlpha = alpha;
      g.fillStyle = '#fff3c0';
      for (let i = 0; i < 4; i++) {
        g.save();
        g.rotate(i * Math.PI / 2);
        g.beginPath();
        g.moveTo(0, -r);
        g.lineTo(r * 0.16, 0);
        g.lineTo(0, r * 0.14);
        g.lineTo(-r * 0.16, 0);
        g.closePath();
        g.fill();
        g.restore();
      }
      // 中心核 + 外圈细环（让刻纹读成"加工上去的徽记"而不是光斑）
      g.beginPath(); g.arc(0, 0, r * 0.15, 0, TAU); g.fill();
      g.globalAlpha = alpha * 0.72;
      g.strokeStyle = '#fff3c0';
      g.lineWidth = Math.max(1, r * 0.060);
      g.beginPath(); g.arc(0, 0, r * 0.36, 0, TAU); g.stroke();
      g.restore();
    }

    // ------------------------------------------------------------ 尺寸
    resize(w, h, dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.refreshBake();          // dpr 变了 → 球贴图与阴影的烘焙尺寸要跟着变
      for (const c of [this.dyn, this.stat]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = w + 'px';
        c.style.height = h + 'px';
      }
      this.dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dctx.imageSmoothingQuality = 'high';
      this.tw = Math.ceil(w / TILE);
      this.th = Math.ceil(h / TILE);
      this.dirty = new Uint8Array(this.tw * this.th);
      this.needFull = true;
      this.prevActive.length = 0;
      if (this.prevActive2) this.prevActive2.length = 0;
    }

    // ------------------------------------------------------------ 脏块
    markRect(x, y, w, h) {
      if (w <= 0 || h <= 0) return;
      let x0 = Math.floor(x / TILE), y0 = Math.floor(y / TILE);
      let x1 = Math.floor((x + w) / TILE), y1 = Math.floor((y + h) / TILE);
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 >= this.tw) x1 = this.tw - 1;
      if (y1 >= this.th) y1 = this.th - 1;
      for (let ty = y0; ty <= y1; ty++) {
        const row = ty * this.tw;
        for (let tx = x0; tx <= x1; tx++) this.dirty[row + tx] = 1;
      }
    }

    /** 外部（如删除球）显式作废一块区域 */
    invalidate(x, y, w, h) { this.markRect(x - 4, y - 4, w + 8, h + 8); }

    /**
     * 球的包围盒必须盖住「最大可能画出的范围」：
     * 球体本身会因速度被沿运动方向拉伸(最多 +16%)、因撞击被挤压(最多 +34%)，
     * 阴影还会向右下偏移。任何一项算漏，脏块就会留下月牙形残影。
     */
    ballAABB(b) {
      /**
       * ⚠️ `--fly-probe` 故意把洋红盘画到 400px（远大于任何区域圆），好让截图里
       * 那团洋红**就是区域圆本身**。那时包围盒必须按 400 算 —— 早先这里写死 `b.r`，
       * 于是盘面落在脏块之外的部分每帧被 clearRect 擦掉，截出来是一块 128 的方块，
       * 量到的根本不是区域半径（探针白做了）。改外观的同时也要改包围盒。
       */
      const r = (this.flatBall && this.flatBallR > b.r) ? this.flatBallR : b.r;
      // ⚠️ 用**插值后的画面位置**（posOf），不是 body.position —— 脏块必须罩住球真正
      // 被画出来的那一块，否则插值让球"超前"物理位置一两像素时就会留下月牙残影。
      const p = this.posOf(b);
      const grow = r * 1.24 + (b.squash || 0) * r * 1.3 + 7;
      const sxc = p.x + 5, syc = p.y + 7;           // 阴影中心（与 drawBall 保持一致）
      const shw = r * 2.30 / 2, shh = r * 1.95 / 2; // 阴影半轴
      let x = Math.min(p.x - grow, sxc - shw - 2);
      let y = Math.min(p.y - grow, syc - shh - 2);
      let x2 = Math.max(p.x + grow, sxc + shw + 2);
      let y2 = Math.max(p.y + grow, syc + shh + 2);
      /**
       * 运动拖尾的残影画在球心**后方**，包围盒必须把它们一起罩住。
       * 漏了这一步的后果和漏掉阴影一样：擦不到的像素留在画布上，
       * 球飞过的路径上会拖出一串永不消失的"幽灵球"。
       */
      const tr = b._trail;
      if (tr && tr.length) {
        /**
         * 火焰椭圆比球大得多（外焰半径 ≈ 1.3r），而且火舌的**短轴 0.78 是被压扁的**，
         * 所以最坏情况下沿运动方向的伸出量就是它的长半轴。这里按"外焰最大半径"统一兜住，
         * 不按椭圆方向精确算 —— 宁可包围盒大几像素，也不能留残影（那会变成幽灵火）。
         */
        const pad = r * 1.35 + 3;
        for (let i = 0; i < tr.length; i++) {
          const q = tr[i];
          if (q.x - pad < x) x = q.x - pad;
          if (q.y - pad < y) y = q.y - pad;
          if (q.x + pad > x2) x2 = q.x + pad;
          if (q.y + pad > y2) y2 = q.y + pad;
        }
      }
      return [x - 2, y - 2, x2 - x + 4, y2 - y + 4];
    }

    /**
     * 维护一颗球的位置历史（供运动拖尾使用）。每帧在收集图元时调用一次。
     *
     * 只在「球真的在快速移动」时记录，慢下来立刻清空：
     *   · 休眠球零成本 —— 不记历史、不加包围盒、不产生残影（空闲降频不受影响）；
     *   · 清空后包围盒自动缩回，上一帧的残影像素被脏块擦掉（见 ballAABB）。
     *
     * `_trail` 挂在球对象上（不是 renderer 上）：球被删掉时历史自然一起释放，
     * 不用维护"球 → 历史"的映射表。
     */
    updateTrail(b) {
      const p = this.posOf(b);
      const v = b.body.velocity;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y);   // px/步
      const fast = this.trailOn && !b.body.isSleeping && sp >= TRAIL_MIN_SPEED;
      if (!fast) {
        if (b._trail && b._trail.length) b._trail.length = 0;
        b._lastX = p.x; b._lastY = p.y;
        return;
      }
      // 瞬移保护：重置球位 / __pbPlace 会让坐标一帧跳很远，不拦的话会拉出一条
      // 横贯屏幕的残影直线（历史点跨越大半个画面，脏块跟着暴涨）。
      if (b._lastX !== undefined) {
        if (Math.abs(p.x - b._lastX) + Math.abs(p.y - b._lastY) > 160 && b._trail) b._trail.length = 0;
      }
      b._lastX = p.x; b._lastY = p.y;

      const tr = b._trail || (b._trail = []);
      const last = tr[tr.length - 1];
      /**
       * ⚠️ **沿这一步真正走过的路径补点**，而不是"每步只记球当前位置"。
       *
       * 这是个必须修的设计缺陷（2026-10-06 实测暴露）：球一步走 |v| px，
       * 高速时一大步就是 40~70px，而火舌单段直径只有 ~2r=60px —— 相邻历史点间距
       * 接近甚至超过火舌自身宽度，**火舌之间不再重叠**。加法混合下不重叠的椭圆
       * 读成"几团分开的白斑"而不是一条火带；速度越快越像白点，
       * 因为每团都被自己叠到过曝（实测 70px/步时整条拖尾是一片纯白）。
       *
       * 修法：把这一步的位移按 TRAIL_SEG 切成若干小段逐段记点 —— 于是点距恒定、
       * 与速度无关，火舌必然重叠。代价只是历史点变多，但**绘制次数由
       * TRAIL_MAX / _trailBudget 双重封顶**，与点距无关。
       */
      if (!last) {
        tr.push({ x: p.x, y: p.y });
      } else {
        const dx = p.x - last.x, dy = p.y - last.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= TRAIL_MIN_GAP) {
          const n = Math.max(1, Math.ceil(dist / TRAIL_SEG));
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            tr.push({ x: last.x + dx * t, y: last.y + dy * t });
          }
        }
      }
      while (tr.length > TRAIL_MAX) tr.shift();
      /**
       * 残影总长度封顶在 |v|·3.2 —— 必须**小于**区域前瞻的 5 帧
       * （sendShape 里上报圆半径 = 球视觉半径 + |v|·leadFrames，LEAD_FRAMES_DEFAULT = 5）。
       * 取 3.6 而不是顶格的 5，是因为火焰外焰还有 ~1.3r 的半径：尾巴端点 + 外焰半径
       * 必须仍落在区域圆内。否则火舌末端会被 SetWindowRgn 齐刷刷切掉一条直边。
       */
      /**
       * 长度上限。取 `max(2.2r, |v|·3.6)` 的较大者：
       *   · 高速段由 `|v|·3.6` 支配（必须 < 区域前瞻 5 帧，见注释）；
       *   · **低速段由 2.2r 兜底** —— 7~10px/步的球只飞 25~36px，若照搬速度公式，
       *     火舌短到还没球大，看起来像"球后面粘了个亮斑"而不是拖尾（实测 8px/步 就是这样）。
       *     固定 2.2r ≈ 66px 让慢速球也有可辨认的火尾。
       */
      const maxDist = Math.max(b.r * 2.2, sp * 3.6);
      while (tr.length > 1 &&
             Math.hypot(p.x - tr[0].x, p.y - tr[0].y) > maxDist) tr.shift();
    }

    /**
     * 画一颗球的**火焰拖尾**（在球体**之下**，由 drawBall 在画阴影之后调用）。
     *
     * （2026-10-06 改版）原来是把球自己的贴图递减透明度叠一串残影 —— 效果像"运动模糊"，
     * 但读起来还是"一串球"。现在换成真正的火：沿位置历史铺一条**锥形火舌**，
     * 颜色按"离球心多远"从炽白渐变到暗红，全程 `'lighter'` 叠加。
     *
     * 三个几何设计，缺一不可：
     *   · **垂直于运动方向拉扁**（短轴 0.62）—— 圆形火球串读起来是"气泡"，拉扁才有方向感；
     *   · 每段画两遍：4× 的宽柔光垫底 + 1.25× 的亮芯，光晕是"热"的来源；
     *   · 尺寸与亮度同时随 k 衰减，只变淡不缩小会糊成一条灰带（见 TRAIL 教训）。
     *
     * 素材皮肤只是火焰的**底色**（走 `tex.single`，省一次重采样），真正让它发亮的是
     * 上面的 'lighter' 层 —— 火焰效果与球皮肤无关，六套皮肤烧出来是同一团火。
     *
     * 返回值是这次用掉的绘制次数，调用方计入 perf.drawCalls（见 §2.12：
     * 绘制调用次数才是这个项目跨环境可比的瓶颈量）。
     */
    drawTrail(g, ball, tex, r) {
      if (this.trailStyle === 'ghost') return this._drawTrailGhost(g, ball, tex, r);
      return this._drawTrailFire(g, ball, tex, r);
    }

    /**
     * 火焰拖尾。
     *
     * 沿位置历史铺一条**锥形火舌**：颜色按"离球心多远"从暖白渐变到暗红。
     *
     * ⚠️ 这一版最大的教训是**混合模式的选择**（前后四版都栽在这里）：
     *
     *   ① 一开始用球贴图做底 → 贴图边缘的暗部把火焰染成灰褐色、还带上球形的硬边。
     *   ② 改成纯色 + 全程 `'lighter'` → 桌面壁纸多为**浅色**，橙色叠到白底上还是白色，
     *      整条火舌在**最常见的浅色壁纸**上退化成"一股白烟"（深色底上颜色很漂亮，
     *      所以只看深色预览图会误判成"已经好了"）。
     *   ③ 正确做法是**分层用不同的混合模式**：
     *      · 主焰 `'source-over'`（不透明暖橙色块）→ 浅底深底都有颜色；
     *      · 只有最外圈光晕用 `'lighter'` → 负责"在深色壁纸上发光"。
     *
     * 以及两条几何要求：
     *   · **锥度必须足够大**，从 1.00r 收到 0.45r；锥度小的时候是"贴在球后面的水滴"。
     *   · 火舌**沿运动轴拉长** 1.55 倍（见 _flame），让相邻椭圆重叠成一条火带，
     *     而不是"一串珠子"。
     */
    _drawTrailFire(g, ball, tex, r) {
      const tr = ball._trail;
      if (!tr || tr.length < 2) return 0;
      const n = Math.min(tr.length - 1, this._trailBudget | 0);
      if (n <= 0) return 0;
      const v = ball.body.velocity;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
      const ux = v.x / sp, uy = v.y / sp;      // 运动单位向量：火舌沿它拉长
      const prevOp = g.globalAlpha;
      const prevComp = g.globalCompositeOperation;
      const cx = ball.body.position.x, cy = ball.body.position.y;
      const tail = tr[0];
      let drawn = 0;
      try {
        /**
         * ⚠️ **主焰用 `'source-over'`，只有最外一圈光晕用 `'lighter'`。**
         *
         * 这是踩到的第四个坑，也是最关键的一个：桌面壁纸多为浅色，而 `'lighter'`
         * 在浅底上会立刻饱和 —— 橙红色叠到白色上还是白色，于是整条火焰在**最常见的
         * 浅色壁纸**上退化成"一股白烟"（实测：深底上颜色漂亮，浅底上完全没颜色）。
         * 主焰改成正常混合后，它是不透明的暖橙色块，在浅底上照样有颜色；
         * 光晕仍用加法，负责让火焰"发光"，深浅底都好看。
         *
         * 代价：主焰之间不再累加亮度，所以锥度/不透明度要重新配（见下方参数）。
         */
        for (let i = 0; i < FIRE_STEPS; i++) {
          const s = i / (FIRE_STEPS - 1);
          const qx = cx + (tail.x - cx) * s;
          const qy = cy + (tail.y - cy) * s;
          if (qx === cx && qy === cy) continue;
          const rr = r * (1.00 - 0.55 * s);        // 火舌锥度：1.00r → 0.45r
          const a = 1 - 0.72 * s;                  // 主焰不透明度：实心 → 很淡
          const col = fireColor(s * 0.92);         // 尾端不取到最暗，留一点红
          // —— 光晕（加法，最外圈，负责"发光"）
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.10 * (1 - 0.5 * s);
          g.fillStyle = col;
          this._flame(g, qx, qy, rr * 2.20, ux, uy);
          // —— 主焰（正常混合，负责"有颜色"）
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = a;
          this._flame(g, qx, qy, rr * 1.30, ux, uy);
          // —— 芯：只有靠球的两枚给，暖白
          if (i < 2) {
            g.globalAlpha = a * 0.75;
            g.fillStyle = i === 0 ? '#fff0c8' : '#ffd98a';
            this._flame(g, qx, qy, rr * 0.72, ux, uy);
          }
          drawn++;
        }
      } finally {
        g.globalAlpha = prevOp;
        g.globalCompositeOperation = prevComp;
      }
      this._trailBudget = (this._trailBudget | 0) - drawn;
      return drawn;
    }

    /**
     * 原版残影拖尾（`trailStyle: 'ghost'`）：直接叠球贴图，递减透明度 + 递减尺寸。
     *
     * 保留它是为了对照 —— 火焰是加法混合的色块，而残影是"过去某一帧的球"，
     * 两者在**多球混战**里的可读性差别很大；换风格后能当场比出来。
     */
    _drawTrailGhost(g, ball, tex, r) {
      const tr = ball._trail;
      if (!tr || tr.length < 2) return 0;
      const img = tex.single || tex.body || tex.base || tex.head;
      if (!img) return 0;
      const n = Math.min(tr.length - 1, this._trailBudget | 0);
      if (n <= 0) return 0;
      const prevOp = g.globalAlpha;
      const cx = ball.body.position.x, cy = ball.body.position.y;
      let drawn = 0;
      /**
       * 从最近的历史点往外画，并且**一边变淡一边缩小**（0.42→~0.10 透明度、1.0→0.66 直径）。
       * 只变淡不缩小的话，等宽的一串圆叠出来是"灰糊糊的一条"；加上收缩才有彗尾的指向性。
       */
      for (let i = tr.length - 2; i >= 0 && drawn < n; i--) {
        const q = tr[i];
        if (q.x === cx && q.y === cy) continue;
        const k = drawn / n;                 // 0 = 离球最近，→1 = 最远
        const sc = 1 - 0.34 * k;
        const rr = r * sc, dd = rr * 2;
        g.globalAlpha = 0.42 * (1 - 0.76 * k);
        g.drawImage(img, q.x - rr, q.y - rr, dd, dd);
        drawn++;
      }
      g.globalAlpha = prevOp;
      this._trailBudget = (this._trailBudget | 0) - drawn;
      return drawn;
    }

    /**
     * 一枚沿运动方向**拉长**的火焰椭圆，用当前 `fillStyle` 填纯色。
     *
     * ⚠️ 注意是**拉长**（长轴 1.55），不是压扁 —— 这一点反直觉但实测差别很大：
     * 拖尾在数学上是一串沿运动轴排开的圆，就算每个都压扁，叠出来仍是一条
     * "有宽度的带"；而把每个椭圆沿运动轴拉长 1.55 倍，相邻椭圆的重叠区变大，
     * 视觉上才连成**一条火舌**而不是"一串珠子"。这也让整条拖尾的有效长度
     * 比几何端点长约 1.5 倍，于是 66px 的历史跨度看起来有 100px 的火尾。
     *
     * **不画贴图**是刻意的 —— 见 _drawTrailFire 第 ① 条：球贴图边缘的暗部会污染
     * 加法混合的颜色，火焰会变成灰褐色并带上球形的硬边。
     */
    _flame(g, x, y, size, ux, uy) {
      g.save();
      g.translate(x, y);
      g.rotate(Math.atan2(uy, ux));
      g.scale(1.55, 0.80);
      g.beginPath();
      g.arc(0, 0, size / 2, 0, TAU);
      g.fill();
      g.restore();
    }

    // ------------------------------------------------------------ 静态层：篮球架
    /**
     * 真实篮球架的结构（右缘立柱 → 支撑臂 → 斜撑 → 篮板 → 篮圈 → 网）。
     * 篮圈画成**带透视的椭圆环**（正面下半弧亮、背面远弧暗），比一根横线像样得多。
     * 几何参数全部来自 physics.js 的真实碰撞体，视觉与物理同源。
     */
    drawHoopStatic(hoop) {
      const g = this.sctx;
      g.clearRect(0, 0, this.w, this.h);
      if (!hoop || !hoop.enabled) return;

      const { cx, rimY, tube, boardY, boardW, boardH } = hoop;
      const boardLeft = hoop.boardLeft !== undefined ? hoop.boardLeft : hoop.boardX - boardW / 2;
      const boardRight = boardLeft + boardW;
      const rx = hoop.span / 2;            // 篮圈椭圆半长轴 = 两端圆心距的一半
      const ry = rimSquash(rx);
      const poleX = this.w - 22;

      this.drawStand(g, { boardLeft, boardRight, boardY, boardW, boardH, poleX, rimY });
      this.drawBackboard(g, { boardLeft, boardY, boardW, boardH, rimY });
      this.drawRim(g, { cx, rimY, rx, ry, tube }, 'back');
      // 网和篮圈近侧弧不画在静态层：它们必须在球「上面」，而 #stat 在 #dyn 下面。
      // 这两块由 frame() 作为 kind 3 / kind 5 的图元画到 #dyn。
      this.drawRim(g, { cx, rimY, rx, ry, tube }, 'front');
    }

    /**
     * 立柱 + 支撑臂 + 斜撑 + 底座。
     * 立柱必须**一路落到地面**：只画篮板附近那一小段时，它是一根悬在半空的铁棍，
     * 怎么调比例都不像篮球架。球从立柱前面经过是正常的（#dyn 画在 #stat 之上，
     * 读作"球在架子前面"），但一根悬空的柱子没有任何解释。
     */
    drawStand(g, s) {
      const { boardRight, boardY, boardH, poleX } = s;
      const H = this.h;
      const poleW = 15;
      const poleTop = boardY - boardH * 1.25;
      // 底座必须整块留在窗口里：poleX 贴着右缘时 74px 宽的底座会被窗口裁掉一半，
      // 看着像右下角糊了一块灰。所以立柱往内挪，底座宽度按到右缘的距离反推。
      const footW = Math.min(46, Math.max(20, (this.w - poleX) * 2 - 2));
      const footH = 15;

      const steel = (x0, x1) => {
        const lg = g.createLinearGradient(x0, 0, x1, 0);
        lg.addColorStop(0.00, '#7e8798');
        lg.addColorStop(0.28, '#e9edf5');
        lg.addColorStop(0.55, '#b3bbca');
        lg.addColorStop(0.82, '#8d95a6');
        lg.addColorStop(1.00, '#5d6675');
        return lg;
      };

      // 底座（先画，让立柱压在上面）
      g.fillStyle = steel(poleX - footW / 2, poleX + footW / 2);
      g.beginPath();
      if (g.roundRect) g.roundRect(poleX - footW / 2, H - footH, footW, footH, 5);
      else g.rect(poleX - footW / 2, H - footH, footW, footH);
      g.fill();
      g.fillStyle = 'rgba(40,50,66,0.55)';
      g.beginPath();
      if (g.roundRect) g.roundRect(poleX - footW / 2, H - 4, footW, 4, 2);
      else g.rect(poleX - footW / 2, H - 4, footW, 4);
      g.fill();

      // 斜撑（先画，压在臂与柱下面）
      g.strokeStyle = 'rgba(152,161,175,0.9)';
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(poleX - 2, boardY + boardH * 0.70);
      g.lineTo(boardRight + 6, boardY - boardH * 0.30);
      g.stroke();

      // 立柱：顶到篮板之上，底落到基座里
      const poleBottom = H - footH * 0.55;
      g.fillStyle = steel(poleX - poleW / 2, poleX + poleW / 2);
      g.beginPath();
      if (g.roundRect) g.roundRect(poleX - poleW / 2, poleTop, poleW, poleBottom - poleTop, 6);
      else g.rect(poleX - poleW / 2, poleTop, poleW, poleBottom - poleTop);
      g.fill();
      // 竖向高光条：一根纯渐变的柱子还是有点像塑料，加一条镜面线就有金属感了
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(poleX - poleW * 0.30, poleTop + 7, 2.2, poleBottom - poleTop - 14);
      g.fillStyle = 'rgba(40,50,66,0.30)';
      g.fillRect(poleX + poleW * 0.24, poleTop + 7, 1.8, poleBottom - poleTop - 14);

      // 支撑臂：篮板右缘 → 立柱
      const armY = boardY - boardH * 0.30;
      const armX0 = boardRight - 18;
      const armX1 = poleX + 4;
      g.save();
      g.translate(armX0, armY);
      const lg2 = g.createLinearGradient(0, -6.5, 0, 6.5);
      lg2.addColorStop(0.00, '#eef1f7');
      lg2.addColorStop(0.45, '#b0b8c6');
      lg2.addColorStop(1.00, '#6a7382');
      g.fillStyle = lg2;
      g.beginPath();
      if (g.roundRect) g.roundRect(0, -6.5, armX1 - armX0, 13, 4);
      else g.rect(0, -6.5, armX1 - armX0, 13);
      g.fill();
      g.restore();
    }

    /** 篮板：半透明板面 + 边框 + 内框（投篮方框）+ 顶部高光 */
    drawBackboard(g, s) {
      const { boardLeft, boardY, boardW, boardH, rimY } = s;
      const bx = boardLeft;
      const by = boardY - boardH / 2;

      g.save();
      g.shadowColor = 'rgba(10,16,28,0.30)';
      g.shadowBlur = 16;
      g.shadowOffsetX = 3;
      g.shadowOffsetY = 5;
      const bg = g.createLinearGradient(0, by, 0, by + boardH);
      bg.addColorStop(0.00, 'rgba(238,246,255,0.92)');
      bg.addColorStop(0.50, 'rgba(214,230,250,0.86)');
      bg.addColorStop(1.00, 'rgba(178,199,230,0.86)');
      g.fillStyle = bg;
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, boardW, boardH, 6);
      else g.rect(bx, by, boardW, boardH);
      g.fill();
      g.restore();

      g.strokeStyle = 'rgba(40,54,76,0.80)';
      g.lineWidth = 2;
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, boardW, boardH, 6);
      else g.rect(bx, by, boardW, boardH);
      g.stroke();

      // 顶部/左侧高光 + 底部阴影：一块纯半透明的矩形没有厚度
      g.strokeStyle = 'rgba(255,255,255,0.90)';
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(bx + 7, by + 2.4);
      g.lineTo(bx + boardW - 7, by + 2.4);
      g.stroke();
      g.strokeStyle = 'rgba(56,72,98,0.32)';
      g.beginPath();
      g.moveTo(bx + 7, by + boardH - 2.4);
      g.lineTo(bx + boardW - 7, by + boardH - 2.4);
      g.stroke();

      // 内框（真实篮板的方框贴着篮圈上方，底边离圈约 10px）
      const sqH = boardH * 0.42;
      const sqW = boardW * 0.44;
      const sqY = rimY - 10 - sqH;
      g.strokeStyle = 'rgba(226,84,26,0.94)';
      g.lineWidth = 2.6;
      g.strokeRect(bx + (boardW - sqW) / 2, sqY, sqW, sqH);
    }

    /**
     * 篮圈：透视椭圆环。
     * 远侧弧必须够暗（否则前后两段同色，整个圈会糊成一块橙色实心饼）。
     * @param {'back'|'front'} half back = 远侧上半弧（暗），front = 近侧下半弧（亮）
     */
    drawRim(g, r, half) {
      const { cx, rimY, rx, ry, tube } = r;
      g.save();
      g.lineCap = 'round';
      g.lineWidth = tube * 2;
      if (half === 'back') {
        g.strokeStyle = '#7d2b05';
        g.beginPath(); g.ellipse(cx, rimY, rx, ry, 0, Math.PI, TAU); g.stroke();
        g.strokeStyle = 'rgba(255,170,110,0.35)';
        g.lineWidth = 2;
        g.beginPath(); g.ellipse(cx, rimY, rx, ry, 0, Math.PI * 1.06, Math.PI * 1.94); g.stroke();
      } else {
        const rgr = g.createLinearGradient(0, rimY - ry, 0, rimY + ry);
        rgr.addColorStop(0.00, '#ffb877');
        rgr.addColorStop(0.34, '#f5852f');
        rgr.addColorStop(0.72, '#df651a');
        rgr.addColorStop(1.00, '#a63c08');
        g.strokeStyle = rgr;
        g.beginPath(); g.ellipse(cx, rimY, rx, ry, 0, 0, Math.PI); g.stroke();
        // 近侧弧顶上的镜面高光
        g.strokeStyle = 'rgba(255,228,196,0.80)';
        g.lineWidth = 2.2;
        g.beginPath(); g.ellipse(cx, rimY, rx, ry, 0, 0.08 * Math.PI, 0.92 * Math.PI); g.stroke();
      }
      g.restore();
    }

    /** 篮圈近侧半弧的包围盒（含描边半宽 tube） */
    rimFrontRect(hoop) {
      const rx = hoop.span / 2 + hoop.tube;
      const ry = rimSquash(hoop.span / 2) + hoop.tube;
      return [hoop.cx - rx - 2, hoop.rimY - hoop.tube - 2, rx * 2 + 4, ry + hoop.tube + 4];
    }

    /** 网的包围盒（含进球时下坠的余量） */
    netRect(hoop) {
      const rx = hoop.span / 2 + 2;
      const ry = rimSquash(hoop.span / 2);
      const len = hoop.netLen || 82;
      return [hoop.cx - rx, hoop.rimY - ry - 4, rx * 2, ry + len + 46];
    }

    drawRimFront(g, hoop) {
      this.drawRim(g, {
        cx: hoop.cx, rimY: hoop.rimY,
        rx: hoop.span / 2, ry: rimSquash(hoop.span / 2), tube: hoop.tube,
      }, 'front');
    }

    /**
     * 网：从篮圈椭圆垂下的菱形网。两族斜向网绳交织 + 底部收口环。
     *
     * 两个细节决定了它像不像网：
     *  1) 先描一遍半透明的深灰"落影"再描白绳 —— 纯白线在浅色桌面上是看不见的，
     *     而且会显得像一堆漂浮的塑料细丝。
     *  2) 顶部按篮圈远侧弧裁掉：挂点的后半圈在 3D 里被篮圈挡住，
     *     不裁就会看到网绳横穿篮圈的暗色远弧，一眼假。
     *
     * @param {number} anim 进球动画强度 0..1（越大网越鼓、越亮）
     * @param {number} ph   动画相位
     */
    drawNet(g, hoop, anim, ph) {
      const cx = hoop.cx, rimY = hoop.rimY;
      const rx = hoop.span / 2, ry = rimSquash(rx);
      const len = hoop.netLen || 82;
      const N = 12, ROWS = 4, SHRINK = 0.46;
      const sag = anim * 18;

      const pt = (i, row) => {
        const t = row / ROWS;
        const a = (i / N) * TAU;
        const k = 1 - SHRINK * t;
        const wob = anim > 0.02 ? anim * 7 * t * Math.sin(a * 2 + ph) : 0;
        return {
          x: cx + Math.cos(a) * rx * k,
          y: rimY + Math.sin(a) * ry * k + len * t + sag * t * t + wob,
        };
      };

      const strokes = (lw, style) => {
        g.lineWidth = lw;
        g.strokeStyle = style;
        // 两族斜绳交织成菱形网格
        for (let dir = -1; dir <= 1; dir += 2) {
          for (let i = 0; i < N; i++) {
            g.beginPath();
            for (let row = 0; row <= ROWS; row++) {
              const p = pt(i + dir * row * 0.5, row);
              if (row === 0) g.moveTo(p.x, p.y);
              else g.lineTo(p.x, p.y);
            }
            g.stroke();
          }
        }
        // 网底收口
        g.beginPath();
        for (let i = 0; i <= N; i++) {
          const p = pt(i, ROWS);
          if (i === 0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        }
        g.stroke();
      };

      g.save();
      g.lineCap = 'round';
      g.beginPath();
      g.rect(cx - rx - 4, rimY - ry + hoop.tube, rx * 2 + 8, len + sag + 70);
      g.clip();
      g.save();
      g.translate(0.9, 1.2);
      strokes(2.4, 'rgba(64,78,100,0.42)');       // 落影
      g.restore();
      strokes(1.5, anim > 0.02
        ? 'rgba(255,255,255,' + (0.82 + anim * 0.18).toFixed(3) + ')'
        : 'rgba(247,250,255,0.95)');
      g.restore();
    }

    // ------------------------------------------------------------ 动态层
    drawBall(g, ball, perf) {
      // ⚠️ 画面位置（插值后），不是 body.position —— 见 syncRenderPos 的说明。
      const p = this.posOf(ball);
      const r = ball.r;

      const v = ball.body.velocity;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y);
      const stretch = Math.min(0.16, sp / 14000);
      const s = (ball.squash || 0) + stretch;

      // 验收模式：同一个变换、同一个半径，只把外观换成一块纯色圆盘（见构造函数）。
      if (this.flatBall) {
        g.save();
        g.translate(p.x, p.y);
        if (s > 0.006) {
          const ang = sp > 30 ? Math.atan2(v.y, v.x) : 0;
          g.rotate(ang);
          g.scale(1 + s, 1 - s * 0.85);
          g.rotate(-ang);
        }
        g.fillStyle = '#ff00ff';
        g.beginPath(); g.arc(0, 0, this.flatBallR > 0 ? this.flatBallR : r, 0, TAU); g.fill();
        g.restore();
        perf.drawCalls += 1;
        return;
      }

      let calls = 0;
      if (this.layerMask & 1) {
        g.globalAlpha = 0.92;
        const sw = r * 2.30, shh = r * 1.95;
        g.drawImage(this.shadowTex, p.x + 5 - sw / 2, p.y + 7 - shh / 2, sw, shh);
        g.globalAlpha = 1;
        calls++;
      }

      const d = r * 2;
      // 皮肤：金球带自己的 skin（'gold'），其余球跟随全局主题（this.skin）
      const set = ball.skin ? this.texFor(ball.skin) : this.tex;
      /**
       * 按「这一帧球要画多大」挑贴图，三级降到最低成本：
       *   s ≤ 0.006 → exact（drawImage 严格 1:1，像素与母版现算逐字节相同）
       *   否则      → head（直径 ×1.3，轻微缩小，肉眼无差）
       *   超过 head → master（320²，与优化前的行为完全一致）
       * 选中哪一级不会改变画面，只会改变每帧的重采样量。
       */
      let tex = set;
      if (s > 0.006) tex = (1 + s) <= Renderer.MIP_HEAD ? set.head : set.master;

      /**
       * 运动拖尾：残影画在**阴影之上、球体之下**，所以放在这里、进变换之前。
       * 残影不做挤压/拉伸（它们是"过去某一帧的球"，用静止形状即可），
       * 一来省掉每颗残影一次 save/rotate/scale，二来视觉上更像运动模糊而非一串变形的球。
       */
      calls += this.drawTrail(g, ball, tex, r);

      g.save();
      g.translate(p.x, p.y);
      if (s > 0.006) {
        const ang = sp > 30 ? Math.atan2(v.y, v.x) : 0;
        g.rotate(ang);
        g.scale(1 + s, 1 - s * 0.85);
        g.rotate(-ang);
      }
      const m = this.layerMask;

      /**
       * 素材皮肤（`tex.single`）：**一张贴图、一次绘制，而且跟着球转**。
       *
       * 为什么整颗球一起转：素材是照片级材质，静止的球面一眼就能看出"贴纸感" ——
       * 真实球体在滚，材质必须跟着滚。圆盘绕圆心旋转，几何上恰好等于球体绕**视线轴**
       * 自转（正投影下这一条是精确的，不是近似），所以直接 rotate 就是对的。
       * 代价是烘进去的高光也会跟着转 —— 实物的高光应该钉在空间里不动。权衡后保留：
       * 本程序的自转角速度很慢（一秒钟也就转几度），高光缓慢扫过读起来像"表面在流动"，
       * 比"球在滚、材质纹丝不动"自然得多；而且省下的这次绘制调用在 100 球档很值钱。
       */
      if (tex.single) {
        if (m & 2) {
          g.save();
          g.rotate(this.angOf(ball));
          g.drawImage(tex.single, -r, -r, d, d);
          g.restore();
          calls++;
        }
        g.restore();
        perf.drawCalls += calls;
        return;
      }

      /**
       * base 与 hi 都不随球旋转、又画在同一坐标系里 → 生产路径直接画烘前合并的 `body`。
       * 每球绘制次数 4 → 3，是 60 球档从 55fps（GPU）/ 47fps（软件）回到 60fps 的原因。
       * 结论来自一次三项对照实验（脚本见 tools/bench-60.js 的注释）：
       *   ① 球缝换成不透明纯色块（同样 1 次绘制）→ 帧率不动 ⇒ 不是逐像素 alpha 混合的锅
       *   ② 全部强制走 1:1 的 exact 档（不做重采样）→ 帧率不动 ⇒ 不是每帧重采样的锅
       *   ③ 少画一层（4 次 → 3 次）→ 54fps 直接回到 60 ⇒ 就是**每帧绘制调用次数**
       * 所以修法是"合并可合并的层"，而不是"把贴图烘小/烘糊"。
       */
      if ((m & 2) && (m & 8)) {
        g.drawImage(tex.body, -r, -r, d, d);
        calls++;
      } else if (m & 2) {
        g.drawImage(tex.base, -r, -r, d, d);
        calls++;
      }
      if (m & 4) {
        g.save();
        // bit16 = 诊断用：让球缝**不旋转**。用它把"旋转 drawImage 本身贵不贵"
        // 与"这一层的数据量大小"分开 —— 两者都表现为同一层，但修法完全不同。
        g.rotate((m & 16) ? 0 : this.angOf(ball));
        g.translate(-r, -r);
        g.drawImage(tex.seam, 0, 0, d, d);
        g.restore();
        calls++;
      }
      if ((m & 8) && !(m & 2)) { g.drawImage(tex.hi, -r, -r, d, d); calls++; }
      g.restore();
      perf.drawCalls += calls;
    }

    /**
     * 拖拽瞄准辅助线：预测抛物线 + 落点标记。
     *
     * 只在拖拽期间存在（见 app.js::predictPath）。点已经由物理侧算好，
     * 这里只负责画：越远的点越淡、越小（暗示"预测置信度递减"），
     * 落点上画一个十字靶环。
     */
    drawAim(g, aim) {
      const pts = aim.pts;
      if (!pts || pts.length < 2) return;
      const col = aim.color || '#7fe3ff';
      g.save();
      g.lineCap = 'round';
      // 每个点先铺一圈深色底再画亮色点。
      // ⚠️ 不能只画亮色：桌面壁纸可能是白的，浅青/浅黄的实心点铺在浅色上几乎不可见
      // （实测 capturePage 的透明底合成出来就是纯白，一眼看过去像"瞄准线没画出来"）。
      // 深色底让它在任何壁纸上都有对比度 —— 与飘字的 strokeText 是同一个理由。
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const k = 1 - i / pts.length;          // 1 → 0，沿路径衰减
        const r = 1.4 + k * 2.0;
        g.globalAlpha = 0.30 + k * 0.42;
        g.fillStyle = col;
        g.beginPath(); g.arc(p.x, p.y, r, 0, TAU); g.fill();
        g.globalAlpha = 0.22 + k * 0.20;
        g.strokeStyle = 'rgba(18,12,4,0.9)';
        g.lineWidth = 1.6;
        g.beginPath(); g.arc(p.x, p.y, r + 0.9, 0, TAU); g.stroke();
      }
      if (aim.hit) {
        const h = aim.hit;
        g.globalAlpha = 0.35;
        g.strokeStyle = 'rgba(18,12,4,0.9)';
        g.lineWidth = 4.2;
        g.beginPath(); g.arc(h.x, h.y, 9, 0, TAU); g.stroke();
        g.globalAlpha = 0.9;
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.beginPath(); g.arc(h.x, h.y, 9, 0, TAU); g.stroke();
        g.globalAlpha = 0.6;
        g.fillStyle = col;
        g.beginPath(); g.arc(h.x, h.y, 3.5, 0, TAU); g.fill();
        g.globalAlpha = 0.5;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(h.x - 16, h.y); g.lineTo(h.x - 5, h.y);
        g.moveTo(h.x + 5, h.y); g.lineTo(h.x + 16, h.y);
        g.stroke();
      }
      g.restore();
      perf.drawCalls += pts.length;
    }

    /**
     * @param {object} scene { balls, hoop, particles, texts, dragging }
     */
    frame(scene) {
      const g = this.dctx;
      const t0 = performance.now();
      this.drawCalls = 0;

      const balls = scene.balls;
      const fx = scene.particles || [];
      const tx = scene.texts || [];
      const rings = scene.rings || [];
      const hoop = scene.hoop;
      const hoopOn = !!(hoop && hoop.enabled);
      const netAnim = hoopOn ? hoop.netAnim : 0;
      const flash = hoopOn ? hoop.flash : 0;

      // ---- 0. 先算本帧的插值渲染位置/角度（见 syncRenderPos）
      // 必须在收集图元之前：下面 updateTrail / ballAABB / drawBall 统统读 posOf()。
      // scene.alpha 缺省 1 = 直接落在物理位置上（老行为，也是 smooth 关掉时的行为）。
      this.syncRenderPos(balls, scene.alpha === undefined ? 1 : scene.alpha);

      // ---- 1. 标记脏块：前两帧的活动元素 + 本帧的活动元素
      // 保留两代历史是廉价保险：位置/尺寸任何一帧算偏，最多也就多刷几块，不会留残影
      for (let i = 0; i < this.prevActive.length; i++) {
        const r = this.prevActive[i];
        this.markRect(r[0], r[1], r[2], r[3]);
      }
      for (let i = 0; i < this.prevActive2.length; i++) {
        const r = this.prevActive2[i];
        this.markRect(r[0], r[1], r[2], r[3]);
      }

      // ---- 2. 收集本帧图元
      // 每个图元的包围盒只算一次，同时用于「标脏」和「本帧要不要重画」两个判断。
      // 顺序 = 全局 z 序（球 → 粒子 → 飘字 → 瞄准线 → 网 → 闪光 → 篮圈近侧弧），
      // 与旧实现逐块绘制时的块内顺序完全一致，所以画面不变。
      const items = [];
      const active = [];
      // 每帧重置拖尾绘制额度（见 TRAIL_BUDGET）；耗尽后剩下的球这一帧不留残影
      this._trailBudget = TRAIL_BUDGET;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        this.updateTrail(b);
        const moving = !b.body.isSleeping || b === scene.dragging || (b.squash || 0) > 0 ||
                       (b._trail && b._trail.length > 0);
        const a = this.ballAABB(b);
        items.push({ rect: a, kind: 0, ref: b });
        if (moving) active.push(a);
      }
      for (let i = 0; i < fx.length; i++) {
        const p = fx[i];
        const pad = p.r + 4;
        const r = [p.x - pad, p.y - pad, pad * 2, pad * 2];
        items.push({ rect: r, kind: 1, ref: p });
        active.push(r);
      }
      // 冲击波光环：压在火花之下、飘字之上，进球那一下的"扩散感"就来自它
      for (let i = 0; i < rings.length; i++) {
        const rg = rings[i];
        const pad = rg.r + rg.w + 4;
        const r = [rg.x - pad, rg.y - pad, pad * 2, pad * 2];
        items.push({ rect: r, kind: 8, ref: rg });
        active.push(r);
      }
      for (let i = 0; i < tx.length; i++) {
        const t = tx[i];
        const r = this.textBox(t);          // 只量一次（旧实现每帧量两遍）
        items.push({ rect: r, kind: 2, ref: t });
        active.push(r);
      }
      // 瞄准线：每帧位置都在变，必须重画（否则上一帧的虚线会留在画布上）
      const aimBox = this.aimAABB(scene.aim);
      if (aimBox) {
        items.push({ rect: aimBox, kind: 6, ref: scene.aim });
        active.push(aimBox);
      }
      // 网与篮圈近侧弧始终入列：脏块被清掉后要能重画回来，否则球路过的位置会在网上留下一个洞
      let netBox = null, rimBox = null, flashBox = null;
      if (hoopOn) {
        netBox = this.netRect(hoop);
        rimBox = this.rimFrontRect(hoop);
        items.push({ rect: netBox, kind: 3, ref: hoop });
        if (flash > 0) {
          flashBox = [hoop.cx - 84, hoop.rimY - 84, 168, 168];
          items.push({ rect: flashBox, kind: 4, ref: hoop });
        }
        items.push({ rect: rimBox, kind: 5, ref: hoop });
        // 动画期间这几块每帧都要重画；静止时靠「球路过时的脏块」顺带重画即可
        if (flash > 0) active.push(flashBox);
        if (netAnim > 0) { active.push(netBox); active.push(rimBox); }
      }

      for (let i = 0; i < active.length; i++) {
        const r = active[i];
        this.markRect(r[0], r[1], r[2], r[3]);
      }
      this.prevActive2 = this.prevActive;
      this.prevActive = active;

      // ---- 3. 决定重绘范围
      const total = this.tw * this.th;
      let dirtyCount = 0;
      if (!this.needFull) {
        for (let i = 0; i < total; i++) if (this.dirty[i]) dirtyCount++;
      }
      const full = this.needFull || dirtyCount > total * 0.6;
      if (full) {
        g.clearRect(0, 0, this.w, this.h);
        this.dirty.fill(1);
        dirtyCount = total;
        this.needFull = false;
      }
      if (dirtyCount === 0) {
        this.tilesDrawn = 0;
        this.lastDrawMs = performance.now() - t0;
        return;
      }

      // ---- 4. 清脏块（纯 clearRect，不再逐块 save/clip/restore）
      let tiles = 0;
      if (!full) {
        for (let ty = 0; ty < this.th; ty++) {
          const row = ty * this.tw;
          for (let tx2 = 0; tx2 < this.tw; tx2++) {
            if (!this.dirty[row + tx2]) continue;
            tiles++;
            g.clearRect(tx2 * TILE, ty * TILE, TILE, TILE);
          }
        }
      } else {
        tiles = total;
      }

      // ---- 5. 每个图元只画一次
      // ⚠️ 旧实现是「逐脏块 × 遍历全部图元」，一个跨 4 块的球会被**完整重绘 4 遍**
      // （球是 4 层 drawImage → 16 次/帧）。脏块只负责"把哪儿擦掉"，不负责"每个元素画几遍"：
      // 先统一清块，再按全局 z 序各画一次，只跳过「包围盒完全不碰脏块」的图元 ——
      // 那些图元的像素这帧根本没被擦掉，保留在画布上即可（休眠球正是靠这一点零成本）。
      //
      // ⚠️ 但"不裁剪也不会出问题"只在**整块包围盒都被清过**时成立。只清了一部分时，
      //    图元会把自己盖在"上一帧残留的同一像素"上再画一遍 ⇒ alpha 叠加。用
      //    `dirtyCover` 区分这两种情况：`all=false` 就按已清块裁剪（见该方法注释）。
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const cov = this.dirtyCover(it.rect);
        if (!cov.any) continue;
        const partial = !cov.all;
        if (partial) { g.save(); g.clip(cov.path); }
        switch (it.kind) {
          case 0: this.drawBall(g, it.ref, this); break;
          case 1: {
            const p = it.ref;
            g.globalAlpha = p.a;
            g.fillStyle = p.color;
            /**
             * 彩带（`shape:'ribbon'`）：细长条 + 自转 —— 圆点堆不出"彩纸在飘"的观感。
             * 用 fillRect 而不是画线：线的端点样式在不同 DPI 下对不齐，矩形最稳。
             */
            if (p.shape === 'ribbon') {
              g.save();
              g.translate(p.x, p.y);
              g.rotate(p.rot || 0);
              g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
              g.restore();
            } else {
              g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill();
            }
            g.globalAlpha = 1;
            break;
          }
          case 2: {
            const t = it.ref;
            g.globalAlpha = t.a;
            g.font = 'bold ' + t.size + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.lineWidth = 4;
            g.strokeStyle = 'rgba(40,16,0,0.65)';
            g.strokeText(t.text, t.x, t.y);
            g.fillStyle = t.color;
            g.fillText(t.text, t.x, t.y);
            g.globalAlpha = 1;
            break;
          }
          case 3: this.drawNet(g, it.ref, netAnim, it.ref.netT || 0); break;
          case 4: {
            const a = it.ref.flash;
            g.globalAlpha = a * 0.9;
            g.strokeStyle = '#ffd66b';
            g.lineWidth = 3;
            g.beginPath();
            g.arc(it.ref.cx, it.ref.rimY, it.ref.span / 2 + it.ref.tube + 12 + (1 - a) * 26, 0, TAU);
            g.stroke();
            g.globalAlpha = 1;
            break;
          }
          case 5: this.drawRimFront(g, it.ref); break;
          case 6: this.drawAim(g, it.ref); break;
          case 8: {
            const rg = it.ref;
            g.globalAlpha = rg.a;
            g.strokeStyle = rg.color;
            g.lineWidth = rg.w;
            g.beginPath(); g.arc(rg.x, rg.y, rg.r, 0, TAU); g.stroke();
            g.globalAlpha = 1;
            break;
          }
        }
        if (partial) g.restore();
      }

      // 脏标记留到所有图元画完再清：第 5 步还要用它判断"这个图元有没有被擦到"
      this.dirty.fill(0);
      this.tilesDrawn = tiles;
      this.lastDrawMs = performance.now() - t0;
    }

    /**
     * 扫描包围盒覆盖的脏块。
     *
     * - `any=false` ⇒ 它这一帧的像素原封不动，**跳过重绘**（休眠球就是靠这条零成本）。
     * - `any=true && all=true` ⇒ 它占的块全被清过 ⇒ 干净地重画一遍（常见路径）。
     * - `any=true && all=false` ⇒ **只被清了一部分**。这时绝不能直接画：`drawBall` /
     *   `drawNet` 这些图元不裁剪、一次就把自己整块画出来，没被清掉的块上还留着上一帧
     *   同一颗球，第二遍画上去就是在同一块像素上**叠加两次**（`1-(1-a)² > a`）。
     *   必须用 `path`（已清块拼出的裁剪区）裁着画：擦掉的照原样重画、没擦的原样保留。
     *
     * 2026-10-11 实测：休眠球 AABB 蹭到邻球的脏块时踩的就是这条 —— 外圈抗锯齿像素
     * alpha 被叠高最多 64，**纯增益、零损失、几何完全不变**（`__pbSnapBox`/`__pbDiffBox`）。
     * `verify-render` 的"休眠球像素保留"判据反复报的 +37 / +72 / +130px 就是它，
     * 不是残影也不是球在动。`path` 只在需要时才建，`all=true` 的常见路径零分配。
     */
    dirtyCover(r) {
      const x0 = Math.max(0, Math.floor(r[0] / TILE));
      const y0 = Math.max(0, Math.floor(r[1] / TILE));
      const x1 = Math.min(this.tw - 1, Math.floor((r[0] + r[2]) / TILE));
      const y1 = Math.min(this.th - 1, Math.floor((r[1] + r[3]) / TILE));
      let any = false, all = true;
      for (let ty = y0; ty <= y1; ty++) {
        const row = ty * this.tw;
        for (let tx = x0; tx <= x1; tx++) {
          if (this.dirty[row + tx]) any = true; else all = false;
        }
        if (any && !all) break;                     // 已经确定要裁剪，不必再扫
      }
      if (!any) return { any: false, all: false, path: null };
      if (all) return { any: true, all: true, path: null };
      const path = new Path2D();
      for (let ty = y0; ty <= y1; ty++) {
        const row = ty * this.tw;
        for (let tx = x0; tx <= x1; tx++) {
          if (this.dirty[row + tx]) path.rect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
      return { any: true, all: false, path: path };
    }

    /**
     * 飘字的包围盒。
     *
     * ⚠️ 不能用固定尺寸（早先是写死的 96×52）。脏块是**唯一**决定"哪块画布被清掉重画"
     * 的东西：文字比声明的盒子宽时，超出的像素落在没被标脏的块里 —— 那些块从不清除，
     * 于是每次飘字都在画布上留一层残影，越叠越糊。成就横幅 / 成就列表都是长文本，
     * 正好会踩中，所以这里按实际宽度量。
     */
    textBox(t) {
      const g = this.dctx;
      g.font = 'bold ' + t.size + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = g.measureText(t.text).width + 16;
      const h = t.size * 1.6 + 8;
      return [t.x - w / 2, t.y - h / 2, w, h];
    }

    invalidateAll() { this.needFull = true; }

    /** 瞄准线（点串 + 落点）的包围盒；没有瞄准线时返回 null */
    aimAABB(aim) {
      if (!aim || !aim.pts || !aim.pts.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < aim.pts.length; i++) {
        const p = aim.pts[i];
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      if (aim.hit) {
        x0 = Math.min(x0, aim.hit.x - 18); x1 = Math.max(x1, aim.hit.x + 18);
        y0 = Math.min(y0, aim.hit.y - 14); y1 = Math.max(y1, aim.hit.y + 14);
      }
      return [x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12];
    }

    /**
     * 空闲期是否还有挂起的重绘。
     * 关键：空闲时主循环默认不渲染，但「切换篮球框 / 增删球 / 窗口尺寸变化」
     * 都只是把脏块标起来 —— 没有这个检查，这些改动要等到下次有球动起来才可见
     * （表现为"点了开关没反应，动一下才出现"）。
     */
    pending() {
      if (this.needFull) return true;
      for (let i = 0; i < this.dirty.length; i++) if (this.dirty[i]) return true;
      return false;
    }
  }

  PB.Renderer = Renderer;
  /**
   * 烘焙余量：mip 按「球直径 × 该倍数」烘。
   * 挤压/拉伸最多把球放大到 1.50 倍（squash ≤ 0.34 + 速度拉伸 ≤ 0.16），
   * 1.3 覆盖了绝大多数帧；只有更夸张的那几十毫秒才回落到 320² 母版。
   */
  Renderer.MIP_HEAD = 1.3;
  PB.TILE = TILE;
  /** 皮肤表暴露给 app.js（菜单显示名 / 循环切换顺序）；'gold' 不在循环里，只归金球用 */
  PB.SKINS = SKINS;
  PB.SKIN_IMG = SKIN_IMG;
  /**
   * 右键菜单「球皮肤」的轮换顺序。
   * 前三个是程序化外观（经典篮球 / 能量球 / 足球 = 手画的调色板），后面几个是
   * **照片级素材**（真实西瓜照片、地球与木星的等距圆柱贴图），材质全部取自
   * 公共领域 / CC0 / CC BY 的公开素材，来源记在 README 的「素材来源」一节。
   */
  PB.SKIN_ORDER = ['classic', 'neon', 'soccer', 'watermelon', 'planet', 'jupiter'];
  window.__pbRMark('render-end');
})();
