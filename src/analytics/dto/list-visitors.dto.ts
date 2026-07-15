import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ListVisitorsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  /** visitors = non-admin only; admins = admin-marked browsers only */
  @IsOptional()
  @IsIn(['visitors', 'admins'])
  audience?: 'visitors' | 'admins' = 'visitors';

  @IsOptional()
  @IsIn([
    'lastPath',
    'sessions',
    'events',
    'duration',
    'lastSeen',
    'deviceName',
    'admin',
  ])
  sortBy?:
    | 'lastPath'
    | 'sessions'
    | 'events'
    | 'duration'
    | 'lastSeen'
    | 'deviceName'
    | 'admin';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
