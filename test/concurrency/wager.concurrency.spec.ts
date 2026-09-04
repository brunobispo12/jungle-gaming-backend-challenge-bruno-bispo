import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

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

      const startedAt = Date.now();
      const response = await submitWager(cluster.next(), {
        externalTransactionId: `unblocked-${label()}`,
        playerId: free.playerId,
        walletId: free.id,
        kind: 'BET',
        amount: '10.00',
      });

      release.open();
      await holding;
      await holder.end();

      // The app's lock_timeout is 20 s; a global lock would push this past it.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(response.body.status).toBe('PROCESSED');
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
    'opção B: REFUND e ROLLBACK simultâneos sobre a mesma BET aplicam os dois',
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

      // Declared consequence of option B: two reversals of different kinds over
      // the same BET both apply, crediting twice.
      expect(processed(responses)).toHaveLength(2);

      const state = await inspectWallet(sql, wallet.id);
      expect(state.balance.toString()).toBe('125.00');
      expect(state.reconstructed.equals(state.balance)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe('README §13.8 — reinício com consistência final', () => {
  test(
    'matar e reiniciar uma instância sob carga não quebra a invariante final',
    async () => {
      const wallet = await openWallet(cluster, '1000.00', label());

      const submissions = inParallel(
        Array.from({ length: 20 }, (_unused, index) => () =>
          submitWager(cluster.next(), {
            externalTransactionId: `restart-${index}-${label()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            amount: '10.00',
          }).catch(() => ({ status: 0, body: {} }) as WagerResponse),
        ),
      );

      await cluster.stop(1);
      const responses = await submissions;
      await cluster.start(1);

      const applied = processed(responses);
      const state = await inspectWallet(sql, wallet.id);

      // Requests in flight on the killed instance may be lost; what must hold is
      // that every applied effect left the ledger and the balance agreeing.
      expect(state.debits).toBe(applied.length);
      expect(state.reconstructed.equals(state.balance)).toBe(true);

      const survivor = await submitWager(cluster.next(), {
        externalTransactionId: `after-restart-${label()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '10.00',
      });
      expect(survivor.body.status).toBe('PROCESSED');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
