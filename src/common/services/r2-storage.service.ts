import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { extname } from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';

export interface UploadResult {
  key: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface ImageOptimizationOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  format?: 'jpeg' | 'png' | 'webp';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

@Injectable()
export class R2StorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicUrl: string;
  private readonly publicBaseUrl: string;
  private readonly logger = new Logger(R2StorageService.name);

  constructor(private configService: ConfigService) {
    const accountId = this.configService.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = this.configService.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'R2_SECRET_ACCESS_KEY',
    );
    this.bucketName =
      this.configService.get<string>('R2_BUCKET_NAME') || 'storefront-media';

    // R2 endpoint format
    const endpoint =
      this.configService.get<string>('R2_ENDPOINT') ||
      `https://${accountId}.r2.cloudflarestorage.com`;

    // Public URL for accessing files.
    // If you set R2_PUBLIC_URL explicitly (recommended), we will use it as-is (trim trailing '/').
    // Cloudflare's Bucket "Public Development URL" can be bucket-scoped already (as shown in the UI),
    // so it may NOT require adding the bucket name.
    const configuredPublicUrl = this.configService.get<string>('R2_PUBLIC_URL');
    this.publicUrl = configuredPublicUrl || `https://pub-${accountId}.r2.dev`;

    this.publicBaseUrl = this.normalizePublicBaseUrl(
      this.publicUrl,
      !!configuredPublicUrl,
      accountId,
    );

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || '',
      },
    });

    this.logger.log(`R2 Storage initialized with bucket: ${this.bucketName}`);
  }

  private normalizePublicBaseUrl(
    url: string,
    isExplicit: boolean,
    accountId?: string,
  ): string {
    try {
      const parsed = new URL(url);
      const trimmed = url.replace(/\/$/, '');

      // Only auto-prefix the bucket when we're using the fallback account-level pub URL.
      // If the URL is explicitly configured, do not mutate it.
      const expectedAccountHost = accountId
        ? `pub-${accountId}.r2.dev`
        : undefined;
      const isFallbackAccountHost =
        !isExplicit &&
        !!expectedAccountHost &&
        parsed.hostname === expectedAccountHost;
      const hasPath =
        parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '';

      if (isFallbackAccountHost && !hasPath) {
        parsed.pathname = `/${this.bucketName}`;
        return parsed.toString().replace(/\/$/, '');
      }

      return trimmed;
    } catch {
      // If it's not a valid URL, fall back to the raw string.
      return url.replace(/\/$/, '');
    }
  }

  private buildPublicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * Upload a file to R2 with automatic image optimization
   * @param file - The file buffer or Express.Multer.File
   * @param folder - The folder/prefix to store the file in (e.g., 'products', 'banners')
   * @param options - Optional image optimization settings
   * @returns Upload result with key, URL, and file metadata
   */
  async uploadFile(
    file: Express.Multer.File,
    folder: string,
    options?: ImageOptimizationOptions,
    downloadFilename?: string,
  ): Promise<UploadResult> {
    let fileBuffer = file.buffer;
    let mimeType = file.mimetype;
    let ext = extname(file.originalname).toLowerCase();
    let fileSize = file.size;

    // Optimize images if it's an image file
    if (file.mimetype.startsWith('image/')) {
      try {
        const optimized = await this.optimizeImage(file.buffer, options);
        fileBuffer = optimized.buffer;
        fileSize = optimized.size;
        mimeType = optimized.mimeType;
        ext = optimized.ext;
        this.logger.log(
          `Image optimized: ${file.originalname} (${file.size} → ${fileSize} bytes)`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to optimize image, using original: ${getErrorMessage(error)}`,
        );
      }
    }

    const uniqueId = crypto.randomUUID();
    const key = `${folder}/${uniqueId}${ext}`;
    const contentDisposition = downloadFilename
      ? `attachment; filename="${downloadFilename.replace(/"/g, '')}"`
      : undefined;

    try {
      // Use multipart upload for files larger than 5MB
      if (fileSize > 5 * 1024 * 1024) {
        await this.uploadLargeFile(key, fileBuffer, mimeType, contentDisposition);
      } else {
        await this.uploadSmallFile(key, fileBuffer, mimeType, contentDisposition);
      }

      const url = this.buildPublicUrl(key);

      this.logger.log(`File uploaded successfully: ${key}`);

      return {
        key,
        url,
        originalName: file.originalname,
        mimeType,
        size: fileSize,
      };
    } catch (error) {
      this.logger.error(
        `Failed to upload file: ${getErrorMessage(error)}`,
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Optimize image using sharp
   */
  private async optimizeImage(
    buffer: Buffer,
    options?: ImageOptimizationOptions,
  ): Promise<{ buffer: Buffer; size: number; mimeType: string; ext: string }> {
    const {
      maxWidth = 2000,
      maxHeight = 2000,
      quality = 85,
      format = 'webp',
    } = options || {};

    let sharpInstance = sharp(buffer);

    // Get metadata to check dimensions
    const metadata = await sharpInstance.metadata();

    // Resize if necessary
    if (
      (metadata.width && metadata.width > maxWidth) ||
      (metadata.height && metadata.height > maxHeight)
    ) {
      sharpInstance = sharpInstance.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert to optimized format
    let optimizedBuffer: Buffer;
    let mimeType: string;
    let ext: string;

    if (format === 'webp') {
      optimizedBuffer = await sharpInstance.webp({ quality }).toBuffer();
      mimeType = 'image/webp';
      ext = '.webp';
    } else if (format === 'jpeg') {
      optimizedBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
      mimeType = 'image/jpeg';
      ext = '.jpg';
    } else {
      optimizedBuffer = await sharpInstance.png({ quality }).toBuffer();
      mimeType = 'image/png';
      ext = '.png';
    }

    return {
      buffer: optimizedBuffer,
      size: optimizedBuffer.length,
      mimeType,
      ext,
    };
  }

  /**
   * Upload small files using PutObjectCommand
   */
  private async uploadSmallFile(
    key: string,
    buffer: Buffer,
    mimeType: string,
    contentDisposition?: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
        CacheControl: 'public, max-age=31536000',
      }),
    );
  }

  /**
   * Upload large files using multipart upload
   */
  private async uploadLargeFile(
    key: string,
    buffer: Buffer,
    mimeType: string,
    contentDisposition?: string,
  ): Promise<void> {
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
        CacheControl: 'public, max-age=31536000',
      },
      queueSize: 4, // Number of concurrent parts
      partSize: 5 * 1024 * 1024, // 5MB parts
    });

    await upload.done();
  }

  /**
   * Delete a file from R2
   * @param keyOrUrl - The key or full URL of the file to delete
   */
  async deleteFile(keyOrUrl: string): Promise<void> {
    // Extract key from URL if full URL is provided
    const key = this.extractKeyFromUrl(keyOrUrl);

    if (!key) {
      this.logger.warn(`Cannot extract key from: ${keyOrUrl}`);
      return;
    }

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );

      this.logger.log(`File deleted successfully: ${key}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete file: ${getErrorMessage(error)}`,
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Delete multiple files from R2
   * @param keysOrUrls - Array of keys or URLs to delete
   */
  async deleteFiles(keysOrUrls: string[]): Promise<void> {
    if (keysOrUrls.length === 0) return;

    const keys = keysOrUrls
      .map((keyOrUrl) => this.extractKeyFromUrl(keyOrUrl))
      .filter((key): key is string => key !== null);

    if (keys.length === 0) {
      this.logger.warn('No valid keys to delete');
      return;
    }

    try {
      // R2/S3 allows up to 1000 objects per delete request
      const batchSize = 1000;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
            },
          }),
        );
      }

      this.logger.log(`Deleted ${keys.length} files successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to delete files: ${getErrorMessage(error)}`,
        getErrorStack(error),
      );
      throw error;
    }
  }

  /**
   * Extract the storage key from a URL or return the key if already a key
   */
  private extractKeyFromUrl(keyOrUrl: string): string | null {
    if (!keyOrUrl) return null;

    // If it's already a key (no http/https), return as is
    if (!keyOrUrl.startsWith('http://') && !keyOrUrl.startsWith('https://')) {
      return keyOrUrl;
    }

    try {
      const url = new URL(keyOrUrl);
      // Remove leading slash from pathname
      const path = url.pathname.startsWith('/')
        ? url.pathname.slice(1)
        : url.pathname;
      // If the URL includes the bucket as the first segment (common with pub-<account>.r2.dev), strip it.
      if (path.startsWith(`${this.bucketName}/`)) {
        return path.slice(this.bucketName.length + 1);
      }
      return path;
    } catch {
      this.logger.warn(`Invalid URL format: ${keyOrUrl}`);
      return null;
    }
  }

  /**
   * Get the public URL for a given key
   */
  getPublicUrl(key: string): string {
    return this.buildPublicUrl(key);
  }

  /**
   * Download a file from R2 as a buffer
   */
  async getFileBuffer(keyOrUrl: string): Promise<Buffer> {
    const key = this.extractKeyFromUrl(keyOrUrl);

    if (!key) {
      throw new Error(`Cannot extract key from: ${keyOrUrl}`);
    }

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    const bytes = await response.Body?.transformToByteArray();
    if (!bytes || bytes.length === 0) {
      throw new Error(`File is empty or missing: ${key}`);
    }

    return Buffer.from(bytes);
  }
}
