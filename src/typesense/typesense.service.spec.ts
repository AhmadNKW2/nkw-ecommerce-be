import { TypesenseService } from './typesense.service';
import {
  PRODUCT_SYNONYM_GROUPS,
  PRODUCT_SYNONYM_SET_NAME,
} from './config/synonyms';

function makeService(client: Record<string, unknown>, configOverrides: Record<string, string> = {}) {
  const configService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const values: Record<string, string> = {
        TYPESENSE_COLLECTION_PRODUCTS: 'products',
        TYPESENSE_HOST: 'localhost',
        TYPESENSE_PORT: '8108',
        TYPESENSE_PROTOCOL: 'http',
        TYPESENSE_API_KEY: 'test-key',
        TYPESENSE_ENABLED: 'true',
        ...configOverrides,
      };
      return values[key] ?? defaultValue;
    }),
  };

  const service = new TypesenseService(client as any, configService as any);
  return { service, configService };
}

describe('TypesenseService — ensureSynonyms', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses synonym_sets API on Typesense v30+ and links the set to the collection', async () => {
    const synonymSetsUpsert = jest.fn().mockResolvedValue({});
    const collectionUpdate = jest.fn().mockResolvedValue({});
    const collectionRetrieve = jest.fn().mockResolvedValue({ fields: [], synonym_sets: [] });

    const client = {
      collections: jest.fn((name: string) => ({
        retrieve: collectionRetrieve,
        update: collectionUpdate,
        documents: () => ({ search: jest.fn() }),
      })),
      synonymSets: jest.fn(() => ({ upsert: synonymSetsUpsert })),
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '30.2' }),
    }) as any;

    const { service } = makeService(client);
    await service.onModuleInit();

    expect(synonymSetsUpsert).toHaveBeenCalledWith({
      items: Object.entries(PRODUCT_SYNONYM_GROUPS).map(([id, synonyms]) => ({
        id,
        synonyms,
      })),
    });
    expect(collectionUpdate).toHaveBeenCalledWith({
      synonym_sets: [PRODUCT_SYNONYM_SET_NAME],
    });
  });

  it('uses the classic per-collection synonyms API when server version is below 30', async () => {
    const synonymUpsert = jest.fn().mockResolvedValue({});
    const synonyms = jest.fn(() => ({ upsert: synonymUpsert }));

    const client = {
      collections: jest.fn((name: string) => ({
        retrieve: jest.fn().mockResolvedValue({ fields: [] }),
        synonyms,
        documents: () => ({ search: jest.fn() }),
      })),
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.25.2' }),
    }) as any;

    const { service } = makeService(client);
    await service.onModuleInit();

    expect(synonyms).toHaveBeenCalledTimes(Object.keys(PRODUCT_SYNONYM_GROUPS).length);
    expect(synonymUpsert).toHaveBeenCalledWith({
      synonyms: PRODUCT_SYNONYM_GROUPS['cpu-processor'],
    });
  });

  it('does not throw when synonym registration fails', async () => {
    const client = {
      collections: jest.fn(() => ({
        retrieve: jest.fn().mockResolvedValue({ fields: [] }),
        documents: () => ({ search: jest.fn() }),
      })),
      synonymSets: jest.fn(() => ({
        upsert: jest.fn().mockRejectedValue(new Error('synonym failure')),
      })),
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '30.2' }),
    }) as any;

    const { service } = makeService(client);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
