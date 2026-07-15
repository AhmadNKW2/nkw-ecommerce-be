import {
  isExactTitleMatch,
  orderIdsByTitleRelevance,
  scoreProductByTitleWordIndexes,
  scoreTitleByWordIndexes,
  selectTitleForWordIndexScoring,
  titleTokensInReadingOrder,
  tokenizeTitleWords,
} from './title-relevance.utils';

describe('title-relevance.utils', () => {
  const exactTitle =
    'لابتوب ألعاب Lenovo LOQ 15IRX10 AI مقاس 15.6 إنش FHD IPS 144Hz بمعالج Intel Core i7-14700HX وكرت RTX 5060 8GB';

  it('detects exact EN/AR title equality after normalization', () => {
    expect(isExactTitleMatch(exactTitle, null, exactTitle)).toBe(true);
    expect(isExactTitleMatch(`  ${exactTitle}  `, null, exactTitle)).toBe(true);
    expect(
      isExactTitleMatch(exactTitle, null, exactTitle.replace('RTX 5060', 'RTX 5050')),
    ).toBe(false);
  });

  it('scores exact title highest', () => {
    const exact = scoreTitleByWordIndexes(exactTitle, exactTitle);
    const close = scoreTitleByWordIndexes(
      exactTitle,
      exactTitle.replace('RTX 5060', 'RTX 5050'),
    );
    expect(exact).toBeGreaterThan(close);
  });

  it('prefers titles where query words appear at earlier indexes', () => {
    const query = 'لابتوب';
    const laptopFirst = scoreTitleByWordIndexes(query, 'لابتوب HP 15');
    const bagFirst = scoreTitleByWordIndexes(query, 'حقيبة لابتوب Ugreen');
    expect(laptopFirst).toBeGreaterThan(bagFirst);
  });

  it('keeps Arabic-first titles in RTL reading order (string start)', () => {
    expect(titleTokensInReadingOrder('لابتوب ألعاب Lenovo')[0]).toBe(
      tokenizeTitleWords('لابتوب')[0],
    );
  });

  it('keeps English-first titles in LTR reading order', () => {
    expect(titleTokensInReadingOrder('Lenovo LOQ laptop')[0]).toBe('lenovo');
  });

  it('selects Arabic title when query starts with Arabic', () => {
    expect(
      selectTitleForWordIndexScoring('لابتوب Lenovo', 'Lenovo Laptop', 'لابتوب لينوفو'),
    ).toBe('لابتوب لينوفو');
  });

  it('selects English title when query starts with English', () => {
    expect(
      selectTitleForWordIndexScoring('Lenovo LOQ', 'Lenovo Laptop', 'لابتوب لينوفو'),
    ).toBe('Lenovo Laptop');
  });

  it('pins exact title ids first then sorts by word-index score', () => {
    const titlesById = new Map<
      number,
      { name_en?: string | null; name_ar?: string | null }
    >([
      [1, { name_ar: 'حقيبة لابتوب' }],
      [2, { name_ar: exactTitle }],
      [3, { name_ar: 'لابتوب HP رخيص' }],
      [4, { name_ar: exactTitle.replace('RTX 5060', 'RTX 4050') }],
    ]);

    const ordered = orderIdsByTitleRelevance({
      query: exactTitle,
      orderedIds: [1, 3, 4, 2],
      exactTitleIds: [2],
      titlesById,
    });

    expect(ordered[0]).toBe(2);
    expect(ordered.slice(1)).toEqual(
      expect.arrayContaining([1, 3, 4]),
    );
    // Closer LOQ variant should beat bag / generic laptop for this long query
    expect(ordered.indexOf(4)).toBeLessThan(ordered.indexOf(1));
  });

  it('scores multi-word queries by shared title word indexes', () => {
    const query = 'Lenovo LOQ RTX 5060';
    const best = scoreProductByTitleWordIndexes(
      query,
      null,
      'لابتوب ألعاب Lenovo LOQ 15IRX10 RTX 5060 8GB',
    );
    const worse = scoreProductByTitleWordIndexes(
      query,
      null,
      'لابتوب ألعاب Lenovo LOQ RTX 4050',
    );
    expect(best).toBeGreaterThan(worse);
  });
});
