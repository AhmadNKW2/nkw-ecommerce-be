import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterAdminClientDto {
  @IsString()
  @MaxLength(64)
  browserKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}
