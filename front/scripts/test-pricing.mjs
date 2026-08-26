#!/usr/bin/env node
/**
 * Puppeteer smoke: public /pricing marketing page (#328).
 * Asserts page shell, live price from GET /saas/config, trial line, self-host card,
 * register CTA, and paywall-enabled vs inactive billing note.
 *
 * Usage (from repo root):
 *   BASE_URL=http://127.0.0.1:4202 npm run test:pricing --prefix front
 *   node front/scripts/test-pricing.mjs
 *
 * Env:
 *   BASE_URL   App URL (default: auto-detect port 4203, 4202, 4200 or http://127.0.0.1:4202)
 *   HEADLESS   Default headless; set 0, false, or no for a visible browser.
 */

import { isHeadless } from './puppeteer-headless.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function resolveBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  for (const port of [4203, 4202, 4200]) {
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

async function main() {
  const baseUrl = await resolveBaseUrl();
  const headless = isHeadless();
  console.log('BASE_URL:', baseUrl);
  console.log('Headless:', headless);
  console.log('---');

  const configUrl = new URL('/api/saas/config', baseUrl).href;
  const cfgRes = await fetch(configUrl, { signal: AbortSignal.timeout(8000) });
  if (!cfgRes.ok) {
    console.error('FAIL: GET /api/saas/config status', cfgRes.status);
    process.exit(1);
  }
  const cfg = await cfgRes.json();
  if (typeof cfg.price_cents !== 'number' || typeof cfg.trial_days !== 'number') {
    console.error('FAIL: saas/config missing price_cents/trial_days:', cfg);
    process.exit(1);
  }
  if (!Array.isArray(cfg.plans) || cfg.plans.length < 1) {
    console.error('FAIL: saas/config.plans should be a non-empty array:', cfg);
    process.exit(1);
  }
  console.log('saas/config:', {
    enabled: cfg.enabled,
    trial_days: cfg.trial_days,
    price_cents: cfg.price_cents,
    currency: cfg.currency,
    plans: cfg.plans.length,
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    defaultViewport: headless ? { width: 1280, height: 720 } : null,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    console.log('1. Loading /pricing...');
    const pricingUrl = new URL('/pricing', baseUrl).href;
    const response = await page.goto(pricingUrl, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    if (!response || response.status() >= 400) {
      console.error('FAIL: HTTP status for /pricing:', response?.status());
      process.exit(1);
    }
    const path = new URL(page.url()).pathname;
    if (path !== '/pricing' && !path.startsWith('/pricing/')) {
      console.error('FAIL: Expected path /pricing (not redirect home), got:', page.url());
      process.exit(1);
    }

    console.log('2. Waiting for pricing shell...');
    await page.waitForSelector('[data-testid="pricing-page"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="pricing-tiers"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="pricing-price"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="pricing-trial"]', { timeout: 10000 });

    const shell = await page.evaluate((expected) => {
      const title = (document.querySelector('.pricing-hero__title')?.textContent || '').trim();
      const priceText = (document.querySelector('[data-testid="pricing-price"]')?.textContent || '').trim();
      const trialText = (document.querySelector('[data-testid="pricing-trial"]')?.textContent || '').trim();
      const registerOk = !!document.querySelector('a[data-testid="pricing-cta-register"]');
      const selfHostPresent = !!document.querySelector('[data-testid="pricing-self-host"]');
      const bannedPositioning = /open[ -]?source|agpl/i.test(document.body?.innerText || '');
      const billingNotes = document.querySelectorAll(
        '[data-testid="pricing-billing-active"], [data-testid="pricing-billing-inactive"]',
      ).length;
      const planCards = Array.from(document.querySelectorAll('[data-testid="pricing-plan-card"]')).map(
        (card) => {
          const rect = card.getBoundingClientRect();
          const topFor = (selector) => card.querySelector(selector)?.getBoundingClientRect().top ?? null;
          const decimal = card.querySelector('.pricing-card__decimal');
          const whole = card.querySelector('.pricing-card__whole');
          return {
            id: card.getAttribute('data-plan-id') || '',
            text: (card.textContent || '').replace(/\s+/g, ' ').trim(),
            height: rect.height,
            nameTop: topFor('.pricing-card__name'),
            ledeTop: topFor('.pricing-card__lede'),
            offerTop: topFor('.pricing-card__offer'),
            priceTop: topFor('.pricing-card__price'),
            trialTop: topFor('.pricing-card__trial'),
            extraTop: topFor('.pricing-card__extra'),
            includesTop: topFor('.pricing-card__includes'),
            ctaTop: topFor('.pricing-btn'),
            decimalText: decimal?.textContent?.trim() || '',
            decimalFontSize: decimal ? parseFloat(getComputedStyle(decimal).fontSize) : 0,
            wholeFontSize: whole ? parseFloat(getComputedStyle(whole).fontSize) : 0,
            standardText:
              card.querySelector('[data-testid="pricing-standard-price"]')?.textContent?.trim() || '',
            dealText: card.querySelector('.pricing-card__deal')?.textContent?.trim() || '',
            usesStruckReference: !!card.querySelector('s, del'),
          };
        },
      );
      const rawKeyDump =
        title.includes('PRICING_PAGE.') ||
        (document.body?.innerText || '').includes('PRICING_PAGE.TITLE');
      const priceMajor = String(Math.round(expected.price_cents / 100));
      const priceMentionsAmount =
        priceText.includes(priceMajor) || priceText.replace(/\s/g, '').includes(priceMajor);
      const trialMentionsDays = trialText.includes(String(expected.trial_days));
      return {
        title,
        priceText,
        trialText,
        registerOk,
        selfHostPresent,
        bannedPositioning,
        billingNotes,
        planCards,
        rawKeyDump,
        priceMentionsAmount,
        trialMentionsDays,
      };
    }, { price_cents: cfg.price_cents, trial_days: cfg.trial_days, plans: cfg.plans });

    if (!shell.title || shell.rawKeyDump) {
      console.error('FAIL: Hero title missing or untranslated. Got:', JSON.stringify(shell.title));
      process.exit(1);
    }
    console.log('   Hero title:', shell.title);

    if (!shell.priceMentionsAmount) {
      console.error(
        'FAIL: Price block should reflect saas/config price_cents. Got:',
        JSON.stringify(shell.priceText),
        'expected major units of',
        cfg.price_cents
      );
      process.exit(1);
    }
    console.log('   Price:', shell.priceText);

    if (!shell.trialMentionsDays) {
      console.error(
        'FAIL: Trial line should include trial_days from config. Got:',
        JSON.stringify(shell.trialText),
        'days=',
        cfg.trial_days
      );
      process.exit(1);
    }
    console.log('   Trial:', shell.trialText);

    if (!shell.registerOk || shell.selfHostPresent || shell.bannedPositioning) {
      console.error('FAIL: Pricing must show managed signup only, without legacy positioning.', shell);
      process.exit(1);
    }

    const expectedPlans = [
      { id: 'lite', name: 'Lite', price: '£9.99', standard: '£34.97', tables: '2 tables', extra: '£3.99' },
      { id: 'pro', name: 'Pro', price: '£39.99', standard: '£139.97', tables: '20 tables', extra: '£3.99' },
      { id: 'ultra', name: 'Ultra', price: '£84.99', standard: '£297.47', tables: '45 tables', extra: '£3.99' },
    ];
    if (shell.planCards.length !== expectedPlans.length) {
      console.error('FAIL: Expected exactly three managed pricing cards.', shell.planCards);
      process.exit(1);
    }
    for (const expected of expectedPlans) {
      const card = shell.planCards.find((row) => row.id === expected.id);
      if (
        !card ||
        !card.text.includes(expected.name) ||
        !card.text.replace(/\s/g, '').includes(expected.price) ||
        card.standardText !== expected.standard ||
        !/launch deal/i.test(card.dealText) ||
        card.usesStruckReference ||
        !card.text.includes(expected.tables) ||
        !card.text.includes(expected.extra)
      ) {
        console.error('FAIL: Pricing card mismatch.', expected, card);
        process.exit(1);
      }
    }

    const alignedFields = [
      'height',
      'nameTop',
      'ledeTop',
      'offerTop',
      'priceTop',
      'trialTop',
      'extraTop',
      'includesTop',
      'ctaTop',
    ];
    for (const field of alignedFields) {
      const values = shell.planCards.map((card) => card[field]);
      if (values.some((value) => typeof value !== 'number')) {
        console.error(`FAIL: Missing pricing-card alignment metric ${field}.`, shell.planCards);
        process.exit(1);
      }
      if (Math.max(...values) - Math.min(...values) > 2) {
        console.error(`FAIL: Pricing cards are not symmetrical at ${field}.`, values);
        process.exit(1);
      }
    }
    for (const card of shell.planCards) {
      if (!/^\.\d{2}$/.test(card.decimalText) || card.decimalFontSize >= card.wholeFontSize) {
        console.error('FAIL: Price decimal must contain two digits and render smaller.', card);
        process.exit(1);
      }
    }

    if (shell.billingNotes !== 0) {
      console.error('FAIL: Internal billing status note must not appear on public pricing.', shell);
      process.exit(1);
    }

    if (pageErrors.length) {
      console.error('FAIL: pageerror(s):', pageErrors);
      process.exit(1);
    }

    await browser.close();
    console.log('\n>>> RESULT: /pricing loads with live saas/config price, trial, and managed signup.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await browser.close();
    process.exit(1);
  }
}

main();
