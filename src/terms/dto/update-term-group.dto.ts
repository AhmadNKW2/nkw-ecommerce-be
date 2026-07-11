import { PartialType } from '@nestjs/mapped-types';
import { CreateTermGroupDto } from './create-term-group.dto';

export class UpdateTermGroupDto extends PartialType(CreateTermGroupDto) {}
