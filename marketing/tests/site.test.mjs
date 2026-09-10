import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, renderHtml, root, safePath, validateConfig } from '../tools/site.mjs';
import config from '../site.config.mjs';

const template = await readFile(resolve(root, 'src/index.html'), 'utf8');
const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
const js = await readFile(resolve(root, 'src/app.js'), 'utf8');
const assets = { styles: '/assets/styles.css', script: '/assets/app.js', favicon: '/assets/favicon.svg' };
const render = (overrides = {}) => renderHtml(template, { ...config, ...overrides }, assets, 2026);

// Configuration and public availability are deliberately independent of CI/deployment.
test('production origin and future source repository are explicit', () => {
  assert.equal(config.siteUrl, 'https://meetodds.kamatbot.com');
  assert.equal(config.repositoryUrl, 'https://github.com/kamatbot/meetodds');
  assert.equal(validateConfig(config), config);
});
test('unpublished release renders a disabled control, not a fake installer link', () => {
  const html = render({ macDownloadUrl: null });
  assert.match(html, /<button[^>]+disabled[^>]*>.*?Mac download coming soon<\/button>/);
  assert.doesNotMatch(html, /href="[^"]+\.dmg"/);
  assert.match(html, /public Mac release is being prepared/);
});
test('verified release URL enables the actual download control and updates copy', () => {
  const html = render({ macDownloadUrl: 'https://downloads.example.com/MeetOdds.dmg' });
  assert.match(html, /href="https:\/\/downloads.example.com\/MeetOdds.dmg"/);
  assert.match(html, /The Mac download is available/);
  assert.doesNotMatch(html, /Mac download coming soon|public Mac release is being prepared/);
});
test('future source status is honest', () => {
  const html = render({ repositoryAvailable: false });
  assert.match(html, /Public repository opening soon/);
  assert.match(html, /public source repository will open/);
  assert.doesNotMatch(html, /kamatbot\/notes/);
});
test('published source status does not imply an installer exists', () => {
  const html = render({ repositoryAvailable: true, macDownloadUrl: null });
  assert.match(html, /The source is available/);
  assert.doesNotMatch(html, /Public repository opening soon|public source repository will open/);
  assert.match(html, /Mac download coming soon/);
});
test('available installer does not imply the source repository has opened', () => {
  const html = render({ repositoryAvailable: false, macDownloadUrl: 'https://example.com/mac.dmg' });
  assert.match(html, /Public repository opening soon/);
  assert.match(html, /Download for Mac/);
});
for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:secret@example.com', 'not-a-url']) {
  test(`rejects unsafe or invalid public URL: ${url.replace('secret', '[redacted]')}`, () => {
    assert.throws(() => validateConfig({ ...config, macDownloadUrl: url }), /HTTPS/);
  });
}
test('site must be a root origin, and status must be boolean', () => {
  assert.throws(() => validateConfig({ ...config, siteUrl: 'https://example.com/subpath' }), /origin/);
  assert.throws(() => validateConfig({ ...config, repositoryAvailable: 'false' }), /boolean/);
  assert.throws(() => validateConfig({ ...config, siteUrl: 'https://example.com/?debug=true' }), /query/);
});
test('URL values cannot inject HTML attributes', () => {
  const html = render({ macDownloadUrl: 'https://example.com/mac.dmg?q="hello"&test=1' });
  assert.match(html, /q=&quot;hello&quot;&amp;test=1/);
  assert.doesNotMatch(html, /href="https:\/\/example.com\/mac.dmg\?q="hello/);
});
test('unknown template tokens fail the build', () => {
  assert.throws(() => renderHtml('{{DOES_NOT_EXIST}}', config, assets), /Unknown template token/);
  assert.doesNotMatch(render(), /\{\{[A-Z_]+\}\}/);
});
test('exactly one heading identifies the page and metadata points at the public domain', () => {
  const html = render();
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/meetodds.kamatbot.com\/">/);
  assert.match(html, /<meta name="description"/);
});
test('all internal links and SVG symbols have unique targets', () => {
  const html = render();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate DOM id');
  for (const [, target] of html.matchAll(/href="#([^"\s]+)"/g)) assert.ok(ids.includes(target), `missing target #${target}`);
});
test('the sample has complete tab relationships and an accessible mode selector', () => {
  const html = render();
  for (const section of ['summary', 'transcript', 'actions']) {
    assert.ok(html.includes(`id="tab-${section}" role="tab"`));
    assert.ok(html.includes(`aria-controls="panel-${section}"`));
    assert.ok(html.includes(`id="panel-${section}" aria-labelledby="tab-${section}"`));
  }
  assert.match(html, /<legend class="sr-only">Sample summary intelligence<\/legend>/);
  assert.match(html, /type="radio" name="demo-mode" value="local" checked/);
});
test('local and cloud privacy boundaries are not conflated', () => {
  const html = render();
  for (const phrase of ['Works offline after model setup', 'No account or API key needed', 'Cloud summaries send the required transcript text to OpenAI', 'usage limits apply', 'not offline or fully local']) {
    assert.ok(html.includes(phrase), `missing disclosure: ${phrase}`);
  }
  assert.match(html, /does not sign you in or collect your credentials/);
  assert.match(html, /not affiliated with OpenAI/);
  assert.doesNotMatch(html, /unlimited ChatGPT|guaranteed accuracy|100% accurate/i);
});
test('progressive enhancement and reduced motion are supported', () => {
  assert.match(template, /<noscript>/);
  assert.match(template, /class="demo-tabs" hidden/);
  assert.match(template, /class="preview-controls" hidden/);
  assert.match(template, /<details><summary>/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /animation[^;]*infinite/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Escape']) assert.ok(js.includes(`'${key}'`));
});
test('site has no third-party runtime requests, telemetry, inline handlers or account logic', () => {
  assert.doesNotMatch(template, /\son(?:click|load|error|submit)\s*=/i);
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(|document\.cookie|localStorage\.|sessionStorage\./);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/);
  assert.doesNotMatch(template, /<script[^>]+src="https?:/);
});
test('development server paths cannot escape the output directory', () => {
  const base = resolve(tmpdir(), 'meetodds-safety');
  assert.equal(safePath('/', base), resolve(base, 'index.html'));
  assert.equal(safePath('/assets/app.js', base), resolve(base, 'assets/app.js'));
  for (const path of ['/../secret', '/%2e%2e/secret', '/..%2fsecret', '/%00', '/%ZZ', '/..\\secret']) assert.equal(safePath(path, base), null, path);
});
test('complete static build has hashed assets, sitemap and a small transfer budget', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'meetodds-site-'));
  try {
    const result = await build(config, dir);
    const files = await readdir(resolve(dir, 'assets'));
    assert.equal(files.length, 3);
    let bytes = Buffer.byteLength(result.html);
    let compressed = gzipSync(result.html).byteLength;
    for (const file of files) {
      assert.match(file, /\.[a-f0-9]{12}\.(css|js|svg)$/);
      const body = await readFile(resolve(dir, 'assets', file));
      bytes += body.byteLength;
      compressed += gzipSync(body).byteLength;
    }
    assert.ok(bytes < 120_000, `uncompressed bytes: ${bytes}`);
    assert.ok(compressed < 30_000, `gzip bytes: ${compressed}`);
    assert.match(await readFile(resolve(dir, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/meetodds.kamatbot.com\/sitemap.xml/);
    assert.match(await readFile(resolve(dir, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/meetodds.kamatbot.com\/<\/loc>/);
    assert.match(await readFile(resolve(dir, '404.html'), 'utf8'), /Page not found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
