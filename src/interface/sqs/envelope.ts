import { createHash } from 'node:crypto';

import { canonicalize } from '@/application/idempotency/payload-hash';
import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import { asRecord, invalid, parseSubmitWager, requiredString } from '@/interface/validation';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const EXPECTED_TYPE = 'WagerTransactionRequested';

export interface WagerMessage {
  readonly messageId: string;
  readonly occurredAt: Date;
  readonly inboxPayloadHash: string;
  readonly command: SubmitWagerCommand;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function correlationIdOf(consumerName: string, messageId: string): string {
  return sha256Hex(`${consumerName}\0${messageId}`);
}

export function parseWagerMessage(rawBody: string): WagerMessage {
  const envelope = asRecord(parseJson(rawBody));
  const messageId = requiredString(envelope, 'messageId');

  const type = requiredString(envelope, 'type');
  if (type !== EXPECTED_TYPE) {
    invalid(`type must be ${EXPECTED_TYPE}`);
  }

  const occurredAt = timestamp(envelope, 'occurredAt');
  const data = asRecord(envelope['data']);
  const idempotencyKey = requiredString(data, 'idempotencyKey');

  return {
    messageId,
    occurredAt,
    // Transport-level hash: the whole envelope minus the key itself, so the same
    // messageId arriving with different content is a conflict, not a redelivery.
    inboxPayloadHash: sha256Hex(
      canonicalize({ type, occurredAt: occurredAt.toISOString(), data }),
    ),
    command: {
      ...parseSubmitWager(data),
      idempotencyKey,
      correlationId: correlationIdOf(CONSUMER_NAME, messageId),
      causationId: messageId,
    },
  };
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    invalid('the message body must be valid JSON');
  }
}

function timestamp(source: Record<string, unknown>, field: string): Date {
  const parsed = new Date(requiredString(source, field));
  if (Number.isNaN(parsed.getTime())) {
    invalid(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}
