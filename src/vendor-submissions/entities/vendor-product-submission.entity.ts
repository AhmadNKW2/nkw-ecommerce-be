import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { VendorProductSubmissionMedia } from './vendor-product-submission-media.entity';

const decimalNumberTransformer: ValueTransformer = {
  to(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }
    return typeof value === 'number' ? value : Number(value);
  },
  from(value: string | number | null | undefined) {
    if (value === null || value === undefined) {
      return value as null | undefined;
    }
    return typeof value === 'number' ? value : Number(value);
  },
};

/**
 * Lifecycle of a vendor AI product submission.
 *
 * pending_ai            -> row created, waiting for the Stage 1 classifier
 * ai_processing         -> AI job currently running
 * awaiting_brand        -> AI could not match a brand; a catalog request is open
 * awaiting_category     -> AI could not match a category; a catalog request is open
 * awaiting_category_specs -> category approved, admin must add specs/attributes,
 *                            then re-run Stage 2
 * ready                 -> brand + category resolved and enriched, ready to materialize
 * materialized          -> a real product row was created
 * rejected              -> submission rejected by an admin
 * failed                -> AI/processing error, needs a retry
 */
export type VendorProductSubmissionStatus =
  | 'pending_ai'
  | 'ai_processing'
  | 'awaiting_brand'
  | 'awaiting_category'
  | 'awaiting_category_specs'
  | 'ready'
  | 'materialized'
  | 'rejected'
  | 'failed';

@Entity('vendor_product_submissions')
@Index('idx_vendor_product_submissions_vendor_id', ['vendor_id'])
@Index('idx_vendor_product_submissions_status', ['status'])
export class VendorProductSubmission {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'int' })
  vendor_id: number;

  @Column({ type: 'int', nullable: true })
  created_by: number | null;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    default: 0,
    transformer: decimalNumberTransformer,
  })
  price: number;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalNumberTransformer,
  })
  sale_price: number | null;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'varchar', length: 40, default: 'pending_ai' })
  status: VendorProductSubmissionStatus;

  /** Raw two-stage AI output kept for review and re-runs. */
  @Column({ type: 'jsonb', nullable: true })
  ai_result: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  resolved_brand_id: number | null;

  @Column({ type: 'int', nullable: true })
  resolved_category_id: number | null;

  @Column({ type: 'int', nullable: true })
  brand_request_id: number | null;

  @Column({ type: 'int', nullable: true })
  category_request_id: number | null;

  @Column({ type: 'int', nullable: true })
  product_id: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @OneToMany(() => VendorProductSubmissionMedia, (media) => media.submission, {
    cascade: true,
  })
  media: VendorProductSubmissionMedia[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
