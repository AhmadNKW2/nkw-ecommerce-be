export type ParsedDeviceInfo = {
  type: 'Desktop' | 'Mobile' | 'Tablet' | 'Unknown';
  /** Marketing / readable model when known, else raw code, else null. */
  model: string | null;
  /** e.g. "Mobile · Galaxy S24 Ultra" or "Desktop" */
  label: string;
};

/** Common Android marketing names for model codes found in UA / Client Hints. */
const MODEL_CODE_MAP: Record<string, string> = {
  // Samsung Galaxy S24 family
  'SM-S921': 'Galaxy S24',
  'SM-S926': 'Galaxy S24+',
  'SM-S928': 'Galaxy S24 Ultra',
  // Samsung Galaxy S23 family
  'SM-S911': 'Galaxy S23',
  'SM-S916': 'Galaxy S23+',
  'SM-S918': 'Galaxy S23 Ultra',
  // Samsung Galaxy S22 family
  'SM-S901': 'Galaxy S22',
  'SM-S906': 'Galaxy S22+',
  'SM-S908': 'Galaxy S22 Ultra',
  // Samsung Galaxy S25 family
  'SM-S931': 'Galaxy S25',
  'SM-S936': 'Galaxy S25+',
  'SM-S938': 'Galaxy S25 Ultra',
  // Samsung A / FE common
  'SM-A556': 'Galaxy A55',
  'SM-A546': 'Galaxy A54',
  'SM-A536': 'Galaxy A53',
  'SM-A256': 'Galaxy A25',
  'SM-S711': 'Galaxy S23 FE',
  'SM-S721': 'Galaxy S24 FE',
  // Google Pixel
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

  // Exact map
  if (MODEL_CODE_MAP[upper]) return MODEL_CODE_MAP[upper];

  // Samsung codes often include suffix: SM-S928B, SM-S928U1
  const samsung = upper.match(/^(SM-[A-Z0-9]{3,6})/);
  if (samsung) {
    const prefix = samsung[1];
    // Try progressively shorter prefixes (SM-S928B → SM-S928)
    for (let len = prefix.length; len >= 6; len--) {
      const key = prefix.slice(0, len);
      if (MODEL_CODE_MAP[key]) return MODEL_CODE_MAP[key];
    }
  }

  // Already a readable name (Pixel 7, iPhone, etc.)
  if (/^(galaxy|pixel|iphone|ipad|xiaomi|redmi|poco|oneplus|huawei|oppo|vivo)/i.test(cleaned)) {
    return cleaned;
  }

  // Keep raw Android model codes that look intentional
  if (/^[A-Z0-9][A-Z0-9\- ]{1,40}$/i.test(cleaned) && !/^(LINUX|ANDROID|MOBILE|K|WV)$/i.test(cleaned)) {
    return cleaned;
  }

  return null;
}

function parseType(userAgent: string | null | undefined): ParsedDeviceInfo['type'] {
  if (!userAgent) return 'Unknown';
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/.test(ua)) {
    return 'Tablet';
  }
  if (
    /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/.test(
      ua,
    )
  ) {
    return 'Mobile';
  }
  return 'Desktop';
}

/** Extract model from classic Android UA: "; SM-S928B Build/" or "; Pixel 7) " */
function extractModelFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;

  // iPhone / iPad — browsers almost never expose Ultra vs Pro
  if (/iphone/i.test(userAgent)) return 'iPhone';
  if (/ipad/i.test(userAgent)) return 'iPad';

  const android = userAgent.match(
    /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i,
  );
  if (android?.[1]) {
    const token = normalizeModelToken(android[1]);
    // Skip generic tokens
    if (
      !token ||
      /^(wv|mobile|u|en-us|en_us|linux)$/i.test(token) ||
      /^\d+\.\d+/.test(token)
    ) {
      return null;
    }
    return mapModelCode(token) || token;
  }

  return null;
}

/**
 * Resolve device type + model from UA and optional Client Hints model.
 * Hints model (Chrome Android) is preferred when present.
 */
export function parseDeviceInfo(
  userAgent?: string | null,
  hintModel?: string | null,
): ParsedDeviceInfo {
  const type = parseType(userAgent);
  const fromHint = mapModelCode(hintModel) || (hintModel ? normalizeModelToken(hintModel) : null);
  const fromUa = extractModelFromUserAgent(userAgent);
  const model =
    type === 'Desktop'
      ? null
      : fromHint && fromHint.length <= 80
        ? fromHint
        : fromUa;

  const label = model ? `${type} · ${model}` : type;
  return { type, model, label };
}
