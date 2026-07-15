import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HEX_COLOR_PATTERN = /^#([0-9A-Fa-f]{6})$/;

export class ShippingDeliveryRuleDto {
  @IsString()
  @MaxLength(64)
  id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days: number[];

  @IsIn(['before', 'after', 'any'])
  cutoffMode: 'before' | 'after' | 'any';

  @IsIn(['offset_days', 'next_weekday'])
  arrivalMode: 'offset_days' | 'next_weekday';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(14)
  arrivalOffsetDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  arrivalWeekday?: number;
}

export class UpdateSeoSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  site_name_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  site_name_ar?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'site_logo must be a valid URL' })
  @MaxLength(2048)
  site_logo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_primary must be a hex color' })
  brand_primary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_primary_2 must be a hex color' })
  brand_primary_2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_primary_3 must be a hex color' })
  brand_primary_3?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_secondary must be a hex color' })
  brand_secondary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_success must be a hex color' })
  brand_success?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_success_2 must be a hex color' })
  brand_success_2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_danger must be a hex color' })
  brand_danger?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  @Matches(HEX_COLOR_PATTERN, { message: 'brand_danger_2 must be a hex color' })
  brand_danger_2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(70)
  default_meta_title_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(70)
  default_meta_title_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  default_meta_description_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  default_meta_description_ar?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'default_og_image must be a valid URL' })
  @MaxLength(2048)
  default_og_image?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  twitter_handle?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  support_email?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'facebook_url must be a valid URL' })
  @MaxLength(2048)
  facebook_url?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'twitter_url must be a valid URL' })
  @MaxLength(2048)
  twitter_url?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'instagram_url must be a valid URL' })
  @MaxLength(2048)
  instagram_url?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  google_verification?: string | null;

  @IsOptional()
  @IsBoolean()
  robots_index?: boolean;

  @IsOptional()
  @IsBoolean()
  robots_follow?: boolean;

  @IsOptional()
  @IsBoolean()
  show_sale_pricing?: boolean;

  @IsOptional()
  @IsBoolean()
  free_delivery_enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  free_delivery_amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  delivery_fee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  low_stock_threshold?: number;

  @IsOptional()
  @IsBoolean()
  shipping_rules_enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(23)
  shipping_cutoff_hour?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShippingDeliveryRuleDto)
  shipping_rules?: ShippingDeliveryRuleDto[];
}