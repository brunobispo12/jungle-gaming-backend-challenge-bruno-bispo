import { describe, expect, test } from 'bun:test';

import { pendingReferenceBackoffMs } from '@/application/use-cases/resolve-pending-reference';

describe('pendingReferenceBackoffMs', () => {
  test('a primeira nova tentativa espera cinco segundos', () => {
    expect(pendingReferenceBackoffMs(1, 0.5)).toBe(5_000);
  });

  test('dobra a cada tentativa', () => {
    expect(pendingReferenceBackoffMs(2, 0.5)).toBe(10_000);
    expect(pendingReferenceBackoffMs(3, 0.5)).toBe(20_000);
    expect(pendingReferenceBackoffMs(6, 0.5)).toBe(160_000);
  });

  test('satura em cinco minutos', () => {
    expect(pendingReferenceBackoffMs(7, 0.5)).toBe(300_000);
    expect(pendingReferenceBackoffMs(99, 0.5)).toBe(300_000);
  });

  test('aplica jitter entre 0.8x e 1.2x', () => {
    expect(pendingReferenceBackoffMs(1, 0)).toBe(4_000);
    expect(pendingReferenceBackoffMs(1, 1)).toBe(6_000);
    expect(pendingReferenceBackoffMs(7, 0)).toBe(240_000);
  });
});
