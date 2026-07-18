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
import {
  CodCollectionStatus,
  OrderStatus,
  PaymentMethod,
} from '../entities/order.entity';
import { AddressDto } from './create-order.dto';

/** Exported so ValidationPipe whitelist metadata is preserved for nested items. */
export class UpdateOrderItemEntry {
  /** Existing line item id. Omit when adding a new product to the order. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  itemId?: number;

  /** Required when adding a new line (no itemId). Optional when updating an existing line. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  productId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  variantId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cost?: number;

  /** Optional vendor override for this line item. */
  @IsOptional()
  @Type(() => Number)
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

  /**
   * Full desired line-item list for the order.
   * - Entries with `itemId` update that line (qty/price/cost/vendor/product).
   * - Entries without `itemId` add a new line (`productId` + `quantity` required).
   * - Existing lines omitted from the list are removed.
   */
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

  /** Shipping-company remittance status for COD cash. */
  @IsOptional()
  @IsEnum(CodCollectionStatus)
  codCollectionStatus?: CodCollectionStatus;
}
