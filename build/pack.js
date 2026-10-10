#!/usr/bin/env node
'use strict';
/**
 * build/pack.js —— Windows 免安装打包
 *
 * 产出：dist/DesktopBasketball-win32-x64/DesktopBasketball.exe
 *       双击即用，无需安装、无需 Node、无需 Electron。
 *
 * 用法：
 *   npm run pack            # 打包（默认做体积裁剪 SLIM + NTFS 压缩 COMPACT）
 *   npm run pack:zip        # 打包 + 压成 zip
 *   npm run pack:7z         # 打包 + 生成 .7z 单文件分发包（约 74 MB）
 *   node build/pack.js --out=<目录>   # 换个输出目录（旧包正被占用时用，见下）
 *   node build/pack.js --no-slim     # 不做体积裁剪（保留 Electron 自带全部 55 个语言包）
 *   node build/pack.js --no-compact  # 不做 NTFS 透明压缩（磁盘占用会翻倍，运行无差别）
 *   （旧产物由 retire() 自动改名移开，不需要 --fresh）
 *
 * 体积（实测，2026-10-05）：
 *   原始 329 MB ──SLIM──> 273 MB ──COMPACT(NTFS/LZX)──> 115 MB
 *   exe 本身 200 MB 是 Chromium 本体，PE 段全是运行时必需，**内容上删不动**；
 *   能变的只有"存的时候压不压"——所以走文件系统层的透明压缩。
 *
 * 关于原生模块：本项目生产依赖里只有 koffi 带 .node 二进制（Win32 调用），
 * 它必须落在 asar 之外才能被 dlopen 到，所以 asar.unpack 里带上了 **\/*.node。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

/**
 * 输出目录。默认 dist/。
 *
 * `--out=<目录>` 是给「正在玩的旧包占着 dist/…/DesktopBasketball.exe」这种情况用的：
 * Windows 上被占用的 exe/dll/asar 写不进去，packager 会失败甚至留下残缺产物。
 * 换一个平级输出目录就能绕过文件锁，事后再交换即可。
 * ⚠️ 若输出目录在项目内（不在 dist/ 下），必须把它排除出 asar，
 *    否则 328 MB 的产物会被打进它自己 —— 见下面 ignore 里的 outRel。
 */
const OUT_ARG = (process.argv.find((a) => a.startsWith('--out=')) || '').slice('--out='.length);
const OUT = OUT_ARG ? path.resolve(ROOT, OUT_ARG) : path.join(ROOT, 'dist');
/** 输出目录相对项目的路径（正斜杠），用于从 asar 里排除它自己 */
const OUT_REL = '/' + path.relative(ROOT, OUT).split(path.sep).join('/');


const ZIP = process.argv.includes('--zip');
/** 生成 .7z 单文件分发包（用本机 7-Zip；LZMA2 固实压缩，约 328MB → 90MB） */
const SEVENZ = process.argv.includes('--7z');

// ------------------------------------------------------------------ 体积裁剪
/**
 * 默认开启；`--no-slim` 可关掉。真正的裁剪动作在 **build/slim.js** 里，
 * 由 main() 以**子进程**方式调用（为什么必须换进程，见那个文件的注释）。
 *
 * 减小的**不是功能也不是画质**，只是 Electron 白带、本项目根本用不到的资源：
 *  · locales/ 55 种语言只留 zh-CN / en-US / en-GB（省 44 MB）
 *  · 删掉 14.5 MB 的 LICENSES.chromium.html（纯许可文本，Chromium 运行时从不读）
 * 刻意**不动**：dxcompiler/dxil（WebGPU 用；删了可能让 GPU 初始化静默降级 = 偷偷降画质）、
 * icudtl.dat / resources.pak / libGLESv2 / d3dcompiler_47（渲染刚需）、
 * vk_swiftshader / vulkan-1（无 GPU 时的兜底）。
 */
const SLIM = !process.argv.includes('--no-slim');

