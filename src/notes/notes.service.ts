import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { Note } from './entities/note.entity';

import { FilterNoteDto } from './dto/filter-note.dto';
import { hydrateProductMedia } from '../products/utils/product-media.util';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { hasAdminAccess } from '../users/utils/admin-access.util';
import { UserRole } from '../users/entities/user.entity';

@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(Note)
    private readonly notesRepository: Repository<Note>,
    private readonly adminNotificationsService: AdminNotificationsService,
  ) {}

  private canManageAllNotes(user: any): boolean {
    if (!user?.role) {
      return false;
    }

    if (
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.CONSTANT_TOKEN_ADMIN
    ) {
      return false;
    }

    return hasAdminAccess(user, 'notes');
  }

  async create(user: any, createNoteDto: CreateNoteDto): Promise<Note> {
    const userId = user?.id || null;
    const note = this.notesRepository.create({
      user_id: userId,
      product_id: createNoteDto.product_id,
      notes: createNoteDto.notes,
      guest_name: !userId ? createNoteDto.guest_name : null,
      guest_phone: !userId ? createNoteDto.guest_phone : null,
      guest_email: !userId ? createNoteDto.guest_email : null,
    });
    const savedNote = await this.notesRepository.save(note);
    this.adminNotificationsService.publishNoteCreated(savedNote.id);
    return savedNote;
  }

  async findAll(user: any, filterDto: FilterNoteDto) {
    const userId = user?.id || null;
    const isAdmin = this.canManageAllNotes(user);

    const { page = 1, per_page = 10 } = filterDto;
    const skip = (page - 1) * per_page;

    const whereCondition = isAdmin ? {} : (userId ? { user_id: userId } : { user_id: IsNull() });

    const [notes, total] = await this.notesRepository.findAndCount({
      where: whereCondition,
      relations: {
        product: {
          productMedia: {
            media: true
          }
        },

        user: true
      },
      order: { created_at: 'DESC' },
      skip,
      take: per_page,
    });

    notes.forEach((note) => {
      if (note.product) {
        hydrateProductMedia(note.product, true);
      }

      if (note.user) {
        delete (note.user as any).password;
        delete (note.user as any).googleId;
        delete (note.user as any).appleId;
      }
    });

    return {
      data: notes,
      meta: {
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page),
      },
    };
  }

  async findByProduct(user: any, productId: number, filterDto: FilterNoteDto) {
    const userId = user?.id || null;
    const isAdmin = this.canManageAllNotes(user);

    const { page = 1, per_page = 10 } = filterDto;
    const skip = (page - 1) * per_page;

    const whereCondition = isAdmin 
      ? { product_id: productId } 
      : (userId ? { user_id: userId, product_id: productId } : { user_id: IsNull(), product_id: productId });

    const [notes, total] = await this.notesRepository.findAndCount({
      where: whereCondition,
      relations: {
        product: {
          productMedia: {
            media: true
          }
        },

        user: true
      },
      order: { created_at: 'DESC' },
      skip,
      take: per_page,
    });

    notes.forEach((note) => {
      if (note.product) {
        hydrateProductMedia(note.product, true);
      }

      if (note.user) {
        delete (note.user as any).password;
        delete (note.user as any).googleId;
        delete (note.user as any).appleId;
      }
    });

    return {
      data: notes,
      meta: {
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page),
      },
    };
  }

  async findOne(user: any, id: number): Promise<Note> {
    const userId = user?.id || null;
    const isAdmin = this.canManageAllNotes(user);

    const note = await this.notesRepository.findOne({
      where: { id },
      relations: {
        product: {
          productMedia: {
            media: true
          }
        },

        user: true
      },
    });

    if (!note) {
      throw new NotFoundException(`Note #${id} not found`);
    }

    if (!isAdmin && note.user_id !== userId && note.user_id !== null) {
      throw new ForbiddenException('You do not have permission to access this note');
    }

    if (note.user) {
      delete (note.user as any).password;
      delete (note.user as any).googleId;
      delete (note.user as any).appleId;
    }

    if (note.product) {
      hydrateProductMedia(note.product, true);
    }

    return note;
  }

  async update(
    user: any,
    id: number,
    updateNoteDto: UpdateNoteDto,
  ): Promise<Note> {
    const note = await this.findOne(user, id);

    if (updateNoteDto.notes !== undefined) {
      note.notes = updateNoteDto.notes;
    }

    return await this.notesRepository.save(note);
  }

  async remove(user: any, id: number): Promise<{ message: string }> {
    const note = await this.findOne(user, id);
    await this.notesRepository.remove(note);
    return { message: 'Note deleted successfully' };
  }
}
