import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  INPUT_QUEUE,
  drainQueue,
  queueUrl,
  sendRaw,
  sqsClient,
} from '../integration/support/sqs';
import { startCluster, type Cluster } from './support/cluster';
import {
  connectDatabase,
  gate,
  inParallel,
  inspectWallet,
  openWallet,
  submitWager,
  type WagerResponse,
} from './support/scenario';

const BOOT_TIMEOUT_MS = 120_000;
const SCENARIO_TIMEOUT_MS = 90_000;

let cluster: Cluster;
let sql: SQL;

beforeAll(async () => {
  cluster = await startCluster(3);
  sql = connectDatabase();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await cluster.shutdown();
  await sql.end();
});

const label = (): string => crypto.randomUUID().slice(0, 8);
const processed = (responses: readonly WagerResponse[]): WagerResponse[] =>
  responses.filter((response) => response.body.status === 'PROCESSED');

describe('README §13.4 — três processos simultâneos', () => {
  test('as três instâncias são processos distintos sobre a mesma infraestrutura', async () => {
    const identities = await Promise.all(
      cluster.instances.map(async (url) => {
        const response = await fetch(`${url}/health/live`);
        return ((await response.json()) as { instanceId: string }).instanceId;
      }),
    );

    expect(new Set(identities).size).toBe(3);
  });
});

