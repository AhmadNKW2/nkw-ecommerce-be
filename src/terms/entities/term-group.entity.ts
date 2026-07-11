import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('term_groups')
@Index('idx_term_groups_source_product_id', ['source_product_id'])
@Index('idx_term_groups_concept_key', ['concept_key'], { unique: true })
export class TermGroup {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column('text', { array: true, default: '{}' })
  terms_en: string[];

  @Column('text', { array: true, default: '{}' })
  terms_ar: string[];

  @Column('int', { array: true, default: '{}' })
  reference_product_ids: number[];

  @Column({ type: 'varchar', length: 160, nullable: true })
  concept_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  concept_label_en: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  concept_label_ar: string | null;

  /** Legacy column kept for backward DB compatibility. */
  @Column({ type: 'int', nullable: true })
  source_product_id: number | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
