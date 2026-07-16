import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type CatalogRequestType = 'brand' | 'category' | 'specs';

export type CatalogRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * Payload the AI suggested for the entity that should be created or confirmed.
 * - brand: { name_en, name_ar, matched_brand_id?, mode: 'match' | 'create' }
 * - category: { name_en, name_ar, parent_id, matched_category_id?, mode, reason }
 * - specs: { stage2 snapshot for admin review of mapped values }
 */
export type CatalogRequestPayload = Record<string, unknown>;

@Entity('catalog_requests')
@Index('idx_catalog_requests_status', ['status'])
@Index('idx_catalog_requests_type', ['type'])
@Index('idx_catalog_requests_submission_id', ['submission_id'])
export class CatalogRequest {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 20 })
  type: CatalogRequestType;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: CatalogRequestStatus;

  @Column({ type: 'int', nullable: true })
  submission_id: number | null;

  @Column({ type: 'int', nullable: true })
  requested_by: number | null;

  @Column({ type: 'int', nullable: true })
  reviewed_by: number | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'jsonb' })
  payload: CatalogRequestPayload;

  /** Brand or category id created when the request was approved. */
  @Column({ type: 'int', nullable: true })
  result_entity_id: number | null;

  @Column({ type: 'text', nullable: true })
  admin_notes: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
