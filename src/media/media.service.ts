import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Media, MediaType } from './entities/media.entity';
import { ProductAttachment } from '../products/entities/product-attachment.entity';
import { SettingsService } from '../settings/settings.service';
import {
  R2StorageService,
  UploadResult,
} from '../common/services/r2-storage.service';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(Media)
    private mediaRepository: Repository<Media>,
    @InjectRepository(ProductAttachment)
    private productAttachmentRepository: Repository<ProductAttachment>,
    private r2StorageService: R2StorageService,
    private settingsService: SettingsService,
  ) {}

  /**
   * Upload a file to R2 and create a media record
   */
  async uploadAndCreate(
    file: Express.Multer.File,
    folder: string = 'products',
  ): Promise<Media> {
    // Log the file details
    this.logger.debug(`Checking if file ${file.originalname} already exists`);

    // Check if media with the exact same original name and size exists
    // (Size check to prevent collision if two different files are named "image.jpg")
    const existingMedia = await this.mediaRepository.findOne({
      where: {
        original_name: file.originalname,
        size: file.size,
      },
    });

    if (existingMedia) {
      this.logger.debug(`Found existing media with ID ${existingMedia.id}, returning it directly`);
      return existingMedia;
    }

    // Unchanged part: Upload to R2
    const uploadResult = await this.r2StorageService.uploadFile(file, folder);

    // Determine media type
    const type = file.mimetype.startsWith('video/')
      ? MediaType.VIDEO
      : MediaType.IMAGE;

    // Create media record
    const media = this.mediaRepository.create({
      url: uploadResult.url,
      type,
      original_name: uploadResult.originalName,
      mime_type: uploadResult.mimeType,
      size: uploadResult.size,
    });

    return this.mediaRepository.save(media);
  }

  /**
   * Upload a document attachment to R2 and create a media record
   */
  async uploadDocumentAndCreate(
    file: Express.Multer.File,
    folder: string = 'product-attachments',
  ): Promise<Media> {
    const existingMedia = await this.mediaRepository.findOne({
      where: {
        original_name: file.originalname,
        size: file.size,
        type: MediaType.DOCUMENT,
      },
    });

    if (existingMedia) {
      this.logger.debug(
        `Found existing document media with ID ${existingMedia.id}, returning it directly`,
      );
      return existingMedia;
    }

    const uploadResult = await this.r2StorageService.uploadFile(
      file,
      folder,
      undefined,
      file.originalname,
    );

    const media = this.mediaRepository.create({
      url: uploadResult.url,
      type: MediaType.DOCUMENT,
      original_name: uploadResult.originalName,
      mime_type: uploadResult.mimeType,
      size: uploadResult.size,
    });

    return this.mediaRepository.save(media);
  }

  /**
   * Create a new media record after file upload
   */
  async create(
    url: string,
    type: MediaType = MediaType.IMAGE,
    originalName?: string,
    mimeType?: string,
    size?: number,
  ): Promise<Media> {
    const media = this.mediaRepository.create({
      url,
      type,
      original_name: originalName,
      mime_type: mimeType,
      size,
    });
    return this.mediaRepository.save(media);
  }

  /**
   * Find media by ID
   */
  async findOne(id: number): Promise<Media> {
    const media = await this.mediaRepository.findOne({ where: { id } });
    if (!media) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }
    return media;
  }

  /**
   * Stream a product document attachment with Content-Disposition: attachment
   */
  async getDocumentDownload(
    mediaId: number,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const toggles = await this.settingsService.getProductFieldToggles();
    if (toggles.product_files_enabled === false) {
      throw new NotFoundException('Product file not found');
    }

    const media = await this.findOne(mediaId);
    if (media.type !== MediaType.DOCUMENT || !media.url) {
      throw new NotFoundException('Product file not found');
    }

    const isLinkedToVisibleProduct = await this.productAttachmentRepository
      .createQueryBuilder('attachment')
      .innerJoin('attachment.product', 'product')
      .where('attachment.media_id = :mediaId', { mediaId })
      .andWhere('product.visible = :visible', { visible: true })
      .andWhere('product.deleted_at IS NULL')
      .getExists();

    if (!isLinkedToVisibleProduct) {
      throw new NotFoundException('Product file not found');
    }

    const buffer = await this.r2StorageService.getFileBuffer(media.url);

    return {
      buffer,
      mimeType: media.mime_type || 'application/octet-stream',
      filename: media.original_name || `file-${media.id}`,
    };
  }

  /**
   * Find multiple media by IDs
   */
  async findByIds(ids: number[]): Promise<Media[]> {
    if (ids.length === 0) return [];
    return this.mediaRepository.find({
      where: { id: In(ids) },
    });
  }

  /**
   * Delete media by ID (also removes file from R2)
   */
  async delete(id: number): Promise<void> {
    const media = await this.mediaRepository.findOne({ where: { id } });
    if (!media) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }

    // Delete from R2 if URL exists
    if (media.url) {
      try {
        await this.r2StorageService.deleteFile(media.url);
      } catch (error) {
        this.logger.warn(`Failed to delete file from R2: ${media.url}`, error);
        // Continue with database deletion even if R2 deletion fails
      }
    }

    // Delete from database
    await this.mediaRepository.delete(id);
  }

  /**
   * Delete multiple media by IDs (also removes files from R2)
   */
  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const mediaItems = await this.mediaRepository.find({
      where: { id: In(ids) },
    });

    if (mediaItems.length === 0) return;

    // Collect URLs to delete from R2
    const urls = mediaItems
      .map((m) => m.url)
      .filter((url): url is string => !!url);

    // Delete from R2
    if (urls.length > 0) {
      try {
        await this.r2StorageService.deleteFiles(urls);
      } catch (error) {
        this.logger.warn('Failed to delete some files from R2', error);
        // Continue with database deletion even if R2 deletion fails
      }
    }

    // Delete from database
    await this.mediaRepository.delete(ids);
  }

  /**
   * Delete a file from R2 by URL (without database operation)
   */
  async deleteFileFromStorage(url: string): Promise<void> {
    if (!url) return;
    try {
      await this.r2StorageService.deleteFile(url);
    } catch (error) {
      this.logger.warn(`Failed to delete file from R2: ${url}`, error);
    }
  }
}
