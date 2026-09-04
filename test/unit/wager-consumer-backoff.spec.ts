import { describe, expect, test } from 'bun:test';

import { retryDelaySeconds } from '@/interface/sqs/wager-consumer.worker';

describe('retryDelaySeconds', () => {
  test('a primeira devolução espera cinco segundos', () => {
    expect(retryDelaySeconds(1)).toBe(5);
  });

  test('dobra a cada recebimento', () => {
    expect(retryDelaySeconds(2)).toBe(10);
    expect(retryDelaySeconds(3)).toBe(20);
    expect(retryDelaySeconds(4)).toBe(40);
  });

  test('satura no visibility timeout da fila', () => {
    expect(retryDelaySeconds(5)).toBe(60);
    expect(retryDelaySeconds(64)).toBe(60);
  });
});
