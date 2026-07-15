import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsISO8601,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class CollectAnalyticsEventDto {
  @IsString()
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  path?: string;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}

export class CollectAnalyticsDto {
  @IsString()
  @MaxLength(64)
  browserKey: string;

  @IsString()
  @MaxLength(64)
  sessionKey: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => CollectAnalyticsEventDto)
  events: CollectAnalyticsEventDto[];
}
