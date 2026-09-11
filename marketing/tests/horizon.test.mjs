import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../site.config.mjs';
import { build } from '../tools/site-horizon.mjs';

const expectedVideoSha256 = '24add1b82249c2322391a171cc1789f582f38e8bdd7eccb6a200e41ce020b00e';
const videoName = `meetodds-hero.${expectedVideoSha256.slice(0, 12)}.mp4`;

test('Horizon build emits the real hero video and app-aligned theme', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'meetodds-horizon-'));
  const result = await build(config, destination);
  const [html, theme, video, videoScript] = await Promise.all([
    readFile(join(destination, 'index.html'), 'utf8'),
    readFile(join(destination, 'horizon.css'), 'utf8'),
    readFile(join(destination, videoName)),
    readFile(join(destination, 'hero-video.js'), 'utf8'),
  ]);

  assert.equal(result.heroVideo, `/${videoName}`);
  assert.ok(html.includes(`data-hero-video="/${videoName}"`));
  assert.match(html, /href="\/horizon\.css"/);
  assert.match(html, /src="\/hero-video\.js"/);
  assert.match(html, /<meta name="theme-color" content="#f8f4ee">/);
  assert.doesNotMatch(html, /<meta name="theme-color" content="#f8faff">/);
  assert.match(theme, /--orange:\s*#e85d2a/);
  assert.match(theme, /--paper:\s*#f8f4ee/);
  assert.match(videoScript, /prefers-reduced-motion/);
  assert.equal(createHash('sha256').update(video).digest('hex'), expectedVideoSha256);
  assert.ok((await stat(join(destination, videoName))).size > 40_000);
});
