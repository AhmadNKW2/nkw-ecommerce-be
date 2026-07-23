import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsString, IsBoolean, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { UserRole } from '../entities/user.entity';

export enum UserSortBy {
  CREATED_AT = 'createdAt',
  EMAIL = 'email',
  FIRST_NAME = 'firstName',
  LAST_NAME = 'lastName',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class FilterUserDto {
  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Page number for paginated results.',
  })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 10,
    default: 10,
    description: 'Maximum number of users returned per page.',
  })
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({
    enum: UserSortBy,
    example: UserSortBy.CREATED_AT,
    default: UserSortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(UserSortBy)
  sortBy?: UserSortBy = UserSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: SortOrder,
    example: SortOrder.DESC,
    default: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;

  @ApiPropertyOptional({
    enum: UserRole,
    isArray: true,
    example: [UserRole.ADMIN, UserRole.CONSTANT_TOKEN_ADMIN],
    description: 'Filter users by one or more roles.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',');
    return [value];
  })
  @IsArray()
  @IsEnum(UserRole, { each: true })
  roles?: UserRole[];

  @ApiPropertyOptional({
    example: true,
    description: 'Filter users by active status.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: 'aisha',
    description: 'Case-insensitive search across email, first name, and last name.',
  })
  @IsOptional()
  @IsString()
  search?: string; // Search in email, firstName, lastName
}
