'use strict';
/** 火焰拖尾放大预览。运行： electron.exe tools/preview-fire-zoom.js → tools/shots/fire-real.png */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1251, height: 821, show: true, backgroundColor: '#20242c',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (e, l, m, ln, s) => console.log('[page]', m));
  try { await win.loadURL(url.pathToFileURL(path.join(__dirname, 'preview-fire-real.html')).href); }
  catch (e) { console.log('LOAD FAIL', e && e.message); }
  setTimeout(async () => {
    try {
      let img = await win.webContents.capturePage();
      // ⚠️ 本机实测偶发拿到 0×0 的空图（窗口还没真正映射完就截了）。
      // 直接写出去会留下 0 字节文件、且看起来像"渲染失败"。这里重试到拿到尺寸为止。
      for (let i = 0; i < 6 && img.getSize().width === 0; i++) {
        await new Promise((r) => setTimeout(r, 400));
        img = await win.webContents.capturePage();
      }
      const out = path.join(__dirname, 'shots', 'fire-real.png');
      const buf = img.toPNG();
      if (!buf || !buf.length) throw new Error('empty capture');
      fs.writeFileSync(out, buf);
      console.log('OK', out, img.getSize().width + 'x' + img.getSize().height);
    } catch (e) { console.log('FAIL', e.message); }
    app.quit();
  }, 1500);
});
app.on('window-all-closed', () => app.quit());
