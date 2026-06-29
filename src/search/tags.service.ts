import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagsRepository: Repository<Tag>,
  ) {}

  async findOrCreate(name: string): Promise<Tag> {
    const normalized = name.toLowerCase().trim();

    let tag = await this.tagsRepository.findOne({
      where: { name: normalized },
    });

    if (tag) return tag;

    tag = this.tagsRepository.create({ name: normalized });
    return this.tagsRepository.save(tag);
  }

  async findAll(page = 1, perPage = 50) {
    const [items, total] = await this.tagsRepository.findAndCount({
      order: { name: 'ASC' },
      skip: (page - 1) * perPage,
      take: perPage,
    });

    return {
      items,
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage),
    };
  }

  async findOne(id: number): Promise<Tag> {
    const tag = await this.tagsRepository.findOne({ where: { id } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    return tag;
  }

  async delete(id: number): Promise<void> {
    const tag = await this.findOne(id);
    await this.tagsRepository.remove(tag);
  }
}
