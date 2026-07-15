import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { FilterPartnerDto } from './dto/filter-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { PartnersService } from './partners.service';

@Controller('partners')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@RequireAdminAccess('partners')
export class PartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Post()
  create(@Body() createPartnerDto: CreatePartnerDto) {
    return this.partnersService.create(createPartnerDto);
  }

  @Get()
  findAll(@Query() filterDto: FilterPartnerDto) {
    return this.partnersService.findAll(filterDto);
  }

  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.partnersService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: number, @Body() updatePartnerDto: UpdatePartnerDto) {
    return this.partnersService.update(id, updatePartnerDto);
  }

  @Delete(':id')
  remove(@Param('id') id: number) {
    return this.partnersService.remove(id);
  }
}