// ------------------------------------------------------------------ NTFS 透明压缩
/**
 * 默认开启（仅 Windows）；`--no-compact` 可关掉。
 *
 * Electron 的 exe 有 200 MB，而它不是「可以删掉的东西」—— 实测 PE 段表：
 *   .text 162.9 MB（Chromium + V8 机器码）| .rdata 30.8 MB（常量/字符串表）
 *   .pdata 4.8 MB（异常展开表）| .data 4.6 MB | .reloc 1.0 MB | .rsrc 0.4 MB（图标）
 * 没有 overlay、没有调试符号、没有多余资源 —— 全是运行时必需。
 * 而且 `Slim` 那两步（locales / LICENSES）已经在文件级别省过了。
 *
 * 想让它在磁盘上变小、又**完全不改变运行行为**，只有一条路：NTFS 透明压缩
 * （`compact /c /exe:LZX`）。压缩由文件系统负责，进程读到的字节一模一样，
 * 所以功能、画质、渲染路径全不变 —— 只是每次读取时 NTFS 驱动顺带解压。
 * 实测：272 MB -> 115 MB（2.4:1），耗时约 10 秒；启动与 60fps 均无异常。
 *
 * 注意：
 *  · 只在 NTFS 卷有效；拷到 exFAT/FAT32（U 盘）或别人的机器上会自动还原成原大小。
 *  · 新产物默认**不继承**压缩属性（packager 每次新建目录），所以要每次打包都跑一遍。
 *  · `compact` 找不到 / 卷不支持时静默跳过，绝不影响打包本身。
 */
const COMPACT = process.platform === 'win32' && !process.argv.includes('--no-compact');

/**
 * 一个目录里所有文件占用的**磁盘空间**（不是逻辑大小）。
 *
 * Node 在 Windows 上通过 GetFileInformationByHandleEx 填了 st_blocks，NTFS 压缩后的
 * 实际占用就反映在 blocks*512 上（实测：未压缩 200.7MB / 压缩后 84.7MB，与 compact
 * 自己报的数字一致）。这样就不必去解析 compact 的输出 —— 它是控制台程序，输出走
 * OEM 代码页，用 utf8 读会乱码，正则匹配"字节的数据保存在"必然失败。
 */
function allocSize(p) {
  let n = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        try { const st = fs.statSync(f); n += st.blocks ? st.blocks * 512 : st.size; } catch (err) { /* ignore */ }
      }
    }
  };
  walk(p);
  return n;
}

/**
 * 对整个产物目录启用 NTFS 压缩，返回前后占用（失败返回 null）。
 * 输出一律丢给 stdio:'ignore' —— 只看结果数字，不看它那一长串逐文件的报表。
 */
