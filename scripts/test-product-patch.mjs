/**
 * Admin login + create test product + PATCH reference_slug / original prices.
 * Usage: node scripts/test-product-patch.mjs
 */

const API = process.env.API_ORIGIN || 'https://api.ordonsooq.com';
const API_BASE = `${API.replace(/\/$/, '')}/api`;
const EMAIL = process.env.ADMIN_EMAIL || 'ahmadnkw@outlook.com';
const PASSWORD = process.env.ADMIN_PASSWORD || 'Ahmad1998.';

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.data.access_token;
}

function pickProduct(body) {
  return body?.data?.product ?? body?.data ?? body?.product ?? body;
}

async function req(method, path, token, json) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('API:', API_BASE);
  console.log('EMAIL:', EMAIL);

  const token = await login();
  console.log('TOKEN:', `${token.slice(0, 24)}...`);

  const cats = await req('GET', '/categories?limit=1&status=active', token);
  const categoryId =
    cats.body?.data?.items?.[0]?.id ??
    cats.body?.data?.[0]?.id ??
    cats.body?.items?.[0]?.id;

  console.log('CATEGORY:', categoryId, `(status ${cats.status})`);

  const stamp = Date.now();
  const productPayload = {
    name_en: `API Test Product ${stamp}`,
    name_ar: 'منتج اختبار',
    short_description_en: 'Test product for patch API',
    short_description_ar: 'منتج اختبار',
    long_description_en: '<p>Test</p>',
    long_description_ar: '<p>اختبار</p>',
    category_ids: categoryId ? [categoryId] : [1],
    sku: `TEST-SKU-${stamp}`,
    price: 50,
    quantity: 10,
    status: 'active',
    visible: false,
  };

  const created = await req('POST', '/products', token, productPayload);
  console.log('\nCREATE PRODUCT:', created.status);
  console.log(JSON.stringify(created.body, null, 2).slice(0, 800));

  const productId = pickProduct(created.body)?.id;
  if (!productId) {
    throw new Error('Create product did not return an id');
  }
  console.log('PRODUCT_ID:', productId);

  console.log('\n--- Reproduce screenshot issues ---');

  const brokenPath = '/products/{request.data["id"]}';
  const broken = await req('PATCH', brokenPath, token, { is_out_of_stock: false });
  console.log('Broken URL (literal braces, like missing Python f-string):', broken.status, brokenPath);
  console.log(JSON.stringify(broken.body).slice(0, 300));

  const noAuthRes = await fetch(`${API_BASE}/products/${productId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_price: 60 }),
  });
  const noAuthBody = await noAuthRes.json().catch(() => ({}));
  console.log('No Authorization header:', noAuthRes.status, JSON.stringify(noAuthBody).slice(0, 300));

  console.log('\n--- Valid PATCH tests ---');

  const patchSlug = await req('PATCH', `/products/${productId}`, token, {
    reference_slug: `test-reference-slug-${productId}`,
  });
  console.log('PATCH reference_slug:', patchSlug.status);
  console.log('reference_slug:', pickProduct(patchSlug.body)?.reference_slug);

  const patchOriginal = await req('PATCH', `/products/${productId}`, token, {
    original_price: 100,
  });
  console.log('PATCH original_price:', patchOriginal.status);
  console.log({
    original_vendor_price: pickProduct(patchOriginal.body)?.original_vendor_price,
    price: pickProduct(patchOriginal.body)?.price,
  });

  const patchSale = await req('PATCH', `/products/${productId}`, token, {
    original_price: 100,
    original_sale_price: 85,
  });
  console.log('PATCH original_sale_price:', patchSale.status);
  console.log({
    original_vendor_price: pickProduct(patchSale.body)?.original_vendor_price,
    original_vendor_sale_price: pickProduct(patchSale.body)?.original_vendor_sale_price,
    price: pickProduct(patchSale.body)?.price,
    sale_price: pickProduct(patchSale.body)?.sale_price,
  });

  const get = await req('GET', `/products/${productId}?is_admin=true`, token);
  const product = pickProduct(get.body);
  console.log('\nFINAL PRODUCT STATE:', get.status);
  console.log(
    JSON.stringify(
      {
        id: product?.id,
        sku: product?.sku,
        reference_slug: product?.reference_slug,
        original_vendor_price: product?.original_vendor_price,
        original_vendor_sale_price: product?.original_vendor_sale_price,
        price: product?.price,
        sale_price: product?.sale_price,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
