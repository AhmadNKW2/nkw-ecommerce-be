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
import { SpecificationsService } from './specifications.service';
import { CreateSpecificationDto } from './dto/create-specification.dto';
import { UpdateSpecificationDto } from './dto/update-specification.dto';
import { ReorderSpecificationsDto } from './dto/reorder-specifications.dto';
import { ReorderSpecificationValuesDto } from './dto/reorder-specification-values.dto';
import { UpdateSpecificationValueDto } from './dto/update-specification-value.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { ApiQuery } from '@nestjs/swagger';

@Controller('specifications')
export class SpecificationsController {
  constructor(private readonly specificationsService: SpecificationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  create(@Body() createSpecificationDto: CreateSpecificationDto) {
    return this.specificationsService.create(createSpecificationDto);
  }

  @Get()
  @ApiQuery({ name: 'category_ids', required: false, type: String, description: 'Comma separated list of category ids (e.g. 1,2,3,5)' })
  findAll(@Query('category_ids') categoryIdsStr?: string) {
    const categoryIds = categoryIdsStr 
      ? categoryIdsStr.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
      : undefined;
    return this.specificationsService.findAll(categoryIds);
  }

  @Put('reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  reorderSpecifications(@Body() reorderDto: ReorderSpecificationsDto) {
    return this.specificationsService.reorderSpecifications(reorderDto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.specificationsService.findOne(+id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  update(
    @Param('id') id: string,
    @Body() updateSpecificationDto: UpdateSpecificationDto,
  ) {
    return this.specificationsService.update(+id, updateSpecificationDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  remove(@Param('id') id: string) {
    return this.specificationsService.remove(+id);
  }

  @Post(':id/values')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  addValue(
    @Param('id') id: string,
    @Body()
    body: { value_en: string; value_ar: string; parent_value_id?: number },
  ) {
    return this.specificationsService.addValue(
      +id,
      body.value_en,
      body.value_ar,
      body.parent_value_id,
    );
  }

  @Put(':id/values/reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  reorderSpecificationValues(
    @Param('id') id: string,
    @Body() reorderDto: ReorderSpecificationValuesDto,
  ) {
    return this.specificationsService.reorderSpecificationValues(+id, reorderDto);
  }

  @Patch('values/:valueId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  updateValue(
    @Param('valueId') valueId: string,
    @Body() updateDto: UpdateSpecificationValueDto,
  ) {
    return this.specificationsService.updateValue(+valueId, updateDto);
  }

  @Delete('values/:valueId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('specifications')
  removeValue(@Param('valueId') valueId: string) {
    return this.specificationsService.removeValue(+valueId);
  }
}
