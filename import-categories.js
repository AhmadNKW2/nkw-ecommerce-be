const { Client } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');

require('dotenv').config();

const PARENT_FALLBACKS = {
  Displays: 'Monitors',
};

function printUsage() {
  console.log(`Usage: node import-categories.js --file <path> [options]

Options:
  --file <path>            JSON category file to import
  --dry-run                Preview changes without updating the database
  --help, -h               Show this help message

Examples:
  node import-categories.js --file "./data/new-categories-2026-06-18.json" --dry-run
  pnpm exec node import-categories.js --file "./data/new-categories-2026-06-18.json"`);
}

function parseArgs(argv) {
  const options = {
    file: '',
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

function slugify(text) {
  return String(text ?? '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function splitParentPath(value) {
  return String(value ?? '')
    .split('>')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

async function readCategories(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('Category file must contain a JSON array');
  }

  return parsed;
}

function buildCategoryIndex(rows) {
  const byName = new Map();
  const childrenByParentId = new Map();

  for (const row of rows) {
    const key = row.name_en.trim().toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, []);
    }
    byName.get(key).push(row);

    const parentId = row.parent_id ?? null;
    if (!childrenByParentId.has(parentId)) {
      childrenByParentId.set(parentId, []);
    }
    childrenByParentId.get(parentId).push(row);
  }

  return { byName, childrenByParentId };
}

function findCategoryByName(index, name, parentId = null) {
  const matches = index.byName.get(String(name).trim().toLowerCase()) ?? [];

  if (parentId === null) {
    const rootMatches = matches.filter((row) => row.parent_id === null);
    if (rootMatches.length === 1) {
      return rootMatches[0];
    }
    if (rootMatches.length > 1) {
      throw new Error(
        `Multiple root categories matched name "${name}". Resolve manually.`,
      );
    }
  }

  const scopedMatches = matches.filter((row) => row.parent_id === parentId);
  if (scopedMatches.length === 1) {
    return scopedMatches[0];
  }
  if (scopedMatches.length > 1) {
    throw new Error(
      `Multiple categories matched name "${name}" under parent id ${parentId}.`,
    );
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function resolveParentCategory(index, recommendedParent) {
  if (!recommendedParent) {
    return { parent: null, resolvedPath: 'root' };
  }

  const segments = splitParentPath(recommendedParent);
  let currentParent = null;
  let currentPath = 'root';

  for (const segment of segments) {
    let match = findCategoryByName(index, segment, currentParent?.id ?? null);

    if (!match && currentParent === null && PARENT_FALLBACKS[segment]) {
      const fallbackName = PARENT_FALLBACKS[segment];
      match = findCategoryByName(index, fallbackName, null);
      if (match) {
        console.log(
          `  Note: parent "${segment}" not found; using fallback "${fallbackName}" (id=${match.id})`,
        );
      }
    }

    if (!match) {
      throw new Error(
        `Parent category not found for path "${recommendedParent}" at segment "${segment}"`,
      );
    }

    currentParent = match;
    currentPath =
      currentPath === 'root' ? segment : `${currentPath} > ${segment}`;
  }

  return { parent: currentParent, resolvedPath: currentPath };
}

function reserveSlug(baseSlug, usedSlugs) {
  let finalSlug = baseSlug;
  let counter = 1;

  while (usedSlugs.has(finalSlug)) {
    counter += 1;
    finalSlug = `${baseSlug}-${counter}`;
  }

  usedSlugs.add(finalSlug);
  return finalSlug;
}

function planCategoryCreation(entry, parent, nextSortOrder, usedSlugs) {
  const level = parent ? parent.level + 1 : 0;

  if (level > 2) {
    throw new Error(
      `Cannot create "${entry.name_en}" under "${parent.name_en}" because max nesting depth is 3 levels`,
    );
  }

  const slug = reserveSlug(slugify(entry.name_en), usedSlugs);

  const planned = {
    name_en: entry.name_en,
    name_ar: entry.name_ar,
    slug,
    parent_id: parent ? parent.id : null,
    level,
    sortOrder: nextSortOrder,
    status: 'active',
    visible: true,
    children: [],
  };

  let childSortOrder = nextSortOrder + 1;
  for (const subCategory of entry.sub_categories ?? []) {
    const childPlan = planCategoryCreation(
      subCategory,
      planned,
      childSortOrder,
      usedSlugs,
    );
    planned.children.push(childPlan);
    childSortOrder += 1 + countPlannedCategories(childPlan.children);
  }

  return planned;
}

function countPlannedCategories(plans) {
  return plans.reduce(
    (total, plan) => total + 1 + countPlannedCategories(plan.children),
    0,
  );
}

function flattenPlans(plans) {
  const rows = [];

  for (const plan of plans) {
    rows.push(plan);
    rows.push(...flattenPlans(plan.children));
  }

  return rows;
}

async function loadExistingCategories(client) {
  const result = await client.query(
  `
    SELECT id, name_en, name_ar, parent_id, level, slug, "sortOrder"
    FROM categories
    ORDER BY id ASC
  `,
  );

  return result.rows;
}

async function insertCategory(client, plan) {
  const result = await client.query(
    `
      INSERT INTO categories (
        name_en,
        name_ar,
        slug,
        parent_id,
        level,
        "sortOrder",
        status,
        visible
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      plan.name_en,
      plan.name_ar,
      plan.slug,
      plan.parent_id,
      plan.level,
      plan.sortOrder,
      plan.status,
      plan.visible,
    ],
  );

  return result.rows[0].id;
}

async function insertPlanTree(client, plan) {
  const id = await insertCategory(client, plan);
  for (const child of plan.children) {
    child.parent_id = id;
    child.level = plan.level + 1;
    await insertPlanTree(client, child);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (!options.file) {
    printUsage();
    throw new Error('--file is required');
  }

  const filePath = path.resolve(options.file);
  const entries = await readCategories(filePath);
  const client = createClient();

  await client.connect();

  try {
    const existingRows = await loadExistingCategories(client);
    const index = buildCategoryIndex(existingRows);
    const usedSlugs = new Set(existingRows.map((row) => row.slug).filter(Boolean));
    const maxSortResult = await client.query(
      'SELECT COALESCE(MAX("sortOrder"), -1) AS max FROM categories',
    );
    let nextSortOrder = Number(maxSortResult.rows[0].max) + 1;

    const skipped = [];
    const plannedRoots = [];

    for (const entry of entries) {
      const existing = findCategoryByName(index, entry.name_en, null);
      if (existing) {
        skipped.push({
          name_en: entry.name_en,
          reason: `already exists (id=${existing.id})`,
        });
        continue;
      }

      let parent = null;
      let resolvedPath = 'root';

      if (entry.recommended_parent) {
        try {
          const resolved = resolveParentCategory(index, entry.recommended_parent);
          parent = resolved.parent;
          resolvedPath = resolved.resolvedPath;
        } catch (error) {
          skipped.push({
            name_en: entry.name_en,
            reason: error.message,
          });
          continue;
        }
      } else if (entry.type !== 'top_level') {
        console.log(
          `  Note: "${entry.name_en}" has no recommended_parent; creating at root`,
        );
      }

      const plan = planCategoryCreation(
        entry,
        parent,
        nextSortOrder,
        usedSlugs,
      );
      plannedRoots.push({ plan, resolvedPath });
      nextSortOrder += 1 + countPlannedCategories(plan.children);
    }

    const allPlanned = flattenPlans(plannedRoots.map((item) => item.plan));

    console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'APPLY'}`);
    console.log(`File: ${filePath}`);
    console.log(`Entries in file: ${entries.length}`);
    console.log(`Planned new categories: ${allPlanned.length}`);
    console.log(`Skipped entries: ${skipped.length}`);

    for (const item of plannedRoots) {
      console.log(
        `\n+ ${item.plan.name_en} -> under ${item.resolvedPath} (${item.plan.children.length} direct children)`,
      );
      for (const child of flattenPlans(item.plan.children)) {
        console.log(`  + ${child.name_en} (level ${child.level})`);
      }
    }

    if (skipped.length > 0) {
      console.log('\nSkipped:');
      for (const item of skipped) {
        console.log(`- ${item.name_en}: ${item.reason}`);
      }
    }

    if (options.dryRun) {
      console.log('\nDry run complete. No database changes were made.');
      return;
    }

    if (allPlanned.length === 0) {
      console.log('\nNothing to insert.');
      return;
    }

    await client.query('BEGIN');

    for (const item of plannedRoots) {
      await insertPlanTree(client, item.plan);
    }

    await client.query('COMMIT');
    console.log(`\nInserted ${allPlanned.length} categories successfully.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
