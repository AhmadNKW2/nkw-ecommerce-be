import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner, TableColumn } from 'typeorm';
import {
  Order,
  OrderStatus,
} from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatusHistory } from './entities/order-status-history.entity';
import { Product } from '../products/entities/product.entity';
import { CouponsService } from '../coupons/coupons.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { FilterOrderDto } from './dto/filter-order.dto';
import { UpdateOrderItemsCostDto } from './dto/update-order-items-cost.dto';
import { AdminCreateOrderDto } from './dto/admin-create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { User } from '../users/entities/user.entity';
import { hydrateProductMedia, getPrimaryMediaUrl } from '../products/utils/product-media.util';
import { TransactionSource } from '../wallet/entities/wallet-transaction.entity';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';
import { Address } from '../addresses/entities/address.entity';
import { isStorefrontAvailableProduct } from '../products/utils/storefront-product-availability.util';
import { resolveWalletPayment } from './utils/wallet-payment.util';
import { SettingsService } from '../settings/settings.service';
import { calculateOrderShippingAmount } from '../settings/delivery-fee.util';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { Vendor } from '../vendors/entities/vendor.entity';

// ... imports

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

type StoredAddressMetadata = {
  email?: string;
  phone?: string;
  buildingNumber?: string;
  floorNumber?: string;
  apartmentNumber?: string;
  notes?: string;
};

function cleanOptionalText(value?: string | null): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue ? normalizedValue : undefined;
}

