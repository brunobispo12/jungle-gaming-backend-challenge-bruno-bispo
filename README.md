# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de aposta de múltiplos provedores
de jogos, por HTTP e por SQS, com entrega *at-least-once*.

As decisões de desenho, os trade-offs e as limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Estado atual

O que existe e roda:

- schema completo em migration versionada e reversível, com constraints, índices, triggers
  de imutabilidade e privilégios de runtime separados da credencial de migration;
- Docker Compose com PostgreSQL 16, LocalStack e três instâncias da aplicação;
- health checks de liveness e readiness;
- `GET /metrics` em formato Prometheus, com transações por status, replay e Inbox
  duplicados, retries, DLQ, espera/conflitos de lock, latência, referências pendentes,
  reconciliação e backlog/idade da Outbox coletados sem depender dos publishers;
- o domínio financeiro — `Money` decimal exato, `Wallet`, ledger imutável, ciclo de vida
  da `WagerTransaction` e validação de reversão;
- criação de wallet e submissão de wager como casos de uso transacionais, com reserva de
  idempotência, lock pessimista por wallet, ledger e outbox no mesmo commit;
- `POST /wallets`, `GET /wallets/:id`, `POST /wagering/transactions` e as duas consultas
  de transação;
- `GET /wallets/:id/ledger?cursor=&limit=`: keyset descendente por `(created_at, id)` com
  cursor opaco, limite padrão 50 e máximo 200 — nunca `OFFSET`, que pularia ou repetiria
  lançamentos enquanto o cliente percorre as páginas;
- `POST /wallets/:id/reconciliation`: compara saldo materializado e saldo reconstruído do
  ledger num único snapshot `REPEATABLE READ READ ONLY`, e reporta a divergência sem
  corrigir nada;
- o publisher da outbox: lease entre publishers concorrentes, backoff exponencial com
  jitter e publicação em `wager-events.fifo` sempre depois do commit;
- o consumidor de `wager-transactions.fifo`: reusa o mesmo caso de uso do HTTP, deduplica
  por inbox persistente `(consumerName, messageId)` no mesmo commit da alteração
  financeira, dá `ack` só depois do commit e separa erro de negócio, transitório e
  permanente, com backoff por `ChangeMessageVisibility` e envio à DLQ antes do delete;
- o worker de referências pendentes: tick de 5 s sem líder, `FOR UPDATE SKIP LOCKED` sem
  lease, backoff exponencial com jitter até 5 min, e encerramento como `REJECTED` ao
  esgotar o TTL de 6 h ou as 100 tentativas — ou como `FAILED` quando a falha é
  determinística, em vez de culpar o provedor por um defeito nosso;
- `ProviderIdentityPort` com `TrustedProviderIdentityAdapter` no caminho real de
  `POST /wagering/transactions`: é o ponto de extensão de autenticação que o desafio pede
  quando ela não é implementada, e o `providerId` resolvido é o que entra no comando;
- a superfície operacional — `/health/live`, `/health/ready` e `/metrics` — responde em
  **qualquer papel**, inclusive num processo sem `api`, porque métricas de um consumer ou
  de um publisher precisam ser raspáveis; sem o papel `api` a API de negócio responde 404;
- 178 testes de unidade, 144 de integração e 11 de concorrência com três processos reais
  contra PostgreSQL e LocalStack reais, com os casos de uso rodando sob a role de runtime
  `wagering_app`, não sob a credencial de migration.

O diferencial de carga está disponível separadamente em `bun run test:load`, com k6,
cinco perfis e validação financeira no PostgreSQL após cada cenário.
Tracing com OpenTelemetry (README §12) continua não implementado. Autenticação funcional
também não existe (README §2 não pontua); o ponto de extensão é `ProviderIdentityPort`, e
o adapter atual confia na identidade declarada. Nada acima descreve comportamento que não
tenha sido executado.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x — runtime, package manager e test runner
- Docker com Docker Compose

## Setup

```bash
bun install
```

## Subir a stack completa

Sobe PostgreSQL, LocalStack e três instâncias da aplicação. As migrations rodam uma vez,
com a credencial de migration, antes de qualquer instância iniciar.

```bash
bun run infra:up
```

As instâncias respondem em `http://localhost:3001`, `:3002` e `:3003`.

```bash
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
```

`live` responde apenas sobre o processo. `ready` verifica PostgreSQL e SQS
separadamente e devolve 503 quando alguma dependência está fora, identificando qual.

Para derrubar tudo, incluindo os volumes:

```bash
bun run infra:down
```

## Testes

A suíte de integração sobe a infraestrutura de teste, recria o schema e roda contra
PostgreSQL real — nunca contra mock.

```bash
bun run test:integration
```

Infraestrutura de teste isolada da stack de desenvolvimento (portas 55432 e 54566):

