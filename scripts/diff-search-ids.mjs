#!/usr/bin/env node
/**
 * Compare search result product IDs between two API bases (recall audit).
 *
 * Usage:
 *   node scripts/diff-search-ids.mjs --query "قبضة"
 *   node scripts/diff-search-ids.mjs --query "laptop lenovo 5050 i7" --a https://api.ordonsooq.com/api --b http://localhost:3000/api
 *   node scripts/diff-search-ids.mjs --query "قبضة" --save-baseline scripts/search-baseline-qabda.json
 *   node scripts/diff-search-ids.mjs --query "قبضة" --baseline scripts/search-baseline-qabda.json
 */
const DEFAULT_A = process.env.SEARCH_DIFF_API_A || 'https://api.ordonsooq.com/api';
const DEFAULT_B = process.env.SEARCH_DIFF_API_B || 'http://localhost:3000/api';

function parseArgs(argv) {
  const args = {
    query: '',
    a: DEFAULT_A,
    b: DEFAULT_B,
    perPage: 50,
    locale: '',
    baseline: '',
    saveBaseline: '',
    maxPages: 50,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--query' && next) {
      args.query = next;
      index += 1;
    } else if (token === '--a' && next) {
      args.a = next.replace(/\/$/, '');
      index += 1;
    } else if (token === '--b' && next) {
      args.b = next.replace(/\/$/, '');
      index += 1;
    } else if (token === '--per-page' && next) {
      args.perPage = Math.max(1, Number(next) || 50);
      index += 1;
    } else if (token === '--locale' && next) {
      args.locale = next;
      index += 1;
    } else if (token === '--baseline' && next) {
      args.baseline = next;
      index += 1;
    } else if (token === '--save-baseline' && next) {
      args.saveBaseline = next;
      index += 1;
    } else if (token === '--max-pages' && next) {
      args.maxPages = Math.max(1, Number(next) || 50);
      index += 1;
    }
  }

  return args;
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload && 'success' in payload) {
    return payload.data;
  }
  return payload;
}

async function getJson(url) {
  const start = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ms: Date.now() - start, body };
}

async function fetchAllSearchIds(apiBase, query, options) {
  const ids = [];
  let page = 1;
  let total = Infinity;
  let totalMs = 0;
  let expansionVersion;

  while (page <= options.maxPages && ids.length < total) {
    const params = new URLSearchParams({
      q: query,
      page: String(page),
      per_page: String(options.perPage),
    });
    if (options.locale) {
      params.set('locale', options.locale);
    }

    const url = `${apiBase}/search?${params.toString()}`;
    const result = await getJson(url);
    totalMs += result.ms;

    if (result.status !== 200) {
      throw new Error(`${apiBase} page ${page} HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
    }

    const data = unwrap(result.body);
    const batch = (data?.data ?? [])
      .map((item) => Number(item?.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    total = Number(data?.meta?.total ?? batch.length);
    if (batch.length === 0) {
      break;
    }

    batch.forEach((id) => {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    });

    page += 1;
  }

  return {
    ids,
    total,
    pagesFetched: page - 1,
    totalMs,
    expansionVersion,
  };
}

function diffSets(leftIds, rightIds) {
  const left = new Set(leftIds);
  const right = new Set(rightIds);
  const onlyLeft = [...left].filter((id) => !right.has(id)).sort((a, b) => a - b);
  const onlyRight = [...right].filter((id) => !left.has(id)).sort((a, b) => a - b);
  const shared = [...left].filter((id) => right.has(id)).length;
  return { onlyLeft, onlyRight, shared };
}

function printSection(title, payload) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error(
      'Usage: node scripts/diff-search-ids.mjs --query "قبضة" [--a API] [--b API] [--baseline file.json] [--save-baseline file.json]',
    );
    process.exit(1);
  }

  console.log(`Query: "${args.query}"`);
  console.log(`per_page=${args.perPage}`);

  if (args.saveBaseline) {
    console.log(`Fetching baseline from A: ${args.a}`);
    const baseline = await fetchAllSearchIds(args.a, args.query, args);
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      args.saveBaseline,
      JSON.stringify(
        {
          query: args.query,
          api: args.a,
          captured_at: new Date().toISOString(),
          ...baseline,
        },
        null,
        2,
      ),
      'utf8',
    );
    printSection('Saved baseline', {
      file: args.saveBaseline,
      unique_ids: baseline.ids.length,
      meta_total: baseline.total,
      pages_fetched: baseline.pagesFetched,
      ms: baseline.totalMs,
    });
    return;
  }

  if (args.baseline) {
    const fs = await import('node:fs/promises');
    const raw = JSON.parse(await fs.readFile(args.baseline, 'utf8'));
    const left = {
      ids: raw.ids ?? [],
      total: raw.total ?? raw.ids?.length ?? 0,
      pagesFetched: raw.pagesFetched ?? 0,
      totalMs: 0,
      label: `baseline:${args.baseline}`,
    };
    console.log(`Fetching current from A: ${args.a}`);
    const right = await fetchAllSearchIds(args.a, args.query, args);
    right.label = args.a;

    const diff = diffSets(left.ids, right.ids);
    printSection('Counts', {
      baseline_unique: left.ids.length,
      baseline_meta_total: left.total,
      current_unique: right.ids.length,
      current_meta_total: right.total,
      shared: diff.shared,
      only_in_baseline: diff.onlyLeft.length,
      only_in_current: diff.onlyRight.length,
      current_ms: right.totalMs,
      current_pages: right.pagesFetched,
    });
    if (diff.onlyLeft.length > 0) {
      printSection('Only in baseline (regressions)', diff.onlyLeft.slice(0, 50));
    }
    if (diff.onlyRight.length > 0) {
      printSection('Only in current (new)', diff.onlyRight.slice(0, 50));
    }
    return;
  }

  console.log(`A: ${args.a}`);
  console.log(`B: ${args.b}`);
  const [left, right] = await Promise.all([
    fetchAllSearchIds(args.a, args.query, args),
    fetchAllSearchIds(args.b, args.query, args),
  ]);
  left.label = args.a;
  right.label = args.b;

  const diff = diffSets(left.ids, right.ids);
  printSection('Counts', {
    a_unique: left.ids.length,
    a_meta_total: left.total,
    a_ms: left.totalMs,
    a_pages: left.pagesFetched,
    b_unique: right.ids.length,
    b_meta_total: right.total,
    b_ms: right.totalMs,
    b_pages: right.pagesFetched,
    shared: diff.shared,
    only_in_a: diff.onlyLeft.length,
    only_in_b: diff.onlyRight.length,
  });
  if (diff.onlyLeft.length > 0) {
    printSection(`Only in A (${args.a})`, diff.onlyLeft.slice(0, 50));
  }
  if (diff.onlyRight.length > 0) {
    printSection(`Only in B (${args.b})`, diff.onlyRight.slice(0, 50));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
