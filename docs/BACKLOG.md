# Backlog

Tracked here until a dedicated issue tracker (Linear/Jira/etc.) is connected. Items should be moved out (and this note updated) once that happens — don't let this file silently become the permanent home for backlog items.

---

## Add `locale: 'ar'` to the existing `name_ar` Typesense field

**Context:** As part of the Track A Typesense search improvements (Arabic normalization, HTML stripping, new `short_description_ar`/`long_description_ar` fields — see `src/typesense/schemas/product.schema.ts`, `src/typesense/mappers/product.mapper.ts`, `src/typesense/utils/text-normalize.ts`), the two new Arabic description fields were given `locale: 'ar'` for proper Arabic-aware tokenization. The existing `name_ar` field was **not** updated to match.

**Why it matters:** `name_ar` is arguably the most important Arabic field for search relevance, but it currently uses Typesense's default (non-locale-aware) tokenizer, while the newer Arabic fields get better tokenization. This is an inconsistency that could affect relevance/ranking quality for Arabic name matches specifically.

**Why it wasn't bundled into Track A:** Changing an existing field's `locale` isn't a simple additive schema change — Typesense requires dropping and recreating the field to change its type/locale, which is a bigger, separate risk than adding new optional fields. It deserves its own review (schema migration plan, reindex impact, relevance QA) rather than being folded into a low-risk additive change set.

**Suggested next steps:**
1. Confirm whether `name_ar` reindexing at current catalog size (~1,000+ products) is cheap enough to do as a standalone migration.
2. Add `locale: 'ar'` to `name_ar` in `product.schema.ts`, drop and recreate the field on the live collection (or do a full collection recreate + alias swap if Track B's alias-based reindex has landed by then).
3. QA relevance on Arabic name searches before/after to confirm improvement, not regression.

---

## Add alerting on Typesense schema-migration failure

**Context:** `TypesenseService.ensureCollectionSchema()` (`src/typesense/typesense.service.ts`) auto-migrates a fixed allowlist of fields (currently `attributes_values_ids`, `specifications_values_ids`, `short_description_ar`, `long_description_ar`) into the live Typesense collection on app boot. If this call fails (e.g. Typesense is briefly unreachable at boot), the failure is caught and only logged via `this.logger.warn(...)` — the app continues starting up normally.

**Why it matters:** A silent failure here means the app boots "successfully" but the new fields never get added to the live collection. Nothing pages or alerts anyone. The first sign of trouble would likely be someone reporting that Arabic (or other newly-added-field) search "randomly" doesn't work, with no obvious connection back to a boot-time log line from potentially days/weeks earlier.

**Suggested next steps:**
1. Add alerting (PagerDuty/Slack webhook/whatever the team uses) on the specific warning log line: `Failed to update Typesense collection schema: ...`.
2. Consider whether this should be a harder failure in some environments (e.g. fail health checks, or block traffic) rather than a warn-and-continue, depending on how critical Typesense-backed search is versus the DB fallback.
---

## English hardware abbreviation synonyms and category boosts

**Context:** Shoppers often search using common English abbreviations (`CPU`, `GPU`, `PSU`, `HDD`) that share no literal token with how matching products are named in our catalog (`Processor`, `Graphics Card`, `Power Supply`, `Hard Drive`). Typesense only does literal/typo-tolerant matching, so without help these searches miss the right products entirely or rank accessories above the actual category.

**Implementation:**
- Synonym groups: [`src/typesense/config/synonyms.ts`](../src/typesense/config/synonyms.ts) — registered at boot by `TypesenseService.ensureSynonyms()` (classic API on Typesense \< v30, `synonym_sets` API on v30+).
- Category ranking boosts: [`src/search/core-intent-category-boosts.ts`](../src/search/core-intent-category-boosts.ts) — maps whole-query terms to stable category slugs, resolved to IDs at query time and prepended to `sort_by` via `_eval()` (requires Typesense v26+).

**How to extend when a new gap is found:**
1. Confirm the gap live (abbreviation query returns wrong/missing products; full-word query works).
2. Add a multi-way synonym group in `synonyms.ts` (e.g. `'mobo-motherboard': ['mobo', 'motherboard']`). No reindex needed — synonyms apply at query time.
3. If the correct products appear but rank too low (buried below unrelated literal matches), add a corresponding entry in `core-intent-category-boosts.ts` pointing at the stable category slug(s). Restart the backend (synonyms re-register on boot; slug cache refreshes within 5 minutes).
4. Add unit tests in `search.service.spec.ts` and/or `core-intent-category-boosts.spec.ts`.
5. Live-verify on both `/api/search` and `/api/search/autocomplete`.

**Currently covered:** `cpu`/`processor`, `gpu`/`graphics card`/`video card`, `psu`/`power supply`, `hdd`/`hard drive`/`hard disk`.

**Not covered (examples for future tickets):** `mobo`/`motherboard` (no "mobo" products in catalog today), `ram`/`memory` (high overlap — both terms appear across many product types, so a whole-query boost would be too broad without category scoping review).