```bash
bun run test:infra:up
bun run test:infra:down
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala dependências |
| `bun run typecheck` | TypeScript em modo estrito, sem emitir |
| `bun run test` | suíte de unidade do domínio e do harness de carga, sem container |
| `bun run infra:up` | sobe PostgreSQL, LocalStack e as três instâncias |
| `bun run infra:down` | derruba a stack e remove volumes |
| `bun run start` | roda a aplicação localmente contra a infraestrutura já no ar |
| `bun run dev` | igual ao anterior, com watch |
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:fresh` | reverte tudo e reaplica |
| `bun run test:integration` | sobe a infra de teste, recria o schema e roda a suíte |
| `bun run test:concurrency` | sobe três processos reais e roda os cenários do README §13 |
| `bun run test:load` | k6: cinco perfis, métricas e verificação financeira com stack isolada |
| `bun run test:infra:up` | sobe só a infraestrutura de teste |
| `bun run test:infra:down` | derruba a infraestrutura de teste |

## Teste de carga

Requer o executável [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) no PATH
(validado com v2.0.0), Bun e Docker Compose. Não roda em nenhuma suíte normal:

```bash
bun run test:load
```

O runner sobe `docker-compose.load.yml`: PostgreSQL em **55434**, LocalStack em **54567**
e três processos Bun em **3201–3203**, com todos os papéis e configurações financeiras
normais. Aplica somente migrations pendentes. Cria fixtures novas por execução, sem
apagar históricos; registra a quantidade de transações pré-existentes. Purga a fila de
eventos antes de medir — ela não tem consumidor downstream, cresce a cada execução e o
broker vai ficando mais lento para aceitar publicações, o que degradaria a comparação
entre execuções. Ao terminar, encerra seus processos e deixa os containers/dados
disponíveis para inspeção.

Defaults: **30 s, 12 VUs por perfil**, sem pausa entre requisições. A sequência é wallets
distintas (uma por VU), hot wallet (uma para todos), hot wallet com saldo escasso,
idempotência (mesmo fato para todos) e mix determinístico BET/BET/WIN/LOSS, com
**5 operações SQS/s** em paralelo no mix.
Cada operação vale `1.00 BRL`. As wallets abrem com `1000000000.00 BRL`, para medir
processamento sem transformar o cenário em rejeições por falta de saldo — exceto o perfil
escasso, que abre com `5.00 BRL` e cicla BET/BET/WIN justamente para prender o saldo na
fronteira de zero e manter o caminho de rejeição sob contenção durante toda a execução.
Uma em cada cinco operações SQS é enviada duas vezes com a mesma identidade autoral
e deduplication IDs diferentes, exercitando a Inbox além da deduplicação FIFO.

Antes da medição há uma prova causal de independência: o runner segura o lock de uma
wallet, confirma que uma operação da aplicação está bloqueada por essa conexão, e exige
que outra wallet conclua enquanto a primeira continua esperando. Esse probe não entra
nos percentis do benchmark.

| Env | Default / significado |
|---|---|
| `LOAD_DURATION` | `30s` por perfil; inteiro com sufixo `s` ou `m` |
| `LOAD_VUS` | `12`; VUs constantes e uma requisição em voo por VU |
| `LOAD_SQS_RPS` | `5`; taxa oferecida pelo produtor SQS no perfil misto |
| `LOAD_DRAIN_TIMEOUT_SECONDS` | `180`; limite para concluir Inbox/Outbox após cada perfil |
| `LOAD_P95_MS` | ausente; SLO opcional explícito para p95 das submissões, em ms |
| `LOAD_BASE_URL` | ausente: gerencia a stack isolada; presente: usa a stack fornecida. Aceita URLs separadas por vírgula |
| `LOAD_METRICS_URLS` | mesmas URLs de negócio; informe todas as instâncias se a base for um balanceador |
| `LOAD_DATABASE_URL` | conexão **runtime** da stack externa; obrigatória com `LOAD_BASE_URL` |
| `LOAD_AWS_ENDPOINT_URL` | endpoint SQS da stack externa; obrigatório com `LOAD_BASE_URL` |
| `LOAD_INPUT_QUEUE`, `LOAD_EVENTS_QUEUE`, `LOAD_DLQ_QUEUE` | nomes padrão da aplicação |

Exemplo PowerShell para uma execução curta:

```powershell
$env:LOAD_DURATION = '10s'
$env:LOAD_VUS = '6'
bun run test:load
Remove-Item Env:LOAD_DURATION, Env:LOAD_VUS
```

No modo externo, a stack deve ser de teste, estar ociosa, usar `wagering_app`, ter os
papéis consumer/outbox habilitados e filas de entrada/DLQ vazias. Não há migration nem
gerenciamento de processos externos. As verificações financeiras são limitadas às
wallets da execução; métricas são deltas por instância e podem incluir tráfego de outros
clientes. Uma única URL não comprova distribuição por três instâncias. As credenciais
AWS usam `AWS_REGION`, `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` (defaults locais).

