import { PartialType } from '@nestjs/mapped-types';
import { CreateProductPriceRuleDto } from './create-product-price-rule.dto';

export class UpdateProductPriceRuleDto extends PartialType(
  CreateProductPriceRuleDto,
) {}