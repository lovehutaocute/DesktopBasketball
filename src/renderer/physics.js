'use strict';
/**
 * physics.js —— 物理层
 *
 * 直接复用成熟引擎 Matter.js 0.20（MIT）：
 *   · 自适应网格 broad-phase（空间分区，避免 O(n²) 全量两两检测）
 *   · Verlet 积分 + 顺序脉冲求解器（Sequential Impulse，Catto GDC08）
 *   · 休眠策略（Sleeping）—— 静止球完全不参与积分与碰撞求解
 *
 * 本层只做三件引擎之外的事：
 *   1) 固定时间步长（accumulator，见 app.js），Matter 永远拿到 16.667ms
 *   2) 拖拽 = 速度伺服（而不是瞬移），保证碰撞仍然正确、松手自然带出初速度
 *   3) 进球判定（穿越篮筐平面 + 速度方向 + 横向范围）
 */
(function () {
  window.__pbRMark('physics-start');
  const M = window.Matter;
  const PB = (window.PB = window.PB || {});

  const STEP_MS = 1000 / 60;

  /** 连击窗口：两次命中间隔 ≤ 该值记为连击，否则重新从 1 起算 */
  const COMBO_WINDOW_MS = 4000;
  /** 空心球判定：球一旦碰到篮板/篮圈就作废；回到篮圈上方 80px 以上视为新一次投篮 */
  const SWISH_RESET_PAD = 80;

  /**
   * ⚠️ 单位约定（本项目最容易踩的坑）：
   * Matter.js 的速度单位是「像素 / 固定步长(16.667ms)」，不是像素/秒。
   * 60 px/step == 3600 px/s。指针速度、配置项一律用 px/s（人读得懂），
   * 进入物理层前必须 V() 折算，否则速度会被放大 60 倍 → 穿透墙体 → 求解器把球炸飞。
   */
  const V = (pxPerSec) => pxPerSec / 60;
  const V_INV = (pxPerStep) => pxPerStep * 60;

  class World {
    constructor(cfg, hooks) {
      this.cfg = cfg;
      this.hooks = hooks || {};

      this.engine = M.Engine.create({ enableSleeping: true });
      this.engine.gravity.y = 1;
      this.engine.gravity.scale = 0.0012;
      this.engine.positionIterations = 8;
      this.engine.velocityIterations = 4;
      this.engine.constraintIterations = 2;

      this.bounds = { w: 1280, h: 720 };
      this.balls = [];
      this.walls = [];
      this.hoop = null;
      this.lastWakeNearAt = 0;   // 邻近球预唤醒的节流时间戳，见 moveDrag
      this.score = 0;
      this.highScore = 0;        // 由 app.js 用 config.highScore 初始化
      this.combo = 0;            // 当前连击数（0 = 尚未进球）
      this.lastScoreAt = 0;      // 上次进球时间戳，连击窗口用

      this.dragBody = null;
      this.dragTarget = null;
      this.dragVel = { x: 0, y: 0 };

      this._wakeRadius = 130;
      this.stats = { steps: 0, lastStepMs: 0, avgStepMs: 0, maxStepMs: 0, awake: 0, pairs: 0 };
    }

    // ------------------------------------------------------------ 边界
    setBounds(w, h) {
      this.bounds.w = w;
      this.bounds.h = h;
      for (const wall of this.walls) M.Composite.remove(this.engine.world, wall);
      const T = 400;
      const opt = { isStatic: true, friction: 0.35, restitution: 0.55, label: 'wall' };
      this.walls = [
        // 地面 = 任务栏顶边
        M.Bodies.rectangle(w / 2, h + T / 2, w + T * 4, T, opt),
        // 左右墙
        M.Bodies.rectangle(-T / 2, h / 2, T, h * 3, opt),
        M.Bodies.rectangle(w + T / 2, h / 2, T, h * 3, opt),
        // 天花板
        M.Bodies.rectangle(w / 2, -T / 2, w + T * 4, T, opt),
      ];
      M.Composite.add(this.engine.world, this.walls);
      if (this.hoop && this.hoop.enabled) this.setHoop(true, true);
    }

    /**
     * 把所有球夹回 `[r, W-r] × [r, H-r]`，并把越界球的速度清零。
     *
     * ⚠️ **窗口尺寸变化后必须调用**（换显示器 / 白板投屏插入 / 系统改分辨率，
     *    见 app.js::resize）。不夹会出现两类事故，表现都是"换了设备以后篮球画面缺失"：
     *      ① 球留在旧屏的**下方** → 它落在"地面"静态体内部（地面厚 400、从 h 往下伸 200），
     *         而 Matter 的 position solver 把"深穿透"当成需要猛推的分离量，
     *         会把球直接弹到几万像素外 —— 这就是 findSpawn 注释里那个最深的坑；
     *      ② 球留在旧屏的**右侧** → 在右墙之外，渲染层照画，但窗口区域（SetWindowRgn）
     *         里没有它，看上去就是"球没了"。
     *
     * 只夹位置、不重新抽签出生点：球少时保持原有分布，不至于让用户觉得"换屏后全乱了"。
     *
     * @returns {number} 真正被搬动过的球数（>0 时值得记一条日志）。
     */
    clampBalls() {
      const w = this.bounds.w, h = this.bounds.h;
      /**
       * ⚠️ 判"越界"必须留容差，而且**不能用 1px**：实测（200 球静置、`--no-gpu`）
       *    躺在地面上的球中心稳定落在 `h - r + 1~2px`（求解器允许的穿插），
       *    靠墙的球同理 `w - r + 1`。1px 容差会把十几颗安静躺着的球判成越界 ——
       *    每次 resize 都"挪回去 + 清速度 + 唤醒 + 记一条日志"，既是一次无谓的物理抖动，
       *    也会用假警覆盖真正要看的那条日志（"换到大屏后夹回了 180 颗"）。
       *    实测最大穿插 2px，取 6px 留 3 倍余量；而我们要防的场景（球在旧屏坐标上）
       *    偏差是**几百像素**，两者差两个数量级，不会误判。
       */
      const TOL = 6;
      let moved = 0;
      for (const b of this.balls) {
        const p = b.body.position;
        const r = b.r;
        let x = p.x, y = p.y;
        if (!isFinite(x) || !isFinite(y)) { x = w / 2; y = h / 2; }
        else {
          if (x < r - TOL) x = r; else if (x > w - r + TOL) x = w - r;
          if (y < r - TOL) y = r; else if (y > h - r + TOL) y = h - r;
        }
        if (x !== p.x || y !== p.y) {
          M.Sleeping.set(b.body, false);
          M.Body.setPosition(b.body, { x: x, y: y });
          M.Body.setVelocity(b.body, { x: 0, y: 0 });
          // 插值快照一起搬，否则这一帧会被画在"旧位置 → 新位置"连线上的某点（见 __pbPlace）
          if (b._px !== undefined) { b._px = x; b._py = y; }
          b.prevY = y;
          moved++;
        }
      }
      return moved;
    }

    // ------------------------------------------------------------ 球
    /**
     * 找一个与现有球不重叠的出生点。
     *
     * ⚠️ 绝不能把球生成在场地之外（尤其是 y<0 的天花板静态体内部）：
     * Matter 的 position solver 会把"深穿透"当成需要猛推的分离量，
     * 直接把球弹到几万像素外 —— 这是本项目踩过的最深的坑。
     * 所以出生点永远在 [r, W-r] × [r, H-r] 之内。
     */
    findSpawn(r) {
      const pad = r + 10;
      const step = r * 2.65;
      const cols = Math.max(1, Math.floor((this.bounds.w - pad * 2) / step));
      const rows = Math.max(1, Math.floor((this.bounds.h - pad * 2) / step));
      const total = cols * rows;
      const start = Math.floor(Math.random() * total);
      for (let k = 0; k < total; k++) {
        const idx = (start + k) % total;
        const x = pad + ((idx % cols) + 0.5) * step;
        const y = pad + (Math.floor(idx / cols) + 0.5) * step;
        if (!this.overlaps(x, y, r * 2.45)) {
          return { x: x, y: y, vx: V((Math.random() - 0.5) * 160), vy: 0 };
        }
      }
      // 网格全满（理论上不会发生：60 颗球只需要 135 个格子里的 60 个）
      return { x: pad + Math.random() * (this.bounds.w - pad * 2), y: pad, vx: 0, vy: 0 };
    }

    overlaps(x, y, d) {
      const d2 = d * d;
      for (let i = 0; i < this.balls.length; i++) {
        const p = this.balls[i].body.position;
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy < d2) return true;
      }
      return false;
    }

    addBall(x, y, vx, vy) {
      const r = this.cfg.ballRadius;
      if (x === undefined) {
        const s = this.findSpawn(r);
        x = s.x; y = s.y; vx = s.vx; vy = s.vy;
      } else if (this.overlaps(x, y, r * 2.3)) {
        // 恢复存档位置时可能已经和其它球重合 → 换成安全出生点
        const s = this.findSpawn(r);
        x = s.x; y = s.y; vx = 0; vy = 0;
      }
      const body = M.Bodies.circle(x, y, r, {
        label: 'ball',
        restitution: this.cfg.restitution,
        friction: 0.055,
        frictionStatic: 0.14,
        frictionAir: this.cfg.frictionAir,
        density: 0.00125,
        slop: 0.02,
        sleepThreshold: 52,
      }, 22);
      M.Body.setVelocity(body, { x: vx || 0, y: vy || 0 });
      M.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.12);

      const ball = {
        body,
        r,
        prevY: y,
        squash: 0,
        squashX: 0,
        squashY: 1,
        spinBoost: 0,
        alive: true,
        wasSleeping: false,
        entered: 0,
        /** 本次投篮是否碰过篮板/篮圈（碰过 → 不是空心球）。挂在刚体上见 bindCollisions */
        touchedHoop: false,
        /** 金球（app.js 随机彩蛋）：投进得双倍分 */
        golden: false,
      };
      body.touchedHoop = false;   // 碰撞回调只能拿到 Matter 刚体，标记同步挂在它上面
      body._pbBall = ball;        // 反向引用：碰撞回调据此把刚体还原成外层 ball 对象
      this.balls.push(ball);
      M.Composite.add(this.engine.world, body);
      return ball;
    }

    removeBall() {
      const ball = this.balls.pop();
      if (!ball) return null;
      M.Composite.remove(this.engine.world, ball.body);
      if (this.dragBody === ball.body) {
        this.dragBody = null;
        this.dragTarget = null;
      }
      return ball;
    }

    clearBalls() {
      for (const b of this.balls) M.Composite.remove(this.engine.world, b.body);
      this.balls.length = 0;
      this.dragBody = null;
      this.dragTarget = null;
    }

    pick(x, y, extra) {
      const pad = extra === undefined ? 10 : extra;
      let best = null;
      let bestD = Infinity;
      for (const b of this.balls) {
        const dx = b.body.position.x - x;
        const dy = b.body.position.y - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= b.r + pad && d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    }

    wakeNear(x, y, radius) {
      const rr = (radius || this._wakeRadius) * (radius || this._wakeRadius);
      for (const b of this.balls) {
        if (b.body.isSleeping) {
          const dx = b.body.position.x - x;
          const dy = b.body.position.y - y;
          if (dx * dx + dy * dy < rr) M.Sleeping.set(b.body, false);
        }
      }
    }

    // ------------------------------------------------------------ 拖拽
    beginDrag(ball, x, y) {
      this.dragBody = ball.body;
      this.dragTarget = { x: x, y: y };
      this.dragVel = { x: 0, y: 0 };
      M.Sleeping.set(ball.body, false);
      this.wakeNear(x, y, 150);
    }

    moveDrag(x, y, vx, vy) {
      if (!this.dragTarget) return;
      this.dragTarget.x = x;
      this.dragTarget.y = y;
      this.dragVel.x = vx;
      this.dragVel.y = vy;
      // 预唤醒邻近球，让被拖的球"带着"周围的球动起来。
      // ⚠️ 按物理步长节流，不要按指针事件频率调：高回报率鼠标的 pointermove
      // 可以到 1000Hz，而球的位置每步（16.7ms）才更新一次 —— 同一个 120px 半径
      // 在一帧里被扫 15 遍完全等价，只是白烧 CPU（而且会把更多球留在“已唤醒”
      // 状态，拖拽期间白白多算十几颗球的碰撞）。
      const now = performance.now();
      if (now - this.lastWakeNearAt >= STEP_MS) {
        this.lastWakeNearAt = now;
        this.wakeNear(x, y, 120);
      }
    }

    endDrag() {
      const b = this.dragBody;
      this.dragBody = null;
      this.dragTarget = null;
      this.lastWakeNearAt = 0;
      if (b) M.Body.setAngularVelocity(b, b.angularVelocity);
      return b;
    }

    // ------------------------------------------------------------ 篮筐
    setHoop(on, force) {
      if (this.hoop && this.hoop.enabled === !!on && !force) return;
      if (this.hoop) {
        for (const p of this.hoop.parts) M.Composite.remove(this.engine.world, p);
      }
      if (!on) {
        this.hoop = { enabled: false, parts: [] };
        this.hooks.onHoopChanged && this.hooks.onHoopChanged(this.hoop);
        return;
      }
      const w = this.bounds.w, h = this.bounds.h;

      // ---- 几何：真实篮球架比例（视觉与碰撞体同源，改这里两边一起变）
      const tube = 6;                        // 篮圈管半径
      const openW = 102;                     // 圈内净宽（球直径 68 → 两侧各留 17）
      const span = openW + tube * 2;         // 两端圆心的距离
      const boardW = 124;                    // 篮板宽
      const boardH = 96;                     // 篮板高
      // 篮板右边留出立柱的位置；距墙 30px < 球直径，球钻不进去。
      // 小屏/窄窗（竖屏、投屏被压扁）上 `w-30` 会把整副篮架推到屏幕外 → 兜一个下限。
      const boardRight = Math.max(boardW / 2 + 60, w - 30);
      const boardX = boardRight - boardW / 2;
      const boardLeft = boardX - boardW / 2;
      const rimY = Math.max(180, h - 322);   // 篮圈高度
      const boardY = rimY + 10 - boardH / 2; // 篮板下沿比篮圈低 10px
      const rimRightC = boardLeft + 4;       // 圈右端圆心略微嵌进篮板
      const cx = rimRightC - span / 2;

      const stat = { isStatic: true, label: 'hoop', friction: 0.22, restitution: 0.62, chamfer: { radius: 1 } };
      const parts = [
        // 篮板（可以打板）
        M.Bodies.rectangle(boardX, boardY, boardW, boardH, stat),
        // 篮圈两端：真实圆管，球撞上会弹开
        M.Bodies.circle(cx - span / 2, rimY, tube, stat),
        M.Bodies.circle(cx + span / 2, rimY, tube, stat),
        // 圈与篮板之间的连接件
        M.Bodies.rectangle((rimRightC + boardLeft) / 2, rimY, Math.max(4, Math.abs(rimRightC - boardLeft) + 4), 9, stat),
      ];
      M.Composite.add(this.engine.world, parts);

      this.hoop = {
        enabled: true, parts,
        cx, rimY, openW, span, tube,
        boardX, boardY, boardW, boardH, boardLeft,
        boardRight: boardLeft + boardW,
        netLen: 82,
        netT: 0,
        netAnim: 0, flash: 0,
      };
      this.hooks.onHoopChanged && this.hooks.onHoopChanged(this.hoop);
    }

    /**
     * 记一次进球。
     * @param {object} ball  进球的那颗球
     * @param {boolean} swish 空心球（全程未碰篮板/篮圈）→ 3 分；否则 2 分
     * @returns {number} 本次得分
     */
    registerScore(ball, swish) {
      // 连击：距上次命中不超过 COMBO_WINDOW_MS 就累加，否则重新从 1 起
      const now = performance.now();
      this.combo = (now - this.lastScoreAt <= COMBO_WINDOW_MS) ? this.combo + 1 : 1;
      this.lastScoreAt = now;

      // 金球双倍：分值 = 基础分（空心 3 / 普通 2）× 2。
      // 金球标记在此处消费掉（一次性），外观复原交给 app.js 的 onScore。
      const golden = !!ball.golden;
      ball.golden = false;
      const base = swish ? 3 : 2;
      const points = base * (golden ? 2 : 1);
      this.score += points;
      if (this.score > this.highScore) this.highScore = this.score;
      if (this.hoop) { this.hoop.netAnim = 1; this.hoop.flash = 1; }
      this.hooks.onScore && this.hooks.onScore(this.hoop, ball, {
        points, base, swish, golden,
        combo: this.combo, score: this.score, highScore: this.highScore,
      });
      return points;
    }

    /** 清空重来：得分与连击归零，最高分保留 */
    resetScore() {
      this.score = 0;
      this.combo = 0;
      this.lastScoreAt = 0;
    }

    // ------------------------------------------------------------ 步进
    step() {
      const t0 = performance.now();
      const e = this.engine;

      // 拖拽：速度伺服（不是瞬移）——碰撞/摩擦/惯性全部继续生效。
      // 注意全程用「每步位移」说话：跟上光标所需的每步位移 ≈ 位置差 × 增益。
      if (this.dragTarget && this.dragBody) {
        const p = this.dragBody.position;
        const k = 0.45;
        let vx = (this.dragTarget.x - p.x) * k;
        let vy = (this.dragTarget.y - p.y) * k;
        const cap = V(this.cfg.maxThrowSpeed) * 0.8;
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp > cap) { vx = (vx / sp) * cap; vy = (vy / sp) * cap; }
        M.Body.setVelocity(this.dragBody, { x: vx, y: vy });
        M.Sleeping.set(this.dragBody, false);
      }

      M.Engine.update(e, STEP_MS);

      // 后处理
      const maxV = V(this.cfg.maxThrowSpeed) * 1.35;
      const hoop = this.hoop;
      const W = this.bounds.w, H = this.bounds.h;
      let awake = 0;
      for (let i = 0; i < this.balls.length; i++) {
        const b = this.balls[i];
        const body = b.body;
        const p = body.position;
        const v = body.velocity;
        const sp = Math.sqrt(v.x * v.x + v.y * v.y);

        // 限速：必须走 Body.setVelocity —— Matter 的 Verlet 积分下一帧是从
        // (position - positionPrev) 重算速度的，只改 body.velocity 不会生效。
        if (sp > maxV) {
          const s = maxV / sp;
          M.Body.setVelocity(body, { x: v.x * s, y: v.y * s });
        }
        const av = body.angularVelocity;
        if (av > 1.2 || av < -1.2) {
          M.Body.setAngularVelocity(body, av > 0 ? 1.2 : -1.2);
        }

        // 兜底：万一还是被求解器弹飞，直接拉回场内的安全出生点
        if (p.x < -300 || p.x > W + 300 || p.y < -600 || p.y > H + 400) {
          const s = this.findSpawn(this.cfg.ballRadius);
          M.Body.setPosition(body, { x: s.x, y: s.y });
          M.Body.setVelocity(body, { x: 0, y: 0 });
          M.Body.setAngularVelocity(body, 0);
          b.prevY = s.y;
          b.touchedHoop = false;
          body.touchedHoop = false;
        } else {
          // 进球判定：球心向下穿越篮圈平面，且穿越点落在圈内
          if (hoop && hoop.enabled) {
            // 回到篮圈上方 80px 以上 → 视为一次新的投篮，清掉"碰过架子"的标记。
            // 不清的话上一轮的碰框会一路留到下一次进球，把空心球误判成普通球。
            if (p.y < hoop.rimY - SWISH_RESET_PAD) {
              b.touchedHoop = false;
              body.touchedHoop = false;
            }
            // 球心必须落在圈内净宽范围内，且向下穿过篮圈平面
            if (b.prevY < hoop.rimY && p.y >= hoop.rimY && v.y > 0 &&
                Math.abs(p.x - hoop.cx) < hoop.openW / 2 - 4) {
              const swish = !body.touchedHoop;   // 全程没碰架子 = 空心球
              b.touchedHoop = false;
              body.touchedHoop = false;
              this.registerScore(b, swish);
            }
          }
          b.prevY = p.y;
        }

        if (!body.isSleeping) awake++;
        else if (!b.wasSleeping) { b.wasSleeping = true; }

        // 落地挤压衰减
        if (b.squash > 0) b.squash *= 0.86;
        if (b.squash < 0.004) b.squash = 0;
      }

      if (hoop && hoop.enabled) {
        // ⚠️ 必须显式归零：只做 *= 0.9 时浮点尾数会拖很久才下溢到 0
        // （0.9^n 约需 7000 步 ≈ 118 秒），期间 isIdle() 永远为 false，
        // rAF 会一直以几百 fps 空转重绘光环 → 静置 CPU 居高不下。
        if (hoop.netAnim > 0) {
          hoop.netAnim *= 0.9;
          hoop.netT += 0.36;
          if (hoop.netAnim < 0.02) hoop.netAnim = 0;
        }
        if (hoop.flash > 0) {
          hoop.flash *= 0.9;
          if (hoop.flash < 0.02) hoop.flash = 0;
        }
      }

      const dt = performance.now() - t0;
      const s = this.stats;
      s.steps++;
      s.lastStepMs = dt;
      s.avgStepMs = s.avgStepMs * 0.97 + dt * 0.03;
      if (dt > s.maxStepMs) s.maxStepMs = dt;
      s.awake = awake;
      const pairs = e.pairs && e.pairs.list ? e.pairs.list.length : 0;
      s.pairs = pairs;
      s.bodies = this.balls.length;
    }

    anyAwake() {
      if (this.dragTarget) return true;
      for (let i = 0; i < this.balls.length; i++) if (!this.balls[i].body.isSleeping) return true;
      return false;
    }

    /** 碰撞回调：用于音效与挤压效果（由 app.js 注册） */
    bindCollisions(onImpact) {
      M.Events.on(this.engine, 'collisionStart', (ev) => {
        for (const pair of ev.pairs) {
          const a = pair.bodyA, b = pair.bodyB;
          const ballBody = a.label === 'ball' ? a : (b.label === 'ball' ? b : null);
          if (!ballBody) continue;
          // 空心球资格：只要碰到篮球架（篮板 / 篮圈 / 连接件）就作废。
          // 标记挂在 Matter 刚体上 —— 回调里只拿得到刚体，拿不到外层 ball 对象。
          if (a.label === 'hoop' || b.label === 'hoop') ballBody.touchedHoop = true;
          const other = ballBody === a ? b : a;
          const rel = M.Vector.magnitude(M.Vector.sub(ballBody.velocity, other.velocity));
          // ⚠️ 回调必须拿到**外层 ball 对象**而不是 Matter 刚体：
          // 上层用它写 `ball.squash`，而渲染读的是外层对象。早先直接传刚体，
          // 于是挤压形变写到了刚体上、渲染永远读到 0 —— 撞击形变其实一直没生效。
          onImpact(ballBody._pbBall || ballBody, rel, pair);
        }
      });
    }
  }

  PB.World = World;
  PB.STEP_MS = STEP_MS;
  PB.V = V;
  PB.V_INV = V_INV;
  window.__pbRMark('physics-end');
})();
