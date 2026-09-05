import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { ApplicationError, ErrorCode } from '@/application/errors';
import type { ProviderIdentityPort, UnitOfWork } from '@/application/ports';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '@/application/use-cases/reconcile-wallet';
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerResult,
} from '@/application/use-cases/submit-wager-transaction';
import type { WagerTransaction } from '@/domain/wager-transaction';
import { WagerTransactionStatus } from '@/domain/wager-transaction';
import type { Wallet } from '@/domain/wallet';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { LOGGER, PROVIDER_IDENTITY, UNIT_OF_WORK } from '@/infrastructure/tokens';
import { ApiRoleGuard } from './api-role.guard';
import { encodeLedgerCursor, parseLedgerQuery } from './ledger-query';
import { requestContextOf } from './request-context';
import {
  boundedString,
  parseCreateWallet,
  parseSubmitWager,
  requireIdempotencyKey,
  requireUuid,
} from '@/interface/validation';

// 201 says this request created the resource; a replay of the same fact returns
// 200 with idempotentReplay true. The business result is identical either way.
function httpStatusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    // FAILED is a recorded permanent infrastructure error, so it answers 500 and
    // never 503: resending the same key would produce the same result.
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

function walletView(wallet: Wallet): unknown {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function ledgerEntryView(entry: WalletLedgerEntry): unknown {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function transactionView(transaction: WagerTransaction): unknown {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.resultBalance?.toJSON(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}

@Controller()
@UseGuards(ApiRoleGuard)
export class WageringController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly submitWager: SubmitWagerTransactionUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(PROVIDER_IDENTITY) private readonly providerIdentity: ProviderIdentityPort,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  @Post('wallets')
  async postWallet(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = parseCreateWallet(body);
    const created = await this.createWallet.execute({
      playerId: parsed.playerId,
      initialBalance: parsed.initialBalance,
      correlationId: requestContextOf(response).correlationId,
    });

    this.logger.write('info', 'wallet created', {
      correlationId: requestContextOf(response).correlationId,
      walletId: created.id,
    });

    response.status(HttpStatus.CREATED);
    return created;
  }

  @Get('wallets/:walletId')
  async getWallet(@Param('walletId') walletId: string): Promise<unknown> {
    const validWalletId = requireUuid(walletId, 'walletId');
    const wallet = await this.unitOfWork.readOnly((repositories) =>
      repositories.wallets.findById(validWalletId),
    );
    if (!wallet) {
      throw new ApplicationError(ErrorCode.ResourceNotFound, 'wallet not found');
    }
    return walletView(wallet);
  }

  @Get('wallets/:walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const validWalletId = requireUuid(walletId, 'walletId');
    const query = parseLedgerQuery(cursor, limit);

    const page = await this.unitOfWork.readOnly(async (repositories) => {
      const wallet = await repositories.wallets.findById(validWalletId);
      if (!wallet) {
        throw new ApplicationError(ErrorCode.ResourceNotFound, 'wallet not found');
      }
      return repositories.ledger.page(wallet, query.limit, query.after);
    });

    const last = page.entries.at(-1);
    return {
      items: page.entries.map(ledgerEntryView),
      hasMore: page.hasMore,
      nextCursor: page.hasMore && last ? encodeLedgerCursor(last) : null,
    };
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async postReconciliation(
    @Param('walletId') walletId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const report = await this.reconcileWallet.execute(requireUuid(walletId, 'walletId'));

    if (!report.consistent) {
      // Amounts stay out of the log line (README §12); the response carries them.
      this.logger.write('error', 'wallet reconciliation diverged', {
        correlationId: requestContextOf(response).correlationId,
        walletId: report.walletId,
        checkedEntries: report.checkedEntries,
      });
    }

    return report;
  }

  @Post('wagering/transactions')
  async postWager(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const parsed = parseSubmitWager(body);
    const context = requestContextOf(response);
    const identity = await this.providerIdentity.resolve({ authorization }, parsed.providerId);

    const result = await this.submitWager.execute({
      ...parsed,
      providerId: identity.providerId,
      idempotencyKey: key,
      correlationId: context.correlationId,
      causationId: context.requestId,
    });

    this.logger.write('info', 'wager transaction completed', {
      correlationId: context.correlationId,
      transactionId: result.transactionId,
      walletId: parsed.walletId,
      providerId: identity.providerId,
      kind: parsed.kind,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });

    response.status(httpStatusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string): Promise<unknown> {
    const validTransactionId = requireUuid(transactionId, 'transactionId');
    const found = await this.unitOfWork.readOnly((repositories) =>
      repositories.wagerTransactions.findById(validTransactionId),
    );
    return transactionView(mustExist(found));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<unknown> {
    const validProviderId = boundedString(providerId, 'providerId', 64);
    const validExternalId = boundedString(
      externalTransactionId,
      'externalTransactionId',
      128,
    );
    const found = await this.unitOfWork.readOnly((repositories) =>
      repositories.wagerTransactions.findByExternalId(validProviderId, validExternalId),
    );
    return transactionView(mustExist(found));
  }
}

function mustExist(transaction: WagerTransaction | undefined): WagerTransaction {
  if (!transaction) {
    throw new ApplicationError(ErrorCode.ResourceNotFound, 'transaction not found');
  }
  return transaction;
}
