import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const fixture = JSON.parse(open(__ENV.LOAD_FIXTURE));
const requests = new Counter('wager_requests');
const errors = new Rate('wager_errors');
const latency = new Trend('wager_latency_ms', true);
const created = new Counter('wager_created');
const replays = new Counter('wager_replays');
const rejected = new Counter('wager_rejected');
const bets = new Counter('wager_bets');
const wins = new Counter('wager_wins');
const losses = new Counter('wager_losses');

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus', vus: Number(__ENV.LOAD_VUS),
      duration: __ENV.LOAD_DURATION, gracefulStop: '35s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'max', 'p(50)', 'p(95)', 'p(99)'],
  thresholds: {
    checks: ['rate==1'], wager_errors: ['rate==0'],
    http_req_failed: ['rate==0'], wager_requests: ['count>0'],
    ...( __ENV.LOAD_P95_MS ? { wager_latency_ms: [`p(95)<${__ENV.LOAD_P95_MS}`] } : {}),
  },
  systemTags: ['method', 'status', 'name', 'scenario', 'expected_response'],
};

const KINDS = { mixed: ['BET', 'BET', 'WIN', 'LOSS'], scarce: ['BET', 'BET', 'WIN'] };
const SINGLE_WALLET = ['hot', 'idempotency', 'scarce'];
// The scarce profile keeps the balance at zero on purpose, so 422 is a designed
// outcome there and must not count as a transport failure.
const acceptRejection = fixture.scenario === 'scarce';

let canonical;
export default function () {
  // Each distributed VU owns a wallet. No two VUs artificially contend there.
  const wallet = fixture.wallets[SINGLE_WALLET.includes(fixture.scenario)
    ? 0 : (__VU - 1) % fixture.wallets.length];
  const identity = fixture.scenario === 'idempotency' ? 'same' : `v${__VU}-i${__ITER}`;
  const cycle = KINDS[fixture.scenario];
  const kind = cycle ? cycle[__ITER % cycle.length] : 'BET';
  const body = {
    providerId: fixture.providerId, externalTransactionId: identity,
    playerId: wallet.playerId, walletId: wallet.id, roundId: identity,
    gameId: 'load-game', kind, money: { amount: '1.00', currency: 'BRL' },
  };
  const base = fixture.urls[(__VU + __ITER - 1) % fixture.urls.length];
  const response = http.post(`${base}/wagering/transactions`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': identity },
    tags: { name: 'submit-wager' }, timeout: '30s',
    ...(acceptRejection ? { responseCallback: http.expectedStatuses(200, 201, 422) } : {}),
  });
  requests.add(1);
  latency.add(response.timings.duration);
  let result;
  try { result = response.json(); } catch { result = {}; }
  const replay = response.status === 200 && result.idempotentReplay === true;
  const balanced = Boolean(result.balance) && /^\d+\.\d{2}$/.test(String(result.balance.amount))
    && result.balance.currency === 'BRL';
  const refused = acceptRejection && response.status === 422 && result.status === 'REJECTED'
    && result.failureCode === 'INSUFFICIENT_FUNDS' && result.idempotentReplay === false;
  const applied = result.status === 'PROCESSED'
    && ((response.status === 201 && result.idempotentReplay === false)
      || (fixture.scenario === 'idempotency' && replay));
  let valid = typeof result.transactionId === 'string' && balanced && (applied || refused);

  if (fixture.scenario === 'idempotency' && valid) {
    // Each VU anchors its responses to the same persisted resource after the
    // first concurrent POST, so the storm still exercises the initial race.
    if (!canonical) {
      const lookup = http.get(`${base}/providers/${fixture.providerId}/wagering/transactions/same`, {
        tags: { name: 'canonical-lookup' }, timeout: '30s',
      });
      check(lookup, { 'canonical lookup succeeds': (r) => r.status === 200 });
      try { canonical = lookup.json(); } catch { canonical = {}; }
    }
    valid = valid && result.transactionId === canonical.transactionId
      && result.balance.amount === '999999999.00'
      && canonical.balance && canonical.balance.amount === result.balance.amount;
  }
  check(response, { 'financial response matches contract': () => Boolean(valid) });
  errors.add(!valid);
  created.add(valid && response.status === 201 ? 1 : 0);
  replays.add(valid && replay ? 1 : 0);
  rejected.add(valid && refused ? 1 : 0);
  bets.add(valid && response.status === 201 && kind === 'BET' ? 1 : 0);
  wins.add(valid && response.status === 201 && kind === 'WIN' ? 1 : 0);
  losses.add(valid && response.status === 201 && kind === 'LOSS' ? 1 : 0);
}

export function handleSummary(data) {
  return { [__ENV.LOAD_SUMMARY]: JSON.stringify(data, null, 2) };
}
