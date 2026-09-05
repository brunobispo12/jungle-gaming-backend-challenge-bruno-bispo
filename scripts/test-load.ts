import assert from 'node:assert/strict';
import { mkdir, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQL, type Subprocess } from 'bun';
import { GetQueueAttributesCommand, GetQueueUrlCommand, PurgeQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { state, verify, type Envelope, type Fixture, type Wallet } from '../test/load/verification';
import { metricDelta, scrape } from '../test/load/metrics';
import { renderReport, type ScenarioReport } from '../test/load/report';

function integer(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  assert.match(raw, /^[1-9]\d*$/, `${name} must be a positive integer`);
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value), `${name} exceeds safe integer`);
  return value;
}
const duration = process.env['LOAD_DURATION'] ?? '30s';
assert.match(duration, /^[1-9]\d*[sm]$/, 'LOAD_DURATION must be an integer followed by s or m');
const seconds = Number(duration.slice(0, -1)) * (duration.endsWith('m') ? 60 : 1);
const vus = integer('LOAD_VUS', 12);
const drainSeconds = integer('LOAD_DRAIN_TIMEOUT_SECONDS', 180);
const sqsRate = integer('LOAD_SQS_RPS', 5);
if (process.env['LOAD_P95_MS']) integer('LOAD_P95_MS', 1);
const managed = !process.env['LOAD_BASE_URL'];
const urls = (process.env['LOAD_BASE_URL'] ?? 'http://localhost:3201,http://localhost:3202,http://localhost:3203')
  .split(',').map(url => new URL(url.trim()).origin);
const metricsUrls = (process.env['LOAD_METRICS_URLS'] ?? urls.join(',')).split(',').map(url => new URL(url.trim()).origin);
const databaseUrl = process.env['LOAD_DATABASE_URL'] ?? (managed
  ? 'postgres://wagering_app:wagering_app@localhost:55434/wagering' : '');
