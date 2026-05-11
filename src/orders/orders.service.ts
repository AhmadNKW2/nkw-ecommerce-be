import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { CouponsService } from '../coupons/coupons.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { FilterOrderDto } from './dto/filter-order.dto';
import { UpdateOrderItemsCostDto } from './dto/update-order-items-cost.dto';
import { User } from '../users/entities/user.entity';
import { TransactionSource } from '../wallet/entities/wallet-transaction.entity';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';
import { Address } from '../addresses/entities/address.entity';

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
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private couponsService: CouponsService,
    private walletService: WalletService,
    private cartService: CartService,
    private productsService: ProductsService,
    private dataSource: DataSource,
  ) {}

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

  async create(user: User, createOrderDto: CreateOrderDto) {
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
        if (!product.visible || product.status !== 'active') {
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
      if (createOrderDto.couponCode) {
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
      const shippingAmount = 0;

      const totalAmount =
        subtotalAmount + taxAmount + shippingAmount - discountAmount;

      if (totalAmount < 0)
        throw new BadRequestException('Total amount cannot be negative');

      // 4. Payment
      let paymentStatus = PaymentStatus.PENDING;

      if (createOrderDto.paymentMethod === PaymentMethod.WALLET) {
        // Check/Deduct wallet
        await this.walletService.deductFunds(
          user.id,
          totalAmount,
          TransactionSource.PURCHASE,
          'Order Payment',
          undefined,
          queryRunner.manager,
        );
        paymentStatus = PaymentStatus.PAID;
      }

      // 5. Create Order
      const order = this.ordersRepository.create({
        userId: user.id,
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
        paymentMethod: createOrderDto.paymentMethod,
        paymentStatus: paymentStatus,
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

      // 7. Record Coupon Usage
      if (couponId) {
        await this.couponsService.applyCoupon(
          user.id,
          couponId,
          String(savedOrder.id),
          discountAmount,
          queryRunner.manager,
        );
      }

      await this.persistUserShippingAddress(
        user.id,
        createOrderDto.shippingAddress,
        queryRunner,
      );

      await queryRunner.commitTransaction();

      void Promise.allSettled(
        [...touchedProductIds].map((productId) =>
          this.productsService.reindexOne(productId),
        ),
      );

      // Clear Cart
      try {
        await this.cartService.clearCart(user.id);
      } catch (err) {
        console.error('Failed to clear cart after order:', err);
      }

      return this.findOne(savedOrder.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findOne(id: number) {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'user'],
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async findAll(userId: number) {
    return this.ordersRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: ['items', 'items.product'],
    });
  }

  async findAllAdmin(filterDto: FilterOrderDto) {
    const { status, page = 1, limit = 10, search } = filterDto;
    const skip = (page - 1) * limit;

    const query = this.ordersRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .skip(skip)
      .take(limit)
      .orderBy('order.createdAt', 'DESC');

    if (status) {
      query.andWhere('order.status = :status', { status });
    }

    if (search) {
      query.andWhere(
        '(CAST(order.id AS TEXT) LIKE :search OR user.email ILIKE :search OR user.firstName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const [data, total] = await query.getManyAndCount();

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

      if (
        status === OrderStatus.DELIVERED &&
        order.paymentMethod === PaymentMethod.COD
      ) {
        order.paymentStatus = PaymentStatus.PAID;
      }

      await queryRunner.manager.save(Order, order);

      if (
        status === OrderStatus.DELIVERED &&
        order.userId &&
        order.paymentStatus === PaymentStatus.PAID
      ) {
        await this.walletService.applyCashback(
          order.userId,
          Number(order.totalAmount),
          String(order.id),
          queryRunner.manager,
        );
      }

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
      if (
        order.paymentMethod === PaymentMethod.WALLET &&
        order.paymentStatus === PaymentStatus.PAID
      ) {
        await this.walletService.addFunds(
          order.userId,
          {
            amount: order.totalAmount,
            source: TransactionSource.REFUND,
            description: `Refund for Order #${order.id}`,
          },
          queryRunner.manager,
        );
        order.paymentStatus = PaymentStatus.REFUNDED;
      }

      order.status = newStatus;
      await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();

      void Promise.allSettled(
        [...touchedProductIds].map((productId) =>
          this.productsService.reindexOne(productId),
        ),
      );

      return this.findOne(order.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
