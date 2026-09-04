import { EntitySchema } from '@mikro-orm/postgresql';

// Monetary columns are declared as string on both sides: node-postgres returns
// numeric as text, so no value ever passes through a JS number.
const MONEY = { type: 'string', columnType: 'numeric(20,2)' } as const;

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultBalanceCurrency: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
  correlationId: string;
  createdAt: Date;
  processedAt: Date | null;
}

export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  brokerMessageId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxMessageRow {
  id: string;
  eventId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  claimedBy: string | null;
  claimedUntil: Date | null;
  lastError: string | null;
  publishedAt: Date | null;
}

export const walletSchema = new EntitySchema<WalletRow>({
  name: 'Wallet',
  tableName: 'wallet',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...MONEY },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransaction',
  tableName: 'wager_transaction',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string', columnType: 'wager_transaction_kind' },
    amount: { ...MONEY },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', columnType: 'wager_transaction_status' },
    failureCode: {
      type: 'string',
      fieldName: 'failure_code',
      columnType: 'wager_failure_code',
      nullable: true,
    },
    resultBalanceAmount: { ...MONEY, fieldName: 'result_balance_amount', nullable: true },
    resultBalanceCurrency: {
      type: 'string',
      fieldName: 'result_balance_currency',
      columnType: 'char(3)',
      nullable: true,
    },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', nullable: true },
    expiresAt: { type: 'Date', fieldName: 'expires_at', nullable: true },
    correlationId: { type: 'string', fieldName: 'correlation_id' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entry',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', columnType: 'ledger_direction' },
    amount: { ...MONEY },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...MONEY, fieldName: 'balance_before' },
    balanceAfter: { ...MONEY, fieldName: 'balance_after' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
  },
});

export const inboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: 'InboxMessage',
  tableName: 'inbox_message',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    brokerMessageId: { type: 'string', fieldName: 'broker_message_id', nullable: true },
    receivedAt: { type: 'Date', fieldName: 'received_at' },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export const outboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: 'OutboxMessage',
  tableName: 'outbox_message',
  properties: {
    id: { type: 'uuid', primary: true },
    eventId: { type: 'uuid', fieldName: 'event_id' },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at' },
    claimedBy: { type: 'string', fieldName: 'claimed_by', nullable: true },
    claimedUntil: { type: 'Date', fieldName: 'claimed_until', nullable: true },
    lastError: { type: 'text', fieldName: 'last_error', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
  },
});

export const SCHEMAS = [
  walletSchema,
  wagerTransactionSchema,
  walletLedgerEntrySchema,
  inboxMessageSchema,
  outboxMessageSchema,
];
