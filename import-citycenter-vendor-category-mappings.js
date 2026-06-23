const { Client } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');

require('dotenv').config();

function printUsage() {
  console.log(`Usage: node import-citycenter-vendor-category-mappings.js --file <path> [options]

Options:
  --file <path>            JSON mapping file to import
  --vendor-id <id>         Vendor id to update
  --vendor-slug <slug>     Vendor slug to match (default: citycenter)
  --vendor-name <name>     Vendor english name to match
  --dry-run                Preview changes without updating the database
  --help, -h               Show this help message

Examples:
  node import-citycenter-vendor-category-mappings.js --file "C:\\mappings.json" --dry-run
  node import-citycenter-vendor-category-mappings.js --file "C:\\mappings.json" --vendor-slug citycenter
  pnpm exec node import-citycenter-vendor-category-mappings.js --file "C:\\mappings.json" --dry-run`);
}

function parseArgs(argv) {
  const options = {
    file: '',
    vendorId: null,
    vendorSlug: 'citycenter',
    vendorName: '',
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--file') {
      options.file = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--vendor-id') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--vendor-id must be a positive integer');
      }

      options.vendorId = value;
      index += 1;
      continue;
    }

    if (arg === '--vendor-slug') {
      options.vendorSlug = (argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (arg === '--vendor-name') {
      options.vendorName = (argv[index + 1] || '').trim();
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

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePathKey(segments) {
  return segments
    .map((segment) => normalizeText(segment))
    .filter(Boolean)
    .join(' > ');
}

function splitPath(value) {
  return String(value ?? '')
    .split('›')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function slugifySegment(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
}

async function readMappings(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('Mapping file must contain a JSON array');
  }

  return parsed;
}

async function resolveVendor(client, options) {
  if (options.vendorId) {
    const result = await client.query(
      `
        SELECT id, slug, name_en, name_ar
        FROM vendors
        WHERE id = $1
        LIMIT 1
      `,
      [options.vendorId],
    );

    if (result.rows.length === 0) {
      throw new Error(`Vendor ${options.vendorId} was not found`);
    }

    return result.rows[0];
  }

  if (options.vendorName) {
    const result = await client.query(
      `
        SELECT id, slug, name_en, name_ar
        FROM vendors
        WHERE lower(name_en) = lower($1)
        ORDER BY id ASC
        LIMIT 2
      `,
      [options.vendorName],
    );

    if (result.rows.length === 0) {
      throw new Error(`No vendor found with name "${options.vendorName}"`);
    }

    if (result.rows.length > 1) {
      throw new Error(
        `Multiple vendors matched name "${options.vendorName}". Pass --vendor-id instead.`,
      );
    }

    return result.rows[0];
  }

  const result = await client.query(
    `
      SELECT id, slug, name_en, name_ar
      FROM vendors
      WHERE lower(coalesce(slug, '')) = lower($1)
         OR lower(coalesce(name_en, '')) = lower($1)
      ORDER BY id ASC
      LIMIT 2
    `,
    [options.vendorSlug],
  );

  if (result.rows.length === 0) {
    const fallback = await client.query(
      `
        SELECT id, slug, name_en, name_ar
        FROM vendors
        WHERE lower(coalesce(name_en, '')) LIKE '%' || lower($1) || '%'
           OR lower(coalesce(slug, '')) LIKE '%' || lower($1) || '%'
        ORDER BY id ASC
        LIMIT 5
      `,
      [options.vendorSlug],
    );

    if (fallback.rows.length === 1) {
      return fallback.rows[0];
    }

    throw new Error(
      `Could not resolve vendor from "${options.vendorSlug}". Matching vendors: ${JSON.stringify(fallback.rows)}`,
    );
  }

  if (result.rows.length > 1) {
    throw new Error(
      `Multiple vendors matched "${options.vendorSlug}". Pass --vendor-id instead.`,
    );
  }

  return result.rows[0];
}

async function loadVendorCategoryRows(client, vendorId) {
  const result = await client.query(
    `
      SELECT
        vc.id,
        vc.title,
        vc.url AS reference_link,
        vc.parent_id,
        vc.sort_order,
        COALESCE(
          json_agg(vcc.category_id ORDER BY vcc.category_id)
            FILTER (WHERE vcc.category_id IS NOT NULL),
          '[]'::json
        ) AS category_ids
      FROM vendor_categories vc
      LEFT JOIN vendor_category_categories vcc
        ON vcc.vendor_category_id = vc.id
      WHERE vc.vendor_id = $1
      GROUP BY vc.id
      ORDER BY vc.sort_order ASC, vc.id ASC
    `,
    [vendorId],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    reference_link: row.reference_link,
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
    sort_order: Number(row.sort_order ?? 0),
    category_ids: Array.isArray(row.category_ids)
      ? row.category_ids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
      : [],
  }));
}

function buildVendorPathMap(rows) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const pathCache = new Map();

  function getPathSegments(row) {
    if (pathCache.has(row.id)) {
      return pathCache.get(row.id);
    }

    const parentSegments =
      row.parent_id != null && rowById.has(row.parent_id)
        ? getPathSegments(rowById.get(row.parent_id))
        : [];
    const segments = [...parentSegments, row.title.trim()];
    pathCache.set(row.id, segments);
    return segments;
  }

  const pathMap = new Map();

  for (const row of rows) {
    const segments = getPathSegments(row);
    const key = normalizePathKey(segments);

    if (!pathMap.has(key)) {
      pathMap.set(key, []);
    }

    pathMap.get(key).push({
      ...row,
      pathSegments: segments,
      path: segments.join(' › '),
    });
  }

  return pathMap;
}

