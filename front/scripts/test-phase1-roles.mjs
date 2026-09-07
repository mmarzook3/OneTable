import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { loginStaff } from './staff-login.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(input.baseUrl, process.env.BASE_URL, 'Explicit target origin must match');
const browser = await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,
  headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
try {
  for (const user of input.users) {
    assert(['kitchen','bartender','waiter'].includes(user.role));
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await loginStaff(page, {baseUrl:input.baseUrl,...user});
      const results = await page.evaluate(async () => {
        const paths = ['/api/users/me','/api/products','/api/orders/kitchen-feed','/api/users','/api/reports/sales'];
        const results = [];
        for (const path of paths) {
          const r = await fetch(path, {credentials:'include',signal:AbortSignal.timeout(15000)});
          results.push({path,status:r.status,role:path.endsWith('/me')?(await r.json())?.role:undefined});
        }
        return results;
      });
      assert.equal(results[0].role,user.role,'Authenticated role mismatch');
      for (const [index,expected] of [[0,200],[1,200],[2,200],[3,403],[4,403]]) {
        assert.equal(results[index].status,expected,`${user.role}: ${results[index].path} expected ${expected}, got ${results[index].status}`);
      }
      for (const path of ['/users','/reports','/settings']) {
        await page.goto(input.baseUrl+path,{waitUntil:'networkidle2',timeout:30000});
        await page.waitForFunction(blocked=>location.pathname!==blocked,{timeout:10000},path);
        assert.equal(new URL(page.url()).origin,input.baseUrl);
      }
      console.log(`PASS ${user.role}: login, permitted reads, denied admin/report APIs and protected UI routes`);
    } finally { await context.close(); }
  }
} catch(error) {
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.name);
  process.exitCode=1;
} finally { await browser.close(); }
