#!/usr/bin/env node
/**
 * Puppeteer smoke: guided restaurant signup wizard on /register.
 *
 * Non-destructive: opens step 0 (intro), clicks Get started, asserts account/
 * restaurant fields + Back/Next, then returns to intro via Back. Does not submit
 * registration or create a tenant.
 *
 * Usage (from repo root):
 *   BASE_URL=http://127.0.0.1:4202 npm run test:guided-signup-wizard --prefix front
 *   HEADLESS=0 BASE_URL=http://127.0.0.1:4202 node front/scripts/test-guided-signup-wizard.mjs
 *
 * Env:
 *   BASE_URL   App URL (default: auto-detect 4203, 4202, 4200 or https://scanaski.uk)
 *   HEADLESS   Default headless; set 0, false, or no for a visible browser.
 */

import { isHeadless } from './puppeteer-headless.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function detectBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  for (const port of [4203, 4202, 4200]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok || res.status < 500) return `http://127.0.0.1:${port}`;
    } catch (_) {}
  }
  return 'https://scanaski.uk';
}

async function main() {
  const baseUrl = await detectBaseUrl();
  const headless = isHeadless();
  console.log('BASE_URL:', baseUrl);
  console.log('Headless:', headless);
  console.log('---');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    defaultViewport: headless ? { width: 1280, height: 720 } : null,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  let hadPageError = false;
  page.on('pageerror', (err) => {
    hadPageError = true;
    console.log('[pageerror]', err.message);
  });

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('pos_language', 'en');
      } catch (_) {}
    });

    console.log('1. Loading /register...');
    const res = await page.goto(new URL('/register', baseUrl).href, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    const status = res?.status() ?? 0;
    if (status >= 400) {
      console.log('   FAIL: /register HTTP', status);
      await browser.close();
      process.exit(1);
    }
    if (!page.url().includes('/register')) {
      console.log('   FAIL: redirected away from /register →', page.url());
      await browser.close();
      process.exit(1);
    }
    await page.waitForSelector('app-register', { timeout: 10000 });
    console.log('   On register page.');

    console.log('2. Asserting step-0 intro (Get started)...');
    await page.waitForSelector('.signup-intro', { timeout: 10000 });
    const intro = await page.evaluate(() => {
      const app = document.querySelector('app-register');
      const lead = app?.querySelector('.signup-intro-lead');
      const steps = app?.querySelectorAll('.signup-steps-list li') || [];
      const buttons = Array.from(app?.querySelectorAll('button') || []).map((b) =>
        (b.textContent || '').trim()
      );
      const getStarted = buttons.find((t) => /get started|empezar|loslegen|commencer/i.test(t));
      return {
        lead: (lead?.textContent || '').trim(),
        stepCount: steps.length,
        getStarted: getStarted || '',
        hasTenantInput: !!app?.querySelector('input#tenant'),
      };
    });
    console.log('   Intro lead:', intro.lead.slice(0, 80) || '(empty)');
    console.log('   Step bullets:', intro.stepCount);
    console.log('   Get started button:', intro.getStarted || '(missing)');

    if (!intro.lead || intro.stepCount < 3 || !intro.getStarted) {
      console.log('   FAIL: step-0 intro incomplete (lead / 3 steps / Get started).');
      await browser.close();
      process.exit(1);
    }
    if (intro.hasTenantInput) {
      console.log('   FAIL: account form visible on step 0 (expected intro only).');
      await browser.close();
      process.exit(1);
    }

    console.log('3. Advancing to account / restaurant basics...');
    await page.evaluate(() => {
      const app = document.querySelector('app-register');
      const btn = Array.from(app?.querySelectorAll('button') || []).find((b) =>
        /get started|empezar|loslegen|commencer/i.test((b.textContent || '').trim())
      );
      btn?.click();
    });
    await page.waitForSelector('app-register input#tenant', { timeout: 10000 });
    await page.waitForSelector('app-register input#address', { timeout: 5000 });
    await page.waitForSelector('app-register input#phone', { timeout: 5000 });
    await page.waitForSelector('app-register input#email', { timeout: 5000 });
    await page.waitForSelector('app-register input#password', { timeout: 5000 });

    const step1 = await page.evaluate(() => {
      const app = document.querySelector('app-register');
      const buttons = Array.from(app?.querySelectorAll('.wizard-nav button') || []).map((b) => ({
        text: (b.textContent || '').trim(),
        type: b.getAttribute('type') || 'button',
        disabled: !!b.disabled,
      }));
      const hasIntro = !!app?.querySelector('.signup-intro');
      return {
        hasIntro,
        hasTenant: !!app?.querySelector('input#tenant'),
        hasAddress: !!app?.querySelector('input#address'),
        hasPhone: !!app?.querySelector('input#phone'),
        hasEmail: !!app?.querySelector('input#email'),
        hasPassword: !!app?.querySelector('input#password'),
        hasWho: /who is this for|für wen|para quién|per a qui/i.test(app?.textContent || ''),
        buttons,
      };
    });

    const hasBack = step1.buttons.some((b) => /back|atrás|zurück|retour/i.test(b.text));
    const hasNext = step1.buttons.some(
      (b) => b.type === 'submit' || /next|siguiente|weiter|suivant/i.test(b.text)
    );
    console.log('   Fields: tenant/address/phone/email/password =', [
      step1.hasTenant,
      step1.hasAddress,
      step1.hasPhone,
      step1.hasEmail,
      step1.hasPassword,
    ].every(Boolean)
      ? 'OK'
      : 'MISSING');
    console.log('   Who-is-this-for:', step1.hasWho ? 'OK' : 'missing');
    console.log('   Back:', hasBack ? 'OK' : 'missing', '| Next:', hasNext ? 'OK' : 'missing');

    if (
      step1.hasIntro ||
      !step1.hasTenant ||
      !step1.hasAddress ||
      !step1.hasPhone ||
      !step1.hasEmail ||
      !step1.hasPassword ||
      !hasBack ||
      !hasNext
    ) {
      console.log('   FAIL: step-1 account form / wizard nav incomplete.');
      await browser.close();
      process.exit(1);
    }

    console.log('4. Back to intro (no submit)...');
    await page.evaluate(() => {
      const app = document.querySelector('app-register');
      const btn = Array.from(app?.querySelectorAll('.wizard-nav button') || []).find((b) =>
        /back|atrás|zurück|retour/i.test((b.textContent || '').trim())
      );
      btn?.click();
    });
    await page.waitForSelector('.signup-intro', { timeout: 10000 });
    const backOnIntro = await page.evaluate(() => !document.querySelector('app-register input#tenant'));
    if (!backOnIntro) {
      console.log('   FAIL: still showing account form after Back.');
      await browser.close();
      process.exit(1);
    }
    console.log('   Back on step 0.');

    if (hadPageError) {
      console.log('   FAIL: pageerror during wizard smoke.');
      await browser.close();
      process.exit(1);
    }

    console.log('\n>>> RESULT: Guided signup wizard step 0 → step 1 → Back OK (no tenant created).');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await browser.close();
    process.exit(1);
  }
}

main();
