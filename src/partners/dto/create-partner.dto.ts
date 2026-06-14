import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePartnerDto {
  @ApiProperty({
    example: 'Aisha Khalid',
    description: 'Primary contact full name for the partner.',
  })
  @IsString()
  @Transform(({ value }) => (value !== undefined ? String(value).trim() : value))
  @MinLength(2)
  @MaxLength(120)
  full_name: string;

  @ApiProperty({
    example: 'Storefront Trading',
    description: 'Company name associated with the partner.',
  })
  @IsString()
  @Transform(({ value }) => (value !== undefined ? String(value).trim() : value))
  @MinLength(2)
  @MaxLength(160)
  company_name: string;

  @ApiProperty({
    example: '+966500000000',
    description: 'Primary phone number for the partner.',
  })
  @IsString()
  @Transform(({ value }) => (value !== undefined ? String(value).trim() : value))
  @MinLength(5)
  @MaxLength(30)
  phone_number: string;
}