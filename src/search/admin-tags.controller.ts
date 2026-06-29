import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

@UseGuards(JwtAuthGuard)
@Controller('admin/tags')
export class AdminTagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  listTags(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
  ) {
    return this.tagsService.findAll(
      page ? parseInt(page) : 1,
      perPage ? parseInt(perPage) : 50,
    );
  }

  @Get(':id')
  getTag(@Param('id', ParseIntPipe) id: number) {
    return this.tagsService.findOne(id);
  }

  @Post()
  createTag(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: CreateTagDto,
  ) {
    return this.tagsService.findOrCreate(dto.name);
  }

  @Delete(':id')
  deleteTag(@Param('id', ParseIntPipe) id: number) {
    return this.tagsService.delete(id);
  }
}
