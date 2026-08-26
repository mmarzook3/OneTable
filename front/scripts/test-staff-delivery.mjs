#!/usr/bin/env node
/**
 * Puppeteer smoke: staff Scanaki Delivery create + edit on /staff/orders.
 *
 * Path: login → /staff/orders → New delivery order → address/phone + item →
 * create → Delivery tab channel badge → Edit delivery → save phone change.
 *
 * Usage (from repo root):
 *   npm run test:staff-delivery --prefix front
 *   BASE_URL=http://127.0.0.1:4202 npm run test:staff-delivery --prefix front
 *
 * Env:
 *   BASE_URL         App URL (default: auto-detect 4203, 4202, 4200)
 *   TENANT_ID        Login tenant (default 1)
 *   LOGIN_EMAIL      Staff/admin with order update (or DEMO_LOGIN_EMAIL / ADMIN_EMAIL)
 *   LOGIN_PASSWORD   Password (or DEMO_LOGIN_PASSWORD / ADMIN_PASSWORD)
 *   HEADLESS         Default headless; set 0, false, or no for a visible browser
 */

import { isHeadless } from './puppeteer-headless.mjs';
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(__dirname, '..', '..');

function loadEnv() {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    readFileSync(envPath, 'utf8')
      .split('\n')
      .forEach((line) => {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      });
  } catch (_) {}
}
loadEnv();

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Set input/textarea so Angular ngModel picks up the value. */
async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  const ok = await page.$eval(
    selector,
    (el, text) => {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === text;
    },
    value,
  );
  if (!ok) throw new Error(`Failed to set ${selector}`);
}

/** Pick first real option on an Angular [ngValue] select (skip null placeholder). */
async function selectFirstRealOption(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const s = document.querySelector(sel);
      return s && s.options && s.options.length >= 2;
    },
    { timeout: 15000 },
    selector,
  );
  const label = await page.$eval(selector, (sel) => {
    const opt = sel.options[1];
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return (opt.textContent || '').trim();
  });
  return label;
}

