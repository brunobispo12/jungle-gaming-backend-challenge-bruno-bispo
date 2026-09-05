export type Scrape = Record<string, string>;

export async function scrape(urls: string[]): Promise<Scrape> {
  const entries = await Promise.all(urls.map(async url => {
    const response = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`metrics unavailable: ${url} (${response.status})`);
    return [url, await response.text()] as const;
  }));
  return Object.fromEntries(entries);
}

function series(scrapes: Scrape): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [url, text] of Object.entries(scrapes)) {
    for (const line of text.split('\n')) {
      const match = /^(\w+(?:\{.*\})?)\s+([\d.eE+\-]+)$/.exec(line);
      if (match) result[`${url} ${match[1]}`] = Number(match[2]);
    }
  }
  return result;
}

export function metricDelta(before: Scrape, after: Scrape) {
  const baseline = series(before);
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(series(after))) {
    const name = key.slice(key.indexOf(' ') + 1);
    if (/^(outbox_pending_messages|outbox_oldest_pending_age_seconds|sqs_dlq_visible_messages)$/.test(name)) continue;
    const difference = value - (baseline[key] ?? 0);
    if (difference < 0) throw new Error(`metric reset during scenario: ${key}`);
    delta[name] = (delta[name] ?? 0) + difference;
  }
  const sum = (name: string) => Object.entries(delta)
    .filter(([key]) => key === name || key.startsWith(`${name}{`))
    .reduce((total, [, value]) => total + value, 0);
  const locks = sum('wallet_lock_wait_seconds_count');
  const buckets = new Map<number, number>();
  for (const [name, value] of Object.entries(delta)) {
    if (!name.startsWith('wallet_lock_wait_seconds_bucket{')) continue;
    const le = /le="([^"]+)"/.exec(name)?.[1];
    if (le !== undefined) {
      const bound = le === '+Inf' ? Infinity : Number(le);
      buckets.set(bound, (buckets.get(bound) ?? 0) + value);
    }
  }
  const upper95 = [...buckets].sort(([a], [b]) => a - b).find(([, n]) => n >= locks * 0.95)?.[0];
  return {
    series: delta, lockAttempts: locks,
    lockMeanMs: locks === 0 ? 0 : sum('wallet_lock_wait_seconds_sum') / locks * 1000,
    lockP95UpperBoundMs: locks === 0 || upper95 === undefined ? null
      : Number.isFinite(upper95) ? upper95 * 1000 : 'above largest finite bucket',
    lockConflicts: sum('wallet_lock_conflicts_total'), retries: sum('wager_retries_total'),
    inboxDuplicates: delta['wager_duplicates_total{layer="inbox"}'] ?? 0,
    published: delta['outbox_publish_duration_seconds_count{outcome="published"}'] ?? 0,
    divergences: sum('wallet_reconciliation_divergences_total'),
    dlqRouted: sum('sqs_dlq_routed_total'),
  };
}
