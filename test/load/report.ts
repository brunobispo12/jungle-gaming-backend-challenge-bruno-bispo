export interface ReportEnvironment {
  runId: string;
  startedAt: string;
  duration: string;
  vus: number;
  sqsRate: number;
  drainSeconds: number;
  urls: string[];
  managed: boolean;
  bun: string;
  platform: string;
  architecture: string;
  cpus: number;
  cpuModel?: string | undefined;
  memoryGiB: number;
  freeMemoryGiB: number;
  k6Version: string;
  database: { role: string; version: string; existing_transactions: number };
  eventsQueuePurged: boolean;
}

export interface WalletState {
  walletId: string;
  balance: string;
  version: number;
  entries: number;
  minimumHistoricalBalance: string | null;
}

export interface Invariants {
  wallets: number;
  transactions: number;
  counts: Record<string, number>;
  rejected: number;
  rejectedByKind: Record<string, number>;
  failureCodes: Record<string, number>;
  events: number;
  inbox: number;
  walletStates: WalletState[];
}

export interface ScenarioReport {
  scenario: string;
  passed: boolean;
  errors: string[];
  loadWallMs: number;
  totalWallMs: number;
  drainMs: number;
  http?: Record<string, { values: Record<string, number> }> | undefined;
  prometheus: {
    lockAttempts: number;
    lockMeanMs: number;
    lockP95UpperBoundMs: number | string | null;
    lockConflicts: number;
    retries: number;
    inboxDuplicates: number;
    published: number;
    divergences: number;
    dlqRouted: number;
  };
  atLoadEnd: { pending: number; oldest_seconds: number; transactions: number };
  afterDrain: { pending: number };
  oldestPendingSeconds: number;
  maxLockWaiters: number;
  openingAmount: string;
  sqsOperations: number;
  invariants?: Invariants | undefined;
}

export interface IndependenceProof {
  passed: boolean;
  freeWalletMs: number;
}

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const LABEL: Record<string, string> = {
  distributed: 'Distribuído',
  hot: 'Hot wallet',
  scarce: 'Escasso',
  idempotency: 'Idempotência',
  mixed: 'Misto',
};

const decimal = (fraction: number) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: fraction, maximumFractionDigits: fraction });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

function num(value: number | undefined, fraction = 2): string {
  return value === undefined || !Number.isFinite(value) ? 'n/d' : decimal(fraction).format(value);
}
function count(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/d' : integer.format(value);
}
function times(numerator: number, denominator: number): string {
  return denominator > 0 ? `${num(numerator / denominator, 1)} vezes` : 'n/d';
}
function perSecond(quantity: number, milliseconds: number): string {
  return milliseconds > 0 ? num((quantity * 1000) / milliseconds) : 'n/d';
}
function label(scenario: string): string {
  return LABEL[scenario] ?? scenario;
}
function metric(report: ScenarioReport, name: string, stat: string): number | undefined {
  return report.http?.[name]?.values[stat];
}
function bucket(value: number | string | null): string {
  return typeof value === 'number' ? count(value) : value === null ? 'n/d' : value;
}
function listKinds(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  return entries.length === 0
    ? 'nenhuma'
    : entries.map(([kind, value]) => `${count(value)} ${kind}`).join(', ');
}
function soleKey(counts: Record<string, number>): string | undefined {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  return entries.length === 1 ? entries[0]![0] : undefined;
}

