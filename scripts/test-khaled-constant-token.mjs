/**
 * Test Khaled constant_token_admin login and permanent token behavior.
 * Usage: node scripts/test-khaled-constant-token.mjs
 */

const API = (process.env.API_ORIGIN || 'https://api.ordonsooq.com').replace(/\/$/, '');
const API_BASE = `${API}/api`;
const EMAIL = process.env.CONSTANT_TOKEN_ADMIN_EMAIL || 'khaled@ordonsooq.com';
const PASSWORD = process.env.CONSTANT_TOKEN_ADMIN_PASSWORD || 'Khaled@Password';
const PRODUCT_ID = Number(process.env.TEST_PRODUCT_ID || 4900);

function decodeToken(token) {
  return JSON.parse(
    Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
  );
}

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Login failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function patch(token, payload) {
  const res = await fetch(`${API_BASE}/products/${PRODUCT_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function logout(token) {
  const res = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log('Testing Khaled constant token admin');
  console.log({ API_BASE, EMAIL, PRODUCT_ID });

  const firstLogin = await login();
  const secondLogin = await login();

  const firstPayload = decodeToken(firstLogin.access_token);
  const secondPayload = decodeToken(secondLogin.access_token);

  console.log('\nLogin #1');
  console.log({
    role: firstLogin.user.role,
    tokenType: firstPayload.type,
    jti: firstPayload.jti,
    exp: firstPayload.exp ?? null,
    expires_in: firstLogin.expires_in,
  });

  console.log('\nLogin #2');
  console.log({
    role: secondLogin.user.role,
    tokenType: secondPayload.type,
    jti: secondPayload.jti,
    exp: secondPayload.exp ?? null,
    expires_in: secondLogin.expires_in,
  });

  console.log('\nSame token across logins?', firstLogin.access_token === secondLogin.access_token);

  const logoutResult = await logout(firstLogin.access_token);
  console.log('\nLogout status:', logoutResult.status);

  const afterLogoutPatch = await patch(firstLogin.access_token, {
    reference_slug: `khaled-constant-token-test-${Date.now()}`,
  });
  console.log('PATCH after logout:', afterLogoutPatch.status);

  await new Promise((resolve) => setTimeout(resolve, 6000));

  const delayedPatch = await patch(firstLogin.access_token, {
    original_price: 110,
    original_sale_price: 95,
  });
  const product = delayedPatch.body?.data?.product ?? delayedPatch.body?.data;
  console.log('PATCH after 6 seconds:', delayedPatch.status);
  console.log({
    original_vendor_price: product?.original_vendor_price,
    original_vendor_sale_price: product?.original_vendor_sale_price,
    price: product?.price,
    sale_price: product?.sale_price,
  });

  const relogin = await login();
  console.log('\nToken unchanged after logout + relogin?', relogin.access_token === firstLogin.access_token);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
