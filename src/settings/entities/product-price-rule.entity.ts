import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';

const decimalNumberTransformer: ValueTransformer = {
  to(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    return typeof value === 'number' ? value : Number(value);
  },
  from(value: string | number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    return typeof value === 'number' ? value : Number(value);
  },
};

@Entity('product_price_rules')
@Index('idx_product_price_rules_is_active', ['is_active'])
@Index('idx_product_price_rules_min_vendor_price', ['min_vendor_price'])
export class ProductPriceRule {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    transformer: decimalNumberTransformer,
  })
  min_vendor_price: number;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalNumberTransformer,
  })
  max_vendor_price: number | null;

  @Column('decimal', {
    precision: 5,
    scale: 2,
    transformer: decimalNumberTransformer,
  })
  percentage: number;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}