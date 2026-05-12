import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductAttributeInputDto {
  @ApiProperty({
    example: 21,
    description: 'Attribute id, for example Color or Size.',
  })
  @IsNumber()
  @Type(() => Number)
  attribute_id: number;

  @ApiProperty({
    type: [Number],
    example: [81],
    description:
      'Exactly one attribute value id that belongs to the provided attribute.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @ArrayUnique()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  attribute_value_ids: number[];
}