function buildMappingIndex(records) {
  const rowsByPath = new Map();
  const skippedNewRecords = [];

  for (const record of records) {
    const categoryName = String(record.cityCenterCategory ?? '').trim();
    const parentSegments = splitPath(record.cityCenterPath);

    if (!categoryName) {
      continue;
    }

    const fullSegments = [...parentSegments];
    if (normalizeText(fullSegments[fullSegments.length - 1]) !== normalizeText(categoryName)) {
      fullSegments.push(categoryName);
    }

    const key = normalizePathKey(fullSegments);
    const actualCategoryId = Number(record.actualCategoryId);
    const validCategoryId =
      Number.isInteger(actualCategoryId) && actualCategoryId > 0
        ? actualCategoryId
        : null;

    if (!rowsByPath.has(key)) {
      rowsByPath.set(key, {
        path: fullSegments.join(' › '),
        pathSegments: fullSegments,
        cityCenterIds: new Set(),
        categoryIds: new Set(),
        statuses: new Set(),
        notes: new Set(),
        records: [],
      });
    }

    const bucket = rowsByPath.get(key);
    bucket.cityCenterIds.add(Number(record.cityCenterId));
    bucket.statuses.add(String(record.status ?? '').trim());
    if (record.note) {
      bucket.notes.add(String(record.note).trim());
    }
    if (validCategoryId != null) {
      bucket.categoryIds.add(validCategoryId);
    } else {
      skippedNewRecords.push({
        cityCenterId: record.cityCenterId,
        path: fullSegments.join(' › '),
        status: record.status,
        suggestedCategory: record.suggestedCategory,
      });
    }
    bucket.records.push(record);
  }

  return { rowsByPath, skippedNewRecords };
}

