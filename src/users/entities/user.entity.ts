import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { Address } from '../../addresses/entities/address.entity';
import type { AdminAccess } from '../admin-access.constants';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  CATALOG_MANAGER = 'catalog_manager',
  CONSTANT_TOKEN_ADMIN = 'constant_token_admin',
}

@Entity('users')
@Index('idx_users_email', ['email'])
@Index('idx_users_role', ['role'])
@Index('idx_users_is_active', ['isActive'])
export class User {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ unique: true })
  email: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column()
  password: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true, unique: true })
  appleId: string;

  @Column({ nullable: true, unique: true })
  googleId: string;

  @Column({ nullable: true })
  image: string;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.USER,
  })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ name: 'admin_access', type: 'jsonb', nullable: true })
  adminAccess: AdminAccess | null;

  @Column({ name: 'constant_access_token', type: 'text', nullable: true })
  constant_access_token: string | null;

  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;
}
