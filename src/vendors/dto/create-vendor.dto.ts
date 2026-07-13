import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsBoolean,
  IsEnum,
  ValidateNested,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VendorStatus } from '../entities/vendor.entity';
import {
  parseProductChangesInput,
  ProductChangesDto,
} from '../../common/dto/product-changes.dto';

export class CreateVendorDto {
  @IsString()
  @IsNotEmpty()
  name_en: string;

  @IsString()
  @IsNotEmpty()
  name_ar: string;

  @IsString()
  @IsOptional()
  description_en?: string;

  @IsString()
  @IsOptional()
  description_ar?: string;

  @IsEmail()
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  email?: string;

  @IsString()
  @MinLength(6)
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  password?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsEnum(VendorStatus)
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  status?: VendorStatus;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === undefined) return undefined;
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  visible?: boolean;

  @ApiPropertyOptional({
    type: ProductChangesDto,
    description:
      'Delta product assignment changes. Send add/remove product IDs here instead of product_ids.',
  })
  @IsOptional()
  @Transform(({ value }) => parseProductChangesInput(value))
  @ValidateNested()
  @Type(() => ProductChangesDto)
  product_changes?: ProductChangesDto;

  // Logo will be handled as file upload
}
