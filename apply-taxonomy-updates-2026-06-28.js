const { Client } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('dotenv').config();

const DEFAULT_VENDOR_SLUG = 'city-center';
const CATEGORY_FILE = path.join(
  __dirname,
  'data',
  'new-categories-2026-06-28-taxonomy.json',
);

const INTERNAL_CATEGORY_IDS = {
  memoryCards: 61,
  laptopBatteries: 143,
  laptopChargers: 144,
};

const CATEGORY_TARGETS = {
  'Docking Stations & USB Hubs': { parentId: 6 },
  'Keyboard & Mouse Combos': { parentId: 6 },
  'Graphics & Drawing Tablets': { parentId: 6 },
  'Optical Drives': { parentId: 42 },
  'PCIe Expansion Cards': { parentId: 42 },
  'Smartwatches & Wearables': { parentId: 150 },
  'Printer Paper & Media': { parentId: 32 },
  'UPS Replacement Batteries': { parentId: 133 },
  'Streaming & Content Creation': { parentId: 109 },
};

const VENDOR_CATEGORY_MAPPINGS = {
  324: 'Keyboard & Mouse Combos',
  374: 'Keyboard & Mouse Combos',
  178: INTERNAL_CATEGORY_IDS.memoryCards,
  418: INTERNAL_CATEGORY_IDS.memoryCards,
  64: 'Docking Stations & USB Hubs',
  63: 'Docking Stations & USB Hubs',
  335: 'Graphics & Drawing Tablets',
  385: 'Graphics & Drawing Tablets',
  153: 'Optical Drives',
  173: 'Optical Drives',
  278: 'Optical Drives',
  413: 'Optical Drives',
  159: 'PCIe Expansion Cards',
  388: 'Smartwatches & Wearables',
  309: 'Printer Paper & Media',
  440: 'Printer Paper & Media',
  312: 'UPS Replacement Batteries',
  370: 'UPS Replacement Batteries',
  297: 'Streaming & Content Creation',
  360: 'Streaming & Content Creation',
  65: INTERNAL_CATEGORY_IDS.laptopChargers,
};

const BATTERY_VENDOR_CATEGORY_ID = 65;

function printUsage() {
  console.log(`Usage: node apply-taxonomy-updates-2026-06-28.js [options]

Options:
  --dry-run                Preview changes without updating the database
  --skip-categories        Skip Phase 1 category creation
  --vendor-slug <slug>     Vendor slug (default: ${DEFAULT_VENDOR_SLUG})
  --help, -h               Show this help message

Examples:
  node apply-taxonomy-updates-2026-06-28.js --dry-run
  pnpm exec node apply-taxonomy-updates-2026-06-28.js`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipCategories: false,
    vendorSlug: DEFAULT_VENDOR_SLUG,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--skip-categories') {
      options.skipCategories = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--vendor-slug') {
      options.vendorSlug = (argv[index + 1] || '').trim() || DEFAULT_VENDOR_SLUG;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveSslConfig() {
  const rawValue = process.env.DB_SSL?.trim().toLowerCase();

  if (rawValue && ['false', '0', 'off', 'no'].includes(rawValue)) {
    return false;
  }

  return { rejectUnauthorized: false };
}

function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: resolveSslConfig(),
  });
}

