#!/usr/bin/env node
// Generates branded PNG launcher icons with zero external dependencies.
// Draws NyxOS's crescent mark; emits standard + maskable sizes used by the manifest.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'icons');

// --- Minimal PNG encoder (RGBA, 8-bit) -----------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rest: compression, filter, interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Drawing -------------------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }
function draw(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4);
  const R = maskable ? size : size * 0.22;       // corner radius
  const cx = size * 0.6, cy = size * 0.4;        // moon center
  const moonR = size * 0.30;
  const carveR = size * 0.24;
  const carveX = cx + size * 0.11, carveY = cy - size * 0.02;
  const glowX = cx, glowY = cy, glowR = size * 0.42;
  const stars = [
    [0.28, 0.30, size * 0.014], [0.38, 0.22, size * 0.008],
    [0.24, 0.44, size * 0.008], [0.74, 0.72, size * 0.010],
    [0.66, 0.84, size * 0.007],
  ];

  const inRounded = (x, y) => {
    if (maskable) return true;
    const rx = Math.min(x, size - x), ry = Math.min(y, size - y);
    if (rx >= R && ry >= R) return true;
    const dx = Math.max(0, R - rx), dy = Math.max(0, R - ry);
    return dx * dx + dy * dy <= R * R;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) { buf[i + 3] = 0; continue; }

      // Background gradient (top-left → bottom-right).
      const t = (x + y) / (2 * size);
      let r = Math.round(lerp(20, 10, t));
      let g = Math.round(lerp(26, 13, t));
      let b = Math.round(lerp(43, 22, t));

      // Accent glow.
      const gd = Math.hypot(x - glowX, y - glowY) / glowR;
      if (gd < 1) {
        const k = (1 - gd) * 0.35;
        r = Math.round(lerp(r, 110, k));
        g = Math.round(lerp(g, 231, k));
        b = Math.round(lerp(b, 208, k));
      }

      // Crescent moon = big disc minus offset disc.
      const dMoon = Math.hypot(x - cx, y - cy);
      const dCarve = Math.hypot(x - carveX, y - carveY);
      if (dMoon <= moonR && dCarve > carveR) {
        r = 124; g = 243; b = 218;
      }

      // Stars.
      for (const [sx, sy, sr] of stars) {
        if (Math.hypot(x - sx * size, y - sy * size) <= sr) {
          r = 207; g = 233; b = 255;
        }
      }

      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

function emit(size, opts, name) {
  const png = encodePNG(size, size, draw(size, opts));
  writeFileSync(resolve(OUT, name), png);
  console.log(`  ${name} (${png.length} bytes)`);
}

console.log('Generating NyxOS icons →');
emit(192, { maskable: false }, 'icon-192.png');
emit(512, { maskable: false }, 'icon-512.png');
emit(192, { maskable: true }, 'icon-192-maskable.png');
emit(512, { maskable: true }, 'icon-512-maskable.png');
console.log('Done.');
