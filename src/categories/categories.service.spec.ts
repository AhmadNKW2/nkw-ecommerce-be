import { CategoriesService } from './categories.service';

describe('CategoriesService category URLs', () => {
  let service: CategoriesService;
  let categoriesRepository: { exists: jest.Mock };
  let categoryUrlsRepository: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(() => {
    categoriesRepository = {
      exists: jest.fn(),
    };

    const categoryUrlQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: 2 }),
    };

    categoryUrlsRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(categoryUrlQueryBuilder),
      create: jest.fn(),
      save: jest.fn(),
    };

    service = new CategoriesService(
      categoriesRepository as never,
      categoryUrlsRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('creates a category URL without any vendor dependency', async () => {
    categoriesRepository.exists.mockResolvedValue(true);
    categoryUrlsRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 77,
        url: 'https://store.example.com/monitors',
        category_id: 9,
        sort_order: 3,
        category: { id: 9, name_en: 'Monitors' },
      });
    categoryUrlsRepository.create.mockImplementation((value) => value);
    categoryUrlsRepository.save.mockResolvedValue({ id: 77 });

    const result = await service.createCategoryUrl({
      url: 'https://store.example.com/monitors',
      category_id: 9,
    });

    expect(categoryUrlsRepository.create).toHaveBeenCalledWith({
      url: 'https://store.example.com/monitors',
      category_id: 9,
      sort_order: 3,
    });
    expect(result).toMatchObject({
      id: 77,
      category_id: 9,
      sort_order: 3,
    });
  });
});