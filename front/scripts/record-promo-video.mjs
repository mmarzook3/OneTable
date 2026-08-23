#!/usr/bin/env node
/**
 * Record a short marketing walkthrough (public pages) with Puppeteer screencast,
 * then mux a soft music bed + letterbox to 1080p with ffmpeg.
 *
 * Inspired by mac-stats screens/mac-stats-features.mp4 (live click-around + ambient bed).
 *
 * Usage (repo root, app up):
 *   BASE_URL=http://127.0.0.1:4202 node front/scripts/record-promo-video.mjs
 *   BASE_URL=https://scanaski.uk node front/scripts/record-promo-video.mjs
 *
 * Env:
 *   BASE_URL        App origin (default: auto-detect 4202/4203/4200)
 *   OUT_DIR         Output directory (default: tmp/promo)
 *   MUSIC_PATH      Bed music file (default: tmp/promo/Homage-by-Kjartan-Abel.mp3)
 *   HEADLESS        Default 1; set 0 to watch the browser
 *   TENANT_ID       Public book/delivery tenant (default 1)
 *   SKIP_ENCODE=1   Keep raw .webm only (no ffmpeg mux)
 *
 * Music (copyleft): default bed is "Homage" by Kjartan Abel, CC BY-SA 4.0.
 * See tmp/promo/MUSIC-LICENSE.txt. Distributed promo videos that include this
 * bed must keep attribution and ShareAlike (CC BY-SA 4.0).
 */

import { isHeadless } from './puppeteer-headless.mjs';
import { createRequire } from 'module';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const VIEWPORT = { width: 1280, height: 720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  for (const port of [4202, 4203, 4200]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'head',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok || res.status < 500) return `http://127.0.0.1:${port}`;
    } catch (_) {}
  }
  return 'http://127.0.0.1:4202';
}

async function dismissNoise(page) {
  // Cookie / consent banners if present — best-effort, never fail the shoot.
  for (const sel of [
    'button[aria-label*="Accept" i]',
    'button[aria-label*="accept"]',
    '.cookie-banner button',
    '#onetrust-accept-btn-handler',
  ]) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await sleep(300);
      }
    } catch (_) {}
  }
}

async function smoothScroll(page, y, steps = 12) {
  await page.evaluate(
    async ({ y, steps }) => {
      const start = window.scrollY;
      const delta = y - start;
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, start + (delta * i) / steps);
        await new Promise((r) => setTimeout(r, 40));
      }
    },
    { y, steps }
  );
  await sleep(250);
}

async function visit(page, baseUrl, path, { holdMs = 2200, scrollY = 0, waitSelector } = {}) {
  const url = new URL(path, baseUrl).href;
  console.log('  →', path);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await dismissNoise(page);
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
  }
  await sleep(Math.min(900, holdMs));
  if (scrollY > 0) {
    await smoothScroll(page, scrollY);
  }
  await sleep(Math.max(400, holdMs - 900));
}

async function runWalkthrough(page, baseUrl, tenantId) {
  // ~40–50s paced tour of public marketing + guest surfaces
  await visit(page, baseUrl, '/', {
    holdMs: 3200,
    scrollY: 420,
    waitSelector: 'body',
  });

  await visit(page, baseUrl, '/features', {
    holdMs: 4500,
    scrollY: 900,
    waitSelector: '.features-page, .features-hero__title, main',
  });
  await smoothScroll(page, 1600);
  await sleep(1200);

  await visit(page, baseUrl, '/pricing', {
    holdMs: 3500,
    scrollY: 500,
    waitSelector: 'main, .pricing-page, h1',
  });

  await visit(page, baseUrl, `/book/${tenantId}`, {
    holdMs: 4000,
    scrollY: 380,
    waitSelector: 'form, main, h1',
  });

  await visit(page, baseUrl, `/delivery/${tenantId}`, {
    holdMs: 4000,
    scrollY: 520,
    waitSelector: 'main, .delivery-page, h1',
  });

  await visit(page, baseUrl, '/about', {
    holdMs: 2800,
    scrollY: 280,
    waitSelector: 'main, h1',
  });

  await visit(page, baseUrl, '/', {
    holdMs: 2200,
    scrollY: 0,
  });
}

function resolveFfmpeg() {
  return (
    process.env.FFMPEG ||
    (existsSync('/opt/homebrew/bin/ffmpeg')
      ? '/opt/homebrew/bin/ffmpeg'
      : existsSync('/usr/local/bin/ffmpeg')
        ? '/usr/local/bin/ffmpeg'
        : 'ffmpeg')
  );
}

function resolveFfprobe() {
  return (
    process.env.FFPROBE ||
    (existsSync('/opt/homebrew/bin/ffprobe')
      ? '/opt/homebrew/bin/ffprobe'
      : existsSync('/usr/local/bin/ffprobe')
        ? '/usr/local/bin/ffprobe'
        : 'ffprobe')
  );
}

/** Bottom music attribution (Homage / Kjartan Abel). PNG overlay — no drawtext needed. */
const MUSIC_CREDIT_TEXT = 'Music: Homage by Kjartan Abel · CC BY-SA 4.0';
const MUSIC_CREDIT_LAST_SECONDS = 6;

function writeMusicCreditPng(pngPath) {
  const py = `
from PIL import Image, ImageDraw, ImageFont
text = ${JSON.stringify(MUSIC_CREDIT_TEXT)}
W, H = 1920, 64
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x, y = (W - tw) // 2, (H - th) // 2 - 2
draw.text((x + 1, y + 1), text, font=font, fill=(0, 0, 0, 140))
draw.text((x, y), text, font=font, fill=(255, 255, 255, 235))
img.save(${JSON.stringify(pngPath)})
`;
  const res = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`credit PNG failed: ${res.stderr || res.stdout || res.status}`);
  }
}

