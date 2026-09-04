import { Money, type MoneyProps } from '@/domain/money';
import { WagerTransaction, openingIdentity } from '@/domain/wager-transaction';
import { Wallet } from '@/domain/wallet';
import { payloadHashOf } from '@/application/idempotency/payload-hash';
import { ApplicationError, ErrorCode } from '@/application/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '@/application/events/wager-events';
import type { Clock, IdGenerator, UnitOfWork } from '@/application/ports';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      openingEntryId: this.ids.next(),
      openingTransactionId,
    });

    return this.unitOfWork.transactional(async (repositories) => {
      const created = await repositories.wallets.insertIfAbsent(wallet);

      if (!created) {
        const existing = await repositories.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );
        throw new ApplicationError(
          ErrorCode.WalletAlreadyExists,
          'a wallet already exists for this player and currency',
          { existingWalletId: existing?.id },
        );
      }

      if (!openingEntry) {
        return view(created);
      }

      const opening = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: created.id,
        playerId: created.playerId,
        money: initialBalance,
        payloadHash: payloadHashOf({
          ...openingIdentity(created.id),
          playerId: created.playerId,
          walletId: created.id,
          kind: 'OPENING',
          money: initialBalance,
        }),
        correlationId: command.correlationId,
        createdAt: now,
      });
      // Reserve while PENDING, then transition: the schema refuses a terminal
      // status without processedAt, and the reservation writes no result columns.
      await repositories.wagerTransactions.reserve(opening);
      opening.markProcessed({ resultBalance: created.balance, at: now });
      await repositories.wagerTransactions.update(opening);
      await repositories.ledger.insert(openingEntry);

      const context = {
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      };

      await repositories.outbox.enqueue(
        [
          WagerTransactionProcessed.from(opening, context),
          WalletBalanceChanged.from(created, openingEntry, {
            ...context,
            eventId: this.ids.next(),
            causationId: opening.id,
          }),
        ],
        now,
      );

      return view(created);
    });
  }
}

function view(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
