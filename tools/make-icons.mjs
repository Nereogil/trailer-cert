// Generates the PWA icons as PNGs with no image library: a tiny hand-rolled
// PNG encoder over zlib, which Node already has. The icon is a trailer
// silhouette with a lightning bolt through it, drawn as filled rectangles and
// polygons on a flat background.
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const BG = [15, 17, 21];
const FG = [232, 234, 240];
const ACCENT = [76, 141, 255];

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeCanvas(size, background) {
  const buf = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    buf[i * 3] = background[0];
    buf[i * 3 + 1] = background[1];
    buf[i * 3 + 2] = background[2];
  }
  return {
    buf,
    set(x, y, colour) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const i = (Math.floor(y) * size + Math.floor(x)) * 3;
      buf[i] = colour[0];
      buf[i + 1] = colour[1];
      buf[i + 2] = colour[2];
    },
    rect(x, y, w, h, colour) {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) this.set(xx, yy, colour);
      }
    },
    disc(cx, cy, r, colour) {
      for (let yy = cy - r; yy <= cy + r; yy++) {
        for (let xx = cx - r; xx <= cx + r; xx++) {
          if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) this.set(xx, yy, colour);
        }
      }
    },
    polygon(points, colour) {
      const ys = points.map((p) => p[1]);
      for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
        const xs = [];
        for (let i = 0; i < points.length; i++) {
          const [x1, y1] = points[i];
          const [x2, y2] = points[(i + 1) % points.length];
          if (y1 === y2) continue;
          if (y >= Math.min(y1, y2) && y < Math.max(y1, y2)) {
            xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
          }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) this.set(x, y, colour);
        }
      }
    },
  };
}

function drawIcon(size, { maskable = false } = {}) {
  const canvas = makeCanvas(size, BG);
  const u = size / 100;
  // Maskable icons lose their outer ~10% to the platform's mask, so the art
  // sits inside a safe zone.
  const inset = maskable ? 12 : 0;
  const s = (v) => (v * (100 - inset * 2)) / 100 + inset;

  // Trailer body
  canvas.rect(s(18) * u, s(34) * u, (s(64) - s(18)) * u, (s(58) - s(34)) * u, FG);
  // Drawbar
  canvas.rect(s(64) * u, s(52) * u, (s(84) - s(64)) * u, 3.5 * u, FG);
  canvas.rect(s(80) * u, s(44) * u, 3.5 * u, (s(56) - s(44)) * u, FG);
  // Wheels
  canvas.disc(s(30) * u, s(64) * u, 8 * u, FG);
  canvas.disc(s(30) * u, s(64) * u, 3.5 * u, BG);
  canvas.disc(s(54) * u, s(64) * u, 8 * u, FG);
  canvas.disc(s(54) * u, s(64) * u, 3.5 * u, BG);

  // Lightning bolt across the body
  canvas.polygon(
    [
      [s(46) * u, s(30) * u],
      [s(30) * u, s(48) * u],
      [s(40) * u, s(48) * u],
      [s(34) * u, s(64) * u],
      [s(52) * u, s(44) * u],
      [s(42) * u, s(44) * u],
    ],
    ACCENT
  );

  return encodePng(size, size, canvas.buf);
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-192.png', drawIcon(192));
writeFileSync('icons/icon-512.png', drawIcon(512));
writeFileSync('icons/icon-maskable-512.png', drawIcon(512, { maskable: true }));
console.log('wrote icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png');