function serializeStoredAddressMetadata(metadata: StoredAddressMetadata): string | null {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private ensureSchemaPromise: Promise<void> | null = null;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    @InjectRepository(OrderStatusHistory)
    private orderStatusHistoryRepository: Repository<OrderStatusHistory>,
    private couponsService: CouponsService,
    private walletService: WalletService,
    private cartService: CartService,
    private productsService: ProductsService,
    private settingsService: SettingsService,
    private adminNotificationsService: AdminNotificationsService,
    private dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureSchemaReady();
  }

  private async ensureSchemaReady(): Promise<void> {
    if (this.ensureSchemaPromise) {
      return this.ensureSchemaPromise;
    }

    this.ensureSchemaPromise = Promise.all([
      this.ensureWalletPaymentColumnsExist(),
      this.ensureOrderStatusHistoryTableExists(),
      this.ensureObsoleteOrderStatusesRemoved(),
    ]).then(() => undefined);

    try {
      await this.ensureSchemaPromise;
    } finally {
      this.ensureSchemaPromise = null;
    }
  }

  private async ensureObsoleteOrderStatusesRemoved(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      await queryRunner.query(`
        UPDATE orders SET status = 'pending' WHERE status::text IN ('shipped', 'processing')
      `);
      await queryRunner.query(`
        UPDATE orders SET status = 'refunded' WHERE status::text = 'returned'
      `);

      if (await queryRunner.hasTable('order_status_history')) {
        await queryRunner.query(`
          UPDATE order_status_history SET status = 'pending' WHERE status IN ('shipped', 'processing')
        `);
        await queryRunner.query(`
          UPDATE order_status_history SET status = 'refunded' WHERE status = 'returned'
        `);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureOrderStatusHistoryTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (await queryRunner.hasTable('order_status_history')) {
        return;
      }

      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS order_status_history (
          id SERIAL PRIMARY KEY,
          "orderId" integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          status varchar(30) NOT NULL,
          note character varying,
          "changedBy" character varying,
          "createdAt" timestamp without time zone NOT NULL DEFAULT now()
        );
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id
        ON order_status_history ("orderId");
      `);

      // Backfill history for orders created before this table existed.
      await queryRunner.query(`
        INSERT INTO order_status_history ("orderId", status, note, "changedBy", "createdAt")
        SELECT id, 'pending', 'Order placed', 'system', "createdAt" FROM orders
        WHERE id NOT IN (SELECT DISTINCT "orderId" FROM order_status_history);
      `);
      await queryRunner.query(`
        INSERT INTO order_status_history ("orderId", status, note, "changedBy", "createdAt")
        SELECT id, status, 'Current status', 'system', "updatedAt" FROM orders
        WHERE status <> 'pending';
      `);
    } finally {
      await queryRunner.release();
    }
  }

  private async recordStatusHistory(
    orderId: number,
    status: OrderStatus,
    note?: string,
    entityManager?: QueryRunner['manager'],
  ): Promise<void> {
    const repo = entityManager
      ? entityManager.getRepository(OrderStatusHistory)
      : this.orderStatusHistoryRepository;
    await repo.insert({
      orderId,
      status,
      note,
      changedBy: 'admin',
    });
  }

  private async ensureWalletPaymentColumnsExist(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (await queryRunner.hasColumn('orders', 'walletAppliedAmount')) {
        return;
      }

      await queryRunner.addColumn(
        'orders',
        new TableColumn({
          name: 'walletAppliedAmount',
          type: 'decimal',
          precision: 10,
          scale: 2,
          default: 0,
        }),
      );
    } finally {
      await queryRunner.release();
    }
  }

  private async persistUserShippingAddress(
    userId: number,
    shippingAddress: CreateOrderDto['shippingAddress'],
    queryRunner: QueryRunner,
  ) {
    const street = shippingAddress.street.trim();

    if (!street) {
      return;
    }

    const city = shippingAddress.city.trim();
    const country = shippingAddress.country?.trim() || 'Jordan';
    const metadata = serializeStoredAddressMetadata({
      email: cleanOptionalText(shippingAddress.email),
      phone: cleanOptionalText(shippingAddress.phone),
      buildingNumber: cleanOptionalText(shippingAddress.building),
      floorNumber: cleanOptionalText(shippingAddress.floor),
      apartmentNumber: cleanOptionalText(shippingAddress.apartment),
      notes: cleanOptionalText(shippingAddress.notes),
    });

    const existingAddress = await queryRunner.manager.findOne(Address, {
      where: {
        userId,
        title: 'shipping',
        addressLine1: street,
        city,
        country,
      },
      lock: { mode: 'pessimistic_write' },
    });

    await queryRunner.manager.update(
      Address,
      { userId, isDefault: true },
      { isDefault: false },
    );

    if (existingAddress) {
      existingAddress.addressLine2 = metadata ?? '';
      existingAddress.state = city;
      existingAddress.zipCode = existingAddress.zipCode || '00000';
      existingAddress.isDefault = true;
      await queryRunner.manager.save(Address, existingAddress);
      return;
    }

    const savedAddress = queryRunner.manager.create(Address, {
      title: 'shipping',
      addressLine1: street,
      addressLine2: metadata ?? '',
      city,
      state: city,
      country,
      zipCode: '00000',
      isDefault: true,
      userId,
    });

    await queryRunner.manager.save(Address, savedAddress);
  }

  async create(user: User | null, createOrderDto: CreateOrderDto) {
    await this.ensureSchemaReady();

    if (!user) {
      const toggles = await this.settingsService.getProductFieldToggles();
      if (!toggles.easy_purchase_enabled) {
        throw new ForbiddenException('Authentication required to place an order');
      }

      if (createOrderDto.couponCode) {
        throw new BadRequestException(
          'Coupons are not available for guest checkout',
        );
      }

      if (Number(createOrderDto.walletAppliedAmount ?? 0) > 0) {
        throw new BadRequestException(
          'Wallet payment is not available for guest checkout',
        );
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Process items, validate stock, calculate subtotal
      let subtotalAmount = 0;
      const orderItemsToCreate: any[] = [];
      const touchedProductIds = new Set<number>();

      // Sort items by productId and variantId to avoid deadlocks
      const sortedItems = [...createOrderDto.items].sort((a, b) => {
        if (a.productId !== b.productId) {
          return a.productId - b.productId;
        }
        const aVariant = a.variantId || 0;
        const bVariant = b.variantId || 0;
        return aVariant - bVariant;
      });

      for (const itemDto of sortedItems) {
        const product = await queryRunner.manager.findOne(Product, {
          where: { id: itemDto.productId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!product) {
          throw new NotFoundException(
            `Product #${itemDto.productId} not found`,
          );
        }

        // Check availability
        if (!isStorefrontAvailableProduct(product)) {
          throw new BadRequestException(
            `Product #${product.name_en} is not available`,
          );
        }

        // Check stock
        const availableQuantity = Number(product.quantity ?? 0);
        if (product.is_out_of_stock || availableQuantity < itemDto.quantity) {
          throw new BadRequestException(
            `Insufficient stock for product ${product.name_en}`,
          );
        }

        // Get price directly from product
        const unitPrice =
          product.sale_price !== null && Number(product.sale_price) > 0
            ? Number(product.sale_price)
            : Number(product.price);

        const itemTotal = unitPrice * itemDto.quantity;
        subtotalAmount += itemTotal;

        orderItemsToCreate.push({
          product,
          variantId: itemDto.variantId ?? null,
          vendorId: product.vendor_id,
          quantity: itemDto.quantity,
          price: unitPrice,
          cost: itemDto.cost ?? product.cost ?? 0,
          totalPrice: itemTotal,
          productSnapshot: {
            name_en: product.name_en,
            name_ar: product.name_ar,
            sku: product.sku,
          },
        });

        product.quantity = availableQuantity - itemDto.quantity;
        if (product.quantity === 0) {
          product.is_out_of_stock = true;
        }
        await queryRunner.manager.save(Product, product);
        touchedProductIds.add(product.id);
      }

      let discountAmount = 0;
      let couponId: number | null = null;

      // 2. Apply Coupon
      if (createOrderDto.couponCode && user) {
        try {
          const validation = await this.couponsService.validateCoupon(user.id, {
            code: createOrderDto.couponCode,
            orderAmount: subtotalAmount,
          });

          // Extract data from response structure: { data: { coupon, discountAmount, ... }, message: ... }
          const data = validation['data'];
          discountAmount = Number(data.discountAmount);
          couponId = Number(data.coupon.id);
        } catch (e) {
          throw new BadRequestException(
            getErrorMessage(e) || 'Invalid coupon',
          );
        }
      }

      // 3. Totals
      const taxAmount = 0;
      const seoSettings = await this.settingsService.getSeoSettings();
      const shippingAmount = calculateOrderShippingAmount(subtotalAmount, seoSettings);

      const totalAmount =
        subtotalAmount + taxAmount + shippingAmount - discountAmount;

      if (totalAmount < 0)
        throw new BadRequestException('Total amount cannot be negative');

      // 4. Payment
      const walletPayment = resolveWalletPayment({
        totalAmount,
        paymentMethod: createOrderDto.paymentMethod,
        walletAppliedAmount: createOrderDto.walletAppliedAmount,
      });

      if (walletPayment.walletAppliedAmount > 0 && user) {
        await this.walletService.deductFunds(
          user.id,
          walletPayment.walletAppliedAmount,
          TransactionSource.PURCHASE,
          'Order Payment',
          undefined,
          queryRunner.manager,
        );
      }

      // 5. Create Order
      const order = this.ordersRepository.create({
        userId: user?.id ?? null,
        status: OrderStatus.PENDING,
        subtotalAmount,
        taxAmount,
        shippingAmount,
        discountAmount,
        totalAmount,
        couponId,
        shippingAddress: createOrderDto.shippingAddress,
        billingAddress:
          createOrderDto.billingAddress || createOrderDto.shippingAddress,
        paymentMethod: walletPayment.paymentMethod,
        walletAppliedAmount: walletPayment.walletAppliedAmount,
        notes: createOrderDto.notes,
      });

      const savedOrder = await queryRunner.manager.save(Order, order);

      // 6. Create Order Items
      for (const itemData of orderItemsToCreate) {
        const orderItem = this.orderItemsRepository.create({
          orderId: savedOrder.id,
          productId: itemData.product.id,
          variantId: itemData.variantId,
          vendorId: itemData.vendorId,
          quantity: itemData.quantity,
          price: itemData.price,
          cost: itemData.cost, // Calculated at time of purchase
          totalPrice: itemData.totalPrice,
          productSnapshot: itemData.productSnapshot,
        });
        await queryRunner.manager.save(OrderItem, orderItem);
      }

      await this.recordStatusHistory(
        savedOrder.id,
        OrderStatus.PENDING,
        'Order placed',
        queryRunner.manager,
      );

      // 7. Record Coupon Usage
      if (couponId && user) {
        await this.couponsService.applyCoupon(
          user.id,
          couponId,
          String(savedOrder.id),
          discountAmount,
          queryRunner.manager,
        );
      }

      if (user) {
        await this.persistUserShippingAddress(
          user.id,
          createOrderDto.shippingAddress,
          queryRunner,
        );
      }

      await queryRunner.commitTransaction();

      // Clear Cart
      if (user) {
        try {
          await this.cartService.clearCart(user.id);
        } catch (err) {
          console.error('Failed to clear cart after order:', err);
        }
      }

      this.adminNotificationsService.publishOrderCreated(savedOrder.id);
      return this.findOne(savedOrder.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Admin-facing order creation. Allows an admin to build an order on behalf
   * of an existing customer (by userId) or a guest, with explicit control
   * over price overrides, payment/status, and shipping cost.
   */
  async createByAdmin(dto: AdminCreateOrderDto) {
    await this.ensureSchemaReady();

    let targetUser: User | null = null;
    if (dto.userId) {
      targetUser = await this.dataSource
        .getRepository(User)
        .findOne({ where: { id: dto.userId } });
      if (!targetUser) {
        throw new NotFoundException(`Customer #${dto.userId} not found`);
      }
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('An order must contain at least one item');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let subtotalAmount = 0;
      const orderItemsToCreate: any[] = [];

      const sortedItems = [...dto.items].sort((a, b) => {
        if (a.productId !== b.productId) {
          return a.productId - b.productId;
        }
        return (a.variantId || 0) - (b.variantId || 0);
      });

      for (const itemDto of sortedItems) {
        const product = await queryRunner.manager.findOne(Product, {
          where: { id: itemDto.productId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!product) {
          throw new NotFoundException(`Product #${itemDto.productId} not found`);
        }

        const availableQuantity = Number(product.quantity ?? 0);
        if (availableQuantity < itemDto.quantity) {
          throw new BadRequestException(
            `Insufficient stock for product ${product.name_en}`,
          );
        }

        const unitPrice =
          itemDto.price != null
            ? Number(itemDto.price)
            : product.sale_price !== null && Number(product.sale_price) > 0
              ? Number(product.sale_price)
              : Number(product.price);

        const itemTotal = unitPrice * itemDto.quantity;
        subtotalAmount += itemTotal;

        const vendorId =
          itemDto.vendorId !== undefined && itemDto.vendorId !== null
            ? Number(itemDto.vendorId)
            : product.vendor_id ?? null;

        if (vendorId != null) {
          const vendor = await queryRunner.manager.findOne(Vendor, {
            where: { id: vendorId },
          });
          if (!vendor) {
            throw new NotFoundException(`Vendor #${vendorId} not found`);
          }
        }

        orderItemsToCreate.push({
          product,
          variantId: itemDto.variantId ?? null,
          vendorId,
          quantity: itemDto.quantity,
          price: unitPrice,
          cost: itemDto.cost ?? product.cost ?? 0,
          totalPrice: itemTotal,
          productSnapshot: {
            name_en: product.name_en,
            name_ar: product.name_ar,
            sku: product.sku,
          },
        });

        product.quantity = availableQuantity - itemDto.quantity;
        if (product.quantity === 0) {
          product.is_out_of_stock = true;
        }
        await queryRunner.manager.save(Product, product);
      }

      const taxAmount = 0;
      const shippingAmount =
        dto.shippingAmount !== undefined
          ? Number(dto.shippingAmount)
          : calculateOrderShippingAmount(
              subtotalAmount,
              await this.settingsService.getSeoSettings(),
            );
      const discountAmount = Number(dto.discountAmount ?? 0);
      const totalAmount = subtotalAmount + taxAmount + shippingAmount - discountAmount;

      if (totalAmount < 0) {
        throw new BadRequestException('Total amount cannot be negative');
      }

      const order = this.ordersRepository.create({
        userId: targetUser?.id ?? null,
        status: dto.status ?? OrderStatus.PENDING,
        subtotalAmount,
        taxAmount,
        shippingAmount,
        discountAmount,
        totalAmount,
        shippingAddress: dto.shippingAddress,
        billingAddress: dto.billingAddress || dto.shippingAddress,
        paymentMethod: dto.paymentMethod,
        walletAppliedAmount: 0,
        notes: dto.notes,
        trackingNumber: dto.trackingNumber,
        ...(dto.orderDate ? { createdAt: new Date(dto.orderDate) } : {}),
      });

      const savedOrder = await queryRunner.manager.save(Order, order);

      for (const itemData of orderItemsToCreate) {
        const orderItem = this.orderItemsRepository.create({
          orderId: savedOrder.id,
          productId: itemData.product.id,
          variantId: itemData.variantId,
          vendorId: itemData.vendorId,
          quantity: itemData.quantity,
          price: itemData.price,
          cost: itemData.cost,
          totalPrice: itemData.totalPrice,
          productSnapshot: itemData.productSnapshot,
        });
        await queryRunner.manager.save(OrderItem, orderItem);
      }

      await this.recordStatusHistory(
        savedOrder.id,
        savedOrder.status,
        'Order created by admin',
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      this.adminNotificationsService.publishOrderCreated(savedOrder.id);
      return this.findOne(savedOrder.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Admin-facing general order update: shipping/billing address, notes,
   * tracking number, payment method/status, and status. Status transitions
   * to cancelled/refunded (and their stock/wallet side effects) are delegated
   * to the existing specialized handlers.
   */
  async update(id: number, dto: UpdateOrderDto) {
    const existingOrder = await this.findOne(id);

    if (dto.status && dto.status !== existingOrder.status) {
      if (dto.status === OrderStatus.CANCELLED || dto.status === OrderStatus.REFUNDED) {
        await this.processCancellation(existingOrder, dto.status);
      } else {
        await this.updateStatus(id, dto.status);
      }
    }

    const fieldsToUpdate: Record<string, any> = {};
    if (dto.shippingAddress !== undefined) {
      fieldsToUpdate.shippingAddress = dto.shippingAddress;
    }
    if (dto.billingAddress !== undefined) {
      fieldsToUpdate.billingAddress = dto.billingAddress;
    }
    if (dto.notes !== undefined) {
      fieldsToUpdate.notes = dto.notes;
    }
    if (dto.trackingNumber !== undefined) {
      fieldsToUpdate.trackingNumber = dto.trackingNumber;
    }
    if (dto.orderDate !== undefined) {
      fieldsToUpdate.createdAt = new Date(dto.orderDate);
    }
    if (dto.paymentMethod !== undefined) {
      fieldsToUpdate.paymentMethod = dto.paymentMethod;
    }

    if (dto.items !== undefined) {
      const itemSync = await this.syncOrderItems(id, existingOrder, dto.items, {
        shippingAmount: dto.shippingAmount,
        discountAmount: dto.discountAmount,
        status: dto.status,
      });
      Object.assign(fieldsToUpdate, itemSync);
    } else if (
      dto.shippingAmount !== undefined ||
      dto.discountAmount !== undefined
    ) {
      const subtotalAmount = Number(existingOrder.subtotalAmount);
      const shippingAmount =
        dto.shippingAmount !== undefined
          ? Number(dto.shippingAmount)
          : Number(existingOrder.shippingAmount);
      const discountAmount =
        dto.discountAmount !== undefined
          ? Number(dto.discountAmount)
          : Number(existingOrder.discountAmount);
      const taxAmount = Number(existingOrder.taxAmount ?? 0);

      fieldsToUpdate.shippingAmount = shippingAmount;
      fieldsToUpdate.discountAmount = discountAmount;
      fieldsToUpdate.totalAmount =
        subtotalAmount + taxAmount + shippingAmount - discountAmount;
    }

    if (Object.keys(fieldsToUpdate).length > 0) {
      await this.ordersRepository.update(id, fieldsToUpdate);
    }

    return this.findOne(id);
  }

  /**
   * Replace the order's line items with the desired list from an admin update.
   * Adjusts product stock for active (non-cancelled/refunded) orders.
   */
  private async syncOrderItems(
    orderId: number,
    existingOrder: Order,
    entries: NonNullable<UpdateOrderDto['items']>,
    amounts: {
      shippingAmount?: number;
      discountAmount?: number;
      status?: OrderStatus;
    },
  ): Promise<Record<string, number>> {
    if (!entries.length) {
      throw new BadRequestException('Order must have at least one item');
    }

    const effectiveStatus = amounts.status ?? existingOrder.status;
    const shouldAdjustStock =
      effectiveStatus !== OrderStatus.CANCELLED &&
      effectiveStatus !== OrderStatus.REFUNDED;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existingItems = await queryRunner.manager.find(OrderItem, {
        where: { orderId },
      });
      const existingById = new Map(existingItems.map((item) => [item.id, item]));
      const keptIds = new Set<number>();
      const stockDelta = new Map<number, number>();

      const bumpStock = (productId: number | null | undefined, delta: number) => {
        if (!shouldAdjustStock || productId == null || delta === 0) return;
        stockDelta.set(productId, (stockDelta.get(productId) || 0) + delta);
      };

      const ensureVendor = async (vendorId: number | null | undefined) => {
        if (vendorId == null) return;
        const vendor = await queryRunner.manager.findOne(Vendor, {
          where: { id: vendorId },
        });
        if (!vendor) {
          throw new NotFoundException(`Vendor #${vendorId} not found`);
        }
      };

      const loadProduct = async (productId: number) => {
        const product = await queryRunner.manager.findOne(Product, {
          where: { id: productId },
        });
        if (!product) {
          throw new NotFoundException(`Product #${productId} not found`);
        }
        return product;
      };

      const toSave: OrderItem[] = [];
      let subtotalAmount = 0;

      for (const entry of entries) {
        if (entry.itemId != null) {
          const item = existingById.get(entry.itemId);
          if (!item) {
            throw new NotFoundException(
              `Order item #${entry.itemId} not found in order #${orderId}`,
            );
          }
          keptIds.add(item.id);

          const previousProductId = item.productId;
          const previousQuantity = item.quantity;
          const nextProductId = entry.productId ?? item.productId;
          const nextQuantity = entry.quantity ?? item.quantity;

          if (!nextProductId) {
            throw new BadRequestException(
              `Product is required for order item #${entry.itemId}`,
            );
          }
          if (nextQuantity < 1) {
            throw new BadRequestException(
              `Quantity must be at least 1 for order item #${entry.itemId}`,
            );
          }

          let productSnapshot = item.productSnapshot;
          if (nextProductId !== previousProductId) {
            const product = await loadProduct(nextProductId);
            productSnapshot = {
              name_en: product.name_en,
              name_ar: product.name_ar,
              sku: product.sku,
            };
            if (entry.vendorId === undefined && item.vendorId == null) {
              item.vendorId = product.vendor_id ?? null;
            }
            bumpStock(previousProductId, previousQuantity);
            bumpStock(nextProductId, -nextQuantity);
          } else if (nextQuantity !== previousQuantity) {
            bumpStock(previousProductId, previousQuantity - nextQuantity);
          }

          if (entry.price !== undefined) {
            item.price = entry.price;
          }
          if (entry.cost !== undefined) {
            item.cost = entry.cost;
          }
          if (entry.vendorId !== undefined) {
            await ensureVendor(entry.vendorId);
            item.vendorId = entry.vendorId;
          }
          if (entry.variantId !== undefined) {
            item.variantId = entry.variantId;
          }

          item.productId = nextProductId;
          item.quantity = nextQuantity;
          item.productSnapshot = productSnapshot;
          item.totalPrice = Number(item.price) * nextQuantity;
          toSave.push(item);
          subtotalAmount += Number(item.price) * nextQuantity;
        } else {
          if (entry.productId == null) {
            throw new BadRequestException(
              'productId is required when adding a new order item',
            );
          }
          const quantity = entry.quantity ?? 1;
          if (quantity < 1) {
            throw new BadRequestException('Quantity must be at least 1');
          }

          const product = await loadProduct(entry.productId);
          const unitPrice =
            entry.price != null
              ? Number(entry.price)
              : product.sale_price !== null && Number(product.sale_price) > 0
                ? Number(product.sale_price)
                : Number(product.price);
          const unitCost =
            entry.cost != null ? Number(entry.cost) : Number(product.cost ?? 0);
          const vendorId =
            entry.vendorId !== undefined
              ? entry.vendorId
              : (product.vendor_id ?? null);
          await ensureVendor(vendorId);

          bumpStock(entry.productId, -quantity);

          const created = queryRunner.manager.create(OrderItem, {
            orderId,
            productId: entry.productId,
            variantId: entry.variantId,
            vendorId: vendorId ?? undefined,
            quantity,
            price: unitPrice,
            cost: unitCost,
            totalPrice: unitPrice * quantity,
            productSnapshot: {
              name_en: product.name_en,
              name_ar: product.name_ar,
              sku: product.sku,
            },
          });
          toSave.push(created);
          subtotalAmount += unitPrice * quantity;
        }
      }

      for (const existing of existingItems) {
        if (!keptIds.has(existing.id)) {
          bumpStock(existing.productId, existing.quantity);
          await queryRunner.manager.delete(OrderItem, { id: existing.id });
        }
      }

      const productIds = [...stockDelta.keys()].sort((a, b) => a - b);
      for (const productId of productIds) {
        const delta = stockDelta.get(productId) || 0;
        const product = await queryRunner.manager.findOne(Product, {
          where: { id: productId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!product) {
          throw new NotFoundException(`Product #${productId} not found`);
        }
        const nextQty = Number(product.quantity ?? 0) + delta;
        if (nextQty < 0) {
          throw new BadRequestException(
            `Insufficient stock for product ${product.name_en}`,
          );
        }
        product.quantity = nextQty;
        product.is_out_of_stock = nextQty === 0;
        await queryRunner.manager.save(Product, product);
      }

      await queryRunner.manager.save(OrderItem, toSave);

      const shippingAmount =
        amounts.shippingAmount !== undefined
          ? Number(amounts.shippingAmount)
          : Number(existingOrder.shippingAmount);
      const discountAmount =
        amounts.discountAmount !== undefined
          ? Number(amounts.discountAmount)
          : Number(existingOrder.discountAmount);
      const taxAmount = Number(existingOrder.taxAmount ?? 0);

      await queryRunner.commitTransaction();

      return {
        subtotalAmount,
        shippingAmount,
        discountAmount,
        totalAmount: subtotalAmount + taxAmount + shippingAmount - discountAmount,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Attach a resolved `image` URL to each order item's product by hydrating
   * the productMedia -> media relation chain (loaded via `attachOrderItemImages`
   * relations/joins). Mutates and returns the same order.
   */
  private attachOrderImages(order: Order): Order {
    order.items?.forEach((item) => {
      if (item.product) {
        const hydrated = hydrateProductMedia(item.product as any, true);
        (item.product as any).image = getPrimaryMediaUrl(hydrated as any) ?? null;
      }
    });
    return order;
  }

  async findOne(id: number) {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: {
        items: {
          product: {
            productMedia: { media: true },
          },
          vendor: true,
        },
        user: true,
        statusHistory: true,
      },
      order: {
        statusHistory: { createdAt: 'ASC' },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.attachOrderImages(order);
  }

  async findAll(userId: number) {
    const orders = await this.ordersRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: {
        items: {
          product: {
            productMedia: { media: true },
          },
        },
      },
    });
    return orders.map((order) => this.attachOrderImages(order));
  }

  async findAllAdmin(filterDto: FilterOrderDto) {
    const { status, userId, page = 1, limit = 10, search } = filterDto;
    const skip = (page - 1) * limit;

    const query = this.ordersRepository
      .createQueryBuilder('ord')
      .leftJoinAndSelect('ord.user', 'user')
      .leftJoinAndSelect('ord.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .leftJoinAndSelect('items.vendor', 'vendor')
      .leftJoinAndSelect('product.productMedia', 'productMedia')
      .leftJoinAndSelect('productMedia.media', 'media')
      // Select a sort key (no "." in the orderBy name — TypeORM treats pre-dot text as an alias).
      .addSelect(
        `CASE WHEN ord.status = :cancelledStatus THEN 1 ELSE 0 END`,
        'cancelled_sort_key',
      )
      .setParameter('cancelledStatus', OrderStatus.CANCELLED)
      .orderBy('cancelled_sort_key', 'ASC')
      .addOrderBy('ord.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (status) {
      query.andWhere('ord.status = :status', { status });
    }

    if (userId) {
      query.andWhere('ord.userId = :userId', { userId });
    }

    if (search) {
      query.andWhere(
        '(CAST(ord.id AS TEXT) LIKE :search OR user.email ILIKE :search OR user.firstName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const [rawData, total] = await query.getManyAndCount();
    const data = rawData.map((order) => this.attachOrderImages(order));

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

  async cancel(id: number, userId: number) {
    const order = await this.findOne(id);
    if (order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    return this.processCancellation(order, OrderStatus.CANCELLED);
  }

  async updateStatus(id: number, status: OrderStatus) {
    const existingOrder = await this.findOne(id);

    if (existingOrder.status === status) return existingOrder;

    // Handle Cancellation/Refund by Admin
    if (status === OrderStatus.CANCELLED || status === OrderStatus.REFUNDED) {
      return this.processCancellation(existingOrder, status);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      order.status = status;

      await queryRunner.manager.save(Order, order);

      if (status === OrderStatus.DELIVERED && order.userId) {
        await this.walletService.applyCashback(
          order.userId,
          Number(order.totalAmount),
          String(order.id),
          queryRunner.manager,
        );
      }

      await this.recordStatusHistory(id, status, undefined, queryRunner.manager);

      await queryRunner.commitTransaction();

      return this.findOne(id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateItemsCost(orderId: number, dto: UpdateOrderItemsCostDto) {
    const order = await this.findOne(orderId);

    const itemMap = new Map(order.items.map((i) => [i.id, i]));

    const toSave: OrderItem[] = [];
    for (const entry of dto.items) {
      const item = itemMap.get(entry.itemId);
      if (!item) {
        throw new NotFoundException(
          `Order item #${entry.itemId} not found in order #${orderId}`,
        );
      }
      item.cost = entry.cost;
      toSave.push(item);
    }

    await this.orderItemsRepository.save(toSave);
    return this.findOne(orderId);
  }

  /**
   * Permanently remove an order. Restores stock (and refunds any wallet
   * amount applied) unless the order was already cancelled/refunded, since
   * those side effects were already handled at that point.
   */
  async remove(id: number) {
    const order = await this.findOne(id);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const alreadyReconciled =
        order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED;

      if (!alreadyReconciled) {
        for (const item of order.items) {
          if (item.productId) {
            const product = await queryRunner.manager.findOne(Product, {
              where: { id: item.productId },
              lock: { mode: 'pessimistic_write' },
            });

            if (product) {
              product.quantity = Number(product.quantity ?? 0) + item.quantity;
              product.is_out_of_stock = false;
              await queryRunner.manager.save(Product, product);
            }
          }
        }

        const walletAppliedAmount = Number(order.walletAppliedAmount ?? 0);
        if (walletAppliedAmount > 0 && order.userId) {
          await this.walletService.addFunds(
            order.userId,
            {
              amount: walletAppliedAmount,
              source: TransactionSource.REFUND,
              description: `Refund for deleted Order #${order.id}`,
            },
            queryRunner.manager,
          );
        }
      }

      await queryRunner.manager.delete(OrderItem, { orderId: id });
      await queryRunner.manager.delete(Order, id);

      await queryRunner.commitTransaction();

      return { success: true, id };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async processCancellation(order: Order, newStatus: OrderStatus) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const touchedProductIds = new Set<number>();

    try {
      // Restore Stock
      for (const item of order.items) {
        if (item.productId) {
          const product = await queryRunner.manager.findOne(Product, {
            where: { id: item.productId },
            lock: { mode: 'pessimistic_write' },
          });

          if (product) {
            product.quantity += item.quantity;
            await queryRunner.manager.save(product);
            touchedProductIds.add(product.id);
          }
        }
      }

      // Refund Wallet
      const walletAppliedAmount = Number(order.walletAppliedAmount ?? 0);

      if (walletAppliedAmount > 0 && order.userId) {
        await this.walletService.addFunds(
          order.userId,
          {
            amount: walletAppliedAmount,
            source: TransactionSource.REFUND,
            description: `Refund for Order #${order.id}`,
          },
          queryRunner.manager,
        );
      }

      order.status = newStatus;
      await queryRunner.manager.save(order);

      await this.recordStatusHistory(
        order.id,
        newStatus,
        newStatus === OrderStatus.REFUNDED ? 'Order refunded' : 'Order cancelled',
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      return this.findOne(order.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
