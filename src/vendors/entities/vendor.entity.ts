import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { Rating } from '../../ratings/entities/rating.entity';
import { VendorCategory } from './vendor-category.entity';

export enum VendorStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('vendors')
@Index('idx_vendors_name_en', ['name_en'])
@Index('idx_vendors_status', ['status'])
@Index('idx_vendors_visible', ['visible'])
@Index('idx_vendors_status_visible', ['status', 'visible'])
@Index('idx_vendors_sort_order', ['sort_order'])
export class Vendor {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, nullable: true })
  slug: string;

  @Column({ unique: true, default: '' })
  name_en: string;

  @Column({ default: '' })
  name_ar: string;

  @Column({ type: 'text', nullable: true })
  description_en: string;

  @Column({ type: 'text', nullable: true })
  description_ar: string;

  @Column('varchar', { nullable: true })
  email: string | null;

  @Column('text', { nullable: true, select: false })
  password: string | null;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  address: string;

  @Column({ nullable: true })
  logo: string;

  @Column({
    type: 'enum',
    enum: VendorStatus,
    default: VendorStatus.ACTIVE,
  })
  status: VendorStatus;

  @Column({ default: true })
  visible: boolean;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ type: 'int', default: 0 })
  rating_count: number;

  @Column({ default: 0 })
  sort_order: number;

  @Column({ nullable: true, type: 'timestamp' })
  archived_at: Date | null;

  @Column({ nullable: true, type: 'int' })
  archived_by: number | null;

  // Products relationship
  @OneToMany('Product', 'vendor')
  products: any[];

  @OneToMany(() => Rating, (rating) => rating.vendor)
  comments: Rating[];

  @OneToMany(() => VendorCategory, (vendorCategory) => vendorCategory.vendor)
  vendor_categories: VendorCategory[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn()
  deleted_at: Date;
}
