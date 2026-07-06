/**
 * End-to-end admin auth debugger.
 * Usage:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/debug-admin-auth.mjs
 */

const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || 'https://addmin.ordonsooq.com';
const API_ORIGIN = process.env.API_ORIGIN || 'https://api.ordonsooq.com';
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

function parseSetCookies(headers) {
  const getSetCookie = headers.getSetCookie?.bind(headers);
  if (typeof getSetCookie === 'function') {
    return getSetCookie();
  }
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

function summarizeCookies(setCookies) {
  return setCookies.map((c) => {
    const name = c.split('=')[0];
    const path = /Path=([^;]+)/i.exec(c)?.[1] ?? '?';
    const maxAge = /Max-Age=(\d+)/i.exec(c)?.[1] ?? '?';
    const httpOnly = /HttpOnly/i.test(c);
    const secure = /Secure/i.test(c);
    const sameSite = /SameSite=([^;]+)/i.exec(c)?.[1] ?? '?';
    return { name, path, maxAge, httpOnly, secure, sameSite };
  });
}

function cookieHeaderFromSetCookies(setCookies) {
  return setCookies
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function login(origin, label) {
  const url = `${origin}/api/auth/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = parseSetCookies(res.headers);
  return {
    label,
    url,
    status: res.status,
    ok: res.ok,
    body,
    setCookies,
    cookieSummary: summarizeCookies(setCookies),
    cookieHeader: cookieHeaderFromSetCookies(setCookies),
  };
}

async function refresh(origin, cookieHeader, label) {
  const url = `${origin}/api/auth/refresh`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = parseSetCookies(res.headers);
  return {
    label,
    url,
    status: res.status,
    ok: res.ok,
    body,
    setCookies,
    cookieSummary: summarizeCookies(setCookies),
    cookieHeader: cookieHeaderFromSetCookies(setCookies),
  };
}

async function profile(origin, cookieHeader, label) {
  const url = `${origin}/api/auth/profile`;
  const res = await fetch(url, {
    method: 'GET',
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  const body = await res.json().catch(() => ({}));
  return { label, url, status: res.status, ok: res.ok, body };
}

async function concurrentRefresh(origin, cookieHeader, count = 2) {
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      refresh(origin, cookieHeader, `concurrent-${i + 1}`),
    ),
  );
  return results;
}

function printSection(title, data) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD env vars.');
    process.exit(1);
  }

  console.log('Admin auth debugger');
  console.log({ ADMIN_ORIGIN, API_ORIGIN, EMAIL });

  const directLogin = await login(API_ORIGIN, 'direct-api-login');
  printSection('Direct API login', {
    status: directLogin.status,
    success: directLogin.body?.success,
    cookies: directLogin.cookieSummary,
    error: directLogin.body?.error,
  });

  const adminLogin = await login(ADMIN_ORIGIN, 'admin-proxy-login');
  printSection('Admin proxy login', {
    status: adminLogin.status,
    success: adminLogin.body?.success,
    cookies: adminLogin.cookieSummary,
    error: adminLogin.body?.error,
  });

  const cookiesToUse = adminLogin.cookieHeader || directLogin.cookieHeader;
  if (!cookiesToUse) {
    console.error('\nLogin failed — cannot continue refresh tests.');
    process.exit(1);
  }

  const hasRefresh = cookiesToUse.includes('refresh_token=');
  const hasAccess = cookiesToUse.includes('access_token=');
  printSection('Cookie jar after login', { hasAccess, hasRefresh });

  const adminRefresh1 = await refresh(ADMIN_ORIGIN, cookiesToUse, 'admin-refresh-1');
  printSection('Admin proxy refresh #1', {
    status: adminRefresh1.status,
    success: adminRefresh1.body?.success,
    error: adminRefresh1.body?.error,
    cookies: adminRefresh1.cookieSummary,
  });

  const cookiesAfterRefresh =
    adminRefresh1.cookieHeader || cookiesToUse;

  const adminRefresh2 = await refresh(ADMIN_ORIGIN, cookiesAfterRefresh, 'admin-refresh-2');
  printSection('Admin proxy refresh #2 (sequential)', {
    status: adminRefresh2.status,
    success: adminRefresh2.body?.success,
    error: adminRefresh2.body?.error,
    cookies: adminRefresh2.cookieSummary,
  });

  const race = await concurrentRefresh(ADMIN_ORIGIN, cookiesAfterRefresh, 2);
  printSection('Concurrent refresh race (simulates double refresh bug)', race.map((r) => ({
    label: r.label,
    status: r.status,
    success: r.body?.success,
    error: r.body?.error,
  })));

  const profileAfterRace = await profile(
    ADMIN_ORIGIN,
    adminRefresh2.cookieHeader || cookiesAfterRefresh,
    'profile-after-race',
  );
  printSection('Profile after race', {
    status: profileAfterRace.status,
    success: profileAfterRace.body?.success,
    error: profileAfterRace.body?.error,
  });

  const refreshOnlyCookie = cookiesAfterRefresh
    .split('; ')
    .filter((p) => p.startsWith('refresh_token='))
    .join('; ');
  const refreshWithRefreshOnly = await refresh(
    ADMIN_ORIGIN,
    refreshOnlyCookie,
    'refresh-with-refresh-cookie-only',
  );
  printSection('Refresh using refresh_token cookie only', {
    status: refreshWithRefreshOnly.status,
    success: refreshWithRefreshOnly.body?.success,
    error: refreshWithRefreshOnly.body?.error,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
