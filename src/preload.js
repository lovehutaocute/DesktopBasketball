'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 球皮肤用的真实素材（照片 / 行星贴图）由**主进程**按需读取，见 main.js 的
 * `get-texture` 处理器。渲染进程只知道素材键名（watermelon / earth / jupiter，
 * 与 render.js 的 SKIN_IMG[*].tex 一致），文件名的映射只留一份、在主进程。
 *
 * 这里保留的两条设计约束（别改回去）：
 *   1. 必须转 data URL：页面是 `file://`，`file://` 页面里的 `file://` 图片在 Chromium
 *      眼里算**跨源**，画进 canvas 之后画布被污染，`getImageData` 直接抛
 *      SecurityError —— 而球皮肤的球面重投影必须逐像素读源图（render.js::bakeSphere）。
 *      data URL 同源，且不必注册自定义协议或放开 webSecurity。
 *   2. 必须**按需单张**取，不能在启动时一次读全部（见 texture() 的注释）。
 */
contextBridge.exposeInMainWorld('dbb', {
  ready: (cb) => ipcRenderer.on('init', (_e, cfg) => cb(cfg)),
  onAction: (cb) => ipcRenderer.on('action', (_e, a) => cb(a)),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, l) => cb(l)),

  sendReady: () => ipcRenderer.send('renderer-ready'),
  shape: (shape, locked) => ipcRenderer.send('shape', shape, !!locked),
  /**
   * 同步上报窗口区域：阻塞到主进程真正 SetWindowRgn 完成。
   * 只有「右键菜单弹出」这种必须先改区域、再让菜单露面的场景才用它，
   * 避免 DOM 先于窗口区域更新导致菜单被裁切。
   */
  shapeSync: (shape, locked) => ipcRenderer.sendSync('shape-sync', shape, !!locked),
  patchConfig: (p) => ipcRenderer.send('patch-config', p),
  saveBalls: (b) => ipcRenderer.send('save-balls', b),
  setAutoStart: (on) => ipcRenderer.invoke('set-autostart', on),
  info: () => ipcRenderer.invoke('app-info'),
  /**
   * 按需取一张球皮肤素材，返回 data URL；取不到返回 null（渲染进程退回程序化外观）。
   *
   * ⚠️ 为什么是**按需单张**而不是启动时一次读全部（2026-10-07 启动优化）：
   * 旧实现在渲染进程 boot() 里同步调 `textures()`，一次读走三张 jpg 共 390 KB、
   * 转成约 520 KB 的 base64，再跨 contextBridge 序列化给页面。而三张图只有西瓜 /
   * 地球 / 木星三套皮肤用得上，**默认皮肤 classic 是程序化绘制、一张都不需要** ——
   * 于是绝大多数启动都在首帧之前白读 390 KB。改成异步 invoke + 只取当前皮肤那一张后：
   *   · 默认皮肤：一次 IPC 都不发，纹理开销归零；
   *   · 素材皮肤：切到那套皮肤时才读，读完重烘（用户看不到中间态）。
   * 主进程侧缓存已读文件，重复切皮肤不重复读盘。
   *
   * @param {string} name watermelon | earth | jupiter
   */
  texture: (name) => ipcRenderer.invoke('get-texture', name),
  quit: () => ipcRenderer.send('quit-app'),
  openConfigDir: () => ipcRenderer.send('open-config-dir'),
  openLog: () => ipcRenderer.send('open-log'),
});
