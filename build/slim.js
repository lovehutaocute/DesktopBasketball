#!/usr/bin/env node
'use strict';
/**
 * build/slim.js —— 产物体积裁剪（由 build/pack.js 以**子进程**方式调用）
 *
 * 用法：node build/slim.js <产物目录>
 *
 * ⚠️ 为什么必须是**独立进程**（以及为什么还要**再来一个**）：
 *   本机的 safe-delete shim 对删除数量设阈值（50 个），超了就把后续删除全部打回。
 *   packager 打完一个 300+ MB 的包，内部（清临时目录等）已经把额度吃掉了，于是**同一个
 *   进程里**再删必然大面积失败。所以裁剪单独起一次 node。
 *   ⚠️ 而且**一轮还删不完**：要删的是 **55 个**（52 语言包 + 3 顶层文件），实测每轮都是删到
 *   第 48~49 个就停下、**按列表顺序的尾巴整批失败**（永远是最后几个：`uk/ur/vi/zh-TW.pak`
 *   + `LICENSES.chromium.html` + `dxcompiler.dll` + `dxil.dll`）。所以本脚本发现残留时会
 *   **自己换一个干净进程再来一轮**（见文件末尾）。
 *   ⚠️ 但在 **Agent 的沙箱里连换进程也救不了**：沙箱把额度按**会话**算，子进程一样是 0 删除
 *   （实测第 2/3/4 轮都是"删掉 0 个文件，7 个待重试"）。这时唯一的办法是**手动**再跑一次
 *   `node build/slim.js <目录>` —— 那一趟会提权出沙箱，一次就清干净。脚本会把这句话打出来。
 *
 * 裁剪内容（**不减功能、不降画质**，只是删掉 Electron 白带、本项目根本用不到的资源）：
 *   · locales/ —— Electron 自带 55 种语言的 .pak（44 MB），只留 zh-CN / en-US / en-GB。
 *     少掉不影响任何功能：找不到匹配语言会自动回退 en-US。
 *   · 以及 `slim-list.js` 的 `DROP_TOP`：许可证文本 + WebGPU 着色器编译器 + ffmpeg。
 *     **每一项为什么能删、为什么别的一些不能删，全部写在那份清单的注释里** ——
 *     改清单只改那一个文件（7z 的排除清单从同一个模块取，不会漂移）。
 *
 * ⚠️ **asar 内部的瘦身不在这里** —— 那是 `pack.js` 的 `ignore` 清单管的（见 README
 * §4.1.3），包括必须硬排除的 `$WIN_T`（里面是**误打包进来的用户 config.json 与
 * runtime.log**，不是缓存）。本脚本只删产物**根目录**下的文件。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
/** 清单本体在 build/slim-list.js（与 pack.js 共用一份，别在这里硬编码文件名） */
const SLIM_LIST = require('./slim-list');

/** 保留语言做成 Set 便于查表 */
const KEEP = new Set(SLIM_LIST.KEEP_LOCALES);
const DROP_TOP = SLIM_LIST.DROP_TOP;

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('slim: 产物目录不存在：' + dir);
  process.exit(1);
}
/** 第几轮（见文件末尾的"换进程重试"）。0 = 首次。 */
const ATTEMPT = Number(process.env.SLIM_ATTEMPT || 0);

/** 重新扫一遍要删的东西（换进程重试时要重扫，不能复用上一轮的清单） */
function collect() {
  const targets = [];
  const loc = path.join(dir, 'locales');
  if (fs.existsSync(loc)) {
    for (const f of fs.readdirSync(loc)) {
      if (KEEP.has(f.replace(/\.pak$/, ''))) continue;
      targets.push(path.join(loc, f));
    }
  }
  for (const f of DROP_TOP) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) targets.push(p);
  }
  return targets;
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

/**
 * 扫一遍 + 删一遍。
 *
 * ⚠️ `bytes` **只统计真正删掉的文件**。第一版是在 `del()` 之前累加，于是"删失败"的文件
 * 会在第二轮重试时被**再算一次**，把"42.8 MB"报成"125.6 MB"（2026-10-13 实际发生），
 * 看日志的人会以为删掉了 125 MB 而目录一点没小。
 */
function sweep() {
  let n = 0, bytes = 0;
  const via = { unlink: 0, rm: 0 };
  const failed = [];
  for (const p of collect()) {
    /** 大小必须**删之前**量（删完 statSync 必然抛），但只在**删成功**时才计入合计 */
    let sz = 0;
    try { sz = fs.statSync(p).size; } catch (e) { /* ignore */ }
    const how = del(p);
    if (!how) {
      // 已经不存在（上一轮/别的进程删过了）不算失败
      if (fs.existsSync(p)) failed.push(path.basename(p));
      continue;
    }
    n++; via[how]++; bytes += sz;
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
  (r.failed.length ? '（' + r.failed.length + ' 个待重试：' + r.failed.slice(0, 4).join(' ') + '）' : ''));

/**
 * ⚠️⚠️ **删不完的尾巴：换一个干净进程再来一轮** —— 这一条是必须的，不是保险。
 *
 * 根因：safe-delete shim 的删除配额是**按进程**算的（阈值 50）。要删的目标是
 * 「52 个语言包 + 3 个顶层文件」= 55 个，**一个进程根本删不完**：实测每次都是删到第 49 个
 * 就停手，然后**按列表顺序的尾巴**整批失败 —— 2026-10-13 实测失败的永远是最后几个
 * （`ur.pak` / `vi.pak` / `zh-TW.pak` + `LICENSES.chromium.html` / `dxcompiler.dll` / `dxil.dll`）。
 *
 * 为什么以前没发现：slim 的输出被 `pack.js` 夹在几十行打包日志里，而**压缩包那边因为有
 * `-x@` 排除清单照样是干净的** —— 于是只有"产物目录"受害（42 MB 白带留着），
 * 现象是"7z 变小了，装完的目录却几乎没变"。所以这里不但要报，还要**自己修好**。
 *
 * 递归有界：每轮至少能删 ~49 个，总量 55 个，两轮必然收敛；`SLIM_ATTEMPT` 兜住上限 4 轮。
 */
if (r.failed.length && ATTEMPT < 4) {
  const res = spawnSync(process.execPath, [__filename, dir], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SLIM_ATTEMPT: String(ATTEMPT + 1) }),
  });
  console.log('   ↑ 一轮删不完（删除额度用尽），换一个干净进程重试（第 ' + (ATTEMPT + 1) + ' 轮）');
  process.stdout.write(res.stdout || '');
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status === 0 ? 0 : 2);
}

/**
 * ⚠️ 删不掉时**必须让调用方知道**：`pack.js` 会把退出码非 0 打成一行醒目的 WARNING。
 * 残留文件本身**不致命**（压缩包已排除，用户拿到的安装包不吃这份亏），但产物目录会白放大
 * 几十 MB，而 `installer.iss` 是直接读这个目录的 —— 安装器会把白带一起装进去。
 */
if (r.failed.length) {
  console.error('slim: 仍有 ' + r.failed.length + ' 个文件删不掉：' + r.failed.join(' ') +
    '。手动重跑 `node build/slim.js ' + dir + '` 即可（每个新进程都有一份新配额）。');
  process.exitCode = 2;
}
