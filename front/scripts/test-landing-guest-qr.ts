import { extractScanakiGuestRoute } from '../src/app/landing/guest-qr-route';

function expectRoute(raw: string, expected: string | null): void {
  const actual = extractScanakiGuestRoute(raw, 'http://127.0.0.1:4202');
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)} for ${JSON.stringify(raw)}, got ${JSON.stringify(actual)}`);
  }
}

const tableToken = 'b32a6b57-8124-4ea7-8f12-98da6f2c5ee1';
const plaqueCode = 'plaque_code-1234567890';

expectRoute(`https://scanaki.uk/menu/${tableToken}`, `/menu/${tableToken}`);
expectRoute(`https://www.scanaki.uk/p/${plaqueCode}`, `/p/${plaqueCode}`);
expectRoute(`/menu/${tableToken}`, `/menu/${tableToken}`);
expectRoute(`https://scanaki.uk/p/${plaqueCode}?utm_source=plaque`, `/p/${plaqueCode}`);

expectRoute('Table 12', null);
expectRoute(`https://malicious.invalid/menu/${tableToken}`, null);
expectRoute(`https://scanaki.uk.evil.invalid/p/${plaqueCode}`, null);
expectRoute(`//malicious.invalid/menu/${tableToken}`, null);
expectRoute(`https://scanaki.uk@malicious.invalid/menu/${tableToken}`, null);
expectRoute('javascript:alert(1)', null);
expectRoute('https://scanaki.uk/login', null);
expectRoute('https://scanaki.uk/public-menu/2', null);
expectRoute('https://scanaki.uk/p/short', null);
expectRoute(`https://scanaki.uk/menu/${tableToken}/payment-success`, null);

console.log('LANDING_GUEST_QR_ROUTE_TEST_OK');
