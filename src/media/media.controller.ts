import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ParseIntPipe,
  StreamableFile,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MediaService } from './media.service';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { mediaFileFilter, documentFileFilter } from '../common/utils/file-upload.helper';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /**
   * Upload a media file (image or video) to Cloudflare R2
   *
   * This is a generic upload endpoint - files are uploaded independently
   * and can be linked to products later.
   *
   * Returns: { id, url, type, original_name, mime_type, size, created_at }
   *
   * Usage:
   * 1. Frontend uploads file immediately when user drops/selects it
   * 2. Frontend stores returned ID in component state
   * 3. When saving product, frontend sends media IDs in payload
   */
  @Post('upload')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(
    UserRole.ADMIN,
    UserRole.VENDOR_ADMIN,
    UserRole.STORE_ADMIN,
  )
  @RequireAdminAccess('products')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      fileFilter: mediaFileFilter,
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // Upload to R2 and create media record
    const media = await this.mediaService.uploadAndCreate(file, 'products');
    return media;
  }

  /**
   * Upload a product document attachment (PDF, Office docs, etc.)
   *
   * Max file size: 5MB. Files are linked to products on create/update.
   */
  @Post('upload-attachment')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(
    UserRole.ADMIN,
    UserRole.VENDOR_ADMIN,
    UserRole.STORE_ADMIN,
  )
  @RequireAdminAccess('products')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      fileFilter: documentFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadAttachment(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const media = await this.mediaService.uploadDocumentAndCreate(file);
    return media;
  }

  /**
   * Download a product document attachment.
   * Public endpoint used by the storefront to force a file download instead of
   * opening the raw R2 URL inline in the browser.
   */
  @Get('attachments/:id/download')
  async downloadAttachment(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<StreamableFile> {
    const file = await this.mediaService.getDocumentDownload(id);
    const safeFilename = file.filename.replace(/[\r\n"]/g, '');
    const encodedFilename = encodeURIComponent(safeFilename);

    return new StreamableFile(file.buffer, {
      type: file.mimeType,
      disposition: `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
    });
  }

  /**
   * Get media by ID
   */
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id') id: string) {
    return this.mediaService.findOne(+id);
  }

  /**
   * Delete media by ID
   * This deletes both the database record and the file from R2.
   */
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(
    UserRole.ADMIN,
    UserRole.VENDOR_ADMIN,
    UserRole.STORE_ADMIN,
  )
  @RequireAdminAccess('products')
  async delete(@Param('id') id: string) {
    await this.mediaService.delete(+id);
    return { message: 'Media deleted successfully' };
  }
}
