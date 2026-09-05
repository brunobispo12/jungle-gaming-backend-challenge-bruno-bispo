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

**Ainda não implementados**, ambos opcionais pelo desafio: tracing com OpenTelemetry
(README §12) e o teste de carga `bun run test:load` (README §14). Autenticação funcional
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
| `bun run test` | suíte de unidade do domínio, sem container |
| `bun run infra:up` | sobe PostgreSQL, LocalStack e as três instâncias |
| `bun run infra:down` | derruba a stack e remove volumes |
| `bun run start` | roda a aplicação localmente contra a infraestrutura já no ar |
| `bun run dev` | igual ao anterior, com watch |
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:fresh` | reverte tudo e reaplica |
| `bun run test:integration` | sobe a infra de teste, recria o schema e roda a suíte |
| `bun run test:concurrency` | sobe três processos reais e roda os cenários do README §13 |
| `bun run test:infra:up` | sobe só a infraestrutura de teste |
| `bun run test:infra:down` | derruba a infraestrutura de teste |

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
