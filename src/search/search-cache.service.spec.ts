import { SearchCacheService } from './search-cache.service';

describe('SearchCacheService', () => {
  const generationStore = new Map<string, number>();

  function makeService() {
    const cacheManager = {
      get: jest.fn(async (key: string) => generationStore.get(key)),
      set: jest.fn(async (key: string, value: number) => {
        generationStore.set(key, value);
      }),
      del: jest.fn(),
    };

    const service = new SearchCacheService(cacheManager as any);
    return { service, cacheManager };
  }

  beforeEach(() => {
    generationStore.clear();
  });

  it('starts at generation v1 when no generation is stored', async () => {
    const { service } = makeService();
    await expect(service.getGeneration()).resolves.toBe(1);
  });

  it('includes the generation in cache keys', async () => {
    const { service } = makeService();
    await expect(service.buildCacheKey('search:public:card', '{"q":"laptop"}')).resolves.toBe(
      'search:public:card:v1:{"q":"laptop"}',
    );
  });

  it('bumps generation on invalidate so new keys miss old entries', async () => {
    const { service } = makeService();

    const firstKey = await service.buildCacheKey('search:public:card', '{"q":"laptop"}');
    await service.invalidateSearchCache('typesense full backfill');
    const secondKey = await service.buildCacheKey('search:public:card', '{"q":"laptop"}');

    expect(firstKey).toBe('search:public:card:v1:{"q":"laptop"}');
    expect(secondKey).toBe('search:public:card:v2:{"q":"laptop"}');
    expect(firstKey).not.toBe(secondKey);
  });

  it('persists generation without expiry', async () => {
    const { service, cacheManager } = makeService();

    await service.invalidateSearchCache('test');

    expect(cacheManager.set).toHaveBeenCalledWith(
      SearchCacheService.GENERATION_CACHE_KEY,
      2,
      0,
    );
  });
});
