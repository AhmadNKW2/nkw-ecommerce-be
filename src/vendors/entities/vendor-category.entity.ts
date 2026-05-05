import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Category } from '../../categories/entities/category.entity';
import { Vendor } from './vendor.entity';

@Entity('vendor_categories')
@Unique('uq_vendor_categories_vendor_url', ['vendor_id', 'reference_link'])
@Index('idx_vendor_categories_vendor_id', ['vendor_id'])
@Index('idx_vendor_categories_parent_id', ['parent_id'])
@Index('idx_vendor_categories_sort_order', ['sort_order'])
export class VendorCategory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ name: 'url', type: 'text' })
  reference_link: string;

  @ManyToOne(() => Vendor, (vendor) => vendor.vendor_categories, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'vendor_id' })
  vendor: Vendor;

  @Column({ type: 'int' })
  vendor_id: number;

  @ManyToOne(() => VendorCategory, (vendorCategory) => vendorCategory.children, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'parent_id' })
  parent: VendorCategory | null;

  @Column({ type: 'int', nullable: true })
  parent_id: number | null;

  @OneToMany(() => VendorCategory, (vendorCategory) => vendorCategory.parent)
  children: VendorCategory[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'vendor_category_categories',
    joinColumn: {
      name: 'vendor_category_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'category_id',
      referencedColumnName: 'id',
    },
  })
  categories: Category[];

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}