async function validateCategoryIds(client, categoryIds) {
  if (categoryIds.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      SELECT id
      FROM categories
      WHERE id = ANY($1::int[])
    `,
    [categoryIds],
  );

  const existingIds = new Set(result.rows.map((row) => Number(row.id)));
  return categoryIds.filter((categoryId) => !existingIds.has(categoryId));
}

function compareIdArrays(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function buildUpdatePlan(mappingIndex, vendorPathMap) {
  const updates = [];
  const missingVendorPaths = [];
  const duplicateVendorPaths = [];

  for (const [pathKey, mapping] of mappingIndex.rowsByPath.entries()) {
    const matches = vendorPathMap.get(pathKey) ?? [];
    const nextCategoryIds = [...mapping.categoryIds].sort((left, right) => left - right);

    if (matches.length === 0) {
      missingVendorPaths.push({
        path: mapping.path,
        category_ids: nextCategoryIds,
        cityCenterIds: [...mapping.cityCenterIds].sort((left, right) => left - right),
      });
      continue;
    }

    if (matches.length > 1) {
      duplicateVendorPaths.push({
        path: mapping.path,
        vendorCategoryIds: matches.map((row) => row.id),
      });
      continue;
    }

    const vendorCategory = matches[0];
    const currentCategoryIds = [...vendorCategory.category_ids].sort((left, right) => left - right);

    updates.push({
      vendorCategoryId: vendorCategory.id,
      path: vendorCategory.path,
      title: vendorCategory.title,
      currentCategoryIds,
      nextCategoryIds,
      changed: !compareIdArrays(currentCategoryIds, nextCategoryIds),
      statuses: [...mapping.statuses].filter(Boolean).sort(),
      notes: [...mapping.notes].filter(Boolean).sort(),
      cityCenterIds: [...mapping.cityCenterIds].sort((left, right) => left - right),
    });
  }

  return { updates, missingVendorPaths, duplicateVendorPaths };
}

async function applyUpdates(client, updates) {
  const changedUpdates = updates.filter((update) => update.changed);

  if (changedUpdates.length === 0) {
    return;
  }

  await client.query('BEGIN');

  try {
    for (const update of changedUpdates) {
      await client.query(
        'DELETE FROM vendor_category_categories WHERE vendor_category_id = $1',
        [update.vendorCategoryId],
      );

      if (update.nextCategoryIds.length > 0) {
        for (const categoryId of update.nextCategoryIds) {
          await client.query(
            `
              INSERT INTO vendor_category_categories (vendor_category_id, category_id)
              VALUES ($1, $2)
            `,
            [update.vendorCategoryId, categoryId],
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function printSummary(summary) {
  console.log('CityCenter vendor category mapping import');
  console.log('Vendor:', JSON.stringify(summary.vendor));
  console.log('Mapping rows:', summary.totalRecords);
  console.log('Unique mapping paths:', summary.uniquePaths);
  console.log('Vendor category nodes:', summary.vendorNodeCount);
  console.log('Matched paths:', summary.matchedPaths);
  console.log('Changed mappings:', summary.changedCount);
  console.log('Unchanged mappings:', summary.unchangedCount);
  console.log('Missing vendor paths:', summary.missingVendorPaths.length);
  console.log('Duplicate vendor path matches:', summary.duplicateVendorPaths.length);
  console.log('Skipped new/unmapped category rows:', summary.skippedNewRecords.length);

  if (summary.invalidCategoryIds.length > 0) {
    console.log('Invalid category ids:', summary.invalidCategoryIds.join(', '));
  }

  const preview = summary.updates
    .filter((update) => update.changed)
    .slice(0, 20)
    .map((update) => ({
      vendorCategoryId: update.vendorCategoryId,
      path: update.path,
      from: update.currentCategoryIds,
      to: update.nextCategoryIds,
      statuses: update.statuses,
      notes: update.notes,
    }));

  if (preview.length > 0) {
    console.log('Changed mapping preview:');
    console.log(JSON.stringify(preview, null, 2));
  }

  if (summary.missingVendorPaths.length > 0) {
    console.log('Missing vendor path preview:');
    console.log(JSON.stringify(summary.missingVendorPaths.slice(0, 20), null, 2));
  }

  if (summary.skippedNewRecords.length > 0) {
    console.log('Skipped new-category preview:');
    console.log(JSON.stringify(summary.skippedNewRecords.slice(0, 20), null, 2));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (!options.file) {
    throw new Error('--file is required');
  }

  const filePath = path.resolve(options.file);
  const mappings = await readMappings(filePath);
  const client = createClient();

  await client.connect();

  try {
    const vendor = await resolveVendor(client, options);
    const vendorRows = await loadVendorCategoryRows(client, Number(vendor.id));
    const vendorPathMap = buildVendorPathMap(vendorRows);
    const mappingIndex = buildMappingIndex(mappings);
    const { updates, missingVendorPaths, duplicateVendorPaths } = buildUpdatePlan(
      mappingIndex,
      vendorPathMap,
    );
    const allMappedCategoryIds = [
      ...new Set(
        updates.flatMap((update) => update.nextCategoryIds),
      ),
    ].sort((left, right) => left - right);
    const invalidCategoryIds = await validateCategoryIds(client, allMappedCategoryIds);

    if (invalidCategoryIds.length > 0) {
      throw new Error(
        `Some mapped category ids do not exist: ${invalidCategoryIds.join(', ')}`,
      );
    }

    const summary = {
      vendor,
      totalRecords: mappings.length,
      uniquePaths: mappingIndex.rowsByPath.size,
      vendorNodeCount: vendorRows.length,
      matchedPaths: updates.length,
      changedCount: updates.filter((update) => update.changed).length,
      unchangedCount: updates.filter((update) => !update.changed).length,
      updates,
      missingVendorPaths,
      duplicateVendorPaths,
      skippedNewRecords: mappingIndex.skippedNewRecords,
      invalidCategoryIds,
    };

    printSummary(summary);

    if (duplicateVendorPaths.length > 0) {
      throw new Error('Duplicate vendor path matches detected. Aborting.');
    }

    if (options.dryRun) {
      console.log('Dry run only. No database changes were made.');
      return;
    }

    await applyUpdates(client, updates);
    console.log(`Applied ${summary.changedCount} vendor category mapping updates.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('CityCenter vendor category mapping import failed:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
