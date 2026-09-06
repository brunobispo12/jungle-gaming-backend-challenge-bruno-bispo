import { describe, expect, test } from 'bun:test';
import type { Request, Response } from 'express';

import type { ProviderIdentityPort, UnitOfWork } from '@/application/ports';
import type { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import type { ReconcileWalletUseCase } from '@/application/use-cases/reconcile-wallet';
import type {
  SubmitWagerCommand,
  SubmitWagerResult,
  SubmitWagerTransactionUseCase,
} from '@/application/use-cases/submit-wager-transaction';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { TrustedProviderIdentityAdapter } from '@/infrastructure/security/trusted-provider-identity';
import { WageringController } from '@/interface/http/wagering.controller';

const BODY = {
  providerId: 'provider-declared',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

function fakeRequest(): Request {
  return { rawHeaders: ['Idempotency-Key', 'key'] } as unknown as Request;
}

function fakeResponse(): Response {
  return {
    locals: {},
    status: () => undefined,
    setHeader: () => undefined,
    getHeader: () => undefined,
  } as unknown as Response;
}

function controllerWith(providerIdentity: ProviderIdentityPort): {
  controller: WageringController;
  submitted: SubmitWagerCommand[];
} {
  const submitted: SubmitWagerCommand[] = [];

  const submitWager = {
    execute: (command: SubmitWagerCommand): Promise<SubmitWagerResult> => {
      submitted.push(command);
      return Promise.resolve({
        transactionId: 'transaction-id',
        status: 'PROCESSED',
        idempotentReplay: false,
      } as SubmitWagerResult);
    },
  } as unknown as SubmitWagerTransactionUseCase;

  const controller = new WageringController(
    {} as CreateWalletUseCase,
    submitWager,
    {} as ReconcileWalletUseCase,
    {} as UnitOfWork,
    providerIdentity,
    { write: () => undefined } as unknown as JsonLogger,
  );

  return { controller, submitted };
}

describe('TrustedProviderIdentityAdapter', () => {
  test('aceita a identidade declarada porque nenhum IdP está ligado', async () => {
    const identity = await new TrustedProviderIdentityAdapter().resolve(
      { authorization: 'Bearer irrelevant' },
      'provider-a',
    );

    expect(identity).toEqual({ providerId: 'provider-a' });
  });

  test('não exige credencial alguma', async () => {
    const identity = await new TrustedProviderIdentityAdapter().resolve({}, 'provider-b');

    expect(identity).toEqual({ providerId: 'provider-b' });
  });
});

describe('ProviderIdentityPort no caminho da submissão', () => {
  test('o comando carrega o providerId resolvido, não o declarado no corpo', async () => {
    const rewriting: ProviderIdentityPort = {
      resolve: () => Promise.resolve({ providerId: 'provider-resolved' }),
    };
    const { controller, submitted } = controllerWith(rewriting);

    await controller.postWager(BODY, 'provider-declared:transaction-123', undefined, fakeRequest(), fakeResponse());

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.providerId).toBe('provider-resolved');
  });

  test('a credencial chega ao port junto da identidade declarada', async () => {
    const seen: { credentials?: unknown; claimed?: string } = {};
    const capturing: ProviderIdentityPort = {
      resolve: (credentials, claimedProviderId) => {
        seen.credentials = credentials;
        seen.claimed = claimedProviderId;
        return Promise.resolve({ providerId: claimedProviderId });
      },
    };
    const { controller } = controllerWith(capturing);

    await controller.postWager(
      BODY,
      'provider-declared:transaction-123',
      'Bearer token-123',
      fakeRequest(),
      fakeResponse(),
    );

    expect(seen.credentials).toEqual({ authorization: 'Bearer token-123' });
    expect(seen.claimed).toBe('provider-declared');
  });
});
