import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsEnum,
  IsOptional,
  IsArray,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {
  @ApiProperty({
    example: 'aisha@example.com',
    description: 'Unique email address for the user account.',
  })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    example: 'apple-user-123456789',
    description: 'Apple identity id when the user signs in with Apple.',
  })
  @IsString()
  @IsOptional()
  appleId?: string;

  @ApiPropertyOptional({
    example: 'google-oauth2|109876543210987654321',
    description: 'Google identity id when the user signs in with Google.',
  })
  @IsString()
  @IsOptional()
  googleId?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/users/42/profile.jpg',
    description: 'Profile image URL for the user.',
  })
  @IsString()
  @IsOptional()
  image?: string;

  @ApiProperty({ example: 'Aisha' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'Khalid' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  lastName: string;

  @ApiProperty({
    example: 'StrongPass123',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({
    example: '+966500000000',
    description: 'Primary contact phone number.',
  })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    enum: UserRole,
    example: UserRole.USER,
    default: UserRole.USER,
    description: 'Role assigned to the user. Defaults to user.',
  })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole; // Optional, defaults to USER

  @ApiPropertyOptional({
    type: [Number],
    example: [101, 205],
    description: 'Product ids to add to the user wishlist after creation.',
  })
  @IsArray()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  product_ids?: number[]; // Products to add to user's wishlist
}
