import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Request,
  Put,
  Req,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { memoryStorage } from 'multer';
import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { FilterBannerDto } from './dto/filter-banner.dto';
import { ReorderBannersDto } from './dto/reorder-banners.dto';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { imageFileFilter } from '../common/utils/file-upload.util';
import { R2StorageService } from '../common/services/r2-storage.service';

@Controller('banners')
export class BannersController {
  constructor(
    private readonly bannersService: BannersService,
    private readonly r2StorageService: R2StorageService,
  ) {}

  // ========== BANNER CRUD ==========

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('banners')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    }),
  )
  async create(
    @Body() createBannerDto: CreateBannerDto,
    @UploadedFile() image: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!image) {
      throw new BadRequestException(
        'image file is required (field name: image)',
      );
    }

    const upload = await this.r2StorageService.uploadFile(image, 'banners');
    return this.bannersService.create(createBannerDto, upload.url);
  }

  @Get()
  findAll(@Query() filterDto: FilterBannerDto) {
    return this.bannersService.findAll(filterDto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.bannersService.findOne(+id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('banners')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async update(
    @Param('id') id: string,
    @Body() updateBannerDto: UpdateBannerDto,
    @UploadedFile() image: Express.Multer.File,
    @Req() req: any,
  ) {
    const upload = image
      ? await this.r2StorageService.uploadFile(image, 'banners')
      : undefined;

    return this.bannersService.update(+id, updateBannerDto, upload?.url);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('banners')
  remove(@Param('id') id: string) {
    return this.bannersService.remove(+id);
  }

  // ========== REORDERING ==========

  @Post('reorder')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('banners')
  reorder(@Body() dto: ReorderBannersDto) {
    return this.bannersService.reorder(dto);
  }
}
