import type { Money } from '@/domain/money';
import type { WagerTransaction } from '@/domain/wager-transaction';
import type { Wallet } from '@/domain/wallet';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import type { IntegrationEvent } from './events/integration-event';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface ProviderCredentials {
  readonly authorization?: string | undefined;
}

export interface ProviderIdentity {
  readonly providerId: string;
}

// The extension point README §2 requires when authentication is not implemented.
// The SQS entry point deliberately skips it: the queue is an internal channel,
// and its payload is still fully validated by the domain.
export interface ProviderIdentityPort {
  resolve(
    credentials: ProviderCredentials,
    claimedProviderId: string,
  ): Promise<ProviderIdentity>;
}

export interface WalletRepository {
  insertIfAbsent(wallet: Wallet): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  reserve(transaction: WagerTransaction): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string, kind: string): Promise<boolean>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  lockDuePendingReference(now: Date): Promise<WagerTransaction | undefined>;
  update(transaction: WagerTransaction): Promise<void>;
}

export interface ReconstructedBalance {
  readonly balance: Money;
  readonly entries: number;
}

export interface LedgerCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  readonly hasMore: boolean;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  reconstructBalance(wallet: Wallet): Promise<ReconstructedBalance>;
  page(wallet: Wallet, limit: number, after?: LedgerCursor): Promise<LedgerPage>;
}

export interface OutboxRepository {
  enqueue(events: readonly IntegrationEvent<unknown>[], now: Date): Promise<void>;
}

export interface InboxMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly brokerMessageId?: string | undefined;
  readonly receivedAt: Date;
  readonly processedAt?: Date | undefined;
}

export interface InboxRepository {
  reserve(message: InboxMessage): Promise<InboxMessage | undefined>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(consumerName: string, messageId: string, processedAt: Date): Promise<void>;
}

export interface PublishableMessage {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export interface OutboxClaim extends PublishableMessage {
  readonly id: string;
  readonly eventType: string;
  readonly attempts: number;
}

// Drains what OutboxRepository enqueued. Each method owns a short transaction of
// its own: the send happens between them, never inside one.
export interface OutboxClaimRepository {
  claim(publisherId: string, now: Date, leaseUntil: Date): Promise<OutboxClaim | undefined>;
  markPublished(id: string, publisherId: string, publishedAt: Date): Promise<boolean>;
  reschedule(
    id: string,
    publisherId: string,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<boolean>;
}

export interface EventPublisher {
  publish(message: PublishableMessage): Promise<void>;
}

export type WagerMetricSource = 'http' | 'sqs' | 'pending-reference';

export interface WagerMetricObservation {
  readonly source: WagerMetricSource;
  readonly kind: string;
  readonly outcome: string;
  readonly status?: string | undefined;
  readonly idempotentReplay?: boolean | undefined;
  readonly durationSeconds: number;
}

export interface MetricsPort {
  observeWager(observation: WagerMetricObservation): void;
  recordDuplicate(layer: 'business' | 'inbox'): void;
  recordRetry(component: 'sqs-consumer' | 'pending-reference' | 'outbox', reason: string): void;
  recordDlq(reason: string): void;
  observeWalletLock(
    durationSeconds: number,
    outcome: 'acquired' | 'not_found' | 'lock_timeout' | 'deadlock' | 'error',
  ): void;
  recordLockConflict(reason: 'lock_timeout' | 'deadlock'): void;
  observeOutboxPublish(outcome: string, durationSeconds: number): void;
  recordPendingReference(outcome: string): void;
  recordReconciliation(consistent: boolean): void;
  observeHttp(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void;
}

export interface MetricsExporter {
  readonly contentType: string;
  exposition(): Promise<string>;
}

export const NOOP_METRICS: MetricsPort = {
  observeWager: () => undefined,
  recordDuplicate: () => undefined,
  recordRetry: () => undefined,
  recordDlq: () => undefined,
  observeWalletLock: () => undefined,
  recordLockConflict: () => undefined,
  observeOutboxPublish: () => undefined,
  recordPendingReference: () => undefined,
  recordReconciliation: () => undefined,
  observeHttp: () => undefined,
};

export interface UnitOfWork {
  // transactional writes at READ COMMITTED; readOnly reads one snapshot at
  // REPEATABLE READ READ ONLY and takes no lock.
  transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  readOnly<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export interface Repositories {
  readonly wallets: WalletRepository;
  readonly wagerTransactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}
