import { IsBoolean, IsOptional, IsString, MaxLength, IsUrl } from 'class-validator';

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
}