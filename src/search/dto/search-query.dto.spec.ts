import { ValidationPipe } from '@nestjs/common';
import { SearchQueryDto } from './search-query.dto';

describe('SearchQueryDto', () => {
  const validationPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  });

  async function transformQuery(query: Record<string, unknown>) {
    return validationPipe.transform(query, {
      type: 'query',
      metatype: SearchQueryDto,
      data: '',
    }) as Promise<SearchQueryDto>;
  }

  it('keeps query-string false for admin stock and visibility filters', async () => {
    const result = await transformQuery({
      q: '*',
      in_stock: 'false',
      visible: 'false',
      is_admin: 'true',
      include_facets: 'false',
      has_no_vendor: 'false',
    });

    expect(result.in_stock).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.is_admin).toBe(true);
    expect(result.include_facets).toBe(false);
    expect(result.has_no_vendor).toBe(false);
  });

  it('parses query-string true booleans', async () => {
    const result = await transformQuery({
      q: '*',
      in_stock: 'true',
      visible: 'true',
    });

    expect(result.in_stock).toBe(true);
    expect(result.visible).toBe(true);
  });
});
