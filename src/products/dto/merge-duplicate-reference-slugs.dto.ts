import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional } from 'class-validator';

export class MergeDuplicateReferenceSlugsDto {
  @ApiPropertyOptional({
    description:
      'When true, returns the merge plan without updating or deleting products.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  dry_run?: boolean;

  @ApiPropertyOptional({
    description: 'Limit the merge to one vendor ID.',
    example: 1,
  })
  @IsNumber()
  @IsOptional()
  vendor_id?: number;
}
