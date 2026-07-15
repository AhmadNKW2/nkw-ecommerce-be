import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAdminClientDeviceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  deviceName: string;
}
