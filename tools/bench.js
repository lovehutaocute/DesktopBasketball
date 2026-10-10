'use strict';
/**
 * bench.js —— 物理层纯计算基准（不需要开窗口，可在 CI / 无桌面环境跑）
 *
 *   node tools/bench.js            默认跑 20 / 50 / 100 颗球
 *   node tools/bench.js 20 200     只跑 20 和 200
 *
 * 场景与 App 内完全一致：同样的墙、同样的半径/恢复系数/空气阻力/
 * 同样的 Matter 引擎参数（positionIterations=6, velocityIterations=4, enableSleeping）。
 * 唯一区别是不渲染，用来把「物理成本」从「渲染成本」里分离出来。
 */
const path = require('path');
const Matter = require('matter-js');

const W = 1440, H = 852;
const R = 34;
const STEP_MS = 1000 / 60;

function buildWorld(n) {
  const engine = Matter.Engine.create({ enableSleeping: true });
  engine.gravity.y = 1;
  engine.gravity.scale = 0.0012;
  engine.positionIterations = 8;
  engine.velocityIterations = 4;
  engine.constraintIterations = 2;

  const T = 400;
  const wopt = { isStatic: true, friction: 0.35, restitution: 0.55, label: 'wall' };
  Matter.Composite.add(engine.world, [
    Matter.Bodies.rectangle(W / 2, H + T / 2, W + T * 4, T, wopt),
    Matter.Bodies.rectangle(-T / 2, H / 2, T, H * 3, wopt),
    Matter.Bodies.rectangle(W + T / 2, H / 2, T, H * 3, wopt),
    Matter.Bodies.rectangle(W / 2, -T / 2, W + T * 4, T, wopt),
  ]);

  // 出生点必须在场地内（生成到静态墙里会让 Matter 的位置求解器把球弹飞）
  const balls = [];
  const step = R * 2.65;
  const cols = Math.max(1, Math.floor((W - (R + 10) * 2) / step));
  for (let i = 0; i < n; i++) {
    const cx = (R + 10) + ((i % cols) + 0.5) * step;
    const cy = (R + 10) + (Math.floor(i / cols) + 0.5) * step;
    const body = Matter.Bodies.circle(cx, cy, R, {
      label: 'ball', restitution: 0.72, friction: 0.055, frictionStatic: 0.14,
      frictionAir: 0.0115, density: 0.00125, slop: 0.02, sleepThreshold: 52,
    }, 22);
    Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 5, y: 0 });
    Matter.Composite.add(engine.world, body);
    balls.push(body);
  }
  return { engine, balls };
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function run(n, steps, warmup) {
  const { engine, balls } = buildWorld(n);
  const times = [];
  const maxV = (2200 * 1.35) / 60;   // px/s → px/step
  let kicks = 0;
  let awakeSum = 0, pairSum = 0, samples = 0, csSum = 0, caSum = 0;
  Matter.Events.on(engine, 'collisionStart', (ev) => { csSum += ev.pairs.length; });
  Matter.Events.on(engine, 'collisionActive', (ev) => { caSum += ev.pairs.length; });
  const t0all = process.hrtime.bigint();

  for (let s = 0; s < steps + warmup; s++) {
    // 保证球一直在动（对应 App 里的"一直有人在玩"），否则休眠会让数字虚高
    if (s % 45 === 0) {
      for (const b of balls) {
        Matter.Sleeping.set(b, false);
        // Matter 的速度单位是「像素/步」，不是像素/秒 → 这里把 px/s 折算进来
        Matter.Body.setVelocity(b, {
          x: (Math.random() - 0.5) * 1600 / 60,
          y: (-Math.random() * 1100 - 300) / 60,
        });
      }
      kicks++;
    }
    const t0 = process.hrtime.bigint();
    Matter.Engine.update(engine, STEP_MS);
    for (const b of balls) {
      const v = b.velocity;
      const sp = Math.hypot(v.x, v.y);
      if (sp > maxV) {
        const k = maxV / sp;
        Matter.Body.setVelocity(b, { x: v.x * k, y: v.y * k });
      }
    }
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (s >= warmup) {
      times.push(dt);
      let aw = 0;
      for (const b of balls) if (!b.isSleeping) aw++;
      awakeSum += aw;
      pairSum += engine.pairs.list.length;
      samples++;
    }
  }
  const wallMs = Number(process.hrtime.bigint() - t0all) / 1e6;

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  return {
    n, steps, kicks, wallMs,
    avg, p50: pct(times, 0.5), p95: pct(times, 0.95), p99: pct(times, 0.99),
    max: times[times.length - 1],
    budget: (avg / STEP_MS) * 100,
    avgAwake: awakeSum / samples,
    avgPairs: pairSum / samples,
    starts: csSum, actives: caSum,
  };
}

const argv = process.argv.slice(2).map(Number).filter((x) => x > 0);
const sizes = argv.length ? argv : [20, 50, 100, 200];
const STEPS = 3600;   // 60 秒模拟
const WARMUP = 180;

console.log('Matter.js ' + require('matter-js/package.json').version +
  ' | node ' + process.version + ' | 场地 ' + W + 'x' + H + ' | 球半径 ' + R);
console.log('');
console.log('| 球数 | 平均 ms/步 | p50 | p95 | p99 | 最大 | 帧预算占用 | 实时倍率 | 平均活跃球 | 平均碰撞对 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const out = [];
for (const n of sizes) {
  const r = run(n, STEPS, WARMUP);
  out.push(r);
  const realtime = (1 / (r.avg / STEP_MS));
  console.log('| ' + r.n + ' | ' + r.avg.toFixed(3) + ' | ' + r.p50.toFixed(3) + ' | ' +
    r.p95.toFixed(3) + ' | ' + r.p99.toFixed(3) + ' | ' + r.max.toFixed(3) + ' | ' +
    r.budget.toFixed(2) + '% | ' + realtime.toFixed(0) + 'x | ' +
    r.avgAwake.toFixed(1) + ' | ' + r.avgPairs.toFixed(1) + ' |');
}
console.log('');
for (const r of out) {
  console.log(r.n + ' 球: 模拟 ' + (r.steps / 60).toFixed(0) + ' 秒, 强行唤醒 ' + r.kicks +
    ' 次, 总墙钟 ' + r.wallMs.toFixed(0) + ' ms, 平均活跃 ' + r.avgAwake.toFixed(1) + '/' + r.n +
    ', 平均碰撞对 ' + r.avgPairs.toFixed(1) +
    ', collisionStart ' + r.starts + ', collisionActive ' + r.actives);
}
require('fs').writeFileSync(
  path.join(__dirname, '..', 'assets', 'bench-physics.json'),
  JSON.stringify({ engine: 'matter-js', version: require('matter-js/package.json').version, node: process.version, results: out }, null, 2)
);
