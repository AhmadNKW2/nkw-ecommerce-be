import { IsEnum, IsOptional, IsNumber, Min, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { CodCollectionStatus, OrderStatus } from '../entities/order.entity';

export class FilterOrderDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  userId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  /** Exact COD collection status filter. */
  @IsOptional()
  @IsEnum(CodCollectionStatus)
  codCollectionStatus?: CodCollectionStatus;

  /**
   * Convenience filter:
   * - owed = pending (still want money from shipping)
   * - received = cash already taken from shipping
   * - cod = any COD collection row
   */
  @IsOptional()
  @IsIn(['owed', 'received', 'cod'])
  codCollection?: 'owed' | 'received' | 'cod';
}
