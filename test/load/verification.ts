import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

export interface Wallet { id: string; playerId: string }
export interface Fixture {
  scenario: string;
  providerId: string;
  urls: string[];
  openingAmount: string;
  wallets: Wallet[];
}
export interface Envelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

interface WalletState {
  id: string; balance: string; version: number; entries: number;
  minimum_historical_balance: string; valid_entries: boolean; consistent: boolean;
}
interface WagerRow {
  id: string; provider_id: string; idempotency_key: string; external_transaction_id: string;
  status: string; failure_code: string | null; processed_at: Date | null;
  entries: number; matching_entries: number; payload_hash: string; player_id: string;
  wallet_id: string; round_id: string; game_id: string; kind: string; amount_text: string; currency: string;
}
interface EventRow {
  id: string; event_id: string; event_type: string; published_at: Date | null;
  claimed_by: string | null; claimed_until: Date | null;
  payload: { eventId: string; eventType: string; data: { transactionId: string } };
}
interface InboxRow {
  message_id: string; processed_at: Date | null; broker_message_id: string | null;
  consumer_name: string; payload_hash: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export async function state(sql: SQL, fixture: Fixture) {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM outbox_message
       WHERE payload->'data'->>'walletId' IN
         (SELECT jsonb_array_elements_text(${JSON.stringify(fixture.wallets.map(w => w.id))}::text::jsonb))
       AND published_at IS NULL) AS pending,
      (SELECT COALESCE(max(extract(epoch FROM now()-occurred_at)),0)::float8
       FROM outbox_message WHERE published_at IS NULL
       AND payload->'data'->>'walletId' IN
         (SELECT jsonb_array_elements_text(${JSON.stringify(fixture.wallets.map(w => w.id))}::text::jsonb))) AS oldest_seconds,
      (SELECT count(*)::int FROM wager_transaction WHERE provider_id=${fixture.providerId}) AS transactions,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()
       AND usename='wagering_app' AND state='active' AND wait_event_type='Lock') AS lock_waiters
  `;
  return row as { pending: number; oldest_seconds: number; transactions: number; lock_waiters: number };
}

export async function verify(
  sql: SQL, fixture: Fixture, expected: Record<string, number>, envelopes: Envelope[],
) {
  return sql.begin(async tx => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const ids = JSON.stringify(fixture.wallets.map(w => w.id));
    const wallets = await tx<WalletState[]>`
      SELECT w.id,w.balance::text,w.currency,w.version,
        COALESCE(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::text AS reconstructed,
        count(l.id)::int AS entries,
        min(l.balance_after)::text AS minimum_historical_balance,
        bool_and(l.balance_after >= 0 AND l.balance_before >= 0
          AND l.balance_after=l.balance_before+CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END
          AND l.currency=w.currency) AS valid_entries,
        w.balance=COALESCE(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0) AS consistent
      FROM wallet w LEFT JOIN wallet_ledger_entry l ON l.wallet_id=w.id
      WHERE w.id IN (SELECT jsonb_array_elements_text(${ids}::text::jsonb)::uuid)
      GROUP BY w.id
    `;
    assert.equal(wallets.length, fixture.wallets.length, 'missing wallet');
    for (const w of wallets) {
      assert.equal(w.consistent, true, `ledger divergence: ${w.id}`);
      assert.equal(w.valid_entries, true, `invalid monetary entry: ${w.id}`);
      // All load wallets have a positive OPENING; subsequent balance changes increment version.
      assert.equal(w.version, w.entries, `version does not match effects: ${w.id}`);
      assert.ok(!w.balance.startsWith('-'), `negative wallet: ${w.id}`);
    }
    const wagers = await tx<WagerRow[]>`
      SELECT t.*, t.amount::text AS amount_text,
        (SELECT count(*)::int FROM wallet_ledger_entry l WHERE l.transaction_id=t.id) AS entries,
        (SELECT count(*)::int FROM wallet_ledger_entry l WHERE l.transaction_id=t.id
          AND l.wallet_id=t.wallet_id AND l.currency=t.currency AND l.amount=t.amount
          AND l.direction::text=CASE WHEN t.kind='BET' THEN 'DEBIT' ELSE 'CREDIT' END
          AND l.balance_after=t.result_balance_amount) AS matching_entries
      FROM wager_transaction t
      WHERE t.wallet_id IN (SELECT jsonb_array_elements_text(${ids}::text::jsonb)::uuid)
    `;
    const seenKeys = new Set<string>();
    const seenExternal = new Set<string>();
    const counts: Record<string, number> = {};
    const failureCodes: Record<string, number> = {};
    const rejectedByKind: Record<string, number> = {};
    let refused = 0;
    for (const t of wagers) {
      const key = `${t.provider_id}:${t.idempotency_key}`;
      const external = `${t.provider_id}:${t.external_transaction_id}`;
      assert.ok(!seenKeys.has(key) && !seenExternal.has(external), 'duplicate identity');
      seenKeys.add(key); seenExternal.add(external);
      assert.ok(['PROCESSED', 'REJECTED'].includes(t.status), `nonterminal wager: ${t.id}`);
      assert.ok(['OPENING', 'BET', 'WIN', 'LOSS'].includes(t.kind));
      assert.ok(t.processed_at);
      if (t.status === 'REJECTED') {
        assert.ok(t.failure_code, `rejection without failureCode: ${t.id}`);
        assert.equal(t.entries, 0, `rejection moved the ledger: ${t.id}`);
        refused += 1;
        failureCodes[t.failure_code] = (failureCodes[t.failure_code] ?? 0) + 1;
        rejectedByKind[t.kind] = (rejectedByKind[t.kind] ?? 0) + 1;
      } else {
        assert.equal(t.failure_code, null);
        assert.equal(t.entries, t.kind === 'LOSS' ? 0 : 1, `wrong ledger cardinality: ${t.id}`);
        assert.equal(t.matching_entries, t.entries, `ledger does not match wager: ${t.id}`);
      }
      assert.equal(t.payload_hash, hash({
        providerId: t.provider_id, externalTransactionId: t.external_transaction_id,
        playerId: t.player_id, walletId: t.wallet_id, roundId: t.round_id, gameId: t.game_id,
        kind: t.kind, amount: t.amount_text, currency: t.currency,
      }), `wrong payloadHash: ${t.id}`);
      assert.equal(t.currency, 'BRL');
      assert.ok(fixture.wallets.some(w => w.id === t.wallet_id && w.playerId === t.player_id));
      if (t.kind === 'OPENING') {
        assert.equal(t.amount_text, fixture.openingAmount);
      } else {
        assert.equal(t.provider_id, fixture.providerId);
        assert.equal(t.amount_text, '1.00');
        assert.equal(t.idempotency_key, t.external_transaction_id);
        if (t.status === 'PROCESSED') counts[t.kind] = (counts[t.kind] ?? 0) + 1;
      }
    }
    for (const kind of ['BET', 'WIN', 'LOSS']) {
      assert.equal(counts[kind] ?? 0, expected[kind] ?? 0, `client/DB count mismatch: ${kind}`);
    }
    assert.equal(refused, expected['REJECTED'] ?? 0, 'client/DB count mismatch: REJECTED');
    assert.equal(wagers.filter(t => t.kind === 'OPENING').length, fixture.wallets.length);
    const events = await tx<EventRow[]>`
      SELECT * FROM outbox_message WHERE payload->'data'->>'walletId' IN
        (SELECT jsonb_array_elements_text(${ids}::text::jsonb))
    `;
    const eventCounts = new Map<string, number>();
    const eventIds = new Set<string>();
    const wagerIds = new Set(wagers.map(t => t.id));
    for (const e of events) {
      assert.ok(!eventIds.has(e.event_id), 'duplicate eventId'); eventIds.add(e.event_id);
      assert.equal(e.payload.eventId, e.event_id);
      assert.equal(e.payload.eventType, e.event_type);
      assert.ok(wagerIds.has(e.payload.data.transactionId), 'orphan event');
      assert.ok(e.published_at, `pending Outbox after drain: ${e.id}`);
      assert.equal(e.claimed_by, null); assert.equal(e.claimed_until, null);
      assert.ok(['WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged']
        .includes(e.event_type));
      const key = `${e.payload.data.transactionId}:${e.event_type}`;
      eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
    }
    for (const t of wagers) {
      const outcome = t.status === 'REJECTED' ? 'WagerTransactionRejected' : 'WagerTransactionProcessed';
      assert.equal(eventCounts.get(`${t.id}:${outcome}`), 1, 'missing/duplicate Wager event');
      assert.equal(eventCounts.get(`${t.id}:WalletBalanceChanged`) ?? 0,
        t.status === 'REJECTED' || t.kind === 'LOSS' ? 0 : 1, 'missing/duplicate balance event');
    }
    const inbox = await tx<InboxRow[]>`
      SELECT * FROM inbox_message WHERE message_id LIKE ${fixture.providerId + ':%'}
    `;
    assert.equal(inbox.length, envelopes.length, 'Inbox cardinality');
    for (const envelope of envelopes) {
      const i = inbox.find(i => i.message_id === envelope.messageId);
      assert.ok(i?.processed_at && i?.broker_message_id, 'missing processed Inbox');
      assert.equal(i.consumer_name, 'wager-transactions-consumer');
      assert.equal(i.payload_hash, hash({ type: envelope.type, occurredAt: envelope.occurredAt, data: envelope.data }));
      assert.ok(wagers.some(t => t.external_transaction_id === envelope.data['externalTransactionId']
        && t.provider_id === fixture.providerId), 'Inbox without financial outcome');
    }
    return { passed: true, wallets: wallets.length, transactions: wagers.length,
      counts, rejected: refused, rejectedByKind, failureCodes,
      events: events.length, inbox: inbox.length,
      walletStates: wallets.map(w => ({
        walletId: w.id, balance: w.balance, version: w.version, entries: w.entries,
        minimumHistoricalBalance: w.minimum_historical_balance,
      })),
    };
  });
}
