import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Category } from './category.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';

@Entity('category_urls')
@Unique('uq_category_urls_category_vendor_url', ['category_id', 'vendor_id', 'url'])
@Index('idx_category_urls_category_id', ['category_id'])
@Index('idx_category_urls_vendor_id', ['vendor_id'])
@Index('idx_category_urls_sort_order', ['sort_order'])
export class CategoryUrl {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  url: string;

  @ManyToOne(() => Category, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column()
  category_id: number;

  @ManyToOne(() => Vendor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vendor_id' })
  vendor: Vendor;

  @Column()
  vendor_id: number;

  @Column({ default: 0 })
  sort_order: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
