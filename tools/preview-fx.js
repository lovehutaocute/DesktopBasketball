'use strict';
/**
 * 开发用：把 tools/preview-fx.html 渲染成一张预览图（金球 + 火焰拖尾）。
 * 运行： node_modules/electron/dist/electron.exe tools/preview-fx.js
 * 产物： tools/shots/fx-preview.png
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240, height: 1500, show: true, backgroundColor: '#eef1f6',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 内容比窗口高 → capturePage 只拍可视区，所以按整页高度把窗口拉长再截。
  // ⚠️ 本机实测 `setContentSize` 会把窗口尺寸算成 0×0（之后 capturePage 永远拿不到东西、
  // app.quit() 也不执行，进程挂死）——所以这里用 `setTimeout` 撑时间、窗口开得比整页高，
  // 不做运行时改尺寸。页面侧用 CSS `zoom` 把内容压进可视区。
  await new Promise((r) => setTimeout(r, 400));
  win.webContents.on('console-message', (e, lvl, msg, line, src) => {
    console.log('[page]', msg, src ? src.split(/[\\/]/).pop() + ':' + line : '');
  });
  try {
    await win.loadURL(url.pathToFileURL(path.join(__dirname, 'preview-fx.html')).href);
  } catch (err) {
    console.log('LOAD FAIL', err && err.message);
  }
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      const out = path.join(__dirname, 'shots', 'fx-preview.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, img.toPNG());
      console.log('OK', out, img.getSize().width + 'x' + img.getSize().height);
    } catch (e) {
      console.log('FAIL', e.message);
    }
    app.quit();
  }, 1700);
});

app.on('window-all-closed', () => app.quit());
