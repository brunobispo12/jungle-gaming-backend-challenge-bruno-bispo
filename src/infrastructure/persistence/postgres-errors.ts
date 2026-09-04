// Contention and connection loss are retryable with the same idempotency key;
// collapsing them into a generic failure tells the provider not to resend
// (README §9). MikroORM wraps the driver error, so the cause chain is walked.
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available — the wallet lock_timeout expired
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const LOCK_CONFLICT_REASONS: Readonly<Record<string, 'lock_timeout' | 'deadlock'>> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
};

const CONNECTION_EXCEPTION_CLASS = '08';

function sqlStateOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ['code', 'errno', 'sqlState'] as const) {
    const state = candidate[key];
    if (typeof state === 'string' && /^[0-9A-Z]{5}$/.test(state)) {
      return state;
    }
  }
  return undefined;
}

function findInCauseChain<T>(
  error: unknown,
  pick: (sqlState: string) => T | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);

    const state = sqlStateOf(current);
    if (state !== undefined) {
      const picked = pick(state);
      if (picked !== undefined) {
        return picked;
      }
    }

    const link = current as { previous?: unknown; cause?: unknown };
    current = link.previous ?? link.cause;
  }

  return undefined;
}

export function isTransientDatabaseFailure(error: unknown): boolean {
  return (
    findInCauseChain(error, (state) =>
      TRANSIENT_SQLSTATES.has(state) || state.startsWith(CONNECTION_EXCEPTION_CLASS)
        ? true
        : undefined,
    ) ?? false
  );
}

// Only a refusal PostgreSQL classified is a lock conflict; a wait that ended in
// success is latency, and belongs in the histogram alone.
export function lockConflictReason(error: unknown): 'lock_timeout' | 'deadlock' | undefined {
  return findInCauseChain(error, (state) => LOCK_CONFLICT_REASONS[state]);
}
