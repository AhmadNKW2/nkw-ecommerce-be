import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('partners')
@Index('idx_partners_full_name', ['full_name'])
@Index('idx_partners_company_name', ['company_name'])
@Index('idx_partners_phone_number', ['phone_number'])
export class Partner {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column()
  full_name: string;

  @Column()
  company_name: string;

  @Column()
  phone_number: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}