import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ReconciliationService } from '../application/reconciliation.service';
import { parseCreateWallet, WalletsService } from '../application/wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.reconciliation.reconcile(walletId);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.wallets.create(parseCreateWallet(body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wallets.get(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.wallets.ledger(walletId, cursor, limit);
  }
}
