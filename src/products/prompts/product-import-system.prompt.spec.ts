import { buildProductImportSystemPrompt } from './product-import-system.prompt';

describe('buildProductImportSystemPrompt', () => {
  it('includes strict brand, specification, and attribute rules', () => {
    const prompt = buildProductImportSystemPrompt({
      brands: [{ name_en: 'Acer' }] as never,
      specifications: [
        {
          id: 1,
          name_en: 'Display Size',
          allow_ai_inference: false,
          values: [],
        },
      ] as never,
      attributes: [
        {
          id: 2,
          name_en: 'Color',
          allow_ai_inference: false,
          values: [],
        },
      ] as never,
    });

    expect(prompt).toContain(
      'NEVER substitute one manufacturer brand for another.',
    );
    expect(prompt).toContain(
      'DO NOT replace it with a different existing DATABASE BRAND.',
    );
    expect(prompt).toContain(
      'If the product input explicitly contains a value for a database specification, you MUST return that specification with exactly ONE value object.',
    );
    expect(prompt).toContain(
      'If the product input does not explicitly contain a usable value for a database specification and allow_ai_inference is FALSE, you MUST return that specification with values: [].',
    );
    expect(prompt).toContain(
      'Ignore is represented ONLY by values: []. You MUST NOT invent a new status such as "not_found", "missing", or "ignore" in the JSON response.',
    );
    expect(prompt).toContain(
      'For specifications, return at most ONE value object per database specification.',
    );
    expect(prompt).toContain(
      'If the product input explicitly contains value(s) for a database attribute, you MUST return ALL explicit values that belong to that attribute.',
    );
    expect(prompt).toContain(
      'For allow_ai_inference = FALSE, if the product data does not explicitly contain this attribute, values MUST stay [] and you MUST NOT choose an existing DB value or create a new one.',
    );
    expect(prompt).toContain(
      'For attributes, preserve ALL explicit source values that belong to the same database attribute.',
    );
    expect(prompt).toContain(
      'Example: from "Intel Core i7-12700F", CPU = "Intel", CPU Series = "Core i7", CPU Model = "12700F".',
    );
    expect(prompt).toContain(
      'DO NOT return any brand that is different from the true manufacturer brand supported by the product data.',
    );
  });
});