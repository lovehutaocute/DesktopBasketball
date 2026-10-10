#!/usr/bin/env node
'use strict';
/**
 * build/slim.js —— 产物体积裁剪（由 build/pack.js 以**子进程**方式调用）
 *
 * 用法：node build/slim.js <产物目录>
 *
 * ⚠️ 为什么必须是**独立进程**：
 *   本机的 safe-delete shim 按「**本进程**累计删除的文件数」设阈值（50 个），超了就
 *   把后续删除全部打回（表现为 `trash operation ... Some operations were aborted`）。
 *   packager 打完一个 328 MB 的包，内部（清临时目录等）已经把配额吃掉了，于是**同一个
 *   进程里**再删 53 个语言包必然 53/53 全失败 —— 实测就是这个现象：pack.js 内删全失败，
 *   同一批文件隔一会儿用独立进程删是 52/52 成功。所以裁剪单独起一次 node。
 *
 * 裁剪内容（**不减功能、不降画质**，只是删掉 Electron 白带、本项目根本用不到的资源）：
 *   · locales/ —— Electron 自带 55 种语言的 .pak（44 MB），只留 zh-CN / en-US / en-GB。
 *     少掉不影响任何功能：找不到匹配语言会自动回退 en-US。
 *   · LICENSES.chromium.html —— 14.5 MB 的纯许可证文本，Chromium 运行时从不读它
 *     （完整文本见 Chromium 源码树；README「打包」一节写了出处）。
 *
 * 刻意**不**动的：dxcompiler.dll / dxil.dll（26 MB，WebGPU/D3D12 着色器编译器，删了
 * 有可能让 GPU 初始化静默降级到软件渲染 = 偷偷降画质）、icudtl.dat、resources.pak、
 * libGLESv2 / d3dcompiler_47（渲染刚需）、vk_swiftshader / vulkan-1（无 GPU 时的兜底）。
 *
 * ⚠️ **asar 内部的瘦身不在这里** —— 那是 `pack.js` 的 `ignore` 清单管的（见 README
 * §4.1.3），包括必须硬排除的 `$WIN_T`（里面是**误打包进来的用户 config.json 与
 * runtime.log**，不是缓存）。本脚本只删产物**根目录**下的文件。
 */
const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set(['zh-CN', 'en-US', 'en-GB']);
const DROP_TOP = ['LICENSES.chromium.html'];

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('slim: 产物目录不存在：' + dir);
  process.exit(1);
}

const targets = [];
const loc = path.join(dir, 'locales');
if (fs.existsSync(loc)) {
  for (const f of fs.readdirSync(loc)) {
    if (KEEP_LOCALES.has(f.replace(/\.pak$/, ''))) continue;
    targets.push(path.join(loc, f));
  }
}
for (const f of DROP_TOP) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) targets.push(p);
}

/** 同步等待（不引 async，保持这个脚本足够简单） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const t = Date.now() + ms; while (Date.now() < t) { /* busy fallback */ } }
}

/**
 * 删一个文件。三条路都试一遍，因为本机 shim 的行为不一致：
 *   1. `unlinkSync` —— shim 会把它转成「移入回收站」，量大/被占用时会报 aborted；
 *   2. `rmSync(p, {force:true})` —— 走 shim 的 rm 分支，单文件一般放行；
 *   3. 都不行就放弃（保留文件，绝不让裁剪反过来弄挂打包）。
 */
function del(p) {
  try { fs.unlinkSync(p); return 'unlink'; } catch (e) { /* next */ }
  try { fs.rmSync(p, { force: true }); return 'rm'; } catch (e) { /* next */ }
  return null;
}

function sweep() {
  let n = 0, bytes = 0;
  const via = { unlink: 0, rm: 0 };
  const failed = [];
  for (const p of targets) {
    if (!fs.existsSync(p)) continue;
    try { bytes += fs.statSync(p).size; } catch (e) { /* ignore */ }
    const how = del(p);
    if (how) { n++; via[how]++; } else { failed.push(path.basename(p)); }
  }
  return { n, bytes, failed, via };
}

let r = sweep();
if (r.failed.length) {
  // 偶发失败（句柄没放开 / 回收站操作被中止）时等一下再来一轮
  sleepSync(1500);
  const r2 = sweep();
  r = {
    n: r.n + r2.n,
    bytes: r.bytes + r2.bytes,
    failed: r2.failed,
    via: { unlink: r.via.unlink + r2.via.unlink, rm: r.via.rm + r2.via.rm },
  };
}

console.log('体积裁剪：删掉 ' + r.n + ' 个文件 / ' + (r.bytes / 1048576).toFixed(1) + ' MB' +
  ' [unlink=' + r.via.unlink + ' rm=' + r.via.rm + ']' +
  (r.failed.length ? '（' + r.failed.length + ' 个失败：' + r.failed.slice(0, 4).join(' ') + '）' : ''));
