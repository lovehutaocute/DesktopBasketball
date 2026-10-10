'use strict';
/**
 * 开发用：把 tools/preview.html 渲染成一张放大预览图（球纹理 + 篮球架）。
 * 运行： node_modules/electron/dist/electron.exe tools/preview-main.js
 * 产物： tools/shots/preview_tex.png
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 1210, show: true, backgroundColor: '#eef1f6',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (e, lvl, msg, line, src) => {
    console.log('[page]', msg, src ? src.split(/[\\/]/).pop() + ':' + line : '');
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.log('did-fail-load', code, desc, url);
  });
  const url = require('url');
  try {
    await win.loadURL(url.pathToFileURL(path.join(__dirname, 'preview.html')).href);
  } catch (err) {
    console.log('LOAD FAIL', err && err.message);
  }
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      const out = path.join(__dirname, 'shots', 'preview_tex.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, img.toPNG());
      console.log('OK', out, img.getSize().width + 'x' + img.getSize().height);
    } catch (e) {
      console.log('FAIL', e.message);
    }
    app.quit();
  }, 1600);
});

app.on('window-all-closed', () => app.quit());
