import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TermsService } from './terms.service';
import { GenerateTermsDto } from './dto/generate-terms.dto';
import { CreateTermGroupDto } from './dto/create-term-group.dto';
import { UpdateTermGroupDto } from './dto/update-term-group.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { Observable } from 'rxjs';

@Controller('terms')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
export class TermsController {
  constructor(private readonly termsService: TermsService) {}

  @Get()
  listTermGroups(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
  ) {
    return this.termsService.listTermGroups({
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 50,
      search: search?.trim() || undefined,
    });
  }

  @Get('coverage')
  getConceptCoverage() {
    return this.termsService.getConceptCoverage();
  }

  @Post()
  createTermGroup(@Body() dto: CreateTermGroupDto) {
    return this.termsService.createTermGroup(dto);
  }

  @Post('generate')
  startTermsGeneration(@Body() dto: GenerateTermsDto) {
    return this.termsService.startTermsGeneration(dto);
  }

  @Post('clear-concepts')
  clearAllConcepts() {
    return this.termsService.clearAllConcepts();
  }

  // Backward compatibility with previous frontend route.
  @Post('clear')
  clearAllTermsLegacy() {
    return this.termsService.clearAllConcepts();
  }

  @Get('jobs/:jobId')
  getTermsGenerationJob(@Param('jobId') jobId: string) {
    return this.termsService.getTermsGenerationJob(jobId);
  }

  @Sse('jobs/:jobId/stream')
  streamTermsGenerationJob(@Param('jobId') jobId: string): Observable<MessageEvent> {
    this.termsService.getTermsGenerationJob(jobId);
    return this.termsService.streamTermsGenerationJob(jobId);
  }

  @Post('jobs/:jobId/cancel')
  cancelTermsGenerationJob(@Param('jobId') jobId: string) {
    return this.termsService.cancelTermsGenerationJob(jobId);
  }

  @Post('jobs/:jobId/pause')
  pauseTermsGenerationJob(@Param('jobId') jobId: string) {
    return this.termsService.pauseTermsGenerationJob(jobId);
  }

  @Post('jobs/:jobId/resume')
  resumeTermsGenerationJob(@Param('jobId') jobId: string) {
    return this.termsService.resumeTermsGenerationJob(jobId);
  }

  @Get(':id')
  getTermGroup(@Param('id', ParseIntPipe) id: number) {
    return this.termsService.getTermGroup(id);
  }

  @Patch(':id')
  updateTermGroup(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTermGroupDto) {
    return this.termsService.updateTermGroup(id, dto);
  }

  @Delete(':id')
  deleteTermGroup(@Param('id', ParseIntPipe) id: number) {
    return this.termsService.deleteTermGroup(id);
  }
}
