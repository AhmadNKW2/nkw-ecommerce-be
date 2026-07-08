import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotesService } from './notes.service';
import { NotesController } from './notes.controller';
import { Note } from './entities/note.entity';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';

@Module({
  imports: [TypeOrmModule.forFeature([Note]), AdminNotificationsModule],
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
