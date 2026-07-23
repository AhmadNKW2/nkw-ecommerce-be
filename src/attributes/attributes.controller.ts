import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Put,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AttributesService } from './attributes.service';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';
import { ReorderAttributesDto } from './dto/reorder-attributes.dto';
import { ReorderAttributeValuesDto } from './dto/reorder-attribute-values.dto';
import { UpdateAttributeValueDto } from './dto/update-attribute-value.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { ApiQuery } from '@nestjs/swagger';

@Controller('attributes')
export class AttributesController {
  constructor(private readonly attributesService: AttributesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  create(@Body() createAttributeDto: CreateAttributeDto) {
    return this.attributesService.create(createAttributeDto);
  }

  @Get()
  @ApiQuery({ name: 'category_ids', required: false, type: String, description: 'Comma separated list of category ids (e.g. 1,2,3,5)' })
  findAll(@Query('category_ids') categoryIdsStr?: string) {
    const categoryIds = categoryIdsStr 
      ? categoryIdsStr.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
      : undefined;
    return this.attributesService.findAll(categoryIds);
  }

  @Put('reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  reorderAttributes(@Body() reorderDto: ReorderAttributesDto) {
    return this.attributesService.reorderAttributes(reorderDto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.attributesService.findOne(+id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  update(
    @Param('id') id: string,
    @Body() updateAttributeDto: UpdateAttributeDto,
  ) {
    return this.attributesService.update(+id, updateAttributeDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  remove(@Param('id') id: string) {
    return this.attributesService.remove(+id);
  }

  @Post(':id/values')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  addValue(
    @Param('id') id: string,
    @Body()
    body: { value_en: string; value_ar: string; parent_value_id?: number },
  ) {
    return this.attributesService.addValue(
      +id,
      body.value_en,
      body.value_ar,
      body.parent_value_id,
    );
  }

  @Put(':id/values/reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  reorderAttributeValues(
    @Param('id') id: string,
    @Body() reorderDto: ReorderAttributeValuesDto,
  ) {
    return this.attributesService.reorderAttributeValues(+id, reorderDto);
  }

  @Patch('values/:valueId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  updateValue(
    @Param('valueId') valueId: string,
    @Body() updateDto: UpdateAttributeValueDto,
  ) {
    return this.attributesService.updateValue(+valueId, updateDto);
  }

  @Delete('values/:valueId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('attributes')
  removeValue(@Param('valueId') valueId: string) {
    return this.attributesService.removeValue(+valueId);
  }
}