describe('README §13.1 — a mesma aposta 50 vezes em paralelo', () => {
  test(
    'produz um único débito e 49 replays, distribuída entre as três instâncias',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());
      const externalTransactionId = `same-bet-${label()}`;

      const responses = await inParallel(
        Array.from({ length: 50 }, () => () =>
          submitWager(cluster.next(), {
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount: '25.00',
          }),
        ),
      );

      const created = responses.filter((response) => response.status === 201);
      const replays = responses.filter((response) => response.body.idempotentReplay === true);

      expect(created).toHaveLength(1);
      expect(replays).toHaveLength(49);

      const transactionIds = new Set(responses.map((response) => response.body.transactionId));
      expect(transactionIds.size).toBe(1);

      const state = await inspectWallet(sql, wallet.id);
      expect(state.debits).toBe(1);
      expect(state.balance.toString()).toBe('975.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('README §13.2 e §8 — cenário obrigatório', () => {
  test(
    'saldo 100.00 com duas apostas de 80.00: uma aplica, a outra é recusada',
    async () => {
      const wallet = await openWallet(cluster, '100.00', label());

      const responses = await inParallel(
        ['first', 'second'].map((suffix) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `race-${suffix}-${label()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount: '80.00',
          }),
        ),
      );

      const applied = processed(responses);
      const rejected = responses.filter((response) => response.body.status === 'REJECTED');

      expect(applied).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejected[0]?.status).toBe(422);

      const state = await inspectWallet(sql, wallet.id);
      expect(state.balance.toString()).toBe('20.00');
      expect(state.debits).toBe(1);
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('README §13.3 — wallets distintas em paralelo', () => {
  test(
    'doze wallets independentes progridem juntas e cada ledger fecha',
    async () => {
      const wallets = await Promise.all(
        Array.from({ length: 12 }, () => openWallet(cluster, '100.00', label())),
      );

      const responses = await inParallel(
        wallets.map((wallet) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `parallel-${wallet.id}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount: '30.00',
          }),
        ),
      );

      expect(processed(responses)).toHaveLength(12);

      for (const wallet of wallets) {
        const state = await inspectWallet(sql, wallet.id);
        expect(state.balance.toString()).toBe('70.00');
        expect(state.reconstructed.equals(state.balance)).toBe(true);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  test(
    'uma wallet travada não bloqueia outra: não existe lock global',
    async () => {
      const held = await openWallet(cluster, '100.00', label());
      const free = await openWallet(cluster, '100.00', label());

      const holder = connectDatabase();
      const acquired = gate();
      const release = gate();

      const holding = holder.begin(async (tx) => {
        await tx`SELECT id FROM wallet WHERE id = ${held.id}::uuid FOR UPDATE`;
        acquired.open();
        await release.wait;
      });

      await acquired.wait;

      // Without a submission on the held wallet, an app that never took the lock
      // would pass this test.
      let contendedSettled = false;
      const contended = submitWager(cluster.next(), {
        externalTransactionId: `blocked-${label()}`,
        playerId: held.playerId,
        walletId: held.id,
        kind: 'BET',
        amount: '10.00',
      });
      contended.finally(() => {
        contendedSettled = true;
      });

      const startedAt = Date.now();
      const response = await submitWager(cluster.next(), {
        externalTransactionId: `unblocked-${label()}`,
        playerId: free.playerId,
        walletId: free.id,
        kind: 'BET',
        amount: '10.00',
      });
      const elapsedMs = Date.now() - startedAt;
      const blockedWhileHeld = !contendedSettled;

      release.open();
      await holding;
      await holder.end();

      // The app's lock_timeout is 20 s; a global lock would push this past it.
      expect(elapsedMs).toBeLessThan(10_000);
      expect(response.body.status).toBe('PROCESSED');
      expect(blockedWhileHeld).toBe(true);
      expect((await contended).body.status).toBe('PROCESSED');

      const state = await inspectWallet(sql, free.id);
      expect(state.balance.toString()).toBe('90.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);

      const contendedState = await inspectWallet(sql, held.id);
      expect(contendedState.balance.toString()).toBe('90.00');
      expect(contendedState.reconstructed.equals(contendedState.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('hot wallet e conflito sob paralelismo real', () => {
  test(
    'trinta operações distintas na mesma wallet: nenhuma perdida, nenhum lost update',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());

      const responses = await inParallel(
        Array.from({ length: 30 }, (_unused, index) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `hot-${index}-${label()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount: '10.00',
          }),
        ),
      );

      expect(processed(responses)).toHaveLength(30);

      const state = await inspectWallet(sql, wallet.id);
      expect(state.debits).toBe(30);
      expect(state.balance.toString()).toBe('700.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  test(
    'mesma key com payloads divergentes em paralelo: uma aplica, a outra conflita',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());
      const shared = `conflict-${label()}`;

      const responses = await inParallel(
        ['25.00', '99.00'].map((amount) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: shared,
            idempotencyKey: shared,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount,
          }),
        ),
      );

      expect(processed(responses)).toHaveLength(1);
      const conflicts = responses.filter((response) => response.status === 409);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.body.error?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

      const state = await inspectWallet(sql, wallet.id);
      expect(state.debits).toBe(1);
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('reversões concorrentes sobre a mesma referência', () => {
  test(
    'dois REFUND simultâneos: um aplica, o outro é recusado por já revertida',
    async () => {
      const wallet = await openWallet(cluster, '100.00', label());
      const betId = `refund-race-bet-${label()}`;
      const round = `round-${betId}`;

      await submitWager(cluster.next(), {
        externalTransactionId: betId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: round,
        kind: 'BET',
        amount: '25.00',
      });

      const responses = await inParallel(
        ['a', 'b'].map((suffix) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `refund-${suffix}-${label()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: round,
            kind: 'REFUND',
            amount: '25.00',
            referenceExternalTransactionId: betId,
          }),
        ),
      );

      expect(processed(responses)).toHaveLength(1);
      const rejected = responses.filter((response) => response.body.status === 'REJECTED');
      expect(rejected[0]?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

      const state = await inspectWallet(sql, wallet.id);
      expect(state.balance.toString()).toBe('100.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  test(
    'REFUND e ROLLBACK simultâneos sobre a mesma BET aplicam um só, em qualquer instância',
    async () => {
      const wallet = await openWallet(cluster, '100.00', label());
      const betId = `optionb-bet-${label()}`;
      const round = `round-${betId}`;

      await submitWager(cluster.next(), {
        externalTransactionId: betId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: round,
        kind: 'BET',
        amount: '25.00',
      });

      const responses = await inParallel(
        (['REFUND', 'ROLLBACK'] as const).map((kind) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `${kind.toLowerCase()}-${label()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: round,
            kind,
            amount: '25.00',
            referenceExternalTransactionId: betId,
          }),
        ),
      );

      expect(processed(responses)).toHaveLength(1);

      const state = await inspectWallet(sql, wallet.id);
      expect(state.balance.toString()).toBe('100.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('README §8 — vários consumidores recebendo operações da mesma wallet', () => {
  test(
    'mensagens distintas para a mesma wallet são serializadas pelo banco, não pelo broker',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());
      const sqs = sqsClient();
      const inputUrl = await queueUrl(sqs, INPUT_QUEUE);
      const total = 12;
      const holder = connectDatabase();
      const acquired = gate();
      const release = gate();
      const holding = holder.begin(async (tx) => {
        await tx`SELECT id FROM wallet WHERE id = ${wallet.id}::uuid FOR UPDATE`;
        acquired.open();
        await release.wait;
      });

      try {
        await drainQueue(sqs, inputUrl);
        await acquired.wait;
        const before = await sqsProcessedByInstance();

        // One MessageGroupId per message on purpose: grouping by wallet would let
        // FIFO serialise the work and prove nothing. Here only the wallet lock can
        // keep the balance correct (INV-053).
        await Promise.all(
          Array.from({ length: total }, async (_unused, index) => {
            const messageId = `same-wallet-${index}-${label()}`;
            await sendRaw(
              sqs,
              inputUrl,
              JSON.stringify({
                messageId,
                type: 'WagerTransactionRequested',
                occurredAt: new Date().toISOString(),
                data: {
                  providerId: 'provider-a',
                  externalTransactionId: messageId,
                  idempotencyKey: `provider-a:${messageId}`,
                  playerId: wallet.playerId,
                  walletId: wallet.id,
                  roundId: `round-${messageId}`,
                  gameId: 'fortune-chimp',
                  kind: 'BET',
                  money: { amount: '10.00', currency: 'BRL' },
                },
              }),
              { groupId: messageId, deduplicationId: messageId },
            );
          }),
        );

        // Each WagerConsumerWorker handles one delivery at a time. Two runtime
        // backends waiting on the held wallet lock prove that distinct workers
        // participated and actually contended instead of merely consuming 12 rows.
        const waitingWorkers = await waitForRuntimeLockWaiters(2);
        expect(waitingWorkers).toBeGreaterThanOrEqual(2);

        release.open();
        await holding;

        const state = await waitForDebits(wallet.id, total);
        const after = await sqsProcessedByInstance();
        const participatingInstances = after.filter(
          (count, index) => count > (before[index] ?? 0),
        );

        expect(participatingInstances.length).toBeGreaterThanOrEqual(2);
        expect(state.debits).toBe(total);
        expect(state.balance.toString()).toBe('880.00');
        expect(state.reconstructed.equals(state.balance)).toBe(true);
      } finally {
        release.open();
        await Promise.allSettled([holding]);
        await holder.end();
        sqs.destroy();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function sqsProcessedByInstance(): Promise<number[]> {
  return Promise.all(
    cluster.instances.map(async (url) => {
      const exposition = await (await fetch(`${url}/metrics`)).text();
      return exposition
        .split('\n')
        .filter(
          (line) => line.startsWith('wager_transactions_total{') && line.includes('source="sqs"'),
        )
        .reduce((total, line) => total + Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1)), 0);
    }),
  );
}

async function waitForRuntimeLockWaiters(expected: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  let waiting = 0;

  while (Date.now() <= deadline) {
    const rows = (await sql`
      SELECT count(DISTINCT pid)::int AS waiting
      FROM pg_stat_activity
      WHERE usename = 'wagering_app'
        AND state = 'active'
        AND wait_event_type = 'Lock'
    `) as { waiting: number }[];
    waiting = rows[0]?.waiting ?? 0;
    if (waiting >= expected) {
      return waiting;
    }
    await Bun.sleep(50);
  }

  return waiting;
}

async function waitForDebits(
  walletId: string,
  expected: number,
): Promise<Awaited<ReturnType<typeof inspectWallet>>> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const state = await inspectWallet(sql, walletId);
    if (state.debits >= expected || Date.now() > deadline) {
      return state;
    }
    await Bun.sleep(250);
  }
}

describe('README §13.8 — reinício com consistência final', () => {
  test(
    'mata os três processos com requests em voo e recupera após iniciar processos novos',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());

      const restartLabel = label();
      const requests = Array.from({ length: 20 }, (_unused, index) => ({
        externalTransactionId: `restart-${index}-${restartLabel}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '10.00',
      }));
      const holder = connectDatabase();
      const acquired = gate();
      const release = gate();
      const holding = holder.begin(async (tx) => {
        await tx`SELECT id FROM wallet WHERE id = ${wallet.id}::uuid FOR UPDATE`;
        acquired.open();
        await release.wait;
      });

      await acquired.wait;
      const inFlight = inParallel(
        requests.map((request, index) => () =>
          submitWager(cluster.instances[index % cluster.instances.length]!, request),
        ),
      );
      // Attach the rejection handler before SIGKILL; connection resets are the
      // expected transport result of killing the serving processes.
      const interrupted = Promise.allSettled([inFlight]);

      try {
        expect(await waitForRuntimeLockWaiters(3)).toBeGreaterThanOrEqual(3);
        await Promise.all(cluster.instances.map((_url, index) => cluster.stop(index)));
        await interrupted;
      } finally {
        release.open();
        await holding;
        await holder.end();
      }

      await Promise.all(cluster.instances.map((_url, index) => cluster.start(index)));

      const recovered = await inParallel(
        requests.map((request) => () => submitWager(cluster.next(), request)),
      );
      expect(processed(recovered)).toHaveLength(requests.length);

      const recoveredState = await inspectWallet(sql, wallet.id);
      expect(recoveredState.debits).toBe(20);
      expect(recoveredState.balance.toString()).toBe('800.00');
      expect(recoveredState.reconstructed.equals(recoveredState.balance)).toBe(true);

      const survivor = await submitWager(cluster.next(), {
        externalTransactionId: `after-restart-${label()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '10.00',
      });
      expect(survivor.body.status).toBe('PROCESSED');

      const finalState = await inspectWallet(sql, wallet.id);
      expect(finalState.debits).toBe(21);
      expect(finalState.balance.toString()).toBe('790.00');
      expect(finalState.reconstructed.equals(finalState.balance)).toBe(true);

      const reconciliation = await fetch(`${cluster.next()}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      expect(reconciliation.status).toBe(200);
      expect(await reconciliation.json()).toMatchObject({
        walletId: wallet.id,
        storedBalance: { amount: '790.00', currency: 'BRL' },
        calculatedBalance: { amount: '790.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 22,
      });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
