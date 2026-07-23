import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

export class UserSummaryResponseDto {
  @ApiProperty({ example: 42 })
  id: number;

  @ApiProperty({ example: 'manager@example.com' })
  email: string;

  @ApiProperty({ example: 'Aisha' })
  firstName: string;

  @ApiProperty({ example: 'Khalid' })
  lastName: string;

  @ApiProperty({ enum: UserRole, example: UserRole.ADMIN })
  role: UserRole;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({
    example: '2026-03-31T12:00:00.000+03:00',
    format: 'date-time',
  })
  createdAt: string;

  @ApiProperty({
    example: '2026-03-31T12:15:00.000+03:00',
    format: 'date-time',
  })
  updatedAt: string;
}

export class UserResponseDto extends UserSummaryResponseDto {
  @ApiPropertyOptional({
    example: '+966500000000',
    nullable: true,
  })
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'apple-user-123456789',
    nullable: true,
  })
  appleId?: string | null;

  @ApiPropertyOptional({
    example: 'google-oauth2|109876543210987654321',
    nullable: true,
  })
  googleId?: string | null;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/users/42/profile.jpg',
    nullable: true,
  })
  image?: string | null;

  @ApiProperty({ example: false })
  emailVerified: boolean;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    format: 'date-time',
  })
  deletedAt?: string | null;
}

export class UserWishlistItemDto {
  @ApiProperty({ example: 7 })
  id: number;

  @ApiProperty({ example: 101 })
  product_id: number;

  @ApiProperty({
    example: '2026-03-31T12:05:00.000+03:00',
    format: 'date-time',
  })
  added_at: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: {
      id: 101,
      name_en: 'Organic Dates',
      name_ar: 'Organic Dates',
      sku: 'OD-101',
      status: 'active',
      image: 'https://cdn.example.com/products/101-primary.jpg',
    },
  })
  product?: Record<string, unknown> | null;
}

export class UserDetailResponseDto extends UserResponseDto {
  @ApiProperty({ type: [UserWishlistItemDto] })
  wishlist: UserWishlistItemDto[];
}