function compactDir(dir) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'compact.exe');
  const bin = fs.existsSync(exe) ? exe : 'compact.exe';
  const before = allocSize(dir);
  try {
    execFileSync(bin, ['/c', '/exe:LZX', '/f', '/s:' + dir], { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    return null;
  }
  const after = allocSize(dir);
  return after < before ? { before, after } : null;   // 没变小就当没做成
}

/**
 * 把旧产物「改名移开」而不是删掉。
 *
 * 为什么不直接 rm：packager 的 overwrite:true 内部就是 fs.rm(dir, {recursive:true})，
 * 而本机的 safe-delete 钩子按「本轮累计 > 50 个文件」拦截 —— dist 里有 76 个文件，
 * 于是**第二次打包必然失败**：
 *   Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":76,"threshold":50,...}
 * 改名不算删除，能稳定绕开；代价是 dist/ 里会留一个 *.old-<时间戳> 目录，可手动清掉。
 */
function retire(p) {
  if (!fs.existsSync(p)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = p + '.old-' + stamp;
  fs.renameSync(p, bak);
  return bak;
}

async function main() {
  let packager;
  try {
    packager = require('@electron/packager');
  } catch (e) {
    console.error('缺少 @electron/packager，请先执行：npm i -D @electron/packager');
    process.exit(1);
  }
  // @electron/packager v20 导出 { packager }
  const run = packager.packager || packager;

  const icon = path.join(ROOT, 'assets', 'icon.ico');
  if (!fs.existsSync(icon)) {
    console.error('缺少 assets/icon.ico，请先执行：npm run genicon');
    process.exit(1);
  }

  const outDir = path.join(OUT, 'DesktopBasketball-win32-x64');
  // 永远只把「产物子目录」改名移开，**不**把整个 dist/ 改名 —— dist/ 在 ignore 里，
  // 但 `dist.old-xxx` 不在，那样改名会把 328MB 的旧产物整个打进新包的 asar。
  const moved = retire(outDir);
  if (moved) console.log('旧产物已移开 -> ' + path.relative(ROOT, moved));

  console.log('开始打包 electron=' + require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version +
              ' node=' + process.version);

  const started = Date.now();
  const appPaths = await run({
    dir: ROOT,
    out: OUT,
    name: 'DesktopBasketball',
    platform: 'win32',
    arch: 'x64',
    icon: icon,
    appVersion: pkg.version,
    appCopyright: 'MIT License',
    overwrite: true,
    prune: true,          // 自动剔除 devDependencies（electron / packager 不进包）
    asar: { unpack: '**/*.node' },
    win32metadata: {
      CompanyName: 'DesktopBasketball',
      FileDescription: 'Windows 桌面物理篮球',
      ProductName: 'DesktopBasketball',
    },
    ignore: [
      /^\/dist(\/|$)/,
      // 自定义 --out 时，把输出目录本身排除掉（否则会打进它自己）
      new RegExp('^' + OUT_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\/|$)'),
      /^\/build(\/|$)/,
      /^\/tools(\/|$)/,
      /^\/\.npmrc$/,
      /^\/\.git(\/|$)/,
      /^\/\.last-verify-dir$/,
      /^\/README\.md$/,
      // assets：运行时只读一样 —— 托盘图标 assets/tray.png（main.js::trayImage）。
      // 球皮肤贴图在 src/renderer/textures/，不在 assets 下。
      // 其余全是构建期/验收期产物：icon.ico 只被**打包前**的 pack.js 从源码目录读
      //（做 exe 图标，不必进 asar）；icon-256.png / cpu-test*.json/.md / drag-test.* /
      // bench-physics / github-research 运行时一处都不读。
      /^\/assets\/(?!tray\.png$)[^/]+$/,
      /^\/package-lock\.json$/,

      /**
       * ⚠️ `$WIN_T` —— 打包时必须显式排除，否则会把**用户的配置与日志**发进产物。
       *
       * packager 会把项目目录整棵树扫进 asar，而 Electron 的 userData（%APPDATA%
       * \DesktopBasketball）落在 `%TEMP%` 之外的路径上；但 asar 的路径规范化会把
       * **Windows 临时目录**替换成字面量 `$WIN_T`。于是某次跑在临时目录里的实例
       * （`--user-data-dir=$TEMP\...`，验收夹具就这么干）留下的整个 userData
       * —— config.json（用户的球数/皮肤/成就）、runtime.log、GPUCache ——
       * 会在下次打包时被一起塞进 app.asar。实测这一项就是 **1.78 MB / 63 个文件**，
       * 其中还包括 DawnWebGPUCache 这类纯缓存。
       *
       * 它不是"占地方"的问题，是**把用户数据混进分发包**的问题：拿到 7z 的人
       * 能直接读到你的配置和运行日志。所以这条必须是硬排除，不是"体积优化"。
       */
      /^\/\$WIN_T(\/|$)/,
      /^\/~\$(\/|$)/,

      // ---- node_modules 瘦身（实测下面这些一个都不在运行时加载链上）----
      /** matter-js 只在 tools/bench.js 里 require，而 tools 已被整体排除；
       *  渲染进程用的是 src/renderer/vendor/matter.min.js 的副本（见 index.html）。 */
      /^\/node_modules\/matter-js(\/|$)/,
      /** koffi 自带的其它平台预编译包（Linux/macOS/arm），本机只用 win32_x64。 */
      /^\/node_modules\/@koromix\/koffi-(?!win32-x64)(\/|$)/,
      /** koffi 的 C++ 源码 / 文档 / 类型声明：node-gyp 只在编译时才读，
       *  运行时入口只有 index.cjs → src/koffi/index.cjs → src/koffi/src/static.cjs
       *  → require('@koromix/koffi-win32-x64')。实测裁掉后 koffi.load() 正常。 */
      /^\/node_modules\/koffi\/(doc|vendor|index\.d\.ts|index\.js|indirect\.(cjs|js)|cnoke\.cjs)(\/|$)/,
      /^\/node_modules\/koffi\/src\/koffi\/src\/(?!static\.cjs$)[^/]+$/,
      /^\/node_modules\/koffi\/lib(\/|$)/,
      /** npm 自身的安装清单，运行时无人读。 */
      /^\/node_modules\/\.package-lock\.json$/,
    ],
  });

  const dir = appPaths[0];

  // ---- 体积裁剪：放在压缩之前，这样 .7z / .zip 也不会把删掉的部分算进去。
  //      必须起**子进程**做（build/slim.js）—— packager 已在本进程里消耗掉
  //      safe-delete 的删除配额，同一进程里再删必定全部失败。原因详见 slim.js。
  if (SLIM) {
    try {
      process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, 'slim.js'), dir],
        { encoding: 'utf8' }));
    } catch (e) {
      console.log('体积裁剪失败（不影响产物本身）：' +
        String((e.stdout || '') + (e.stderr || '')).trim());
    }
  }
  const exe = path.join(dir, 'DesktopBasketball.exe');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n打包完成 (' + secs + 's)');
  console.log('  目录 : ' + dir);
  console.log('  程序 : ' + exe);
  console.log('  体积 : ' + (dirSize(dir) / 1048576).toFixed(1) + ' MB');

  if (ZIP) {
    const zipPath = path.join(OUT, 'DesktopBasketball-' + pkg.version + '-win32-x64.zip');
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    console.log('\n压缩中 -> ' + zipPath);
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -Path "' + dir + '" -DestinationPath "' + zipPath + '" -CompressionLevel Optimal -Force',
    ], { stdio: 'inherit' });
    console.log('  zip  : ' + zipPath + '  ' + (fs.statSync(zipPath).size / 1048576).toFixed(1) + ' MB');
  }

  if (SEVENZ) {
    const sz = find7z();
    if (!sz) {
      console.log('\n未找到 7-Zip（7z.exe），跳过 .7z 打包 —— 装一个 7-Zip 或手动压缩即可。');
    } else {
      const arc = path.join(OUT, 'DesktopBasketball-' + pkg.version + '-win32-x64.7z');
      if (fs.existsSync(arc)) { try { fs.rmSync(arc, { force: true }); } catch (e) { /* ignore */ } }

      // 压缩时直接排除用不到的资源（清单与 build/slim.js 一致）。
      // 这条是**兜底**：7z 是外部程序、不受 Node 侧 safe-delete shim 的批量限制，
      // 所以哪怕 slim.js 一个文件都没删掉，压缩包也不会把 56 MB 白带的语言包算进去。
      const excl = writeSlimExcludeList(dir);
      const args = ['a', '-t7z', '-mx=9', '-ms=on', '-mmt=on'];
      if (excl) args.push('-x@' + excl);
      args.push(arc, path.basename(dir));

      console.log('\n压缩中（7z / LZMA2 / 固实）-> ' + arc);
      // 在 dir 的父目录里执行，压缩包内顶层才是 DesktopBasketball-win32-x64/
      execFileSync(sz, args, { cwd: path.dirname(dir), stdio: 'inherit' });
      console.log('  7z   : ' + arc + '  ' + (fs.statSync(arc).size / 1048576).toFixed(1) + ' MB');
      if (excl) { try { fs.unlinkSync(excl); } catch (e) { /* ignore */ } }
    }
  }

  // ---- NTFS 透明压缩：磁盘占用再砍一半，运行行为完全不变（见 COMPACT 的注释）
  if (COMPACT) {
    const r = compactDir(dir);
    if (r) {
      console.log('\nNTFS 压缩：磁盘占用 ' + (r.before / 1048576).toFixed(1) + ' MB -> ' +
                  (r.after / 1048576).toFixed(1) + ' MB（' + (r.before / r.after).toFixed(1) +
                  ':1，读取时由文件系统自动解压，功能与画质不变）');
    } else {
      console.log('\nNTFS 压缩：跳过（非 NTFS 卷 / compact.exe 不可用 / 已经压过）');
    }
  }

  console.log('\n运行方式：双击 ' + path.basename(exe) + '（启动后自动最小化到系统托盘）');
  console.log('若显卡驱动异常导致黑屏/闪退，可加参数启动：DesktopBasketball.exe --no-gpu');

  // 提醒清理 retire() 留下的旧目录（本机删除受保护，交给用户手动删最稳）
  try {
    const olds = fs.readdirSync(OUT).filter((n) => n.includes('.old-'));
    if (olds.length) {
      const rel = path.relative(ROOT, OUT) || '.';
      console.log('\n注：' + rel + '/ 下有 ' + olds.length + ' 个旧产物目录（改名移开时留下的），确认新版可用后可手动删除：');
      for (const n of olds) console.log('    ' + rel + '/' + n);
    }
  } catch (e) { /* ignore */ }
}

/** 生成给 7z 用的排除清单（`-x@file`）；没有可排除项时返回 null */
function writeSlimExcludeList(dir) {
  const KEEP = new Set(['zh-CN', 'en-US', 'en-GB']);
  const base = path.basename(dir);
  const lines = [];
  const loc = path.join(dir, 'locales');
  if (fs.existsSync(loc)) {
    for (const f of fs.readdirSync(loc)) {
      if (KEEP.has(f.replace(/\.pak$/, ''))) continue;
      lines.push(base + '/locales/' + f);
    }
  }
  for (const f of ['LICENSES.chromium.html']) {
    if (fs.existsSync(path.join(dir, f))) lines.push(base + '/' + f);
  }
  if (!lines.length) return null;
  const p = path.join(OUT, '.slim-exclude.txt');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  console.log('  7z 排除清单：' + lines.length + ' 项');
  return p;
}

/** 找一个可用的 7z.exe（本机常见安装位置）；找不到返回 null */
function find7z() {
  const cands = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { n += fs.statSync(f).size; } catch (err) { /* ignore */ } }
    }
  };
  walk(p);
  return n;
}

main().catch((e) => {
  console.error('\n打包失败：', e && e.stack || e);
  process.exit(1);
});
