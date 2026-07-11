import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { ProductMedia } from '../../products/entities/product-media.entity';
import { ProductAttachment } from '../../products/entities/product-attachment.entity';

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
  DOCUMENT = 'document',
}

/**
 * Unified media entity - handles uploaded files that can be linked to products
 *
 * This allows "upload first, link later" pattern:
 * 1. User uploads file -> Media entity created with url
 * 2. User submits product form -> product_media rows link media IDs to products
 *
 * Legacy product columns remain in the table for backward-compatible backfill,
 * but product ownership now lives in the product_media join table.
 */
@Entity('media')
@Index('idx_media_product_id', ['legacy_product_id'])
@Index('idx_media_type', ['type'])
@Index('idx_media_created_at', ['created_at'])
@Index('idx_media_product_sort', ['legacy_product_id', 'legacy_sort_order'])
export class Media {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 500, nullable: true })
  url: string;

  @Column({
    type: 'enum',
    enum: MediaType,
    default: MediaType.IMAGE,
  })
  type: MediaType;

  @Column({ nullable: true })
  original_name: string;

  @Column({ nullable: true })
  mime_type: string;

  @Column({ type: 'bigint', nullable: true })
  size: number;

  @Column({ nullable: true })
  alt_text: string;

  // ===== Legacy Product Linking =====

  @Column({ name: 'product_id', type: 'int', nullable: true, select: false })
  legacy_product_id: number | null;

  @Column({ name: 'sort_order', default: 0, select: false })
  legacy_sort_order: number;

  @Column({ name: 'is_primary', default: false, select: false })
  legacy_is_primary: boolean;

  @OneToMany(() => ProductMedia, (productMedia) => productMedia.media)
  productMedia: ProductMedia[];

  @OneToMany(() => ProductAttachment, (productAttachment) => productAttachment.media)
  productAttachments: ProductAttachment[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
