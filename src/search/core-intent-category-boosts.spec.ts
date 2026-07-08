import {
  CORE_INTENT_CATEGORY_BOOSTS,
  getCoreIntentBoostKey,
} from './core-intent-category-boosts';

describe('getCoreIntentBoostKey', () => {
  it('matches known single-token abbreviations case-insensitively', () => {
    expect(getCoreIntentBoostKey('CPU')).toBe('cpu');
    expect(getCoreIntentBoostKey('cpus')).toBe('cpu');
    expect(getCoreIntentBoostKey('  GPU  ')).toBe('gpu');
    expect(getCoreIntentBoostKey('PSU')).toBe('psu');
    expect(getCoreIntentBoostKey('HDD')).toBe('hdd');
  });

  it('does not match multi-word queries', () => {
    expect(getCoreIntentBoostKey('cpu cooler')).toBeUndefined();
    expect(getCoreIntentBoostKey('power supply')).toBeUndefined();
  });

  it('does not match unrelated single-word queries', () => {
    expect(getCoreIntentBoostKey('tablet')).toBeUndefined();
    expect(getCoreIntentBoostKey('monitor')).toBeUndefined();
  });

  it('covers every configured boost key', () => {
    for (const key of Object.keys(CORE_INTENT_CATEGORY_BOOSTS)) {
      expect(getCoreIntentBoostKey(key)).toBe(key);
    }
  });
});
