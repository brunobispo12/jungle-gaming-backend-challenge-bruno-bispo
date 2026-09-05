import { describe, expect, test } from 'bun:test';
import { metricDelta } from './metrics';

describe('load metric windows (run explicitly, outside normal suites)', () => {
  test('subtracts each instance baseline before aggregating; never sums global gauges', () => {
    const before = {
      a: 'wallet_lock_wait_seconds_count{outcome="acquired"} 100\nwallet_lock_wait_seconds_sum{outcome="acquired"} 10\noutbox_pending_messages 500',
      b: 'wallet_lock_wait_seconds_count{outcome="acquired"} 10\nwallet_lock_wait_seconds_sum{outcome="acquired"} 1\noutbox_pending_messages 500',
    };
    const after = {
      a: 'wallet_lock_wait_seconds_count{outcome="acquired"} 110\nwallet_lock_wait_seconds_sum{outcome="acquired"} 12\noutbox_pending_messages 0',
      b: 'wallet_lock_wait_seconds_count{outcome="acquired"} 20\nwallet_lock_wait_seconds_sum{outcome="acquired"} 4\noutbox_pending_messages 0',
    };
    const result = metricDelta(before, after);
    expect(result.lockAttempts).toBe(20);
    expect(result.lockMeanMs).toBe(250);
    expect(result.lockConflicts).toBe(0);
    expect(result.series['outbox_pending_messages']).toBeUndefined();
  });

  test('reports the histogram upper bound, not an invented precise percentile', () => {
    const result = metricDelta({}, { a: [
      'wallet_lock_wait_seconds_count{outcome="acquired"} 100',
      'wallet_lock_wait_seconds_bucket{le="0.1",outcome="acquired"} 94',
      'wallet_lock_wait_seconds_bucket{le="0.5",outcome="acquired"} 98',
      'wallet_lock_wait_seconds_bucket{le="+Inf",outcome="acquired"} 100',
      'wallet_lock_conflicts_total{reason="lock_timeout"} 2',
      'wallet_lock_conflicts_total{reason="deadlock"} 1',
    ].join('\n') });
    expect(result.lockP95UpperBoundMs).toBe(500);
    expect(result.lockConflicts).toBe(3);
  });

  test('rejects a process reset instead of presenting negative counter rates', () => {
    expect(() => metricDelta({ a: 'http_requests_total 20' }, { a: 'http_requests_total 1' }))
      .toThrow('metric reset');
  });
});
