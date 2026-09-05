import type { LedgerCursor } from '@/application/ports';
import { invalid, requireUuid } from '@/interface/validation';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export interface LedgerQuery {
  readonly limit: number;
  readonly after?: LedgerCursor | undefined;
}

// Opaque on purpose: the client must not build a cursor by hand, because the
// keyset is a storage detail and a hand-made pair could skip or repeat entries.
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

export function parseLedgerQuery(cursor?: string, limit?: string): LedgerQuery {
  const after = cursor === undefined || cursor === '' ? undefined : decodeCursor(cursor);
  return after === undefined ? { limit: parseLimit(limit) } : { limit: parseLimit(limit), after };
}

function parseLimit(raw?: string): number {
  if (raw === undefined || raw === '') {
    return LEDGER_DEFAULT_LIMIT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    invalid('limit must be an integer');
  }

  const limit = Number.parseInt(raw, 10);
  if (limit < 1 || limit > LEDGER_MAX_LIMIT) {
    invalid(`limit must be between 1 and ${LEDGER_MAX_LIMIT}`);
  }
  return limit;
}

function decodeCursor(raw: string): LedgerCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator < 0) {
    invalid('cursor is not a valid ledger cursor');
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id === '') {
    invalid('cursor is not a valid ledger cursor');
  }

  return { createdAt, id: requireUuid(id, 'cursor id') };
}
