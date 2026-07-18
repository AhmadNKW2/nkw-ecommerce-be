import { IsEnum } from 'class-validator';
import { CodCollectionStatus } from '../entities/order.entity';

export class UpdateCodCollectionDto {
  @IsEnum(CodCollectionStatus)
  status: CodCollectionStatus;
}
