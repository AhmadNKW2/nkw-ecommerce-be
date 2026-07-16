import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Media } from '../../media/entities/media.entity';
import { VendorProductSubmission } from './vendor-product-submission.entity';

@Entity('vendor_product_submission_media')
@Unique('uq_vendor_submission_media', ['submission_id', 'media_id'])
@Index('idx_vendor_submission_media_submission_id', ['submission_id'])
export class VendorProductSubmissionMedia {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'int' })
  submission_id: number;

  @ManyToOne(() => VendorProductSubmission, (submission) => submission.media, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'submission_id' })
  submission: VendorProductSubmission;

  @Column({ type: 'int' })
  media_id: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media: Media;

  @Column({ default: 0 })
  sort_order: number;

  @Column({ default: false })
  is_primary: boolean;

  @CreateDateColumn()
  created_at: Date;
}
