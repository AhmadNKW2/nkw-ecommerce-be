#!/usr/bin/env node
/**
 * Live production diagnostic: Typesense vs DB fallback
 */
const API = 'https://api.ordonsooq.com/api';
const TS_PUBLIC = 'https://typesense-production-e98f.up.railway.app';
const TS_KEY = process.env.TYPESENSE_API_KEY || '';

async function getJson(url, headers = {}) {
  const start = Date.now();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ms: Date.now() - start, body };
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload && 'success' in payload) {
    return payload.data;
  }
  return payload;
}

async function main() {
  console.log('=== Ordonsooq production search diagnostic ===\n');

  // 1. Typesense health via backend (internal network)
  const health = await getJson(`${API}/health/typesense`);
  console.log('1) Backend → Typesense health');
  console.log(`   HTTP ${health.status} (${health.ms}ms)`);
  console.log(`   ${JSON.stringify(unwrap(health.body))}\n`);

  // 2. Direct public Typesense (may 502 if port misconfigured)
  if (TS_KEY) {
    const tsHealth = await getJson(`${TS_PUBLIC}/health`, {
      'X-TYPESENSE-API-KEY': TS_KEY,
    });
    console.log('2) Direct public Typesense /health');
    console.log(`   HTTP ${tsHealth.status} (${tsHealth.ms}ms)`);
    console.log(`   ${JSON.stringify(tsHealth.body).slice(0, 200)}\n`);

    const tsCol = await getJson(`${TS_PUBLIC}/collections/products`, {
      'X-TYPESENSE-API-KEY': TS_KEY,
    });
    console.log('3) Direct public Typesense /collections/products');
    console.log(`   HTTP ${tsCol.status} (${tsCol.ms}ms)`);
    if (tsCol.body?.num_documents !== undefined) {
      console.log(`   num_documents=${tsCol.body.num_documents}`);
      console.log(`   created_at=${tsCol.body.created_at}`);
    } else {
      console.log(`   ${JSON.stringify(tsCol.body).slice(0, 300)}\n`);
    }
  } else {
    console.log('2-3) Skipped direct Typesense (set TYPESENSE_API_KEY env)\n');
  }

  // 4. Browse all — facets empty = DB fallback, facets present = Typesense
  const browse = await getJson(`${API}/search?q=*&per_page=2&page=1`);
  const browseData = unwrap(browse.body);
  console.log('4) Search browse (q=*)');
  console.log(`   HTTP ${browse.status} (${browse.ms}ms)`);
  console.log(`   total=${browseData?.meta?.total}`);
  console.log(`   facets=${browseData?.facets?.length ?? 0}`);
  console.log(`   search_time_ms=${browseData?.search_time_ms}`);
  const browseSource =
    (browseData?.facets?.length ?? 0) > 0 ? 'TYPESENSE (facets present)' : 'DB FALLBACK (no facets)';
  console.log(`   inferred_source=${browseSource}\n`);

  // 5. Text search relevance
  const mac = await getJson(`${API}/search?q=macbook&per_page=5`);
  const macData = unwrap(mac.body);
  console.log('5) Search "macbook"');
  console.log(`   HTTP ${mac.status} (${mac.ms}ms)`);
  console.log(`   total=${macData?.meta?.total}`);
  console.log(`   facets=${macData?.facets?.length ?? 0}`);
  const names = (macData?.data ?? []).map((p) => p.name_en?.slice(0, 55));
  names.forEach((n, i) => console.log(`   [${i + 1}] ${n}`));
  console.log('');

  // 6. Unique typo test — Typesense fuzzy vs DB ILIKE differ
  const typo = await getJson(`${API}/search?q=macbok&per_page=3`);
  const typoData = unwrap(typo.body);
  console.log('6) Typo search "macbok" (Typesense fuzzy vs DB exact)');
  console.log(`   total=${typoData?.meta?.total}, facets=${typoData?.facets?.length ?? 0}`);
  (typoData?.data ?? []).slice(0, 3).forEach((p, i) => {
    console.log(`   [${i + 1}] ${p.name_en?.slice(0, 55)}`);
  });
  console.log('');

  // 7. Product detail — always DB
  const slugRes = await getJson(`${API}/products?limit=1&page=1`);
  const slugPayload = unwrap(slugRes.body);
  const first = slugPayload?.data?.[0] ?? slugPayload?.[0];
  if (first?.slug) {
    const detail = await getJson(`${API}/products/slug/${first.slug}`);
    const detailData = unwrap(detail.body);
    console.log('7) Product detail by slug (always PostgreSQL)');
    console.log(`   slug=${first.slug}`);
    console.log(`   found=${Boolean(detailData?.id ?? detailData?.slug)}`);
  }

  console.log('\n=== Summary ===');
  console.log(
    browseSource.startsWith('TYPESENSE')
      ? 'Production search IS using Typesense (index has data).'
      : 'Production search is falling back to PostgreSQL.',
  );
  if ((browseData?.meta?.total ?? 0) > 0 && browseSource.startsWith('DB')) {
    console.log('Site shows products because DB fallback + Postgres still has all products.');
  }
  if ((browseData?.meta?.total ?? 0) > 0 && browseSource.startsWith('TYPESENSE')) {
    console.log(`Typesense index contains ~${browseData.meta.total} searchable products.`);
    console.log('Wiping volume on wrong service/volume would NOT affect this — backend still hits populated index.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
