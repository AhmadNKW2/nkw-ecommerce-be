import { IsIn, IsOptional } from 'class-validator';

export class DateCoverageDto {
  /** Which analytics surface to size date pills for */
  @IsOptional()
  @IsIn(['overview', 'products', 'search', 'visitors', 'admins'])
  scope?: 'overview' | 'products' | 'search' | 'visitors' | 'admins' =
    'overview';
}