function probeDurationSeconds(mediaPath) {
  const res = spawnSync(
    resolveFfprobe(),
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      mediaPath,
    ],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) {
    throw new Error(`ffprobe failed: ${res.stderr || res.status}`);
  }
  const dur = parseFloat(String(res.stdout).trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`bad duration from ffprobe: ${res.stdout}`);
  }
  return dur;
}

/** Burn small bottom credit for the last N seconds (in-place via temp file). */
function burnMusicCredit({ mp4Path, outDir }) {
  const ffmpeg = resolveFfmpeg();
  const pngPath = join(outDir, 'credit-overlay.png');
  const tmpOut = join(outDir, 'satisfecho-promo-with-credit.mp4');
  writeMusicCreditPng(pngPath);
  const dur = probeDurationSeconds(mp4Path);
  const start = Math.max(0, dur - MUSIC_CREDIT_LAST_SECONDS);
  console.log(`Burning music credit (last ${MUSIC_CREDIT_LAST_SECONDS}s, from t=${start.toFixed(2)})…`);
  const res = spawnSync(
    ffmpeg,
    [
      '-y',
      '-i',
      mp4Path,
      '-i',
      pngPath,
      '-filter_complex',
      `[0:v][1:v]overlay=0:H-h-12:enable='gte(t\\,${start})'[v]`,
      '-map',
      '[v]',
      '-map',
      '0:a',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      tmpOut,
    ],
    { stdio: 'inherit' }
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg credit burn exited with ${res.status}`);
  }
  spawnSync('mv', ['-f', tmpOut, mp4Path], { stdio: 'inherit' });
}

function encodeWithMusic({ webmPath, musicPath, mp4Path, outDir }) {
  const ffmpeg = resolveFfmpeg();

  // Letterbox to 1920x1080, soft music bed with fade in/out, AAC audio.
  const vf =
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f1419,format=yuv420p";
  const af =
    'volume=0.22,afade=t=in:st=0:d=1.5,afade=t=out:st=38:d=3';

  const args = [
    '-y',
    '-i',
    webmPath,
    '-stream_loop',
    '-1',
    '-i',
    musicPath,
    '-filter_complex',
    `[0:v]${vf}[v];[1:a]${af}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-shortest',
    '-movflags',
    '+faststart',
    mp4Path,
  ];

  console.log('Encoding with ffmpeg…');
  const res = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg exited with ${res.status}`);
  }
  burnMusicCredit({ mp4Path, outDir });
}

async function main() {
  const baseUrl = await resolveBaseUrl();
  const outDir = resolve(repoRoot, process.env.OUT_DIR || 'tmp/promo');
  mkdirSync(outDir, { recursive: true });
  const tenantId = process.env.TENANT_ID || '1';
  const headless = isHeadless();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const webmPath = join(outDir, `satisfecho-promo-raw-${stamp}.webm`);
  const mp4Path = join(outDir, `satisfecho-promo-${stamp}.mp4`);
  const latestMp4 = join(outDir, 'satisfecho-promo-latest.mp4');
  const musicPath = resolve(
    repoRoot,
    process.env.MUSIC_PATH || 'tmp/promo/Homage-by-Kjartan-Abel.mp3'
  );

  if (!existsSync(musicPath) && process.env.SKIP_ENCODE !== '1') {
    console.error('Missing copyleft music bed:', musicPath);
    console.error(
      'Download Homage (CC BY-SA 4.0) by Kjartan Abel, e.g.:\n' +
        '  curl -L -o tmp/promo/Homage-by-Kjartan-Abel.mp3 \\\n' +
        '    https://usercontent.one/wp/kjartan-abel.com/wp-content/uploads/2022/04/Homage-by-Kjartan-Abel.mp3\n' +
        'See tmp/promo/MUSIC-LICENSE.txt'
    );
    process.exit(1);
  }

  console.log('BASE_URL:', baseUrl);
  console.log('OUT:', outDir);
  console.log('Headless:', headless);
  console.log('---');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    defaultViewport: VIEWPORT,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  console.log('Recording screencast…');
  const recorder = await page.screencast({ path: webmPath });

  try {
    await runWalkthrough(page, baseUrl, tenantId);
  } finally {
    await recorder.stop();
    await browser.close();
  }

  console.log('Raw webm:', webmPath);
  writeFileSync(
    join(outDir, 'README.txt'),
    [
      'Scanaki promo draft (inspect)',
      `BASE_URL: ${baseUrl}`,
      `Recorded: ${new Date().toISOString()}`,
      `Raw: ${webmPath}`,
      `Music bed: ${musicPath}`,
      '',
      'Music (copyleft): Homage by Kjartan Abel — CC BY-SA 4.0',
      '  https://kjartan-abel.com/library/homage/',
      '  Attribution required; ShareAlike applies to distributed derivatives.',
      '  Details: MUSIC-LICENSE.txt',
      '',
      'Pages: / → /features → /pricing → /book/{tenant} → /delivery/{tenant} → /about → /',
      '',
    ].join('\n')
  );

  if (process.env.SKIP_ENCODE === '1') {
    console.log('SKIP_ENCODE=1 — done (webm only).');
    return;
  }

  encodeWithMusic({ webmPath, musicPath, mp4Path, outDir });
  spawnSync('cp', ['-f', mp4Path, latestMp4], { stdio: 'inherit' });
  console.log('---');
  console.log('Draft MP4:', mp4Path);
  console.log('Latest:   ', latestMp4);
  console.log('Music credit (bottom, last 6s):', MUSIC_CREDIT_TEXT);
  console.log('Open: open', latestMp4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
