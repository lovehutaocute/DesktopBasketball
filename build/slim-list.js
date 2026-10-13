'use strict';
/**
 * build/slim-list.js —— 产物体积裁剪的**唯一清单**。
 *
 * 为什么要单独一个文件：同一份清单有**两个**使用场景，分开写必然漂移 ——
 *   · `build/slim.js`  —— 在**解包目录**里把这些文件真删掉（本地直接跑 / 安装器装的）；
 *   · `build/pack.js`  —— 生成 7z 时把它们写进 `-x@` 排除清单（7z 是独立产物）。
 * 只改一处的后果是"7z 里有、目录里没有"（或者反过来），两个分发包大小对不上。
 *
 * ------------------------------------------------------------------ 删什么
 * 前提：本应用的技术栈是 **Canvas 2D 画布 + WebAudio 合成音**（见 src/renderer/），
 * 不用 WebGL、不用 WebGPU、不播任何媒体文件。凡是不在这条链上的 Chromium 组件都可以走。
 *
 *   · `LICENSES.chromium.html`（14.5 MB）—— 纯许可证文本，Chromium 运行时从不读它
 *     （完整文本在 Chromium 源码树里，README「打包」一节写了出处）。
 *   · `dxcompiler.dll`（25.9 MB）+ `dxil.dll`（1.5 MB）—— DX12 / WebGPU 的着色器
 *     编译器（HLSL → DXIL）。Chromium 只在 **Dawn（WebGPU）** 与 **D3D12** 上用；
 *     本应用的画布是 **CPU 光栅化的 Canvas 2D**，GPU 合成走 ANGLE 的 **D3D11** 后端
 *     （那个用的是 `d3dcompiler_47.dll`，**保留**）。文件不在时 Dawn 只会报
 *     "WebGPU 不可用"，不碰 GPU 进程的 D3D11 初始化，所以不会触发"GPU 崩溃自愈 →
 *     落盘 forceNoGpu" 那条粘性降级。
 *
 *     ⚠️ 但"推理"不算数 —— 这两个文件是**在打包版上实测过**才敢删的（2026-10-12）。
 *     难点是"没法在 Agent 侧起 GPU 进程"（见下），解法是用
 *     **`--in-process-gpu`**（main.js 里本来就有这个开关，注释说明了原因）把 GPU 逻辑
 *     并进主进程，于是两条路径都能测：
 *       · `--no-gpu`（纯软件合成）→ 正常；
 *       · `--in-process-gpu --use-angle=d3d11`（**真实硬件渲染路径**）→ 正常，
 *         开发版 30.2 帧/s vs 打包版 22.5 帧/s（同量级，未出现 GPU 进程崩溃）。
 *     残留不确定性只有一个：**WebGPU 未专门验证**（本应用不用它，且两条路径都未崩）。
 *     判据是"删了要在**打包版**上实测启动 + 出帧"，不能只看 js 里有没有引用。
 *
 * ------------------------------------------------------------------ ⛔ 别删 ffmpeg.dll
 * 这里曾经把 `ffmpeg.dll`（3.0 MB）也列进删除项，理由是"声音全走 WebAudio，
 * 不加载媒体文件，Chromium 的 ffmpeg 解码链一次都不会初始化" —— **这个推理是错的，
 * 而且代价是灾难性的**。Chromium 的**渲染进程**在启动时就会 `InitializeMediaLibrary()`，
 * 它会去 `LoadLibrary("ffmpeg.dll")`；加载失败是**致命 CHECK**。现象（2026-10-12 实测）：
 *   · 打包版一启动就 `render-process-gone {"reason":"crashed","exitCode":-2147483645}`
 *     （`0x80000003` = `STATUS_BREAKPOINT`），之后**每 1.3 秒崩一次**，无限重启；
 *   · `ready-to-show` 永远不触发、`SetWindowRgn` 也没发生过、`--eval` 一个结果都不回；
 *   · 开发版（`node_modules/electron/dist/` 里 ffmpeg 还在）完全正常 —— 所以只在打包版暴露。
 * 把 `ffmpeg.dll` 拷回去立刻恢复正常，A/B 单变量坐实。**"代码里没用"不等于"进程不加载"。**
 *
 * ------------------------------------------------------------------ 留什么（动一个有真风险，收益还小）
 *   · `ffmpeg.dll`（3.0 MB）—— 见上，渲染进程启动的硬依赖。
 *   · `vk_swiftshader.dll` + `vulkan-1.dll`（6.5 MB）—— **没有硬件 GPU 时的兜底**。
 *     托盘有「软件合成」开关，且 GPU 连续崩溃 2 次后本应用会自己落盘 `forceNoGpu`；
 *     留一份 SwiftShader 意味着这类机器还有机会走软件 Vulkan，删了就彻底按在纯 CPU
 *     合成上（低配机/集显机上这恰恰是**帧率**问题，与本轮"多球不掉帧"的目标相反）。
 *   · `libGLESv2.dll` / `libEGL.dll` / `d3dcompiler_47.dll` —— ANGLE D3D11 后端，硬件加速刚需。
 *   · `icudtl.dat` / `resources.pak` / `*.pak` / `snapshot_blob.bin` —— 文本、渲染与
 *     启动快照资源，缺了会启动即崩或中文乱码。
 */
module.exports = {
  /** locales/ 里保留的语言（找不到匹配语言会自动回退 en-US，少留不影响功能） */
  KEEP_LOCALES: ['zh-CN', 'en-US', 'en-GB'],
  /** 产物**根目录**下要删掉的文件名 */
  DROP_TOP: [
    'LICENSES.chromium.html',
    'dxcompiler.dll',
    'dxil.dll',
  ],
};
