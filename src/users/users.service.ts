import {
  Injectable,
  ConflictException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, TableColumn } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { FilterUserDto } from './dto/filter-user.dto';
import { Wishlist } from '../wishlist/entities/wishlist.entity';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { Address } from '../addresses/entities/address.entity';
import { Order } from '../orders/entities/order.entity';
import { CartService } from '../cart/cart.service';
import { WalletService } from '../wallet/wallet.service';
import {
  getPrimaryMediaUrl,
  hydrateProductMedia,
} from '../products/utils/product-media.util';
import {
  normalizeAdminAccess,
  resolveAdminAccess,
} from './utils/admin-access.util';
import type { AdminAccess } from './admin-access.constants';

type SanitizedUser = Omit<User, 'password'> & {
  adminAccess: AdminAccess;
};

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Wishlist)
    private wishlistRepository: Repository<Wishlist>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Address)
    private addressRepository: Repository<Address>,
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private cartService: CartService,
    private walletService: WalletService,
    private dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureAdminAccessColumn();
    await this.ensureConstantAccessTokenColumn();
    await this.ensureVendorIdColumn();
    await this.ensureUserRoleEnumValues();
  }

  private async ensureUserRoleEnumValues(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'users_role_enum' AND e.enumlabel = 'vendor_admin'
          ) THEN
            ALTER TYPE users_role_enum ADD VALUE 'vendor_admin';
          END IF;
        END $$;
      `);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'users_role_enum' AND e.enumlabel = 'store_admin'
          ) THEN
            ALTER TYPE users_role_enum ADD VALUE 'store_admin';
          END IF;
        END $$;
      `);
    } catch (error) {
      // Enum type name may differ across environments; column migration still applies.
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureVendorIdColumn(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasColumn('users', 'vendor_id'))) {
        await queryRunner.addColumn(
          'users',
          new TableColumn({
            name: 'vendor_id',
            type: 'int',
            isNullable: true,
          }),
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureConstantAccessTokenColumn(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasColumn('users', 'constant_access_token'))) {
        await queryRunner.addColumn(
          'users',
          new TableColumn({
            name: 'constant_access_token',
            type: 'text',
            isNullable: true,
          }),
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  async getConstantAccessToken(userId: number): Promise<string | null> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: { id: true, constant_access_token: true },
    });

    return user?.constant_access_token ?? null;
  }

  async setConstantAccessToken(userId: number, token: string): Promise<void> {
    await this.usersRepository.update(userId, {
      constant_access_token: token,
    });
  }

  private async ensureAdminAccessColumn(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasColumn('users', 'admin_access'))) {
        await queryRunner.addColumn(
          'users',
          new TableColumn({
            name: 'admin_access',
            type: 'jsonb',
            isNullable: true,
          }),
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  private buildStoredAdminAccess(
    role: UserRole,
    adminAccess?: Partial<AdminAccess> | null,
  ): AdminAccess | null {
    if (
      role !== UserRole.ADMIN &&
      role !== UserRole.CATALOG_MANAGER &&
      role !== UserRole.CONSTANT_TOKEN_ADMIN &&
      role !== UserRole.VENDOR_ADMIN &&
      role !== UserRole.STORE_ADMIN
    ) {
      return null;
    }

    if (!adminAccess) {
      return null;
    }

    const normalized = normalizeAdminAccess(adminAccess);
    if (!normalized) {
      return null;
    }

    return normalized;
  }

  sanitizeUser(user: User): SanitizedUser {
    const { password, ...userWithoutPassword } = user;
    return {
      ...userWithoutPassword,
      adminAccess: resolveAdminAccess(user),
    };
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const { product_ids, adminAccess, vendor_id, ...userData } = createUserDto;
    userData.email = userData.email.toLowerCase().trim();

    const existingUser = await this.usersRepository.findOne({
      where: { email: userData.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(userData.password, 10);
    const role = userData.role || UserRole.USER;

    if (
      (role === UserRole.VENDOR_ADMIN || role === UserRole.STORE_ADMIN) &&
      (!vendor_id || vendor_id <= 0)
    ) {
      throw new ConflictException('vendor_id is required for vendor/store admins');
    }

    const user = this.usersRepository.create({
      ...userData,
      password: hashedPassword,
      role,
      vendor_id:
        role === UserRole.VENDOR_ADMIN || role === UserRole.STORE_ADMIN
          ? vendor_id
          : null,
      adminAccess: this.buildStoredAdminAccess(role, adminAccess),
    });

    const savedUser = await this.usersRepository.save(user);

    // Sync products to wishlist if provided
    if (product_ids && product_ids.length > 0) {
      await this.syncProductsToWishlist(savedUser.id, product_ids);
    }

    return savedUser;
  }

  async findAll(filterDto?: FilterUserDto) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      roles,
      isActive,
      search,
    } = filterDto || {};

    const queryBuilder = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.email',
        'user.firstName',
        'user.lastName',
        'user.role',
        'user.isActive',
        'user.createdAt',
        'user.updatedAt',
      ]);

    // Filter by multiple roles
    if (roles && roles.length > 0) {
      queryBuilder.andWhere('user.role IN (:...roles)', { roles });
    }

    // Filter by isActive
    if (isActive !== undefined) {
      queryBuilder.andWhere('user.isActive = :isActive', { isActive });
    }

    // Search
    if (search) {
      queryBuilder.andWhere(
        '(user.email ILIKE :search OR user.firstName ILIKE :search OR user.lastName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Sorting
    queryBuilder.orderBy(`user.${sortBy}`, sortOrder);

    // Pagination
    queryBuilder.skip((page - 1) * limit).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get user's wishlist with full product details
    const wishlistItems = await this.wishlistRepository.find({
      where: { user_id: id },
      relations: {
        product: {
          productMedia: {
            media: true
          },

          vendor: true,
          category: true,

          productCategories: {
            category: true
          },

          attributes: {
            attribute: true
          }
        }
      },
      order: { created_at: 'DESC' },
    });

    // Map wishlist items with full product details
    const wishlist = wishlistItems.map((item) => {
      const product = item.product
        ? hydrateProductMedia(item.product, true)
        : null;
      const image = getPrimaryMediaUrl(product);

      return {
        id: item.id,
        product_id: item.product_id,
        added_at: item.created_at,
        product: product
          ? {
              id: product.id,
              name_en: product.name_en,
              name_ar: product.name_ar,
              sku: product.sku,
              short_description_en: product.short_description_en,
              short_description_ar: product.short_description_ar,
              long_description_en: product.long_description_en,
              long_description_ar: product.long_description_ar,
              status: product.status,
              visible: product.visible,
              image,
              average_rating: product.average_rating,
              total_ratings: product.total_ratings,
              created_at: product.created_at,
              vendor: product.vendor
                ? {
                    id: product.vendor.id,
                    name_en: product.vendor.name_en,
                    name_ar: product.vendor.name_ar,
                    logo: product.vendor.logo,
                  }
                : null,
              category: product.category
                ? {
                    id: product.category.id,
                    name_en: product.category.name_en,
                    name_ar: product.category.name_ar,
                  }
                : null,
              categories:
                product.productCategories?.map((pc) => ({
                  id: pc.category?.id,
                  name_en: pc.category?.name_en,
                  name_ar: pc.category?.name_ar,
                })) || [],
              media:
                product.media?.map((m) => ({
                  id: m.id,
                  url: m.url,
                  type: m.type,
                  is_primary: m.is_primary,
                })) || [],
              price: product.price,
              sale_price: product.sale_price,
              quantity: product.quantity,
              is_out_of_stock: product.is_out_of_stock,
              attributes:
                product.attributes?.map((attr) => ({
                  id: attr.id,
                  attribute: attr.attribute
                    ? {
                        id: attr.attribute.id,
                        name_en: attr.attribute.name_en,
                        name_ar: attr.attribute.name_ar,
                      }
                    : null,
                })) || [],
            }
          : null,
      };
    });

    // Exclude password from response
    const userWithoutPassword = this.sanitizeUser(user);

    const [addresses, cart, walletResponse, transactionsResponse, orders] =
      await Promise.all([
        this.addressRepository.find({
          where: { userId: id },
          order: { isDefault: 'DESC', createdAt: 'DESC' },
        }),
        this.cartService.getCart(id).catch(() => ({
          id: null,
          user_id: id,
          items: [],
          total_amount: 0,
        })),
        this.walletService.getWallet(id),
        this.walletService.getTransactions(id, { page: 1, limit: 20 }),
        this.ordersRepository.find({
          where: { userId: id },
          relations: {
            items: {
              product: true
            }
          },
          order: { createdAt: 'DESC' },
          take: 20,
        }),
      ]);

    const wallet = walletResponse.data;

    return {
      ...userWithoutPassword,
      wishlist,
      addresses,
      cart,
      wallet: {
        balance: Number(wallet.balance),
        totalCashback: Number(wallet.totalCashback),
      },
      transactions: transactionsResponse.data,
      orders,
    };
  }

  async findOneById(id: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return await this.usersRepository.findOne({ where: { email: email.toLowerCase().trim() } });
  }

  async findByAppleId(appleId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { appleId } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { googleId } });
  }

  async validatePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  async updatePassword(userId: number, newPassword: string): Promise<void> {
    const user = await this.findOneById(userId);
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await this.usersRepository.save(user);
  }

  // Update user (including role)
  async update(id: number, updateUserDto: UpdateUserDto): Promise<User> {
    const { product_ids, adminAccess, ...updateData } = updateUserDto;
    const user = await this.findOneById(id);

    Object.assign(user, updateData);

    if (adminAccess !== undefined) {
      user.adminAccess = this.buildStoredAdminAccess(user.role, adminAccess);
    }

    const savedUser = await this.usersRepository.save(user);

    // Sync products to wishlist if provided
    if (product_ids !== undefined) {
      await this.syncProductsToWishlist(id, product_ids);
    }

    return savedUser;
  }

  /**
   * Sync products to user's wishlist (replaces existing wishlist)
   */
  private async syncProductsToWishlist(
    userId: number,
    product_ids: number[],
  ): Promise<void> {
    // Remove all existing wishlist items for this user
    await this.wishlistRepository.delete({ user_id: userId });

    if (product_ids.length === 0) return;

    // Validate products exist and are active
    const validProducts = await this.productRepository.find({
      where: { id: In(product_ids), status: ProductStatus.ACTIVE },
      select: {
        id: true
      },
    });

    const validProductIds = validProducts.map((p) => p.id);

    // Create new wishlist items
    const wishlistItems = validProductIds.map((productId) =>
      this.wishlistRepository.create({
        user_id: userId,
        product_id: productId,
      }),
    );

    if (wishlistItems.length > 0) {
      await this.wishlistRepository.save(wishlistItems);
    }
  }

  // Delete user
  async remove(id: number): Promise<void> {
    const user = await this.findOneById(id);
    await this.usersRepository.remove(user);
  }
}