assert.ok(databaseUrl, 'LOAD_DATABASE_URL is required with LOAD_BASE_URL');
const endpoint = process.env['LOAD_AWS_ENDPOINT_URL'] ?? (managed ? 'http://localhost:54567' : '');
assert.ok(endpoint, 'LOAD_AWS_ENDPOINT_URL is required with LOAD_BASE_URL');
const env = {
  ...process.env, DATABASE_URL: databaseUrl,
  DATABASE_MIGRATION_URL: 'postgres://wagering_migrator:wagering_migrator@localhost:55434/wagering',
  AWS_ENDPOINT_URL: endpoint, AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  SQS_INPUT_QUEUE: process.env['LOAD_INPUT_QUEUE'] ?? 'wager-transactions.fifo',
  SQS_EVENTS_QUEUE: process.env['LOAD_EVENTS_QUEUE'] ?? 'wager-events.fifo',
  SQS_DLQ_QUEUE: process.env['LOAD_DLQ_QUEUE'] ?? 'wager-transactions-dlq.fifo',
};
const runId = `load-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const artifactDir = path.resolve('artifacts/load', runId);
await mkdir(artifactDir, { recursive: true });
// Exclusive ownership prevents two managed runners from sharing the same processes/queues.
const lockPath = path.resolve('artifacts/load/runner.lock');
const lock = await open(lockPath, 'wx');
const children = new Set<Subprocess>();
let interrupted = false;
const stop = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const sql = new SQL(databaseUrl, { max: 3 });
const sqs = new SQSClient({ endpoint, region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
async function save(name: string, data: unknown) {
  await Bun.write(path.join(artifactDir, name), JSON.stringify(data, null, 2));
}
async function command(args: string[]) {
  const proc = Bun.spawn(args, { env, stdout: 'inherit', stderr: 'inherit' });
  children.add(proc);
  const code = await proc.exited;
  children.delete(proc);
  assert.equal(code, 0, `${args.slice(0, 3).join(' ')} failed (${code})`);
}
async function capture(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  assert.equal(code, 0, `${args[0]} inspection failed: ${stderr}`);
  return stdout.trim();
}
async function until(predicate: () => Promise<boolean>, timeout: number, label: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('load interrupted');
    if (await predicate()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}
async function queue(name: string) {
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  assert.ok(response.QueueUrl); return response.QueueUrl;
}
async function queueState(url: string) {
  const response = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [
    'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed',
  ] }));
  return Object.fromEntries(Object.entries(response.Attributes ?? {}).map(([key, value]) => [key, Number(value)]));
}
const totalQueued = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);
const SCENARIOS = ['distributed', 'hot', 'scarce', 'idempotency', 'mixed'];
const SINGLE_WALLET = ['hot', 'scarce', 'idempotency'];
// The scarce profile opens near zero so the balance stays on the rejection
// boundary for the whole run; the BET/BET/WIN cycle drifts it back down.
const OPENING: Record<string, string> = { scarce: '5.00' };
async function createFixture(scenario: string, count: number): Promise<Fixture> {
  const wallets: Wallet[] = [];
  const openingAmount = OPENING[scenario] ?? '1000000000.00';
  for (let i = 0; i < count; i++) {
    const playerId = `${runId}-${scenario}-${i}`;
    const response = await fetch(`${urls[i % urls.length]}/wallets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: openingAmount, currency: 'BRL' } }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 201, 'fixture creation failed');
    wallets.push(await response.json() as Wallet);
  }
  return { scenario, providerId: `${runId}-${scenario}`, urls, openingAmount, wallets };
}
function wager(fixture: Fixture, wallet: Wallet, identity: string, kind = 'BET') {
  return { providerId: fixture.providerId, externalTransactionId: identity,
    playerId: wallet.playerId, walletId: wallet.id, roundId: identity, gameId: 'load-game',
    kind, money: { amount: '1.00', currency: 'BRL' },
  };
}
async function submit(fixture: Fixture, wallet: Wallet, identity: string, index = 0) {
  return fetch(`${urls[index % urls.length]}/wagering/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': identity },
    body: JSON.stringify(wager(fixture, wallet, identity)), signal: AbortSignal.timeout(10000),
  });
}
async function proveNoGlobalLock() {
  const fixture = await createFixture('independence', 2);
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  let holderPid = 0;
  const holding = sql.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid`;
    holderPid = row.pid;
    await tx`SELECT id FROM wallet WHERE id=${fixture.wallets[0]!.id}::uuid FOR UPDATE`;
    acquired(); await gate;
  });
  let blocked: Promise<Response> | undefined;
  let finished = false;
  try {
    await ready;
    blocked = submit(fixture, fixture.wallets[0]!, 'blocked').then(r => { finished = true; return r; });
    void blocked.catch(() => {});
    await until(async () => {
      const rows = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ${holderPid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
      return rows[0].n > 0;
    }, 5000, 'application waiting on held wallet');
    const started = Date.now();
    const free = await submit(fixture, fixture.wallets[1]!, 'free', 1);
    assert.equal(free.status, 201);
    assert.equal(finished, false, 'held operation must still be blocked when free wallet finishes');
    return { fixture, freeWalletMs: Date.now() - started, passed: true };
  } finally {
    release(); await holding;
    if (blocked) assert.equal((await blocked).status, 201);
  }
}

