import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { loginStaff } from './staff-login.mjs';

const credentials = JSON.parse(readFileSync(0, 'utf8'));
const baseUrl = process.env.BASE_URL;
if (!baseUrl || !credentials.email || !credentials.password || !Number.isSafeInteger(credentials.tenantId)) {
  throw new Error('Explicit BASE_URL and stdin email/password/tenantId required');
}
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  // Separate contexts prove a fresh session rather than reusing a prior login.
  for (let run = 1; run <= 2; run++) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await loginStaff(page, { baseUrl, ...credentials });
      console.log(`PASS fresh staff login ${run}: server session and tenant verified`);
    } catch (error) {
      const evidenceDir = process.env.LOGIN_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.evaluate(() => {
          document.querySelectorAll('input').forEach(input => { input.value = ''; });
        }).catch(() => {});
        await page.screenshot({ path: join(evidenceDir, `staff-login-failure-${run}.png`) }).catch(() => {});
      }
      throw error;
    } finally { await context.close(); }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await browser.close(); }