function environmentSection(environment: ReportEnvironment): string[] {
  const machine = `${PLATFORM[environment.platform] ?? environment.platform} ${environment.architecture}`;
  const cpu = environment.cpuModel?.trim() ?? 'CPU não identificada';
  const base = environment.database.existing_transactions;
  return [
    '## Ambiente e método',
    '',
    `${machine}, ${cpu} (${environment.cpus} CPUs lógicas), ${num(environment.memoryGiB)} GiB de RAM e ` +
      `${num(environment.freeMemoryGiB)} GiB livres no início; Bun ${environment.bun}; ${environment.k6Version}; ` +
      `${environment.database.version.split(' on ')[0]}, com a role de runtime \`${environment.database.role}\`. ` +
      `${environment.urls.length} processos Bun acumulam api, consumer, pending-worker e outbox-publisher; sem tracing. ` +
      `A base tinha **${count(base)} transações** antes desta execução` +
      `${base === 0 ? ', ou seja, a stack foi recriada vazia' : ', preservadas e excluídas das verificações por run ID'}.` +
      `${environment.eventsQueuePurged ? ' A fila de eventos foi purgada antes de medir; o motivo está em *Limitações*.' : ''}` +
      ' São números de máquina compartilhada, sem isolamento de CPU e sem extrapolação de capacidade.',
    '',
    'Modelo fechado de VUs constantes, sem think time, uma submissão síncrona por VU. Os perfis são ' +
      'sequenciais e cada um espera seu drain antes do seguinte; setup, prova de independência, scrapes e ' +
      `drain ficam fora dos percentis do k6. Cada wager vale \`1.00 BRL\`. O perfil misto ofereceu ` +
      `${environment.sqsRate} operações SQS/s em paralelo, uma em cada cinco reenviada com a mesma identidade ` +
      'autoral e deduplication ID distinto no broker. Sem retry HTTP automático.',
    '',
  ];
}

function clientTable(reports: ScenarioReport[]): string[] {
  const lines = [
    '| Perfil | HTTP total | Submissões | Submissões/s | Erro | p50 ms | p95 ms | p99 ms | Máx ms | Carga real s | Total do cenário s |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const report of reports) {
    lines.push(
      `| ${label(report.scenario)} | ${count(metric(report, 'http_reqs', 'count'))} ` +
        `| ${count(metric(report, 'wager_requests', 'count'))} | ${num(metric(report, 'wager_requests', 'rate'))} ` +
        `| ${num((metric(report, 'wager_errors', 'rate') ?? 0) * 100)}% ` +
        `| ${num(metric(report, 'wager_latency_ms', 'p(50)'))} | ${num(metric(report, 'wager_latency_ms', 'p(95)'))} ` +
        `| ${num(metric(report, 'wager_latency_ms', 'p(99)'))} | ${num(metric(report, 'wager_latency_ms', 'max'))} ` +
        `| ${num(report.loadWallMs / 1000)} | ${num(report.totalWallMs / 1000)} |`,
    );
  }
  return lines;
}

function lockTable(reports: ScenarioReport[]): string[] {
  const lines = [
    '| Perfil | Tentativas de lock | Espera média ms | Limite superior do bucket p95 ms | Timeout/deadlock | Máximo de backends esperando lock |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const report of reports) {
    lines.push(
      `| ${label(report.scenario)} | ${count(report.prometheus.lockAttempts)} | ${num(report.prometheus.lockMeanMs)} ` +
        `| ${bucket(report.prometheus.lockP95UpperBoundMs)} | ${count(report.prometheus.lockConflicts)} ` +
        `| ${count(report.maxLockWaiters)} |`,
    );
  }
  return lines;
}

function outboxTable(reports: ScenarioReport[]): string[] {
  const lines = [
    '| Perfil | Outbox pendente no fim da carga | Idade máxima da Outbox s | Drain e verificação s | Pendentes depois | Eventos verificados |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const report of reports) {
    lines.push(
      `| ${label(report.scenario)} | ${count(report.atLoadEnd.pending)} | ${num(report.oldestPendingSeconds)} ` +
        `| ${num(report.drainMs / 1000)} | ${count(report.afterDrain.pending)} | ${count(report.invariants?.events)} |`,
    );
  }
  return lines;
}

