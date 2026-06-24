import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateProductFieldTogglesDto {
  // Disabling toggles
  @IsOptional()
  @IsBoolean()
  vendors_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  attributes_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  specifications_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  weight_and_dimensions_enabled?: boolean;

  // Appearance-only toggles
  @IsOptional()
  @IsBoolean()
  reference_link_visible_admin?: boolean;

  @IsOptional()
  @IsBoolean()
  meta_title_visible_admin?: boolean;

  @IsOptional()
  @IsBoolean()
  meta_description_visible_admin?: boolean;
}
