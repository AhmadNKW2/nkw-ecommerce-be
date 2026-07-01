import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Coupon, CouponType, CouponStatus } from './entities/coupon.entity';
import { CouponUsage } from './entities/coupon-usage.entity';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ValidateCouponDto } from './dto/validate-coupon.dto';
import { FilterCouponDto } from './dto/filter-coupon.dto';

@Injectable()
export class CouponsService {
  constructor(
    @InjectRepository(Coupon)
    private couponRepository: Repository<Coupon>,
    @InjectRepository(CouponUsage)
    private couponUsageRepository: Repository<CouponUsage>,
  ) {}

  async create(createCouponDto: CreateCouponDto): Promise<Coupon> {
    // Check if coupon code already exists
    const existing = await this.couponRepository.findOne({
      where: { code: createCouponDto.code.toUpperCase() },
    });

    if (existing) {
      throw new ConflictException('Coupon code already exists');
    }

    // Validate percentage coupons
    if (
      createCouponDto.type === CouponType.PERCENTAGE &&
      createCouponDto.value > 100
    ) {
      throw new BadRequestException('Percentage value cannot exceed 100');
    }

    const coupon = this.couponRepository.create({
      ...createCouponDto,
      code: createCouponDto.code.toUpperCase(),
    });

    return await this.couponRepository.save(coupon);
  }

  async findAll(filterDto?: FilterCouponDto) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      type,
      status,
      search,
      minValue,
      maxValue,
    } = filterDto || {};

    const queryBuilder = this.couponRepository.createQueryBuilder('coupon');

    // Filter by type
    if (type) {
      queryBuilder.andWhere('coupon.type = :type', { type });
    }

    // Filter by status
    if (status) {
      queryBuilder.andWhere('coupon.status = :status', { status });
    }

    // Filter by value range
    if (minValue !== undefined) {
      queryBuilder.andWhere('coupon.value >= :minValue', { minValue });
    }
    if (maxValue !== undefined) {
      queryBuilder.andWhere('coupon.value <= :maxValue', { maxValue });
    }

    // Search
    if (search) {
      queryBuilder.andWhere(
        '(coupon.code ILIKE :search OR coupon.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Sorting
    queryBuilder.orderBy(`coupon.${sortBy}`, sortOrder);

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
      message: 'Coupons retrieved successfully',
    };
  }

  async findOne(id: number): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({ where: { id } });

    if (!coupon) {
      throw new NotFoundException('Coupon not found');
    }

    return coupon;
  }

  async findByCode(code: string): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({
      where: { code: code.toUpperCase() },
    });

    if (!coupon) {
      throw new NotFoundException('Coupon not found');
    }

    return coupon;
  }

  async update(id: number, updateCouponDto: UpdateCouponDto): Promise<Coupon> {
    const coupon = await this.findOne(id);

    if (
      updateCouponDto.type === CouponType.PERCENTAGE &&
      updateCouponDto.value &&
      updateCouponDto.value > 100
    ) {
      throw new BadRequestException('Percentage value cannot exceed 100');
    }

    Object.assign(coupon, updateCouponDto);
    return await this.couponRepository.save(coupon);
  }

  async delete(id: number): Promise<void> {
    const coupon = await this.findOne(id);
    await this.couponRepository.remove(coupon);
  }

  async validateCoupon(userId: number, validateDto: ValidateCouponDto) {
    const coupon = await this.findByCode(validateDto.code);

    // Check if coupon is active
    if (coupon.status !== CouponStatus.ACTIVE) {
      throw new BadRequestException('Coupon is not active');
    }

    // Check date validity
    const now = new Date();
    if (coupon.validFrom && new Date(coupon.validFrom) > now) {
      throw new BadRequestException('Coupon is not yet valid');
    }
    if (coupon.validUntil && new Date(coupon.validUntil) < now) {
      throw new BadRequestException('Coupon has expired');
    }

    // Check minimum purchase amount
    if (
      coupon.minPurchaseAmount &&
      validateDto.orderAmount < coupon.minPurchaseAmount
    ) {
      throw new BadRequestException(
        `Minimum purchase amount of ${coupon.minPurchaseAmount} required`,
      );
    }

    // Check total usage limit
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      throw new BadRequestException('Coupon usage limit reached');
    }

    // Check per-user usage limit
    if (coupon.perUserLimit) {
      const userUsageCount = await this.couponUsageRepository.count({
        where: { couponId: coupon.id, userId },
      });

      if (userUsageCount >= coupon.perUserLimit) {
        throw new BadRequestException(
          'You have reached the usage limit for this coupon',
        );
      }
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.type === CouponType.PERCENTAGE) {
      discountAmount = (validateDto.orderAmount * coupon.value) / 100;
      if (
        coupon.maxDiscountAmount &&
        discountAmount > coupon.maxDiscountAmount
      ) {
        discountAmount = coupon.maxDiscountAmount;
      }
    } else {
      discountAmount = coupon.value;
    }

    // Ensure discount doesn't exceed order amount
    if (discountAmount > validateDto.orderAmount) {
      discountAmount = validateDto.orderAmount;
    }

    return {
      data: {
        coupon,
        discountAmount,
        finalAmount: validateDto.orderAmount - discountAmount,
      },
      message: 'Coupon is valid',
    };
  }

  async applyCoupon(
    userId: number,
    couponId: number,
    orderId: string,
    discountAmount: number,
    manager?: EntityManager,
  ) {
    const coupon = await this.findOne(couponId);
    const transactionalManager = manager || this.couponRepository.manager;

    // Increment usage count
    coupon.usageCount += 1;
    await transactionalManager.save(coupon);

    // Record usage
    const usage = this.couponUsageRepository.create({
      couponId,
      userId,
      orderId,
      discountAmount,
    });

    await transactionalManager.save(usage);

    return {
      data: usage,
      message: 'Coupon applied successfully',
    };
  }

  async getUserCouponUsage(userId: number) {
    const usage = await this.couponUsageRepository.find({
      where: { userId },
      relations: {
        coupon: true
      },
      order: { usedAt: 'DESC' },
    });

    return {
      data: usage,
      message: 'Coupon usage history retrieved successfully',
    };
  }
}
