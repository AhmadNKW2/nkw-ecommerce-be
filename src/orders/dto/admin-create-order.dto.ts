import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, PaymentMethod } from '../entities/order.entity';
import { AddressDto } from './create-order.dto';

class AdminOrderItemDto {
  @IsNotEmpty()
  @IsNumber()
  productId: number;

  @IsOptional()
  @IsNumber()
  variantId?: number;

  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  /** Optional vendor override; defaults to the product's vendor. */
  @IsOptional()
  @IsNumber()
  vendorId?: number;
}

export class AdminCreateOrderDto {
  @IsOptional()
  @IsNumber()
  userId?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminOrderItemDto)
  items: AdminOrderItemDto[];

  @IsNotEmpty()
  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress: AddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto;

  @IsNotEmpty()
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  /** Optional override for the order's creation date (ISO date string, e.g. 2026-07-05). */
  @IsOptional()
  @IsDateString()
  orderDate?: string;
}
