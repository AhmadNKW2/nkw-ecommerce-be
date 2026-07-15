import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const DATE_PRESETS = ['7d', '28d', '90d', '365d'] as const;

export class AnalyticsQueryDto {
  @IsOptional()
  @IsIn(DATE_PRESETS)
  range?: (typeof DATE_PRESETS)[number] = '28d';

  /** YYYY-MM-DD — overrides range when both startDate and endDate are set */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;
}
