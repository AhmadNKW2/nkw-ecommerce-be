import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateSitePopupSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  image_url?: string | null;

  @IsOptional()
  @IsString()
  link_url?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  dismiss_after_seconds?: number;
}