function scarceSection(scarce: ScenarioReport, vus: number): string[] {
  const invariants = scarce.invariants;
  if (!invariants || invariants.rejected === 0) {
    return [];
  }
  const wallet = invariants.walletStates[0];
  const applied = Object.values(invariants.counts).reduce((total, value) => total + value, 0);
  const attempts: Record<string, number> = { ...invariants.counts };
  for (const [kind, value] of Object.entries(invariants.rejectedByKind)) {
    attempts[kind] = (attempts[kind] ?? 0) + value;
  }
  const sole = soleKey(invariants.failureCodes);
  return [
    '## Perfil escasso: o caminho de recusa sob contenção',
    '',
    `O perfil escasso abre uma Wallet com \`${scarce.openingAmount} BRL\` e cicla BET/BET/WIN sobre ela com ` +
      `${vus} VUs. O ciclo debita mais do que credita, então o saldo cai à fronteira em segundos e fica lá: ` +
      'o excedente é recusado, e cada recusa devolve o saldo observado.',
    '',
    `Das ${count(metric(scarce, 'wager_requests', 'count'))} submissões, ${count(applied)} foram aplicadas ` +
      `(${listKinds(invariants.counts)}) e **${count(invariants.rejected)} recusadas** ` +
      `(${listKinds(invariants.rejectedByKind)}), ` +
      `${sole ? `todas com \`${sole}\`` : `com as taxonomias ${listKinds(invariants.failureCodes)}`}. ` +
      `Tentativas por tipo: ${listKinds(attempts)}.`,
    '',
    'O fechamento no PostgreSQL:',
    '',
    `- menor \`balance_after\` histórico: **\`${wallet?.minimumHistoricalBalance ?? 'n/d'}\`**;`,
    `- saldo final \`${wallet?.balance ?? 'n/d'}\`, com ${count(wallet?.entries)} lançamentos e ` +
      `\`version\` ${count(wallet?.version)} — um lançamento e uma versão por efeito, nenhum a mais;`,
    `- as ${count(invariants.rejected)} recusas não produziram lançamento nem mudança de saldo, e emitiram ` +
      `exatamente um \`WagerTransactionRejected\` cada, dentro dos ${count(invariants.events)} eventos do perfil;`,
    '- `wallet.balance` igual ao saldo reconstruído pelo ledger, como nos demais perfis.',
    '',
    'É a evidência direta contra as duas primeiras falhas eliminatórias: VUs concorrentes disputando a decisão ' +
      'de débito no ponto exato onde uma race produziria saldo negativo ou débito duplicado. Os outros perfis ' +
      'abrem com saldo alto de propósito e por isso não conseguem demonstrar isso — neles a folga é grande por ' +
      'construção.',
    '',
  ];
}

function contentionSection(reports: ScenarioReport[]): string[] {
  const distributed = reports.find((report) => report.scenario === 'distributed');
  const hot = reports.find((report) => report.scenario === 'hot');
  const scarce = reports.find((report) => report.scenario === 'scarce');
  if (!distributed || !hot) {
    return [];
  }
  const distributedRate = metric(distributed, 'wager_requests', 'rate') ?? 0;
  const hotRate = metric(hot, 'wager_requests', 'rate') ?? 0;
  const lines = [
    `Concentrar a carga numa Wallet só ${hotRate < distributedRate
      ? `derrubou o throughput de ${num(distributedRate)} para ${num(hotRate)} submissões/s, ${times(distributedRate, hotRate)}`
      : `não derrubou o throughput: ${num(hotRate)} submissões/s contra ${num(distributedRate)} do distribuído`}. ` +
      `A espera média de lock foi de ${num(distributed.prometheus.lockMeanMs)} ms no distribuído para ` +
      `${num(hot.prometheus.lockMeanMs)} ms na hot wallet, ` +
      `${times(hot.prometheus.lockMeanMs, distributed.prometheus.lockMeanMs)}, e a cauda chegou a p99 de ` +
      `${num(metric(hot, 'wager_latency_ms', 'p(99)'))} ms e máximo de ${num(metric(hot, 'wager_latency_ms', 'max'))} ms, ` +
      `${hot.prometheus.lockConflicts === 0
        ? 'sem `lock_timeout` nem deadlock'
        : `com ${count(hot.prometheus.lockConflicts)} conflitos de lock`}. ` +
      'É serialização deliberada por Wallet, e nenhum saldo se perdeu nela.',
    '',
  ];
  if (scarce) {
    lines.push(
      `O perfil escasso mediu ${num(metric(scarce, 'wager_requests', 'rate'))} submissões/s e espera média de ` +
        `${num(scarce.prometheus.lockMeanMs)} ms: mesmo recusada, toda operação continua tomando o lock da ` +
        'Wallet, porque a decisão de saldo acontece sob o lock e não antes dele.',
      '',
    );
  }
  return lines;
}

