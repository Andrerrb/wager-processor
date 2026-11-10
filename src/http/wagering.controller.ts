import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransaction } from '../application/process-wager';
import { TransactionQueries } from '../application/transaction-queries';
import type { WagerResult } from '../application/views';
import { parseWagerCommand } from '../application/wager-command';

/**
 * Status code contract:
 * 201 processed (new) · 200 processed (replay) · 202 accepted, waiting for reference
 * 422 business rejection (body has failureCode) · 400 invalid payload
 * 409 idempotency conflict · 503 transient failure (retry with same key)
 */
export function statusFor(result: WagerResult): number {
  switch (result.transaction.status) {
    case 'PROCESSED':
      return result.replayed ? 200 : 201;
    case 'PENDING':
    case 'PENDING_REFERENCE':
      return 202;
    default:
      return 422;
  }
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: TransactionQueries,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const command = parseWagerCommand(body, idempotencyKey);
    const result = await this.processWager.execute(command);
    res.status(statusFor(result));
    return result;
  }

  @Get()
  byExternalId(@Query('provider') provider?: string, @Query('externalId') externalId?: string) {
    return this.queries.byExternalId(provider, externalId);
  }

  @Get(':id')
  byId(@Param('id') id: string) {
    return this.queries.byId(id);
  }
}