interface Summary { metrics: Record<string, { values: Record<string, number> }>; state: { testRunDurationMs: number } }
interface Sample { atMs: number; db: Awaited<ReturnType<typeof state>>; prometheus: Awaited<ReturnType<typeof scrape>> }
const reports: ScenarioReport[] = [];
try {
  const k6Version = await capture(['k6', 'version']);
  console.log(k6Version);
  if (managed) {
    await command(['docker', 'compose', '-f', 'docker-compose.load.yml', 'up', '-d', '--wait']);
    await command(['bun', 'run', 'scripts/migrate.ts', 'up']);
    for (let i = 0; i < urls.length; i++) {
      const proc = Bun.spawn(['bun', 'run', 'src/bootstrap/main.ts'], {
        env: { ...env, NODE_ENV: 'test', APP_ROLES: 'api,consumer,pending-worker,outbox-publisher',
          PORT: String(3201 + i), INSTANCE_ID: `load-${i + 1}` },
        stdout: Bun.file(path.join(artifactDir, `application-${i + 1}.log`)),
        stderr: Bun.file(path.join(artifactDir, `application-${i + 1}.stderr.log`)),
      });
      children.add(proc);
    }
  }
  for (const url of urls) await until(async () => {
    try { return (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 60000, `readiness ${url}`);
  const input = await queue(env.SQS_INPUT_QUEUE);
  const dlq = await queue(env.SQS_DLQ_QUEUE);
  const events = await queue(env.SQS_EVENTS_QUEUE);
  assert.equal(totalQueued(await queueState(input)), 0, 'input queue must be idle before load');
  assert.equal(totalQueued(await queueState(dlq)), 0, 'DLQ must be empty before load');
  // Nothing consumes this queue, so it grows across runs until the broker slows
  // enough to stall Outbox drain. ARCHITECTURE.md 13.1 carries the measurement.
  if (managed) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: events })).catch(() => undefined);
    await until(async () => totalQueued(await queueState(events)) === 0, 120000, 'events queue purge');
  }
  const [db] = await sql`SELECT current_user AS role,version() AS version,
    (SELECT count(*)::int FROM wager_transaction) AS existing_transactions`;
  assert.equal(db.role, 'wagering_app', 'inspection and lock probe must use runtime role');
  const environment = { runId, startedAt: new Date().toISOString(), duration, vus, sqsRate,
    drainSeconds, urls, metricsUrls, managed, bun: Bun.version, platform: os.platform(),
    architecture: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    memoryGiB: os.totalmem() / 1024 ** 3, freeMemoryGiB: os.freemem() / 1024 ** 3, database: db, k6Version,
    docker: managed ? await capture(['docker', 'ps', '--format', '{{.Names}} {{.Image}} {{.Ports}}']) : undefined,
    topology: managed ? 'three Bun processes; PostgreSQL 16 and LocalStack 3 in dedicated Docker Compose' : 'external stack supplied by operator',
    tracing: false, model: 'closed constant-VU, no think time; percentiles include failures',
    eventsQueuePurged: managed,
  };
  await save('environment.json', environment);
  const proof = await proveNoGlobalLock();
  await until(async () => (await state(sql, proof.fixture)).pending === 0, drainSeconds * 1000, 'probe Outbox drain');
  await save('independence.json', { ...proof, invariants: await verify(sql, proof.fixture, { BET: 2 }, []) });

  for (const scenario of SCENARIOS) {
    console.log(`\n▸ load ${scenario}: ${vus} VUs, ${duration}`);
    const scenarioStarted = Date.now();
    const fixture = await createFixture(scenario, SINGLE_WALLET.includes(scenario) ? 1 : vus);
    await until(async () => (await state(sql, fixture)).pending === 0, drainSeconds * 1000, 'fixture Outbox drain');
    const fixturePath = path.join(artifactDir, `${scenario}-fixture.json`);
    const summaryPath = path.join(artifactDir, `${scenario}-k6.json`);
    await Bun.write(fixturePath, JSON.stringify(fixture));
    const before = await scrape(metricsUrls);
    await save(`${scenario}-before.prom.json`, before);
    const samples: Sample[] = [];
    const errors: string[] = [];
    const envelopes: Envelope[] = [];
    let loading = true;
    const loadStart = Date.now();
    const monitor = (async () => {
      while (loading && !interrupted) {
        try { samples.push({ atMs: Date.now() - loadStart, db: await state(sql, fixture), prometheus: await scrape(metricsUrls) }); }
        catch (error) { errors.push(`sampling: ${String(error)}`); }
        await Bun.sleep(2000);
      }
    })();
    const producer = (async () => {
      if (scenario !== 'mixed') return;
      for (let i = 0; loading && !interrupted && i < seconds * sqsRate; i++) {
        const identity = `sqs-${i}`;
        const body = wager(fixture, fixture.wallets[i % fixture.wallets.length]!, identity, ['BET', 'BET', 'WIN', 'LOSS'][i % 4]);
        const envelope: Envelope = { messageId: `${fixture.providerId}:${identity}`,
          type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
          data: { ...body, idempotencyKey: identity } };
        envelopes.push(envelope);
        for (let copy = 0; copy < (i % 5 === 0 ? 2 : 1); copy++) {
          await sqs.send(new SendMessageCommand({ QueueUrl: input, MessageBody: JSON.stringify(envelope),
            MessageGroupId: `${identity}-${copy}`, MessageDeduplicationId: `${envelope.messageId}-${copy}` }));
        }
        await Bun.sleep(Math.max(0, loadStart + (i + 1) * 1000 / sqsRate - Date.now()));
      }
    })().catch(error => { errors.push(`SQS producer: ${String(error)}`); });
    const k6 = Bun.spawn(['k6', 'run', '--no-usage-report', 'test/load/workload.js'], {
      env: { ...process.env, K6_NEW_MACHINE_READABLE_SUMMARY: 'false',
        LOAD_FIXTURE: fixturePath, LOAD_SUMMARY: summaryPath, LOAD_VUS: String(vus), LOAD_DURATION: duration },
      stdout: Bun.file(path.join(artifactDir, `${scenario}-k6.log`)),
      stderr: Bun.file(path.join(artifactDir, `${scenario}-k6.stderr.log`)),
    });
    children.add(k6);
    const code = await k6.exited;
    children.delete(k6); loading = false;
    const loadWallMs = Date.now() - loadStart;
    const drainStart = Date.now();
    await producer;
    const [afterLoad, atLoadEnd] = await Promise.all([scrape(metricsUrls), state(sql, fixture)]);
    await monitor;
    let invariants: Awaited<ReturnType<typeof verify>> | undefined;
    let summary: Summary | undefined;
    try {
      summary = await Bun.file(summaryPath).json() as Summary;
      const count = (metric: string) => summary!.metrics[metric]?.values['count'] ?? 0;
      const expected: Record<string, number> = { BET: count('wager_bets'), WIN: count('wager_wins'),
        LOSS: count('wager_losses'), REJECTED: count('wager_rejected') };
      for (const e of envelopes) {
        const kind = e.data['kind'] as string; expected[kind] = (expected[kind] ?? 0) + 1;
      }
      await until(async () => {
        const s = await state(sql, fixture);
        return s.pending === 0 && s.transactions >= Object.values(expected).reduce((a, b) => a + b, 0)
          && totalQueued(await queueState(input)) === 0;
      }, drainSeconds * 1000, `${scenario} input/Outbox drain`);
      invariants = await verify(sql, fixture, expected, envelopes);
      assert.equal(totalQueued(await queueState(dlq)), 0, 'unexpected DLQ messages');
      if (scenario === 'scarce') {
        assert.ok(count('wager_rejected') > 0, 'scarce profile must exercise the rejection path');
        assert.ok(count('wager_bets') > 0, 'scarce profile must also apply debits');
      }
      if (scenario === 'idempotency') {
        assert.equal(count('wager_created'), 1, 'storm must create exactly one operation');
        assert.equal(count('wager_replays'), count('wager_requests') - 1);
      }
      assert.equal(code, 0, 'k6 threshold or runtime failure');
    } catch (error) { errors.push(String(error)); }
    const after = await scrape(metricsUrls);
    const delta = metricDelta(before, afterLoad);
    if (delta.divergences || delta.dlqRouted) errors.push('divergence/DLQ metric increment');
    const report = { scenario, passed: errors.length === 0, errors, duration, vus, loadWallMs,
      totalWallMs: Date.now() - scenarioStarted, drainMs: Date.now() - drainStart,
      http: summary?.metrics, k6State: summary?.state, prometheus: delta,
      atLoadEnd, afterDrain: await state(sql, fixture), sqsOperations: envelopes.length,
      oldestPendingSeconds: Math.max(atLoadEnd.oldest_seconds, ...samples.map(s => s.db.oldest_seconds), 0),
      maxLockWaiters: Math.max(0, ...samples.map(s => s.db.lock_waiters)),
      openingAmount: fixture.openingAmount,
      sqsOfferedOperations: scenario === 'mixed' ? seconds * sqsRate : 0,
      queuesAfter: { input: await queueState(input), dlq: await queueState(dlq), events: await queueState(events) },
      invariants,
    };
    reports.push(report);
    await save(`${scenario}-samples.json`, samples);
    await save(`${scenario}-after-load.prom.json`, afterLoad);
    await save(`${scenario}-after-drain.prom.json`, after);
    await save(`${scenario}-sqs.json`, envelopes);
    await save(`${scenario}-report.json`, report);
    await save('report.json', reports);
    await Bun.write(path.join(artifactDir, 'summary.md'), renderReport(environment, reports, proof));
    const metric = (name: string) => summary?.metrics[name]?.values;
    console.log(JSON.stringify({ scenario, passed: report.passed,
      requests: metric('wager_requests'), latency: metric('wager_latency_ms'), errors: metric('wager_errors'),
      locks: delta.lockAttempts, lockMeanMs: delta.lockMeanMs, conflicts: delta.lockConflicts,
      pendingAtEnd: atLoadEnd.pending, oldestPendingSeconds: report.oldestPendingSeconds,
      drainMs: report.drainMs, validationErrors: errors,
    }, null, 2));
  }
  // The committed report is the run's record: written whatever the outcome, so a
  // failing profile leaves its own evidence instead of the previous run's numbers.
  await Bun.write(path.resolve('test/load/RESULTS.md'), renderReport(environment, reports, proof));
  assert.ok(reports.every(r => r.passed), 'load scenarios failed; inspect report.json');
} catch (error) {
  process.exitCode = 1;
  await save('failure.json', { message: String(error), interrupted });
  console.error(String(error));
} finally {
  stop();
  await Promise.all([...children].map(child => child.exited));
  await sql.close(); sqs.destroy();
  await lock.close(); await unlink(lockPath);
  console.log(`\nArtifacts: ${artifactDir}`);
}
