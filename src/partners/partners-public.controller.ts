import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreatePartnerLeadDto } from './dto/create-partner-lead.dto';
import { PartnersService } from './partners.service';

@ApiTags('partners')
@Controller('partners')
export class PartnersPublicController {
  constructor(private readonly partnersService: PartnersService) {}

  @Post('leads')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a public sell-with-us partner lead',
  })
  createLead(@Body() createPartnerLeadDto: CreatePartnerLeadDto) {
    return this.partnersService.createLead(createPartnerLeadDto);
  }
}
