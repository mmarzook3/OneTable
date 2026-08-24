const SCANAKI_HOSTS = new Set(['scanaki.uk', 'www.scanaki.uk']);
const TABLE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PLAQUE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Converts a scanned Scanaki table or smart-plaque URL into a safe internal route.
 * Absolute URLs must use the Scanaki domain. Relative routes are accepted only so
 * local development and same-origin QR proofs can be tested without production DNS.
 */
export function extractScanakiGuestRoute(raw: string, currentOrigin: string): string | null {
  const value = raw.replace(/\0/g, '').trim();
  if (!value) return null;

  const isAbsolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  let url: URL;
  try {
    url = new URL(value, currentOrigin);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let currentUrl: URL;
  try {
    currentUrl = new URL(currentOrigin);
  } catch {
    return null;
  }
  const scanakiHost = SCANAKI_HOSTS.has(url.hostname.toLowerCase());
  const sameOriginRelativeRoute = !isAbsolute && url.origin === currentUrl.origin;
  if (!scanakiHost && !sameOriginRelativeRoute) return null;

  let segments: string[];
  try {
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments.length !== 2) return null;

  const [kind, identifier] = segments;
  if (kind.toLowerCase() === 'p' && PLAQUE_CODE_RE.test(identifier)) {
    return `/p/${encodeURIComponent(identifier)}`;
  }
  if (kind.toLowerCase() === 'menu' && TABLE_TOKEN_RE.test(identifier)) {
    return `/menu/${encodeURIComponent(identifier)}`;
  }
  return null;
}