function normalizeSearchText(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

function resolveBatteryChargerCategoryId(product, defaultCategoryId) {
  const text = normalizeSearchText(
    product.name_en,
    product.name_ar,
    product.short_description_en,
    product.short_description_ar,
    product.long_description_en,
    product.long_description_ar,
    product.original_vendor_category_name,
  );

  if (['battery', 'cell', 'replacement battery'].some((keyword) => text.includes(keyword))) {
    return INTERNAL_CATEGORY_IDS.laptopBatteries;
  }

  if (
    ['charger', 'adapter', 'power supply', 'ac adapter'].some((keyword) =>
      text.includes(keyword),
    )
  ) {
    return INTERNAL_CATEGORY_IDS.laptopChargers;
  }

  return defaultCategoryId;
}

async function resolveVendor(client, vendorSlug) {
  const result = await client.query(
    `
      SELECT id, slug, name_en
      FROM vendors
      WHERE lower(coalesce(slug, '')) = lower($1)
         OR lower(coalesce(name_en, '')) = lower($1)
      ORDER BY id ASC
      LIMIT 2
    `,
    [vendorSlug],
  );

  if (result.rows.length !== 1) {
    throw new Error(
      `Expected exactly one vendor for slug "${vendorSlug}", found ${result.rows.length}`,
    );
  }

  return result.rows[0];
}

async function loadCategoryIndex(client) {
  const result = await client.query(
    `SELECT id, name_en, parent_id, level FROM categories ORDER BY id ASC`,
  );

  const byNameAndParent = new Map();

  for (const row of result.rows) {
    const key = `${String(row.name_en).trim().toLowerCase()}::${row.parent_id ?? 'root'}`;
    byNameAndParent.set(key, row);
  }

  return { rows: result.rows, byNameAndParent };
}

function resolveCategoryId(categoryIndex, target, options = {}) {
  if (typeof target === 'number') {
    return target;
  }

  const config = CATEGORY_TARGETS[target];
  if (!config) {
    throw new Error(`Unknown category target "${target}"`);
  }

  const key = `${String(target).trim().toLowerCase()}::${config.parentId}`;
  const match = categoryIndex.byNameAndParent.get(key);

  if (!match) {
    if (options.allowMissing) {
      return null;
    }

    throw new Error(
      `Category "${target}" under parent id ${config.parentId} was not found. Run Phase 1 first.`,
    );
  }

  return match.id;
}

async function ensureCategories(options) {
  if (options.skipCategories) {
    console.log('Skipping Phase 1 category creation.');
    return { created: false };
  }

  const importArgs = [
    path.join(__dirname, 'import-categories.js'),
    '--file',
    CATEGORY_FILE,
  ];

  if (options.dryRun) {
    importArgs.push('--dry-run');
  }

  const result = spawnSync(process.execPath, importArgs, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error('Phase 1 category creation failed');
  }

  return { created: !options.dryRun };
}

async function setVendorCategoryMapping(client, vendorCategoryId, categoryIds) {
  await client.query(
    'DELETE FROM vendor_category_categories WHERE vendor_category_id = $1',
    [vendorCategoryId],
  );

  for (const categoryId of categoryIds) {
    await client.query(
      `
        INSERT INTO vendor_category_categories (vendor_category_id, category_id)
        VALUES ($1, $2)
      `,
      [vendorCategoryId, categoryId],
    );
  }
}

async function loadProductsForVendorCategory(client, vendorId, vendorCategoryId) {
  const result = await client.query(
    `
      SELECT
        p.id,
        p.name_en,
        p.name_ar,
        p.short_description_en,
        p.short_description_ar,
        p.long_description_en,
        p.long_description_ar,
        p.original_vendor_category_id,
        p.original_vendor_category_name,
        p.category_id
      FROM products p
      WHERE p.vendor_id = $1
        AND (
          p.original_vendor_category_id = $2
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(p.original_vendor_categories, '[]'::jsonb)) elem
            WHERE (elem->>'id') ~ '^[0-9]+$'
              AND CAST(elem->>'id' AS int) = $2
          )
        )
      ORDER BY p.id ASC
    `,
    [vendorId, vendorCategoryId],
  );

  return result.rows;
}

async function migrateProductToCategory(client, productId, categoryId) {
  await client.query('UPDATE products SET category_id = $2 WHERE id = $1', [
    productId,
    categoryId,
  ]);

  await client.query('DELETE FROM product_categories WHERE product_id = $1', [
    productId,
  ]);

  await client.query(
    `
      INSERT INTO product_categories (product_id, category_id)
      VALUES ($1, $2)
    `,
    [productId, categoryId],
  );
}

async function applyVendorMappings(client, vendorId, categoryIndex, dryRun) {
  const updates = [];

  for (const [vendorCategoryIdRaw, target] of Object.entries(
    VENDOR_CATEGORY_MAPPINGS,
  )) {
    const vendorCategoryId = Number(vendorCategoryIdRaw);
    const categoryId = resolveCategoryId(categoryIndex, target, {
      allowMissing: dryRun,
    });

    const current = await client.query(
      `
        SELECT category_id
        FROM vendor_category_categories
        WHERE vendor_category_id = $1
        ORDER BY category_id ASC
      `,
      [vendorCategoryId],
    );

    const currentIds = current.rows.map((row) => Number(row.category_id));
    const nextIds = categoryId == null ? [target] : [categoryId];
    const changed =
      categoryId != null &&
      (currentIds.length !== nextIds.length ||
        currentIds.some((value, index) => value !== nextIds[index]));

    const vendorCategory = await client.query(
      'SELECT title FROM vendor_categories WHERE id = $1 AND vendor_id = $2',
      [vendorCategoryId, vendorId],
    );

    updates.push({
      vendorCategoryId,
      title: vendorCategory.rows[0]?.title ?? '(missing)',
      from: currentIds,
      to: nextIds,
      changed,
      pendingCategoryCreation: categoryId == null,
    });
  }

  console.log('\nPhase 2 vendor category mappings:');
  console.log(JSON.stringify(updates, null, 2));

  if (dryRun) {
    return { changedCount: updates.filter((item) => item.changed).length };
  }

  for (const update of updates) {
    if (!update.changed || update.pendingCategoryCreation) {
      continue;
    }

    await setVendorCategoryMapping(client, update.vendorCategoryId, update.to);
  }

  return { changedCount: updates.filter((item) => item.changed).length };
}

async function migrateProducts(client, vendorId, categoryIndex, dryRun) {
  const migrations = [];
  const affectedProductIds = new Set();

  for (const [vendorCategoryIdRaw, target] of Object.entries(
    VENDOR_CATEGORY_MAPPINGS,
  )) {
    const vendorCategoryId = Number(vendorCategoryIdRaw);
    const defaultCategoryId = resolveCategoryId(categoryIndex, target, {
      allowMissing: dryRun,
    });
    if (defaultCategoryId == null) {
      continue;
    }
    const products = await loadProductsForVendorCategory(
      client,
      vendorId,
      vendorCategoryId,
    );

    for (const product of products) {
      const targetCategoryId =
        vendorCategoryId === BATTERY_VENDOR_CATEGORY_ID
          ? resolveBatteryChargerCategoryId(product, defaultCategoryId)
          : defaultCategoryId;

      if (product.category_id === targetCategoryId) {
        continue;
      }

      migrations.push({
        productId: product.id,
        name_en: product.name_en,
        vendorCategoryId,
        fromCategoryId: product.category_id,
        toCategoryId: targetCategoryId,
      });
      affectedProductIds.add(product.id);
    }
  }

  console.log('\nPhase 2 product migrations:');
  console.log(`Products to update: ${migrations.length}`);
  if (migrations.length > 0) {
    console.log(JSON.stringify(migrations.slice(0, 25), null, 2));
    if (migrations.length > 25) {
      console.log(`... and ${migrations.length - 25} more`);
    }
  }

  if (dryRun) {
    return {
      migratedCount: migrations.length,
      affectedProductIds: [...affectedProductIds],
    };
  }

  for (const migration of migrations) {
    await migrateProductToCategory(
      client,
      migration.productId,
      migration.toCategoryId,
    );
  }

  return {
    migratedCount: migrations.length,
    affectedProductIds: [...affectedProductIds],
  };
}

async function verifyCategories(client, categoryIndex, dryRun) {
  const resolved = {};

  for (const name of Object.keys(CATEGORY_TARGETS)) {
    const categoryId = resolveCategoryId(categoryIndex, name, {
      allowMissing: dryRun,
    });
    resolved[name] = categoryId ?? `pending (parent #${CATEGORY_TARGETS[name].parentId})`;
  }

  console.log('\nResolved new category IDs:');
  console.log(JSON.stringify(resolved, null, 2));

  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log(`Vendor slug: ${options.vendorSlug}`);

  await ensureCategories(options);

  const client = createClient();
  await client.connect();

  try {
    const vendor = await resolveVendor(client, options.vendorSlug);
    console.log(`Vendor: ${vendor.name_en} (id=${vendor.id})`);

    const categoryIndex = await loadCategoryIndex(client);
    const resolvedCategories = await verifyCategories(
      client,
      categoryIndex,
      options.dryRun,
    );

    if (!options.dryRun) {
      await client.query('BEGIN');
    }

    const mappingResult = await applyVendorMappings(
      client,
      Number(vendor.id),
      categoryIndex,
      options.dryRun,
    );

    const migrationResult = await migrateProducts(
      client,
      Number(vendor.id),
      categoryIndex,
      options.dryRun,
    );

    if (!options.dryRun) {
      await client.query('COMMIT');
    }

    console.log('\nSummary');
    console.log(`New categories verified: ${Object.keys(resolvedCategories).length}`);
    console.log(`Vendor mappings changed: ${mappingResult.changedCount}`);
    console.log(`Products migrated: ${migrationResult.migratedCount}`);

    if (migrationResult.affectedProductIds.length > 0) {
      console.log(
        'Run a product reindex after applying (POST /products/reindex) so Typesense reflects new category paths.',
      );
    }
  } catch (error) {
    if (!options.dryRun) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Taxonomy update failed:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