async function clickButtonByText(page, pattern) {
  const clicked = await page.evaluate((reSource) => {
    const re = new RegExp(reSource, 'i');
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => re.test((b.textContent || '').trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  }, pattern.source);
  return clicked;
}

async function main() {
  const baseUrl = await resolveBaseUrl();
  const tenantId = process.env.TENANT_ID || '1';
  const headless = isHeadless();
  const loginEmail =
    process.env.LOGIN_EMAIL ||
    process.env.ADMIN_EMAIL ||
    process.env.DEMO_LOGIN_EMAIL;
  const loginPassword =
    process.env.LOGIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    process.env.DEMO_LOGIN_PASSWORD;

  const suffix = String(Date.now()).slice(-8);
  const address = `Calle Staff Delivery ${suffix}, Madrid`;
  const phone = `+346${suffix}`;
  const phoneEdited = `+346${String(Number(suffix) + 1).padStart(8, '0').slice(-8)}`;
  const customer = `Smoke Delivery ${suffix}`;

  console.log('test-staff-delivery (Puppeteer)');
  console.log('BASE_URL:', baseUrl);
  console.log('TENANT_ID:', tenantId);
  console.log('Headless:', headless);
  console.log('Customer:', customer, phone);
  console.log('---');

  if (!loginEmail || !loginPassword) {
    console.error('FAIL: LOGIN_EMAIL/LOGIN_PASSWORD (or DEMO_LOGIN_*) required');
    process.exit(1);
  }

  const hardFails = [];
  const pageErrors = [];

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    defaultViewport: headless ? { width: 1280, height: 720 } : null,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    console.log('[pageerror]', err.message);
  });

  try {
    // 1. Login
    console.log('1. Staff login');
    const loginUrl = new URL('/login', baseUrl);
    loginUrl.searchParams.set('tenant', tenantId);
    await page.goto(loginUrl.href, { waitUntil: 'networkidle2', timeout: 25000 });
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.type('input[type="email"]', loginEmail);
    await page.type('input[type="password"]', loginPassword);
    const submit = await page.$('button[type="submit"]');
    if (submit) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        submit.click(),
      ]);
    }
    await sleep(1500);
    if (page.url().includes('/login')) {
      throw new Error('Staff login failed (still on /login)');
    }
    console.log('   Logged in:', page.url());

    // 2. Open orders + create modal
    console.log('2. Open /staff/orders → New delivery order');
    await page.goto(new URL('/staff/orders', baseUrl).href, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await page.waitForFunction(
      () => {
        const t = document.body?.innerText || '';
        return (
          t.includes('Orders') ||
          t.includes('Pedidos') ||
          t.includes('Bestellungen') ||
          t.includes('Commandes') ||
          !!document.querySelector('.filter-tabs')
        );
      },
      { timeout: 20000 },
    );

    const opened = await clickButtonByText(
      page,
      /new delivery order|nuevo pedido de entrega|neue lieferbestellung|nouvelle commande de livraison|nova comanda d.?entrega/i,
    );
    if (!opened) {
      hardFails.push('New delivery order button not found (need order-update permission)');
    } else {
      await page.waitForSelector('#delivery-address', { timeout: 10000 });
      console.log('   Create modal open');

      await setInputValue(page, '#delivery-address', address);
      await setInputValue(page, '#delivery-phone', phone);
      await setInputValue(page, '#delivery-customer', customer);

      // Wait for product list (API) then add one line
      let productLabel = '';
      try {
        productLabel = await selectFirstRealOption(page, 'select[name="deliveryAddProduct"]');
      } catch (_) {
        hardFails.push('No products in delivery create modal (seed demo products?)');
      }
      if (productLabel) {
        console.log('   Product:', productLabel);
        const added = await clickButtonByText(
          page,
          /^(add|añadir|hinzufügen|ajouter|afegir)$/i,
        );
        if (!added) {
          // Prefer the Add next to quantity in the modal
          await page.evaluate(() => {
            const row = document.querySelector('.add-items-row');
            const btn = row?.querySelector('button');
            if (btn && !btn.disabled) btn.click();
          });
        }
        await sleep(400);
        const hasDraft = await page.$('.delivery-draft-items .edit-order-row');
        if (!hasDraft) {
          hardFails.push('Delivery draft item not added');
        } else {
          console.log('   Draft item added');
        }
      }

      // Optional courier assign (None is OK)
      const courierSelect = await page.$('#delivery-courier');
      if (courierSelect) {
        const courierCount = await page.$eval(
          '#delivery-courier',
          (sel) => sel.options.length,
        );
        if (courierCount >= 2) {
          await selectFirstRealOption(page, '#delivery-courier');
          console.log('   Courier selected (first available)');
        } else {
          console.log('   No couriers listed; leaving unassigned');
        }
      }

      if (!hardFails.length) {
        const createPromise = page.waitForResponse(
          (res) =>
            res.url().includes('/orders/satisfecho-delivery') &&
            res.request().method() === 'POST',
          { timeout: 25000 },
        );
        const createClicked = await page.evaluate(() => {
          const actions = document.querySelector('.modal-actions');
          const btn = actions?.querySelector('button.btn-primary');
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
        });
        if (!createClicked) {
          hardFails.push('Create delivery primary button missing or disabled');
        } else {
          const createRes = await createPromise.catch(() => null);
          if (!createRes) {
            hardFails.push('POST /orders/satisfecho-delivery missing');
          } else if (createRes.status() >= 400) {
            const body = await createRes.json().catch(() => ({}));
            hardFails.push(
              `Create delivery failed: HTTP ${createRes.status()} ${JSON.stringify(body)}`,
            );
          } else {
            const body = await createRes.json().catch(() => ({}));
            console.log('   Create OK, order id:', body.id ?? '(pending list refresh)');
          }
        }
      }
    }

    // 3. Delivery tab + channel badge
    console.log('3. Assert Delivery tab + channel badge');
    await sleep(1000);
    const deliveryTab = await clickButtonByText(
      page,
      /^(delivery|entrega|lieferung|livraison)$/i,
    );
    if (!deliveryTab) {
      // filter-tab may include a badge count
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('button.filter-tab'));
        const d = tabs.find((t) =>
          /delivery|entrega|lieferung|livraison/i.test(t.textContent || ''),
        );
        d?.click();
      });
    }
    await sleep(800);

    const listOk = await page.evaluate((addr) => {
      const t = document.body?.innerText || '';
      if (t.includes('ORDERS.CHANNEL_') || t.includes('ORDERS.NEW_DELIVERY')) return false;
      const badge = Array.from(document.querySelectorAll('.order-channel-badge')).some((el) =>
        /satisfecho\s*delivery|entrega\s*satisfecho|satisfecho-lieferung|livraison\s*satisfecho/i.test(
          el.textContent || '',
        ),
      );
      const hasAddress = t.includes(addr);
      const hasCards = !!document.querySelector('.order-card, .order-grid .order-card');
      return (badge || hasAddress) && (hasCards || hasAddress);
    }, address);
    if (!listOk) {
      hardFails.push('Delivery tab missing channel badge or created address');
    } else {
      console.log('   Delivery list shows Scanaki Delivery / address');
    }

    // 4. Edit delivery metadata
    console.log('4. Edit delivery (phone)');
    const editOpened = await clickButtonByText(
      page,
      /edit delivery|editar entrega|lieferung bearbeiten|modifier la livraison|editar l.?entrega/i,
    );
    if (!editOpened) {
      hardFails.push('Edit delivery button not found on created order');
    } else {
      await page.waitForSelector('#edit-delivery-phone', { timeout: 10000 });
      await setInputValue(page, '#edit-delivery-phone', phoneEdited);

      const patchPromise = page.waitForResponse(
        (res) =>
          /\/orders\/\d+\/delivery/.test(res.url()) &&
          ['PATCH', 'PUT', 'POST'].includes(res.request().method()),
        { timeout: 20000 },
      );
      // Also accept generic order update paths
      const saveClicked = await page.evaluate(() => {
        const actions = document.querySelector('.modal-actions');
        const btn = actions?.querySelector('button.btn-primary');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      if (!saveClicked) {
        hardFails.push('Edit delivery Save button missing or disabled');
      } else {
        const patchRes = await patchPromise.catch(() => null);
        if (!patchRes) {
          // Fallback: any successful delivery-related save + phone in DOM
          await sleep(1200);
          const phoneVisible = await page.evaluate(
            (p) => (document.body?.innerText || '').includes(p),
            phoneEdited,
          );
          if (!phoneVisible) {
            hardFails.push('Edit delivery save response missing and phone not updated in UI');
          } else {
            console.log('   Edit OK (phone visible; no discrete PATCH observed)');
          }
        } else if (patchRes.status() >= 400) {
          const body = await patchRes.json().catch(() => ({}));
          hardFails.push(
            `Edit delivery failed: HTTP ${patchRes.status()} ${JSON.stringify(body)}`,
          );
        } else {
          console.log('   Edit OK:', patchRes.status());
          await sleep(600);
          const phoneVisible = await page.evaluate(
            (p) => (document.body?.innerText || '').includes(p),
            phoneEdited,
          );
          if (!phoneVisible) {
            hardFails.push('Edited phone not visible on Delivery tab after save');
          } else {
            console.log('   Updated phone visible on list');
          }
        }
      }
    }

    if (pageErrors.length) {
      hardFails.push(`Page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    }

    await browser.close();

    console.log('\n---');
    if (hardFails.length) {
      for (const f of hardFails) console.error('FAIL:', f);
      console.log('\n>>> RESULT: Staff Scanaki Delivery smoke FAILED');
      process.exit(1);
    }
    console.log('>>> RESULT: Staff Scanaki Delivery smoke OK (create + edit)');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();
