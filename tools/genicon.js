'use strict';
/**
 * genicon.js —— 零依赖生成托盘图标 / 应用图标（自己写 PNG + ICO 编码）
 *   node tools/genicon.js
 * 输出：assets/tray.png、assets/icon-256.png、assets/icon.ico
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

function encodeICO(images) {
  const n = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  const blobs = [];
  let offset = 6 + 16 * n;
  images.forEach((img, i) => {
    const blob = bmpEntry(img.rgba, img.size);
    blobs.push(blob);
    dir[i * 16 + 0] = img.size >= 256 ? 0 : img.size;
    dir[i * 16 + 1] = img.size >= 256 ? 0 : img.size;
    dir[i * 16 + 2] = 0;
    dir[i * 16 + 3] = 0;
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(blob.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += blob.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---------------------------------------------------------------- 篮球位图
const STOPS = [
  [0.00, [255, 205, 148]],
  [0.30, [246, 165, 82]],
  [0.62, [228, 120, 34]],
  [0.88, [182, 78, 16]],
  [1.30, [120, 45, 6]],
];

function lerp(a, b, t) { return a + (b - a) * t; }

function baseColor(u, v, dist, R) {
  // (u,v) 相对球心、已归一化到半径 1
  const hx = -0.36, hy = -0.42;
  const d = Math.hypot(u - hx, v - hy) / 1.15;
  let c = STOPS[STOPS.length - 1][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (d <= STOPS[i][0]) {
      const a = STOPS[i - 1], b = STOPS[i];
      const t = (d - a[0]) / (b[0] - a[0]);
      c = [lerp(a[1][0], b[1][0], t), lerp(a[1][1], b[1][1], t), lerp(a[1][2], b[1][2], t)];
      break;
    }
  }
  // 边缘暗化
  const e = Math.max(0, (dist - 0.68) / 0.32);
  const k = 1 - 0.42 * Math.min(1, e * e);
  return [c[0] * k, c[1] * k, c[2] * k];
}

function renderBall(size) {
  const SS = size >= 64 ? 3 : 5;         // 超采样倍数
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.478;
  const seamW = Math.max(size * 0.028, R * 0.075);

  const inSeam = (px, py) => {
    const u = (px - cx) / R, v = (py - cy) / R;
    if (Math.abs(v) < seamW / R) return true;
    if (Math.abs(u) < seamW / R) return true;
    const cl = Math.abs(Math.hypot(u + 0.98, v) - 0.98);
    if (cl < seamW / R) return true;
    const cr = Math.abs(Math.hypot(u - 0.98, v) - 0.98);
    if (cr < seamW / R) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, sr = 0, sg = 0, sb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const dist = Math.hypot(px - cx, py - cy);
          if (dist > R) continue;
          cov++;
          const u = (px - cx) / R, v = (py - cy) / R;
          let c;
          if (inSeam(px, py)) {
            c = [46, 19, 4];
          } else {
            c = baseColor(u, v, dist / R, R);
            // 左上小高光
            const hd = Math.hypot(px - (cx - R * 0.40), py - (cy - R * 0.44));
            if (hd < R * 0.30) {
              const t = Math.pow(1 - hd / (R * 0.30), 2) * 0.42;
              c = [lerp(c[0], 255, t), lerp(c[1], 255, t), lerp(c[2], 255, t)];
            }
          }
          sr += c[0]; sg += c[1]; sb += c[2];
        }
      }
      const total = SS * SS;
      const i = (y * size + x) * 4;
      if (cov === 0) { rgba[i + 3] = 0; continue; }
      rgba[i] = Math.round(sr / cov);
      rgba[i + 1] = Math.round(sg / cov);
      rgba[i + 2] = Math.round(sb / cov);
      rgba[i + 3] = Math.round(255 * (cov / total));
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- main
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const tray = renderBall(32);
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, 32, tray));

const big = renderBall(256);
fs.writeFileSync(path.join(outDir, 'icon-256.png'), encodePNG(256, 256, big));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => ({ size: s, rgba: renderBall(s) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(images));

console.log('已生成: assets/tray.png, assets/icon-256.png, assets/icon.ico',
  '(', fs.statSync(path.join(outDir, 'icon.ico')).size, 'bytes )');