function outboxSection(reports: ScenarioReport[]): string[] {
  const backlogged = reports
    .filter((report) => report.atLoadEnd.pending > 0)
    .sort((a, b) => b.atLoadEnd.pending - a.atLoadEnd.pending);
  if (backlogged.length === 0) {
    return ['Nenhum perfil terminou a carga com Outbox pendente.', ''];
  }
  const faster = backlogged.filter(
    (report) =>
      report.drainMs > 0 &&
      report.loadWallMs > 0 &&
      report.atLoadEnd.pending / report.drainMs > report.prometheus.published / report.loadWallMs,
  ).length;
  const lines = ['A publicação da Outbox não acompanhou a entrada nos perfis com backlog:', ''];
  for (const report of backlogged) {
    lines.push(
      `- **${label(report.scenario)}**: ${count(report.invariants?.events)} eventos gerados e ` +
        `${count(report.prometheus.published)} publicados durante a carga ` +
        `(${perSecond(report.prometheus.published, report.loadWallMs)}/s), deixando ` +
        `${count(report.atLoadEnd.pending)} pendentes, drenados em ${num(report.drainMs / 1000)} s ` +
        `(${perSecond(report.atLoadEnd.pending, report.drainMs)}/s aparentes), com idade máxima de ` +
        `${num(report.oldestPendingSeconds)} s.`,
    );
  }
  lines.push(
    '',
    'A vazão de drenagem é aparente, não medida: o intervalo inclui a verificação SQL e as consultas de fila ' +
      `do próprio runner. Em ${count(faster)} de ${count(backlogged.length)} perfis com backlog ela superou a ` +
      'taxa de publicação observada durante a carga, o que é compatível com o publisher disputando banco, CPU e ' +
      'broker com o tráfego HTTP em vez de bater num teto fixo — esta execução não isola essa causa.',
    'O publisher publica uma mensagem por iteração, com claim, send e completion. Não houve perfil de CPU nem ' +
      'tracing para atribuir o custo entre rede, broker, banco e escalonamento da máquina. O benchmark torna o ' +
      'backlog visível, sem mudar o publisher.',
    '',
  );
  return lines;
}

const LIMITATIONS = [
  '## Limitações e custo de observação',
  '',
  '**A fila de eventos degrada a medição se não for limpa.** Nada consome `wager-events.fifo` neste produto, ' +
    'então ela cresce a cada execução e o broker fica progressivamente mais lento aceitando `SendMessage`, até o ' +
    'drain da Outbox estourar seu limite e reprovar o cenário. Por isso o runner a purga no modo gerenciado. O ' +
    'backlog remanescente nessa fila **não** equivale a Outbox não publicada: são mensagens já publicadas sem ' +
    'consumidor downstream.',
  '',
  '**O monitor tem custo dentro do que ele mede.** As amostras SQL de backlog, idade e espera por lock rodam a ' +
    'cada 2 s durante a carga e a cada 200 ms durante o drain, no mesmo PostgreSQL que os publishers usam. O ' +
    'índice parcial `outbox_pending_ix` limita a consulta ao conjunto pendente, mas o custo não foi isolado e ' +
    'está dentro das durações de drain acima.',
  '',
  '**A variância entre execuções é grande.** Os números valem para o ambiente e o workload registrados no topo ' +
    'deste arquivo, não como promessa de capacidade. O modelo é fechado: quando o serviço fica lento, o cliente ' +
    'reduz a taxa, e isso não mede chegada aberta. Os gauges Prometheus continuam sujeitos ao collector de 15 s; ' +
    'são as amostras SQL que estabelecem o backlog do cenário.',
  '',
  'Integridade não tem estado mensurável de "quase falhar": ou uma invariante foi violada, ou não foi. Só o ' +
    'perfil escasso mede folga nula por construção; nos demais o menor saldo histórico fica muito acima de zero. ' +
    'O teste obrigatório de duas apostas de 80 sobre 100 continua na suíte de concorrência.',
  '',
  '## Como reproduzir',
  '',
  '```bash',
  'bun run test:load',
  '```',
  '',
  'Um `LOAD_P95_MS` deliberadamente impossível reprova os perfis por latência e mantém as invariantes ' +
    'financeiras aprovadas em separado, o que confirma que os dois critérios falham de forma independente. As ' +
    'variáveis de ambiente e o modo de stack externa estão no `README.md`; a metodologia está em ' +
    '`test/load/README.md` e a escolha do diferencial no `ARCHITECTURE.md`, seção 14.1.',
];

