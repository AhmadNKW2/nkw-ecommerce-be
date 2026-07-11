import { extname } from 'path';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

// File filter for images and videos
export const mediaFileFilter = (
  req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile: boolean) => void,
) => {
  const allowedImageTypes = /jpeg|jpg|png|gif|webp|avif|tiff|tif/;
  const allowedVideoTypes = /mp4|avi|mov|wmv|flv|webm/;
  const ext = extname(file.originalname).toLowerCase().slice(1);
  const mimetype = file.mimetype;

  const isImage = allowedImageTypes.test(ext) && mimetype.startsWith('image/');
  const isVideo = allowedVideoTypes.test(ext) && mimetype.startsWith('video/');

  if (isImage || isVideo) {
    callback(null, true);
  } else {
    callback(
      new BadRequestException(
        'Invalid file type. Only images (jpeg, jpg, png, gif, webp, avif, tiff, tif) and videos (mp4, avi, mov, wmv, flv, webm) are allowed.',
      ),
      false,
    );
  }
};

// File filter for images only
export const imageFileFilter = (
  req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile: boolean) => void,
) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|avif|tiff|tif/;
  const ext = extname(file.originalname).toLowerCase().slice(1);
  const mimetype = file.mimetype;

  if (allowedTypes.test(ext) && mimetype.startsWith('image/')) {
    callback(null, true);
  } else {
    callback(
      new BadRequestException(
        'Invalid file type. Only images (jpeg, jpg, png, gif, webp, avif, tiff, tif) are allowed.',
      ),
      false,
    );
  }
};

// File filter for product document attachments (PDF, Office docs, archives, etc.)
export const documentFileFilter = (
  req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, acceptFile: boolean) => void,
) => {
  const allowedExtensions =
    /pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|rar|7z|json|xml/;
  const allowedMimeTypes = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/json',
    'application/xml',
    'text/xml',
  ]);

  const ext = extname(file.originalname).toLowerCase().slice(1);
  const mimetype = file.mimetype;

  if (allowedExtensions.test(ext) && allowedMimeTypes.has(mimetype)) {
    callback(null, true);
    return;
  }

  callback(
    new BadRequestException(
      'Invalid file type. Allowed: PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP, RAR, 7Z, JSON, XML.',
    ),
    false,
  );
};

// Generate unique filename
export const editFileName = (
  req: Request,
  file: Express.Multer.File,
  callback: (error: Error | null, filename: string) => void,
) => {
  const name = file.originalname.split('.')[0];
  const fileExtName = extname(file.originalname);
  const randomName = Array(16)
    .fill(null)
    .map(() => Math.round(Math.random() * 16).toString(16))
    .join('');
  callback(null, `${name}-${Date.now()}-${randomName}${fileExtName}`);
};
