/** Zero-dependency static build and loopback-only development server. Not a production server. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../site.config.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src');
export const output = resolve(root, 'dist');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function validateConfig(value) {
  for (const key of ['siteUrl', 'repositoryUrl', 'macDownloadUrl']) {
    if (key === 'macDownloadUrl' && value[key] === null) continue;
    let url;
    try { url = new URL(value[key]); } catch { throw new Error(`${key} must be an absolute HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${key} must be a public HTTPS URL without credentials`);
    if (url.hash) throw new Error(`${key} must not contain a fragment`);
    if (key !== 'macDownloadUrl' && url.search) throw new Error(`${key} must not contain a query`);
    if (key === 'siteUrl' && url.pathname !== '/') throw new Error('siteUrl must be an origin; deploy this site at the domain root');
  }
  if (typeof value.repositoryAvailable !== 'boolean') throw new Error('repositoryAvailable must be a boolean');
  return value;
}

export function renderHtml(template, settings, assets, year = new Date().getUTCFullYear()) {
  validateConfig(settings);
  const site = settings.siteUrl.replace(/\/$/, '');
  const repo = settings.repositoryUrl.replace(/\/$/, '');
  const live = settings.macDownloadUrl !== null;
  const control = live
    ? `<a class="button" href="${escapeHtml(settings.macDownloadUrl)}"><svg class="icon"><use href="#i-apple"/></svg>Download for Mac</a>`
    : '<button class="button button-disabled" type="button" disabled><svg class="icon"><use href="#i-apple"/></svg>Mac download coming soon</button>';
  const availability = `${live ? 'The Mac download is available in the download section below.' : 'The public Mac download is being prepared.'} ${settings.repositoryAvailable ? 'The source is available' : 'The public source repository will open'} at <a href="${escapeHtml(repo)}">github.com/kamatbot/meetodds</a>.`;
  const replacements = {
    SITE_URL: escapeHtml(site), REPO_URL: escapeHtml(repo), YEAR: String(year),
    STYLES: escapeHtml(assets.styles), SCRIPT: escapeHtml(assets.script), FAVICON: escapeHtml(assets.favicon),
    REPO_STATUS: settings.repositoryAvailable ? 'Read it. Fork it. Make it better.' : 'Public repository opening soon at github.com/kamatbot/meetodds.',
    DOWNLOAD_CONTROL: control,
    DOWNLOAD_STATUS: live ? 'Mac download available. Check the release notes for system requirements.' : 'The public Mac release is being prepared. A download link will appear here when it is ready.',
    AVAILABILITY_TEXT: availability,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in replacements)) throw new Error(`Unknown template token: ${key}`);
    return replacements[key];
  });
}

export async function build(settings = config, destination = output) {
  validateConfig(settings);
  // Only clear our known build directory. Tests use fresh temporary directories.
  if (resolve(destination) === output) await rm(output, { recursive: true, force: true });
  await mkdir(resolve(destination, 'assets'), { recursive: true });
  const assets = {};
  for (const [name, filename] of [['styles', 'styles.css'], ['script', 'app.js'], ['favicon', 'favicon.svg']]) {
    const content = await readFile(resolve(source, filename));
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const file = `${name}.${hash}${extname(filename)}`;
    await writeFile(resolve(destination, 'assets', file), content);
    assets[name] = `/assets/${file}`;
  }
  const template = await readFile(resolve(source, 'index.html'), 'utf8');
  const html = renderHtml(template, settings, assets);
  await writeFile(resolve(destination, 'index.html'), html);
  await writeFile(resolve(destination, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — MeetOdds</title><body><main><h1>This page is not here.</h1><p><a href="/">Back to MeetOdds</a></p></main></body></html>');
  const origin = settings.siteUrl.replace(/\/$/, '');
  await writeFile(resolve(destination, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  await writeFile(resolve(destination, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(origin)}/</loc></url></urlset>\n`);
  return { html, assets, destination };
}

export function safePath(pathname, base = output) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const path = resolve(base, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (path !== resolve(base) && !path.startsWith(`${resolve(base)}${sep}`)) return null;
  return path;
}

export async function serve({ port = 4173, development = false } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  if (development) await build();
  else await readFile(resolve(output, 'index.html')); // Fail early with a useful missing-build error.
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (development && pathname === '/') {
        // Serialize rebuilds so two browser tabs cannot race while writing assets.
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
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  console.log(`MeetOdds ${development ? 'development' : 'preview'}: http://127.0.0.1:${port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  try {
    if (command === 'build') { await build(); console.log(`Built static website → ${output}`); }
    else if (command === 'dev' || command === 'preview') await serve({ port: Number(process.env.PORT ?? 4173), development: command === 'dev' });
    else throw new Error('Usage: node tools/site.mjs <build|dev|preview>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
