import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ProcessWagerTransaction } from './application/process-wager';
import { ReconciliationService } from './application/reconciliation.service';
import { TransactionQueries } from './application/transaction-queries';
import { WalletsService } from './application/wallets.service';
import { AuthGuard } from './http/auth.guard';
import { HttpErrorFilter } from './http/error.filter';
import { HealthController } from './http/health.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { createSqsClient } from './infra/sqs';
import config from './mikro-orm.config';
import { BackgroundWorkers } from './workers/background-workers';
import { OutboxPublisher } from './workers/outbox.publisher';
import { PendingReferenceWorker } from './workers/pending-reference.worker';
import { SqsConsumer } from './workers/sqs.consumer';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    ProcessWagerTransaction,
    WalletsService,
    TransactionQueries,
    ReconciliationService,
    PendingReferenceWorker,
    OutboxPublisher,
    SqsConsumer,
    BackgroundWorkers,
    { provide: SQSClient, useFactory: createSqsClient },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
