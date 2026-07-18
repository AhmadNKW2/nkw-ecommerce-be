import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { CreatePartnerLeadDto } from './dto/create-partner-lead.dto';
import { FilterPartnerDto } from './dto/filter-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';
import { Partner } from './entities/partner.entity';

const DEFAULT_LEAD_COMPANY_NAME = 'N/A';

@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(Partner)
    private readonly partnersRepository: Repository<Partner>,
    private readonly adminNotificationsService: AdminNotificationsService,
  ) {}

  async create(createPartnerDto: CreatePartnerDto): Promise<Partner> {
    await this.ensurePhoneNumberAvailable(createPartnerDto.phone_number);

    const partner = this.partnersRepository.create(createPartnerDto);
    const savedPartner = await this.partnersRepository.save(partner);
    this.adminNotificationsService.publishPartnerCreated(savedPartner.id);
    return savedPartner;
  }

  async createLead(createPartnerLeadDto: CreatePartnerLeadDto): Promise<Partner> {
    return this.create({
      full_name: createPartnerLeadDto.full_name,
      company_name:
        createPartnerLeadDto.company_name?.trim() || DEFAULT_LEAD_COMPANY_NAME,
      phone_number: createPartnerLeadDto.phone_number,
    });
  }

  async findAll(filterDto?: FilterPartnerDto) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      search,
    } = filterDto || {};

    const where = search
      ? [
          { full_name: ILike(`%${search}%`) },
          { company_name: ILike(`%${search}%`) },
          { phone_number: ILike(`%${search}%`) },
        ]
      : undefined;

    const [data, total] = await this.partnersRepository.findAndCount({
      where,
      order: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number): Promise<Partner> {
    const partner = await this.partnersRepository.findOne({ where: { id } });

    if (!partner) {
      throw new NotFoundException('Partner not found');
    }

    return partner;
  }

  async update(
    id: number,
    updatePartnerDto: UpdatePartnerDto,
  ): Promise<Partner> {
    const partner = await this.findOne(id);

    if (
      updatePartnerDto.phone_number &&
      updatePartnerDto.phone_number !== partner.phone_number
    ) {
      await this.ensurePhoneNumberAvailable(updatePartnerDto.phone_number, id);
    }

    Object.assign(partner, updatePartnerDto);
    return this.partnersRepository.save(partner);
  }

  async remove(id: number): Promise<{ message: string }> {
    const partner = await this.findOne(id);
    await this.partnersRepository.remove(partner);

    return { message: 'Partner deleted successfully' };
  }

  private async ensurePhoneNumberAvailable(
    phoneNumber: string,
    currentId?: number,
  ): Promise<void> {
    const existingPartner = await this.partnersRepository.findOne({
      where: { phone_number: phoneNumber },
    });

    if (existingPartner && existingPartner.id !== currentId) {
      throw new ConflictException('Phone number already exists');
    }
  }
}