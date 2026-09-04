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
- o domínio financeiro — `Money` decimal exato, `Wallet`, ledger imutável, ciclo de vida
  da `WagerTransaction` e validação de reversão;
- 108 testes de unidade do domínio e 37 de integração contra PostgreSQL real.

**Ainda não implementados**: os casos de uso, a API de wagering, o consumidor SQS, a
outbox, o worker de referências pendentes e a reconciliação. Nada abaixo descreve
comportamento que não tenha sido executado.

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
| `APP_ROLES` | papéis ativos nesta instância: `api`, `consumer`, `pending-worker`, `outbox-publisher` |
| `PORT`, `INSTANCE_ID` | porta HTTP e identificação nos logs |

## Banco

Duas credenciais, de propósito:

- `wagering_migrator` é dona do schema e roda migrations;
- `wagering_app` é a role de runtime. Recebe `UPDATE` apenas nas colunas mutáveis de cada
  lifecycle e nenhum `DELETE` em tabela financeira ou auditável. No ledger não recebe
  `UPDATE`, `DELETE` nem `TRUNCATE`.

A imutabilidade do ledger e dos estados terminais é garantida por trigger além do
privilégio, porque entidade imutável em TypeScript não protege contra SQL direto.