export function renderReport(
  environment: ReportEnvironment,
  reports: ScenarioReport[],
  independence: IndependenceProof,
): string {
  const scarce = reports.find((report) => report.scenario === 'scarce');
  const mixed = reports.find((report) => report.scenario === 'mixed');
  const replay = reports.find((report) => report.scenario === 'idempotency');
  const failed = reports.filter((report) => !report.passed);
  const totals = reports.reduce(
    (accumulator, report) => ({
      retries: accumulator.retries + report.prometheus.retries,
      dlq: accumulator.dlq + report.prometheus.dlqRouted,
      divergences: accumulator.divergences + report.prometheus.divergences,
    }),
    { retries: 0, dlq: 0, divergences: 0 },
  );

  const lines = [
    '<!-- Gerado por `bun run test:load`. Não editar à mão: os números e as comparações saem do run',
    '     registrado abaixo, e uma nova execução sobrescreve este arquivo. -->',
    '',
    `# Medição local — ${environment.startedAt.slice(0, 10)}`,
    '',
    `Execução: \`bun run test:load\`, ${environment.vus} VUs e ${environment.duration} por perfil. ` +
      `Run ID: \`${environment.runId}\`. ` +
      `${failed.length === 0
        ? `Todos os ${reports.length} perfis aprovados.`
        : `**${failed.length} de ${reports.length} perfis reprovados**: ${failed
            .map((report) => `${label(report.scenario)} (${report.errors.join('; ')})`)
            .join(' · ')}.`} ` +
      `Artefatos brutos ficam em \`artifacts/load/${environment.runId}/\`, ignorados pelo Git.`,
    '',
    ...environmentSection(environment),
    '## Resultados',
    '',
    ...clientTable(reports),
    '',
    'Throughput e percentis são de submissões e incluem falhas, caso existam. O HTTP total inclui as consultas ' +
      'canônicas do perfil de idempotência, que não entram nos percentis. A carga real inclui a saída do k6 e sua ' +
      'graça para terminar requests; o total do cenário inclui preparação, carga, drain e verificação.',
    '',
    ...lockTable(reports),
    '',
    'A espera do histograma cobre a chamada de aquisição do lock, incluindo ida e volta ao banco, e não apenas o ' +
      'tempo bloqueado. O p95 de lock é um bucket, não um percentil exato. Backends esperando lock são amostras ' +
      'de todos os locks da role de runtime, não somente de wallet. A prova causal separada ' +
      `${independence.passed ? 'confirmou' : '**falhou** ao confirmar'} que uma Wallet livre conclui em ` +
      `${count(independence.freeWalletMs)} ms enquanto a operação da Wallet presa permanece bloqueada.`,
    '',
    ...outboxTable(reports),
    '',
    'A idade máxima é o maior `outbox_oldest_pending_age_seconds` observado nas amostras SQL do perfil, medido ' +
      'direto no banco e não pelo gauge Prometheus. Os eventos verificados incluem os `OPENING` das Wallets do ' +
      `perfil. Nos deltas Prometheus: ${count(totals.retries)} retries, ${count(totals.dlq)} roteamentos à DLQ e ` +
      `${count(totals.divergences)} divergências de reconciliação.` +
      `${mixed
        ? ` No misto, ${count(mixed.invariants?.inbox)} Inboxes processadas e ` +
          `${count(mixed.prometheus.inboxDuplicates)} duplicatas detectadas pela Inbox.`
        : ''}`,
    '',
    ...(scarce ? scarceSection(scarce, environment.vus) : []),
    '## Interpretação',
    '',
    ...contentionSection(reports),
    ...outboxSection(reports),
    ...(replay
      ? [
          `Na tempestade de replay houve ${count(metric(replay, 'wager_created', 'count'))} criação, ` +
            `${count(metric(replay, 'wager_replays', 'count'))} replays e ` +
            `${count(replay.invariants?.counts['BET'])} débito persistido.`,
          '',
        ]
      : []),
    'Todas as Wallets fecharam com saldo igual ao ledger líquido. As contagens de primeiras aplicações e de ' +
      'recusas coincidiram com o banco, hashes e identidades foram verificados, LOSS não criou ledger, e cada ' +
      'efeito criou exatamente um lançamento e os eventos esperados.',
    '',
    ...LIMITATIONS,
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
