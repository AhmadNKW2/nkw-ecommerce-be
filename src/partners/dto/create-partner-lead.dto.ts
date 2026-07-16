import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreatePartnerLeadDto {
  @ApiProperty({
    example: 'Aisha Khalid',
    description: 'Primary contact full name for the partner lead.',
  })
  @IsString()
  @Transform(({ value }) => (value !== undefined ? String(value).trim() : value))
  @MinLength(2)
  @MaxLength(120)
  full_name: string;

  @ApiPropertyOptional({
    example: 'Storefront Trading',
    description: 'Optional company name associated with the partner lead.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  company_name?: string;

  @ApiProperty({
    example: '+962790000000',
    description: 'Primary phone number for the partner lead.',
  })
  @IsString()
  @Transform(({ value }) => (value !== undefined ? String(value).trim() : value))
  @MinLength(5)
  @MaxLength(30)
  phone_number: string;
}