Artefatos em `artifacts/load/<run-id>/`, ignorados pelo Git: `summary.md`,
`environment.json`, resumo k6, relatório SQL, logs da aplicação e snapshots Prometheus
antes/depois e a cada 2 s. O report inclui requests HTTP totais, submissões/s, taxa de
erro, p50/p95/p99, duração de carga/total/drain, conflitos/espera de locks, backlog da
Outbox e o pico de `outbox_oldest_pending_age_seconds` observado no perfil.
O resumo de replay exclui GETs de consulta canônica dos percentis de submissão, mas os
inclui no total HTTP. Falhas também entram nos percentis; não há retry HTTP automático.

**Critério de sucesso:** zero erro HTTP/contrato, todos os checks k6 válidos, operações
persistidas em quantidade igual às primeiras aplicações observadas, um único efeito na
tempestade de replay, nenhuma wallet negativa, ledger reconciliado, hashes/identidades
coerentes, Inbox processada e todos os eventos esperados publicados sem claim residual.
No perfil escasso soma-se o caminho de recusa: toda rejeição carrega `INSUFFICIENT_FUNDS`,
não gera lançamento nem altera saldo, emite exatamente um `WagerTransactionRejected`, e o
perfil reprova se nenhuma rejeição ou nenhum débito tiver ocorrido.
Timeout de drain, DLQ, divergência ou threshold falho terminam com exit não zero e
preservam os artefatos. Não há meta de throughput ou latência inventada pelo benchmark.

O modelo é fechado: quando o serviço fica lento, o cliente reduz a taxa. Não é um teste
de chegada aberta nem uma promessa de capacidade. Os gauges podem estar atrasados pelo
collector de 15 s; amostras SQL mostram o backlog real do cenário. Essas amostras não são
gratuitas: o monitor consulta o banco a cada 2 s durante a carga e a cada 200 ms durante o
drain, no mesmo PostgreSQL que os publishers usam, e esse custo está dentro das durações
reportadas. Integridade é binária: os saldos mínimos históricos reportam folga financeira,
não uma distância até uma race — exceto no perfil escasso, onde o mínimo histórico é o
próprio zero e a folga medida é nula por construção.
A fila de eventos acumula mensagens publicadas porque não há consumidor downstream no
produto; isso é diferente de Outbox não publicada, e é o motivo de o runner purgá-la antes
de cada medição gerenciada. Para um banco novamente vazio, encerre
a stack de carga entre execuções (`docker compose -f docker-compose.load.yml down -v`);
esse comando remove somente os dados reproduzíveis dessa stack.

[`test/load/RESULTS.md`](test/load/RESULTS.md) é **gerado pelo runner**, não escrito à mão:
o texto de método e limitações é fixo, e todo número, tabela e comparação sai do run. Cada
execução sobrescreve o arquivo, inclusive quando um perfil reprova — o relatório é o registro
da execução, não uma afirmação separada dela. Os dados brutos ficam em `artifacts/load/`,
ignorados pelo Git. O cálculo de deltas e percentis do harness tem testes próprios, que rodam
junto com `bun run test` por não precisarem de container.

## Configuração

Variáveis lidas pelo processo. O Docker Compose já as define; rodar fora dele exige
apontá-las para a infraestrutura desejada.

| Variável | Papel |
|---|---|
| `DATABASE_URL` | conexão da role de runtime, sem DDL e sem `DELETE` em tabela financeira |
| `DATABASE_MIGRATION_URL` | conexão da credencial de migration, a única que altera schema |
| `AWS_ENDPOINT_URL` | endpoint do SQS (LocalStack) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | credenciais do cliente SQS |
| `SQS_INPUT_QUEUE`, `SQS_DLQ_QUEUE`, `SQS_EVENTS_QUEUE` | nomes das filas |
| `APP_ROLES` | papéis ativos nesta instância: `api`, `consumer`, `pending-worker`, `outbox-publisher`. Todo papel abre a porta e serve health e `/metrics`; só `api` serve a API de negócio |
| `PORT`, `INSTANCE_ID` | porta HTTP e identidade da instância nos logs e no lease da outbox |
| `WALLET_LOCK_TIMEOUT_MS` | teto da espera pelo lock da wallet antes de virar falha transitória; default 20000, abaixo do visibility timeout de 60 s |

## Banco

Duas credenciais, de propósito:

- `wagering_migrator` é dona do schema e roda migrations;
- `wagering_app` é a role de runtime. Recebe `UPDATE` apenas nas colunas mutáveis de cada
  lifecycle e nenhum `DELETE` em tabela financeira ou auditável. No ledger não recebe
  `UPDATE`, `DELETE` nem `TRUNCATE`.

A imutabilidade do ledger e dos estados terminais é garantida por trigger além do
privilégio, porque entidade imutável em TypeScript não protege contra SQL direto.
