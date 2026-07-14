import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, PaymentMethod } from '../entities/order.entity';
import { AddressDto } from './create-order.dto';

class UpdateOrderItemEntry {
  @IsNumber()
  itemId: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  /** Optional vendor override for this line item. */
  @IsOptional()
  @IsNumber()
  vendorId?: number;
}

export class UpdateOrderDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress?: AddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

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

  /** Update per-line price/cost/vendor without changing the linked product. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemEntry)
  items?: UpdateOrderItemEntry[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;
}
