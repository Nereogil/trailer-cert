// Zero-dependency static server bound to every interface, so a phone on the
// same WiFi can reach it. Development convenience only, never a host for real
// use: it has no TLS, and the camera and storage APIs want a secure context.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname));
    if (path === '/' || path === sep) path = '/index.html';

    const full = join(ROOT, path);
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(full);
    if (info.isDirectory()) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log(`Serving ${ROOT}`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const address of addresses) {
    console.log(`  network: http://${address}:${PORT}   <- open this on the phone`);
  }
});
