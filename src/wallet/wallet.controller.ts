import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { AddFundsDto } from './dto/add-funds.dto';
import { FilterTransactionDto } from './dto/filter-transaction.dto';
import { CreateCashbackRuleDto } from './dto/create-cashback-rule.dto';
import { UpdateCashbackRuleDto } from './dto/update-cashback-rule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // --- Cashback Rules ---

  @Post('cashback-rules')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('cashback_rules')
  createRule(@Body() dto: CreateCashbackRuleDto) {
    return this.walletService.createCashbackRule(dto);
  }

  @Get('cashback-rules')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('cashback_rules')
  listRules() {
    return this.walletService.findAllCashbackRules();
  }

  @Patch('cashback-rules/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('cashback_rules')
  updateRule(@Param('id') id: string, @Body() dto: UpdateCashbackRuleDto) {
    return this.walletService.updateCashbackRule(+id, dto);
  }

  @Delete('cashback-rules/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('cashback_rules')
  deleteRule(@Param('id') id: string) {
    return this.walletService.deleteCashbackRule(+id);
  }

  // --- Wallet & Transactions ---

  @Get()
  getWallet(@Request() req) {
    return this.walletService.getWallet(req.user.id);
  }

  @Get('cashback-preview')
  previewCashback(@Query('orderAmount') orderAmount: string) {
    return this.walletService.previewCashback(Number(orderAmount));
  }

  // Filter transactions
  @Post('transactions/filter')
  filterTransactions(@Request() req, @Body() filterDto: FilterTransactionDto) {
    return this.walletService.getTransactions(req.user.id, filterDto);
  }

  @Get('transactions')
  getTransactions(@Request() req, @Query() filterDto: FilterTransactionDto) {
    return this.walletService.getTransactions(req.user.id, filterDto);
  }

  @Post('add-funds')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  addFunds(@Body() addFundsDto: AddFundsDto, @Request() req) {
    // This could be modified to get userId from body for admin operations
    return this.walletService.addFunds(req.user.id, addFundsDto);
  }
}
