/** Horizon marketing build: layers the current app visual system and real product video over the proven static site. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../site.config.mjs';
import { build as buildBase, output, root, safePath, validateConfig } from './site.mjs';

const source = resolve(root, 'src');
const heroVideoSource = resolve(source, 'hero.mp4');

async function materializeVideo(destination) {
  const bytes = await readFile(heroVideoSource);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const filename = `meetodds-hero.${digest.slice(0, 12)}.mp4`;
  const path = resolve(destination, filename);
  await writeFile(path, bytes);
  return `/${filename}`;
}

export async function build(settings = config, destination = output) {
  validateConfig(settings);
  const base = await buildBase(settings, destination);
  await mkdir(destination, { recursive: true });

  const [theme, videoScript, baseHtml, videoPath] = await Promise.all([
    readFile(resolve(source, 'horizon.css')),
    readFile(resolve(source, 'hero-video.js')),
    readFile(resolve(destination, 'index.html'), 'utf8'),
    materializeVideo(destination),
  ]);
  await writeFile(resolve(destination, 'horizon.css'), theme);
  await writeFile(resolve(destination, 'hero-video.js'), videoScript);

  const html = baseHtml
    .replace('<meta name="theme-color" content="#f8faff">', '<meta name="theme-color" content="#f8f4ee">')
    .replace('</head>', '  <link rel="stylesheet" href="/horizon.css">\n</head>')
    .replace('<body>', `<body data-hero-video="${videoPath}">`)
    .replace('</body>', '  <script type="module" src="/hero-video.js"></script>\n</body>');
  await writeFile(resolve(destination, 'index.html'), html);
  return { ...base, html, heroVideo: videoPath };
}

export async function serve({ port = 4173, development = false } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  if (development) await build();
  else await readFile(resolve(output, 'index.html'));

  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
  };
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (development && pathname === '/') {
        queue = queue.catch(() => {}).then(() => build());
        await queue;
      }
      const file = safePath(pathname);
      if (!file) { res.writeHead(400); res.end('Bad request'); return; }
      let bytes;
      try { bytes = await readFile(file); } catch { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Length': bytes.byteLength,
        'Cache-Control': development ? 'no-store' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end('Unable to serve the page');
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  console.log(`MeetOdds Horizon ${development ? 'development' : 'preview'}: http://127.0.0.1:${port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  try {
    if (command === 'build') { await build(); console.log(`Built Horizon website → ${output}`); }
    else if (command === 'dev' || command === 'preview') await serve({ port: Number(process.env.PORT ?? 4173), development: command === 'dev' });
    else throw new Error('Usage: node tools/site-horizon.mjs <build|dev|preview>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
