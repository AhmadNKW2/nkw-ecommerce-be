export type ParsedDeviceInfo = {
  type: 'Desktop' | 'Mobile' | 'Tablet' | 'Unknown';
  /** Marketing name when known, else "Samsung SM-…" / raw code, else null. */
  model: string | null;
  /** e.g. "Mobile · Galaxy S24 Ultra" or "Desktop" — never a bare model code alone. */
  label: string;
};

/** Common Android marketing names for model codes in UA / Client Hints. */
const MODEL_CODE_MAP: Record<string, string> = {
  'SM-S921': 'Galaxy S24',
  'SM-S926': 'Galaxy S24+',
  'SM-S928': 'Galaxy S24 Ultra',
  'SM-S911': 'Galaxy S23',
  'SM-S916': 'Galaxy S23+',
  'SM-S918': 'Galaxy S23 Ultra',
  'SM-S901': 'Galaxy S22',
  'SM-S906': 'Galaxy S22+',
  'SM-S908': 'Galaxy S22 Ultra',
  'SM-S931': 'Galaxy S25',
  'SM-S936': 'Galaxy S25+',
  'SM-S938': 'Galaxy S25 Ultra',
  'SM-S711': 'Galaxy S23 FE',
  'SM-S721': 'Galaxy S24 FE',
  'SM-A556': 'Galaxy A55',
  'SM-A546': 'Galaxy A54',
  'SM-A536': 'Galaxy A53',
  'SM-A528': 'Galaxy A52s',
  'SM-A525': 'Galaxy A52',
  'SM-A256': 'Galaxy A25',
  'SM-A366': 'Galaxy A36',
  'SM-S845': 'Galaxy S25 Edge',
  'PIXEL 9 PRO XL': 'Pixel 9 Pro XL',
  'PIXEL 9 PRO': 'Pixel 9 Pro',
  'PIXEL 9': 'Pixel 9',
  'PIXEL 8 PRO': 'Pixel 8 Pro',
  'PIXEL 8': 'Pixel 8',
  'PIXEL 7 PRO': 'Pixel 7 Pro',
  'PIXEL 7': 'Pixel 7',
  'PIXEL 6 PRO': 'Pixel 6 Pro',
  'PIXEL 6': 'Pixel 6',
};

function normalizeModelToken(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function mapModelCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = normalizeModelToken(raw);
  if (!cleaned || cleaned.length < 2) return null;

  const upper = cleaned.toUpperCase();

  if (MODEL_CODE_MAP[upper]) return MODEL_CODE_MAP[upper];

  const samsung = upper.match(/^(SM-[A-Z0-9]+)/);
  if (samsung) {
    const full = samsung[1];
    // SM-S928B → try SM-S928, SM-S92, …
    for (let len = Math.min(full.length, 10); len >= 6; len--) {
      const key = full.slice(0, len);
      if (MODEL_CODE_MAP[key]) return MODEL_CODE_MAP[key];
    }
    // Unmapped Samsung code — still label as Samsung so UI isn't a bare code
    return `Samsung ${full}`;
  }

  if (
    /^(galaxy|pixel|iphone|ipad|xiaomi|redmi|poco|oneplus|huawei|oppo|vivo)/i.test(
      cleaned,
    )
  ) {
    return cleaned;
  }

  if (
    /^[A-Z0-9][A-Z0-9\- ]{1,40}$/i.test(cleaned) &&
    !/^(LINUX|ANDROID|MOBILE|K|WV)$/i.test(cleaned)
  ) {
    return cleaned;
  }

  return null;
}

/**
 * Prefer clear Desktop/Mobile signals. Avoid false Mobile from loose /mobi/ matches.
 * Chrome reduced UA "Android 10; K" is still Mobile (has Mobile Safari).
 */
export function parseType(
  userAgent: string | null | undefined,
): ParsedDeviceInfo['type'] {
  if (!userAgent) return 'Unknown';
  const ua = userAgent.toLowerCase();

  // Strong desktop OS signals first (admin laptops must stay Desktop)
  if (
    (/windows nt|macintosh|mac os x|cros|x11|linux x86_64|wow64|win64/.test(ua) ||
      (/linux/.test(ua) && !/android/.test(ua))) &&
    !/android|iphone|ipod|ipad/.test(ua)
  ) {
    return 'Desktop';
  }

  if (/ipad|tablet|kindle|silk|playbook/.test(ua)) {
    return 'Tablet';
  }
  // Android without "Mobile" ≈ tablet
  if (/android/.test(ua) && !/mobile/.test(ua)) {
    return 'Tablet';
  }
  if (
    /iphone|ipod|windows phone|blackberry|opera mini|iemobile/.test(ua) ||
    (/android/.test(ua) && /mobile/.test(ua)) ||
    /mobile safari/.test(ua)
  ) {
    return 'Mobile';
  }

  return 'Unknown';
}

function extractModelFromUserAgent(
  userAgent: string | null | undefined,
): string | null {
  if (!userAgent) return null;

  if (/iphone/i.test(userAgent)) return 'iPhone';
  if (/ipad/i.test(userAgent)) return 'iPad';

  // Chrome reduced UA: "Android 10; K)" — model intentionally hidden
  if (/Android[^;]*;\s*K\s*[;)]/i.test(userAgent)) {
    return null;
  }

  const android = userAgent.match(
    /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i,
  );
  if (android?.[1]) {
    const token = normalizeModelToken(android[1]);
    if (
      !token ||
      /^(wv|mobile|u|en-us|en_us|linux|k)$/i.test(token) ||
      /^\d+\.\d+/.test(token)
    ) {
      return null;
    }
    return mapModelCode(token) || token;
  }

  return null;
}

export function parseDeviceInfo(
  userAgent?: string | null,
  hintModel?: string | null,
): ParsedDeviceInfo {
  const type = parseType(userAgent);
  const fromHint =
    mapModelCode(hintModel) ||
    (hintModel ? normalizeModelToken(hintModel) : null);
  const fromUa = extractModelFromUserAgent(userAgent);

  // Models only make sense for phones/tablets
  const model =
    type === 'Desktop' || type === 'Unknown'
      ? null
      : fromHint && fromHint.length <= 80
        ? fromHint
        : fromUa;

  const label = model ? `${type} · ${model}` : type;
  return { type, model, label };
}
