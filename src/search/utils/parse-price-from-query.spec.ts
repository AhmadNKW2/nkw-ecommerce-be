import { parsePriceFromQuery } from './parse-price-from-query';

describe('parsePriceFromQuery', () => {
  it('parses Arabic less-than and strips phrase from query', () => {
    const result = parsePriceFromQuery('لابتوب أقل من 3000');
    expect(result.cleanedQuery).toBe('لابتوب');
    expect(result.maxPrice).toBe(3000);
    expect(result.minPrice).toBeUndefined();
    expect(result.strippedPhrases.length).toBeGreaterThan(0);
  });

  it('parses English under and strips phrase', () => {
    const result = parsePriceFromQuery('iphone under 500');
    expect(result.cleanedQuery).toBe('iphone');
    expect(result.maxPrice).toBe(500);
  });

  it('parses Arabic between range', () => {
    const result = parsePriceFromQuery('لابتوب بين 2000 و 4000');
    expect(result.cleanedQuery).toBe('لابتوب');
    expect(result.minPrice).toBe(2000);
    expect(result.maxPrice).toBe(4000);
  });

  it('parses more than as min price', () => {
    const result = parsePriceFromQuery('asus laptop more than 1000');
    expect(result.cleanedQuery).toBe('asus laptop');
    expect(result.minPrice).toBe(1000);
    expect(result.maxPrice).toBeUndefined();
  });

  it('does not treat bare spec numbers as price', () => {
    const result = parsePriceFromQuery('لابتوب i7 5060 أسوس');
    expect(result.cleanedQuery).toBe('لابتوب i7 5060 أسوس');
    expect(result.minPrice).toBeUndefined();
    expect(result.maxPrice).toBeUndefined();
  });

  it('parses Arabic-indic digits', () => {
    const result = parsePriceFromQuery('لابتوب أقل من ٥٠٠٠');
    expect(result.maxPrice).toBe(5000);
  });

  it('does not override existing URL price filters', () => {
    const result = parsePriceFromQuery('لابتوب أقل من 3000', {
      minPrice: 100,
      maxPrice: 200,
    });
    expect(result.minPrice).toBeUndefined();
    expect(result.maxPrice).toBeUndefined();
  });

  it('combines less and more without between into a range', () => {
    const result = parsePriceFromQuery('laptop more than 1000 less than 3000');
    expect(result.minPrice).toBe(1000);
    expect(result.maxPrice).toBe(3000);
  });
});
