import assert from 'node:assert/strict';

/** Login through the UI and verify the server session, with bounded stage errors. */
export async function loginStaff(page, { baseUrl, email, password, tenantId }) {
  const origin = new URL(baseUrl).origin;
  let stage = 'load-form';
  try {
    const response = await page.goto(`${origin}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
    assert(response?.ok(), 'Login page HTTP failure');
    assert.equal(new URL(page.url()).origin, origin, 'Unexpected login origin');
    await page.waitForSelector('form.ng-pristine #email', { visible: true, timeout: 15000 });
    await page.waitForSelector('#password', { visible: true, timeout: 15000 });
    stage = 'fill-form';
    await page.type('#email', email);
    await page.type('#password', password);
    await page.waitForFunction(() => {
      const form = document.querySelector('#email')?.closest('form');
      const button = form?.querySelector('button[type="submit"]');
      return form?.classList.contains('ng-valid') && button && !button.disabled;
    }, { timeout: 10000 });
    stage = 'submit-response';
    const [loginResponse] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).origin === origin &&
        new URL(r.url()).pathname === '/api/token' && r.request().method() === 'POST',
      { timeout: 15000 }),
      page.click('form.ng-valid button[type="submit"]'),
    ]);
    assert.equal(loginResponse.status(), 200, `Login rejected: HTTP ${loginResponse.status()}`);
    stage = 'authenticated-route';
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 });
    assert.equal(new URL(page.url()).origin, origin, 'Unexpected authenticated origin');
    stage = 'server-session';
    const session = await page.evaluate(async () => {
      const r = await fetch('/api/users/me', { credentials: 'include', redirect: 'error',
        signal: AbortSignal.timeout(10000) });
      const body = await r.json();
      return { status: r.status, tenantId: body?.tenant_id, email: body?.email };
    });
    assert.equal(session.status, 200, 'Session request failed');
    assert.equal(session.tenantId, tenantId, 'Authenticated tenant mismatch');
    assert.equal(session.email, email, 'Authenticated user mismatch');
  } catch (error) {
    // Never include credentials, response bodies, cookies or page URLs in errors.
    const rejected = error.message?.match(/^Login rejected: HTTP \d{3}/)?.[0];
    throw new Error(`Staff login failed at ${stage}: ${rejected || error.name}`);
  }
}
