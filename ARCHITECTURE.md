# Architecture

Este documento descreve o serviço entregue: as decisões tomadas, os trade-offs aceitos e as limitações conhecidas. As escolhas abaixo priorizam correção financeira sob duplicação, entrega fora de ordem, concorrência entre processos e falhas entre commit, publicação e ACK.

A stack é Bun 1.x como runtime, package manager e test runner; TypeScript strict; NestJS; PostgreSQL; MikroORM; AWS SQS com LocalStack; e Docker Compose.

## 1. Escopo e prioridades

O serviço recebe operações de apostas por HTTP e SQS, mantém o saldo materializado de cada Wallet, registra toda movimentação em um ledger imutável e publica eventos de integração por Transactional Outbox.

Correção significa preservar simultaneamente estes invariantes:

- um mesmo fato financeiro não gera débito ou crédito duplicado;
- o saldo de uma Wallet nunca fica negativo;
- toda alteração de saldo possui exatamente uma WalletLedgerEntry correspondente;
- operações sem efeito financeiro não criam ledger;
- o saldo pode ser reconstruído a partir do ledger;
- um evento confirmado junto ao fato financeiro não é abandonado;
- replay devolve o resultado histórico, não o saldo atual;
- nenhuma garantia depende de uma única instância.

A ordem de prioridade é: exatidão de Money, atomicidade, idempotência, concorrência por Wallet, recuperação de falhas e, depois, throughput. Uma Wallet muito concorrida poderá esperar por lock; Wallets diferentes continuam independentes.

Ficam fora desta entrega autenticação funcional, double-entry bookkeeping, correção automática de divergências, exactly-once e ordenação global de eventos. Também não entram CQRS, CommandBus, repositórios genéricos, ClickHouse nem dashboards elaborados. OpenTelemetry permanece não implementado; observabilidade é logs JSON em stdout e métricas Prometheus. O diferencial opcional de carga do README §14 é executável por `bun run test:load`.

`ProviderIdentityPort` é o único ponto de extensão de autenticação, hoje implementado por `TrustedProviderIdentityAdapter`, que aceita a identidade declarada porque nenhum Identity Provider está ligado. O port fica no caminho real de `POST /wagering/transactions`: o controller resolve a identidade antes de submeter, e é o `providerId` resolvido que entra no comando e no `payloadHash`. Uma evolução troca só o adapter, por um que faça introspecção de OAuth2 client credentials e valide o `provider_id` do token contra o corpo. Health checks continuam públicos; a entrada SQS não passa pelo port — a fila é canal interno (README §2), e seus dados continuam sujeitos às mesmas validações de domínio.

## 2. Topologia

O mesmo caso de uso financeiro é chamado pelas duas entradas:

    HTTP Controller ───────────────────────┐
                                           │
    SQS Consumer → persistent Inbox ───────┼→ SubmitWagerTransactionUseCase
                                           │             │
                                           │             ▼
                                           │        PostgreSQL
                                           │        ├─ wallet
                                           │        ├─ wager_transaction
                                           │        ├─ wallet_ledger_entry
                                           │        ├─ inbox_message
                                           │        └─ outbox_message
                                           │             │
    Pending Reference Worker ──────────────┘             ▼
                                                  Outbox Publisher
                                                         │
                                                         ▼
                                                  wager-events.fifo

Um único binário suporta os papéis api, consumer, pending-worker e outbox-publisher por `APP_ROLES`. Docker Compose inicia três processos com todos os papéis. O desenho é multi-instance; nenhum papel precisa ser singleton: Inbox, unique indexes, row locks, SKIP LOCKED e leases coordenam instâncias concorrentes.

Todo processo abre a porta HTTP, qualquer que seja o papel, porque `/health/live`, `/health/ready` e `/metrics` precisam ser alcançáveis também num consumer ou num publisher — métricas que ninguém consegue raspar não são observabilidade. O papel `api` não decide mais se há porta, e sim se a API de negócio é servida: sem ele, `ApiRoleGuard` responde 404 em `/wallets` e `/wagering/transactions`, e a superfície operacional continua respondendo. Cada processo tem a sua `PORT`.

A indisponibilidade de um papel afeta disponibilidade ou latência, não muda a regra de correção. O estado necessário para recuperar trabalho fica no PostgreSQL ou no SQS, nunca apenas em memória do processo.

O código é separado em domain, application, infrastructure, interface e bootstrap. As portas são WalletRepository, WagerTransactionRepository, LedgerRepository, InboxRepository, OutboxRepository, OutboxClaimRepository, UnitOfWork, EventPublisher, IdGenerator, Clock, MetricsPort, MetricsExporter e ProviderIdentityPort; não há abstrações genéricas para operações que o domínio já nomeia melhor.

## 3. Money e domínio

As classes de domínio têm construtor privado ou protegido e estado encapsulado. Factories como create/from validam uma criação ou transição nova; rehydrate apenas recompõe o estado já validado e persistido, sem repetir regras de transição. Não há setters públicos para contornar Wallet, WagerTransaction ou WalletLedgerEntry.

### 3.1 Money sem ponto flutuante

Money é imutável e guarda um Decimal de decimal.js com precisão 34. O caminho completo é `decimal string → Money(Decimal) → persistence row string → EntitySchema com type string → PostgreSQL numeric(20,2)`; a leitura faz o caminho inverso. Nenhuma etapa monetária usa Number, parseFloat, coerção unária, float ou double.

Nos contratos de entrada, 25, 25.0 e 25.00 são normalizados para 25.00 antes do payloadHash. Notação científica, NaN, Infinity, string vazia, mais de duas casas, valores negativos e valores acima de 999999999999999999.99 são rejeitados. Money pode representar zero e valores negativos produzidos internamente por `negate`, como a diferença de reconciliação; initialBalance admite zero. O contrato de Wager exige amount maior que zero e rejeita `0.00` com AMOUNT_NOT_POSITIVE antes da reserva. Não existe arredondamento silencioso.

Money compara moeda em toda operação. O modelo permanece multi-moeda, embora a entrega possa operar apenas com BRL. Direção financeira é representada por LedgerDirection, não pelo sinal do valor.

### 3.2 Wallet e ledger

Wallet é o aggregate root do saldo. Wallet.debit e Wallet.credit validam moeda e saldo, calculam o novo Money e devolvem a única WalletLedgerEntry da alteração, com balanceBefore e balanceAfter. Balance, version, updatedAt e o lançamento são persistidos na mesma transação.

version nasce em 1 e só incrementa quando balance muda. Ela é dado de domínio e segue nos eventos; não é o mecanismo de concorrência. LOSS, PENDING_REFERENCE e REJECTED podem observar o saldo sob lock sem alterar version ou updatedAt.

WalletLedgerEntry não possui transições. amount é sempre positivo e direction informa DEBIT ou CREDIT. A factory valida:

- moedas compatíveis;
- balanceBefore e balanceAfter não negativos;
- CREDIT: balanceAfter = balanceBefore + amount;
- DEBIT: balanceAfter = balanceBefore − amount.

### 3.3 Ciclo de vida de WagerTransaction

PENDING é uma reserva inicial dentro da transação SQL. A linha é inserida cedo para disputar as chaves únicas, mas o fluxo normal não a torna observável por commit.

Transições permitidas:

    PENDING ───────────────→ PROCESSED
       │
       ├───────────────────→ REJECTED
       │
       └───────────────────→ PENDING_REFERENCE
                                  │
                                  ├→ PROCESSED
                                  ├→ REJECTED
                                  └→ FAILED

PROCESSED, REJECTED e FAILED são terminais. processedAt existe exatamente nesses estados. Um trigger rejeita UPDATE ou DELETE de uma linha que já estava terminal.

FAILED tem uso restrito: somente uma falha determinística e permanente ao processar uma PENDING_REFERENCE já persistida, com PostgreSQL funcional. Timeout, deadlock, conexão caída ou SQS indisponível são transitórios e não geram FAILED — a classificação reconhece tanto o SQLSTATE quanto a perda de socket que chega sem SQLSTATE algum, porque tratar um blip de rede como determinístico terminalizaria uma pendência legítima.

FAILED não tem evento próprio: publica `WagerTransactionRejected` com `failureCode = INFRASTRUCTURE_FAILURE`, que é o que distingue esse caso de uma recusa por regra de negócio no mesmo tipo de evento. A alternativa seria um quinto tipo de evento fora dos quatro mínimos do README §11, e o `failureCode` já resolve para o consumidor.

### 3.4 Efeito financeiro por kind

| Kind | Saldo | Ledger | Regra principal |
|---|---|---|---|
| OPENING | crédito inicial | CREDIT se maior que zero | interno à criação da Wallet |
| BET | débito | DEBIT | rejeita saldo insuficiente |
| WIN | crédito | CREDIT | referência opcional a BET da rodada |
| LOSS | nenhum | nenhum | registra PROCESSED e snapshot |
| REFUND | crédito | CREDIT | reverte BET PROCESSED |
| ROLLBACK | inverso da referência | direção invertida | reverte BET, WIN ou REFUND PROCESSED |

OPENING usa providerId internal, externalTransactionId opening:<walletId>, idempotencyKey internal:opening:<walletId>, roundId/gameId internal e hash canônico. O provider internal é inválido nas entradas externas, mas continua consultável por `GET /providers/internal/wagering/transactions/opening:<walletId>`: esconder o OPENING deixaria o histórico da Wallet incompleto. Saldo inicial zero cria somente a Wallet; saldo positivo cria OPENING, ledger e eventos na mesma transação. A Wallet continua observável com version 1.

WIN não exige referência. Se uma referência opcional é resolvida, ela é validada. Se o identificador opcional ainda não existe, o WIN é processado sem vínculo interno. Não há log ou métrica específicos para essa escolha.

### 3.5 Reversões — opção B

REFUND e ROLLBACK exigem referenceExternalTransactionId. A referência é resolvida por providerId e externalTransactionId e deve coincidir em provider, player, Wallet, moeda e rodada. O valor precisa ser exatamente igual em magnitude; reversão parcial está fora de escopo.

REFUND referencia apenas BET PROCESSED. ROLLBACK referencia BET, WIN ou REFUND PROCESSED. ROLLBACK de BET produz crédito; ROLLBACK de WIN ou REFUND produz débito e é REJECTED com REVERSAL_WOULD_OVERDRAW se deixar saldo negativo.

Adoto a opção B como interpretação candidata da frase “uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação”:

- uma referência pode ter no máximo um REFUND PROCESSED;
- a mesma referência pode ter no máximo um ROLLBACK PROCESSED;
- o banco impede repetição do mesmo kind;
- REFUND e ROLLBACK podem referenciar diretamente a mesma transação.

A constraint correspondente é:

    UNIQUE (reference_transaction_id, kind)
    WHERE status = 'PROCESSED'
      AND kind IN ('REFUND', 'ROLLBACK')

Portanto, BET → REFUND(BET) → ROLLBACK(BET) é aceito e pode gerar dois créditos. Essa consequência é mantida explícita porque é o custo da leitura textualmente mais próxima do enunciado. Não há cascata: reverter REFUND não reabre BET, e reverter BET não altera WIN.

### 3.6 FailureCode

FailureCode é resultado persistido de negócio ou de FAILED; ErrorCode pertence ao protocolo e nunca é gravado como estado financeiro.

| Grupo | FailureCode |
|---|---|
| Saldo | INSUFFICIENT_FUNDS; REVERSAL_WOULD_OVERDRAW |
| Referência ausente ou em estado inválido | REFERENCE_NOT_FOUND; REFERENCE_NOT_PROCESSED; REFERENCE_KIND_NOT_REVERSIBLE |
| Referência incompatível | REFERENCE_MISMATCH; REVERSAL_AMOUNT_MISMATCH; REFERENCE_ALREADY_REVERSED |
| Moeda | CURRENCY_MISMATCH, tanto para operação em moeda diferente da Wallet quanto para referência em outra moeda |
| Wallet | WALLET_NOT_FOUND; WALLET_PLAYER_MISMATCH |
| Falha terminal do pending worker | INFRASTRUCTURE_FAILURE |

Os dois códigos de saldo são separados porque uma BET sem fundos e uma reversão que causaria saldo negativo pedem diagnósticos diferentes. OPENING recebido por HTTP ou SQS é erro de contrato e falha antes da reserva da Wager. Os demais erros de protocolo usam ErrorCode estável conforme a matriz HTTP e nunca são persistidos como resultado financeiro.

## 4. PostgreSQL: schema e invariantes

Escolhi MikroORM porque seu Unit of Work, Identity Map e suporte a transações/locks deixam explícita a fronteira que importa neste desafio. EntitySchema mapeia persistence rows POJO; mappers dedicados fazem domínio ↔ persistência. Assim Money, Wallet e WagerTransaction não recebem decorators do ORM ou do NestJS. Cada requisição, mensagem ou iteração de worker usa um EntityManager forkado.

Reservas com ON CONFLICT, row locks e claims podem usar QueryBuilder ou SQL encapsulado nos repositórios quando a operação precisa acontecer imediatamente, sem depender do flush tardio do Unit of Work. O custo é algum código de mapeamento, aceito para não acoplar as invariantes do domínio ao formato das tabelas.

Migrations são versionadas, têm up/down e rodam com uma credencial separada. A role da aplicação possui apenas os privilégios necessários ao runtime. As constraints têm nomes estáveis para diagnóstico e testes de banco.

| Invariante | Mecanismo no PostgreSQL | Por que não basta código |
|---|---|---|
| Wallet única e válida | UNIQUE(player_id,currency); balance numeric(20,2) CHECK(balance >= 0); version CHECK(version >= 1); UNIQUE(id,currency) sustenta a FK composta dos snapshots | requisições concorrentes e SQL direto contornam consultas prévias |
| Identidades da Wager | UNIQUE(provider_id,idempotency_key) e UNIQUE(provider_id,external_transaction_id) | coordena todas as instâncias |
| Valor e referência | amount numeric(20,2) CHECK(amount > 0) ao lado de currency char(3) NOT NULL da própria operação, coluna distinta de result_balance_currency; self FK reference_transaction_id ON DELETE RESTRICT; CHECKs por kind | evita valor ou vínculo estruturalmente inválido |
| Reversão opção B | índice único parcial em (reference_transaction_id,kind) para REFUND/ROLLBACK PROCESSED | fecha a corrida entre duas reversões do mesmo kind |
| Lifecycle e snapshot | CHECKs entre status, failure_code, processed_at e result_balance; FK `(wallet_id,result_balance_currency) → wallet(id,currency)` com MATCH SIMPLE quando há snapshot; trigger bloqueia UPDATE/DELETE de estado terminal | replay depende de histórico coerente e imutável |
| Seleção de pending | índice parcial (next_attempt_at,id) para PENDING_REFERENCE | evita varrer o histórico |
| Um ledger por efeito | UNIQUE(transaction_id,wallet_id) e FKs ON DELETE RESTRICT | retry ou mapper defeituoso não duplica nem deixa órfão |
| Ledger exato | numeric(20,2) mais uma currency char(3) NOT NULL comum aos três valores; CHECK amount > 0, saldos não negativos e balance_after = balance_before ± amount | protege aritmética e não-negatividade no último limite |
| Ledger imutável | trigger de UPDATE/DELETE e role da aplicação sem UPDATE, DELETE ou TRUNCATE | entidade imutável não protege contra SQL direto |
| Inbox | PRIMARY KEY(consumer_name,message_id), identidade/hash imutáveis e processed_at >= received_at | dedup precisa sobreviver a processos e reinícios |
| Outbox | UNIQUE(event_id); claim nulo ou completo; índice parcial de itens não publicados por next_attempt_at/claim/ordem | coordena publishers e mantém eventos recuperáveis |
| Paginação do ledger | índice (wallet_id,created_at DESC,id DESC) | sustenta o cursor keyset |

Os CHECKs de WagerTransaction tornam PENDING uma reserva sem resultado; exigem snapshot e referência externa em PENDING_REFERENCE; e exigem processedAt nos estados terminais. PROCESSED não tem failureCode; REJECTED e FAILED têm, e FAILED aceita apenas INFRASTRUCTURE_FAILURE. resultBalance existe para todo resultado que encontrou a Wallet, com WALLET_NOT_FOUND como única exceção. Sua moeda é a da Wallet observada, não necessariamente a da operação: em CURRENCY_MISMATCH elas diferem; nos outros resultados com snapshot, um CHECK exige igualdade.

WagerTransaction não tem FK simples obrigatória de wallet_id para permitir que WALLET_NOT_FOUND permaneça auditável. A FK composta com result_balance_currency é ignorada pelo MATCH SIMPLE quando o snapshot é nulo e valida a Wallet quando ele existe. Toda WalletLedgerEntry, que representa efeito financeiro real, tem FK para Wallet e WagerTransaction.

A igualdade entre Wallet.balance e a soma do ledger atravessa linhas e tabelas, portanto não cabe em um CHECK local. Ela é protegida pela transação financeira única, pelo lançamento criado pela própria Wallet e verificada pela reconciliação.

A reversão de uma migration é operação sobre schema, não um caminho runtime para apagar ledger. A role da aplicação não recebe DELETE nas tabelas financeiras/auditáveis e só atualiza as colunas mutáveis de cada lifecycle. Em wallet_ledger_entry, não recebe UPDATE, DELETE nem TRUNCATE; manutenção destrutiva exige a credencial separada de migration/operação.

IDs de Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage e eventId são UUID v7 gerados por IdGenerator. O desenho usa sua unicidade, não supõe ordem temporal pelo UUID.

## 5. Fronteira transacional e concorrência

Operações financeiras normais usam READ COMMITTED. Esse nível permite que uma nova consulta após o INSERT concorrente veja a transação vencedora, enquanto o row lock da Wallet serializa o saldo. Em READ COMMITTED o próprio `SELECT … FOR UPDATE` reavalia a linha quando o bloqueio termina e devolve a versão que a vencedora commitou: por isso, no cenário obrigatório, a segunda BET lê `20.00` e não os `100.00` visíveis no início da sua transação. É esse comportamento — não a coluna `version` — que elimina o lost update.

Escolhi lock pessimista porque o cenário central é contenção sobre um saldo mutável. Dentro da transação, a implementação executa um único SELECT … FOR UPDATE bloqueante na Wallet. Não há probe não bloqueante seguido de retry, nem comparação otimista por version.

Cada tentativa de lock da Wallet usa `SET LOCAL lock_timeout`, com default de 20 s. Lock timeout e deadlock causam rollback; no HTTP são expostos como 503 com `Retry-After`, e no SQS são tratados como falha transitória sem ACK. Não existe deadline global de transação ou de request nesta entrega.

Não há lock global. Operações em Wallets diferentes adquirem rows diferentes e podem avançar em paralelo. O custo é serialização e espera em hot Wallets, coerente com a unidade de concorrência exigida pelo desafio.

### 5.1 Fronteiras

| Fluxo | O que fica na mesma transação |
|---|---|
| HTTP wager | reserva Wager, lock da Wallet, resultado, Wallet, ledger, snapshot e Outbox |
| SQS wager | Inbox primeiro, reserva/replay Wager, estado financeiro, ledger, snapshot, Outbox e Inbox processed |
| Wallet opening | Wallet, OPENING, ledger e Outbox quando saldo inicial é positivo |
| Pending worker | lock da Wager pendente, referência, Wallet lock, resultado ou reagendamento e Outbox |
| Outbox claim | somente seleção e gravação do token/lease |
| Outbox completion | somente marcação condicional de sucesso ou retry |
| Reconciliation | leituras sob REPEATABLE READ READ ONLY |

Nenhuma chamada SQS ocorre com a transação financeira aberta.

### 5.2 Ordem de locks

A ordem é:

1. reserva da Inbox, quando a origem é SQS;
2. reserva da própria WagerTransaction em PENDING;
3. row lock da Wager em PENDING_REFERENCE, apenas no worker;
4. Wallet por SELECT … FOR UPDATE;
5. referência relida depois da Wallet, sem um segundo row lock;
6. INSERTs de ledger e Outbox;
7. claim de Outbox em transação independente.

Referências terminais são imutáveis. O lock da Wallet serializa reversões válidas, por isso o fluxo não precisa travar a referência depois de já possuir a Wallet. Replay não trava Wallet, e reconciliação não usa row lock.

Se um fluxo futuro precisar travar mais de uma Wallet, deverá ordenar os IDs crescentemente. Nenhum fluxo atual precisa disso.

## 6. Idempotência e replay

### 6.1 Identidades e hashes

Idempotency-Key é obrigatório no HTTP e é a fonte da verdade. Seu escopo é providerId:

    UNIQUE(provider_id, idempotency_key)

externalTransactionId possui uma unicidade independente:

    UNIQUE(provider_id, external_transaction_id)

Uma chave nova para externalTransactionId já existente retorna EXTERNAL_TRANSACTION_ID_REUSED; não é replay.

O business payloadHash é SHA-256 hexadecimal de JSON canônico, com chaves ordenadas por code unit, campos ausentes omitidos e Money já normalizado. Participam providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId quando presente.

Idempotency-Key e metadados de transporte não participam. Assim HTTP e SQS produzem o mesmo hash para o mesmo fato.

### 6.2 Algoritmo da primeira submissão

1. Validar o contrato e normalizar Money na fronteira; calcular payloadHash no caso de uso.
2. Iniciar READ COMMITTED; no SQS, reservar a Inbox antes de qualquer consulta de negócio.
3. Inserir WagerTransaction em PENDING com INSERT … ON CONFLICT DO NOTHING RETURNING.
4. Se não inseriu, executar uma nova consulta em READ COMMITTED:
   - procurar providerId+idempotencyKey;
   - hash igual: replay;
   - hash divergente: IDEMPOTENCY_KEY_CONFLICT;
   - sem key, procurar providerId+externalTransactionId;
   - external existente: EXTERNAL_TRANSACTION_ID_REUSED;
   - nada encontrado: SERVICE_UNAVAILABLE transitório.
5. Somente quem inseriu trava a Wallet.
6. Resolver referência, decidir o resultado e persistir saldo, ledger, resultBalance e Outbox quando aplicáveis.
7. Sair de PENDING para PROCESSED, REJECTED ou PENDING_REFERENCE; no SQS, marcar a Inbox processada.
8. Commit; só depois responder ou enviar ACK.

O INSERT concorrente espera a decisão da unique index. Se a vencedora commitar, a consulta seguinte a enxerga; se abortar, uma concorrente assume a inserção. Em 50 requisições idênticas, uma única transação toca a Wallet.

Corridas esperadas não usam SQLSTATE 23505 como controle normal: as reservas de Wager e Wallet usam `ON CONFLICT DO NOTHING`. Uma violação residual de constraint aborta a transação e segue como erro interno seguro; não existe classificador genérico por `constraint_name` nem subsistema de alerting nesta entrega.

### 6.3 Resultado histórico

resultBalance é parte do resultado persistido, não uma consulta à Wallet durante replay:

- PROCESSED guarda o saldo depois da operação, ou o saldo observado para LOSS;
- REJECTED guarda o saldo observado quando a Wallet existe;
- PENDING_REFERENCE guarda o saldo do aceite;
- FAILED guarda o saldo observado na terminalização;
- WALLET_NOT_FOUND não possui snapshot.

Replay devolve transactionId, status, failureCode e resultBalance originais sem lock ou nova Outbox. Enquanto pending, retorna o snapshot do aceite. Quando o worker terminaliza, substitui esse snapshot pelo resultado terminal.

### 6.4 Replay entre canais

Se HTTP já processou e uma nova mensagem SQS traz o mesmo negócio com outro messageId, a transação SQS ainda insere e processa sua própria Inbox. A identidade de Wager vira replay sem Wallet lock, a Inbox é marcada e o ACK só ocorre após esse commit.

Se SQS processou primeiro, HTTP encontra a Wager na consulta inicial e devolve o snapshot histórico. HTTP não cria Inbox.

Essa ordem separa duas perguntas: “esta entrega SQS já foi consumida?” e “este fato financeiro já foi aplicado?”.

Se o processo morrer antes do commit, reserva, saldo, ledger, Inbox e Outbox sofrem rollback juntos. Se morrer depois do commit HTTP e antes da resposta, o retry encontra a idempotency key e devolve o resultado histórico. Se morrer depois do commit SQS e antes do ACK, a redelivery encontra a Inbox processada e não repete o efeito financeiro.

## 7. Inbox e consumer SQS

O consumer lê `wager-transactions.fifo` e aceita o envelope `WagerTransactionRequested` com `messageId`, `occurredAt` e os mesmos dados de negócio da entrada HTTP. A DLQ é `wager-transactions-dlq.fifo`.

Inbox deduplica entregas de transporte por:

    PRIMARY KEY (consumer_name, message_id)

consumerName é wager-transactions-consumer. messageId é o campo autoral do envelope; o broker MessageId é guardado separadamente apenas para diagnóstico. O contrato assume que messageId é globalmente único dentro desse consumidor lógico.

O inboxPayloadHash é diferente do business payloadHash. Ele cobre type, occurredAt e data completa já canonizada, incluindo idempotencyKey, e exclui metadata do broker.

Ao consumir:

1. validar JSON, messageId, type, occurredAt e data;
2. calcular inboxPayloadHash e business payloadHash; rawBodyHash é calculado somente ao rotear para a DLQ;
3. iniciar transação;
4. reservar Inbox com INSERT … ON CONFLICT DO NOTHING RETURNING;
5. se perdeu:
   - mesmo hash e processedAt preenchido: redelivery, sem efeito;
   - hash divergente: erro permanente, sem chegar ao caso de uso;
   - processedAt ausente: estado anômalo, rollback e retry transitório;
6. se ganhou, executar a idempotência de negócio;
7. persistir resultado, Inbox e Outbox atomicamente;
8. commit;
9. ACK/DeleteMessage.

Uma entrega nova que encontra replay de negócio ainda precisa commitar sua Inbox antes do ACK. Isso cobre HTTP → SQS e reemissões do produtor.

### 7.1 Classificação

| Classe | Exemplos | Banco | SQS |
|---|---|---|---|
| Business rejection | saldo insuficiente, moeda/referência inválida | REJECTED + Inbox + Outbox | ACK após commit |
| Transient | PostgreSQL/SQS indisponível, timeout, deadlock | rollback | sem ACK, visibility/backoff |
| Permanent contract | envelope/kind inválido, hash divergente, conflito de identidade | nenhuma Wager nova | DLQ e depois delete |
| Unknown | exceção não classificada | rollback | transient + log seguro |

Para erro permanente descoberto depois de reservar Inbox, a transação é revertida antes do envio à DLQ. O SendMessage para wager-transactions-dlq.fifo precede o DeleteMessage da origem.

Como a DLQ também é FIFO:

- MessageGroupId reutiliza o atributo da origem;
- MessageDeduplicationId é SHA-256(consumerName || NUL || brokerMessageId || NUL || rawBodyHash).

Esses dados existem mesmo quando o JSON é inválido. Se o processo morrer após o send e antes do delete, a DLQ pode receber duplicata após a janela de dedup, mas a origem não é perdida.

### 7.2 FIFO, retry e shutdown

Na fila de entrada:

    MessageGroupId = walletId
    MessageDeduplicationId = SHA-256(providerId || NUL || envelope.messageId)
    VisibilityTimeout = 60 s
    maxReceiveCount = 5

A deduplicação do SQS é otimização: ela não cobre a entrada HTTP, não substitui a identidade de negócio e tem janela limitada. A correção financeira continua no PostgreSQL e na Inbox.

Backoff transitório:

    min(60 s, 5 s × 2^(ApproximateReceiveCount − 1))

O consumer aplica ChangeMessageVisibility e não apaga a mensagem. Uma mensagem em retry bloqueia temporariamente outras do mesmo walletId; grupos de outras Wallets continuam avançando. Uma indisponibilidade longa pode levar uma mensagem válida à DLQ após cinco recebimentos e exigir redrive operacional; alerting não faz parte desta entrega.

O consumer é ativado apenas nas instâncias configuradas para o papel de worker. Durante o graceful shutdown, deixa de buscar novas mensagens, aguarda até 25 s pelos itens em processamento e reserva a janela restante até 30 s para devolver imediatamente a visibilidade dos itens que não concluíram. Mensagens recebidas em lote que ainda não iniciaram processamento também têm a visibilidade devolvida, evitando mantê-las indisponíveis durante o drain. O que não commitou não é marcado como processado.

## 8. Pending references e reversões

Para REFUND ou ROLLBACK, referência ausente significa que referenceExternalTransactionId foi fornecido, mas a transação ainda não existe. WIN mantém a escolha da seção 3.4: sua referência é opcional e, se ainda não existir, segue sem vínculo interno.

Na submissão, a transação reserva a Wager, trava a Wallet e grava PENDING_REFERENCE com attempts=0, expiresAt=createdAt+6h, primeira tentativa em aproximadamente 5 s e resultBalance do aceite. O evento WagerTransactionPendingReference entra na mesma Outbox; depois do commit, HTTP responde 202 ou o consumer envia ACK.

Cada instância executa ticks de 5 s, sem líder. Uma iteração:

1. abre transação e seleciona uma Wager elegível por nextAttemptAt/id com FOR UPDATE SKIP LOCKED LIMIT 1;
2. mantém esse row lock até o commit;
3. se a referência continuar ausente, incrementa attempts e reagenda; ao atingir 6 h ou 100 tentativas, trava a Wallet e relê a referência. Se ela apareceu durante a espera, segue o processamento normal; somente se ainda estiver ausente atualiza o snapshot e conclui como REJECTED/REFERENCE_NOT_FOUND com evento;
4. se a referência existir, trava a Wallet, relê e valida status, kind, provider, player, Wallet, moeda, rodada, magnitude e reversão anterior do mesmo kind;
5. processa ou rejeita, atualiza resultBalance, cria ledger e eventos quando aplicável e commita.

Após uma busca ausente, o atraso é:

    min(300 s, 5 s × 2^(attempts − 1)) × jitter[0.8,1.2]

Falha transitória causa rollback e não consome tentativa lógica. Não há claim persistente nesse worker: o row lock cobre toda a operação, que é apenas de banco. Se o processo morrer antes do commit, a conexão libera o lock e tudo volta. Depois do commit, status ou nextAttemptAt impede repetição. Dois workers não aplicam financeiramente a mesma pending.

Essa é a diferença para a Outbox: o pending worker pode manter o row lock porque não faz rede; o publisher precisa liberar a transação antes de chamar SQS e, por isso, usa lease.

Se ocorrer uma falha determinística permanente, a tentativa original faz rollback. Uma transação curta posterior trava a mesma Wager e a Wallet, confirma PENDING_REFERENCE, grava snapshot, INFRASTRUCTURE_FAILURE, processedAt e FAILED. Referências terminais continuam imutáveis.

A opção B também vale no worker. A aplicação verifica reversão anterior do mesmo kind sob Wallet lock e o índice parcial é a última barreira contra concorrência.

## 9. Transactional Outbox e eventos

Publicar diretamente antes do commit criaria evento de um fato que pode abortar. Publicar somente depois do commit sem intenção persistida perderia o evento se o processo morresse. Por isso o envelope entra em outbox_message na mesma transação da Wager, Wallet, ledger e Inbox quando aplicável.

OutboxMessage.enqueue define attempts=0 e nextAttemptAt=occurredAt, deixando o item elegível imediatamente.

### 9.1 Claim e publicação

1. O publisher abre uma transação curta e seleciona uma linha elegível com FOR UPDATE SKIP LOCKED LIMIT 1.
2. Grava um token em claimedBy, define claimedUntil=now+30 s e commita.
3. Faz SendMessage fora da transação, com timeout máximo de 10 s.
4. Em sucesso, outra transação marca publishedAt somente se o token ainda pertence ao publisher.
5. Em falha, um update também condicionado incrementa attempts, registra lastError, agenda a próxima tentativa e libera o claim.

Backoff:

    min(60 s, 1 s × 2^(attempts − 1)) × jitter[0.8,1.2]

Não existe limite terminal para um evento confirmado. attempts serve para telemetria e backoff; o item continua elegível até publicação. As métricas expõem backlog e idade para monitoramento externo, mas o serviço não implementa alerting.

O token do claim é o INSTANCE_ID do processo, o mesmo que identifica a instância nos logs, então uma linha ainda travada aponta para quem a segurava.

O laço reclama uma mensagem por vez. Depois de publicar tenta a próxima imediatamente; sem nada elegível espera 500 ms; depois de um erro inesperado espera 2 s. O desligamento interrompe a espera ociosa em vez de aguardá-la, e o envio em andamento termina antes de o processo sair. Só a instância com o papel outbox-publisher roda esse laço. Todo papel abre a porta HTTP para `/health/live`, `/health/ready` e `/metrics`; somente `api` habilita as rotas de negócio.

### 9.2 Janelas de crash

| Janela | Comportamento |
|---|---|
| Antes do commit do claim | outro publisher seleciona o item |
| Depois do claim, antes do send | lease expira e outro publisher assume |
| Send aceito, antes de publishedAt | republicação possível com o mesmo eventId |
| SQS indisponível | registro permanece no PostgreSQL e continua em retry |

A folga entre timeout de 10 s e lease de 30 s reduz claims expirando durante uma chamada saudável. Pausa de processo ou resultado desconhecido ainda pode duplicar; não pode perder o item.

### 9.3 Garantias e ordenação

A atomicidade termina no registro da Outbox: fato financeiro e intenção de publicar commitam juntos. A entrega externa é at-least-once; eventId é estável e UNIQUE, mas um resultado desconhecido pode causar nova publicação, então consumidores precisam deduplicá-lo. Não há exactly-once, nenhum evento confirmado é abandonado por número de tentativas e publishers concorrentes podem inverter occurredAt.

SQS FIFO preserva a ordem em que as publicações chegam ao broker, não a ordem de commit. O desenho não promete ordenação por ocorrência.

A fila de saída é wager-events.fifo. MessageDeduplicationId é eventId. MessageGroupId segue aggregateId: transactionId nos eventos da Wager e walletId em WalletBalanceChanged.

Eventos mínimos:

| Evento | Quando | aggregateId | Dados principais |
|---|---|---|---|
| WagerTransactionProcessed | qualquer operação aplicada, inclusive OPENING e LOSS | transactionId | identificação da Wager/provider/Wallet, player, round, game, kind, money, processedAt e referência opcional |
| WagerTransactionRejected | regra de negócio, inclusive expiração de pending | transactionId | identificação da Wager/provider/Wallet, kind, money, failureCode e processedAt |
| WagerTransactionPendingReference | referência ainda ausente | transactionId | identificação da Wager/provider/Wallet, kind, referência externa e money |
| WalletBalanceChanged | somente quando balance muda | walletId | transactionId, direction, money, balanceBefore, balanceAfter e walletVersion |

IntegrationEvent<T> é uma classe abstrata que concentra eventId, aggregateId, correlationId, causationId, occurredAt, data e toJSON. Cada evento da tabela é uma subclasse concreta; eventType e version pertencem ao tipo, não a strings soltas no call site.

Os payloads usam MoneyProps, nunca a instância Money. Cada tipo começa em version 1; mudança aditiva preserva versão e mudança incompatível cria nova versão coexistente.

HTTP usa X-Correlation-Id válido ou gera um; causationId é o request ID. SQS deriva correlationId deterministicamente de consumerName+messageId e usa messageId como causationId. O pending worker herda o correlationId persistido.

## 10. Contrato HTTP

O contrato distingue erro de protocolo de resultado de negócio:

| Resultado | HTTP | Persistência |
|---|---:|---|
| Payload/header inválido | 400 | nada |
| Corpo acima do limite do parser | 413 | nada |
| Charset ou encoding não suportado | 415 | nada |
| Idempotency-Key com payload divergente | 409 | nada novo |
| externalTransactionId reutilizado com outra key | 409 | nada novo |
| Primeira operação PROCESSED | 201 | Wager, efeito, ledger e Outbox |
| Replay PROCESSED | 200 | nada novo; snapshot histórico |
| Regra de negócio | 422 | REJECTED e Outbox |
| Replay REJECTED | 422 | nada novo; mesmo failureCode/snapshot |
| Referência ainda ausente | 202 | PENDING_REFERENCE e Outbox |
| Replay ainda pending | 202 | snapshot do aceite |
| Pending depois terminalizada | 200 ou 422 | snapshot terminal |
| Recurso de GET ausente | 404 | nenhuma mudança |
| FAILED já persistida | 500 no POST/replay; 200 no GET | recurso auditável |
| Falha interna | 500 | rollback |
| Falha transitória | 503 | rollback e Retry-After |

POST /wallets retorna 201. A unicidade playerId+currency usa INSERT … ON CONFLICT DO NOTHING RETURNING; a perdedora lê a vencedora e retorna 409 WALLET_ALREADY_EXISTS com existingWalletId. Esse endpoint não aceita Idempotency-Key: o próprio par playerId+currency é a chave, e um retry de rede recebe o mesmo 409 com o existingWalletId.

A frase “mesma resposta” é interpretada como o mesmo resultado de negócio: transactionId, status, failureCode e resultBalance históricos. No contrato HTTP, resultBalance é serializado no campo balance. Não significa resposta HTTP byte a byte. 201 informa que aquela requisição criou o recurso; um replay processado usa 200 e idempotentReplay=true. Rejeição permanece 422 e pending permanece 202.

Erros de contrato usam envelope error com code estável, mensagem segura, details opcionais e correlationId. Resultados de negócio usam o recurso, inclusive em 422. Corpos de erro e logs não incluem payload financeiro completo.

Consultas:

- GET /wallets/:walletId;
- GET /wallets/:walletId/ledger;
- GET /wagering/transactions/:transactionId;
- GET /providers/:providerId/wagering/transactions/:externalTransactionId.

O cursor do ledger é base64url opaco de createdAt+id. A busca usa keyset por (created_at,id) descendente e não depende da ordenação do UUID v7. limit tem default 50, mínimo 1 e máximo 200.

A página de ledger tem items, nextCursor e hasMore. As consultas de Wager devolvem uma TransactionView com status, failureCode e resultBalance persistidos.

GET /health/live verifica somente processo. GET /health/ready verifica PostgreSQL e SQS separadamente e retorna 200 ou 503. Ambos são públicos.

## 11. Reconciliação

Wallet.balance é o saldo materializado para processamento rápido; wallet_ledger_entry é a trilha auditável.

POST /wallets/:walletId/reconciliation abre:

    BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY

No mesmo snapshot, a consulta lê o saldo da Wallet e calcula:

    COALESCE(SUM(CASE
      WHEN direction = 'CREDIT' THEN amount
      WHEN direction = 'DEBIT'  THEN -amount
    END), 0.00)

O COALESCE é necessário porque uma Wallet aberta com saldo zero não possui OPENING nem ledger; o saldo reconstruído nesse caso é 0.00, não NULL.

A resposta contém storedBalance, calculatedBalance, difference, consistent e checkedEntries. Wallet inexistente retorna 404. Wallet existente retorna 200 mesmo quando há divergência.

Reconciliação nunca atualiza saldo ou ledger. Reparar automaticamente esconderia o defeito e exigiria escolher uma fonte como correta sem contexto operacional. Uma diferença gera resposta explícita, log e métrica. O custo cresce linearmente com o histórico da Wallet; não há snapshot incremental nesta entrega.

## 12. Observabilidade

Dois sinais são entregues, e respondem a perguntas diferentes:

| Sinal | Responsabilidade | Estado |
|---|---|---|
| JSON logs em stdout | eventos discretos e erros classificados | entregue |
| Prometheus em `GET /metrics` | comportamento agregado para monitoramento externo | entregue |
| OpenTelemetry traces | caminho e latência de uma execução individual | opcional pelo README §12, **não implementado** |

Logs carregam `correlationId` e, quando existem, `messageId`, `brokerMessageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status` e `idempotentReplay`. `messageId` é o ID autoral do envelope e `brokerMessageId` é o identificador entregue pelo SQS. Payload financeiro completo, `amount`, `balance`, credenciais e dados sensíveis ficam de fora; o teste de logging em `test/integration/logging.spec.ts` percorre objetos e arrays recursivamente, rejeita chaves proibidas em qualquer profundidade e também verifica os valores movimentados, inclusive numa divergência real de reconciliação.

Os três identificadores de correlação têm papéis distintos: `correlationId` é controlado pela aplicação e acompanha a operação de negócio, aceito do provedor no HTTP e derivado deterministicamente de `(consumerName, messageId)` no SQS; `causationId` identifica a causa imediata de um `IntegrationEvent`; e nenhum deles substitui `messageId`, a chave da Inbox ou a `Idempotency-Key`.

### 12.1 Métricas expostas

`GET /metrics` responde com o `contentType` do `Registry` próprio da aplicação — nunca o registry default do `prom-client`, e sem `collectDefaultMetrics()`. O endpoint é fino: lê o registry e devolve o texto.

| Métrica | Tipo | Labels |
|---|---|---|
| `wager_transactions_total` | Counter | `status`, `kind`, `source` |
| `wager_duplicates_total` | Counter | `layer` (`business`, `inbox`) |
| `wager_retries_total` | Counter | `component`, `reason` |
| `wager_processing_duration_seconds` | Histogram | `source`, `kind`, `outcome` |
| `sqs_dlq_routed_total` | Counter | `reason` |
| `sqs_dlq_visible_messages` | Gauge | — |
| `wallet_lock_wait_seconds` | Histogram | `outcome` |
| `wallet_lock_conflicts_total` | Counter | `reason` (`lock_timeout`, `deadlock`) |
| `pending_reference_attempts_total` | Counter | `outcome` |
| `outbox_publish_duration_seconds` | Histogram | `outcome` |
| `outbox_pending_messages` | Gauge | — |
| `outbox_oldest_pending_age_seconds` | Gauge | — |
| `wallet_reconciliation_divergences_total` | Counter | — |
| `http_requests_total` | Counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |

Todas as labels declaradas têm conjunto fechado. Nenhuma carrega `walletId`, `transactionId`, `providerId`, `messageId`, `correlationId`, `externalTransactionId`, `idempotencyKey` ou qualquer outro identificador: `reason` e `outcome` recebem categorias controladas dos call sites atuais, e `route` é o padrão de rota casado pelo Express, jamais a URL concreta. O teste unitário exercita todas as famílias e sua exposição, mas não promete detectar genericamente qualquer label nova de alta cardinalidade.

`wallet_lock_wait_seconds` observa **toda** tentativa de adquirir o `FOR UPDATE` da Wallet, inclusive a que termina em erro, sem limiar arbitrário de "contenção": uma espera longa e bem-sucedida fica na distribuição do histograma. `wallet_lock_conflicts_total` só incrementa quando o PostgreSQL recusou a aquisição, classificado por SQLSTATE — `55P03` é `lock_timeout` e `40P01` é `deadlock`.

Os três Gauges descrevem o último estado coletado e por isso não são lidos no scrape. Um coletor em background, `OperationalMetricsCollector`, inicia uma coleta ao subir e, depois, roda em todo processo a cada 15 s; consulta a outbox no PostgreSQL e a DLQ por `GetQueueAttributes` e escreve os valores no registry. Ler isso dentro do `collect()` do `prom-client` faria `GET /metrics` esperar por PostgreSQL e SQS naquele instante. Se uma coleta falha, o erro é logado, `/metrics` continua disponível e preserva a última amostra bem-sucedida; a freshness fica sem limite até a dependência voltar. Como os três Gauges são fatos globais reportados por todas as instâncias, a leitura correta em PromQL é `max by (...)`.

O contador de reconciliação existe porque o README §9 exige que divergência seja contabilizada em métrica, além de logada e sinalizada na resposta. Nada nesse caminho corrige saldo.

Liveness não consulta dependências. Readiness diferencia PostgreSQL e SQS para tornar a falha operacionalmente diagnosticável. Health e métricas respondem em qualquer papel, inclusive num processo sem `api`.

Ficam fora desta entrega, todos opcionais pelo README §12: OpenTelemetry e propagação de trace context, Collector, backend de traces, exemplars e dashboard. Nenhuma garantia financeira, de Inbox, ACK, lock ou Outbox depende de telemetria.

## 13. Estratégia de testes

O caminho principal é `docker-compose.test.yml` controlado por scripts Bun. PostgreSQL 16 e LocalStack são serviços reais em containers, e nenhuma suíte substitui os dois por mock. O schema é recriado por `migrate:fresh` antes de cada execução, e três processos reais são iniciados com `Bun.spawn` contra a mesma infraestrutura.

Os casos de uso rodam nos testes sob a **role de runtime** `wagering_app`, nunca sob a credencial de migration. A distinção importa: um `GRANT` de coluna que falte deixa de ser um defeito silencioso e vira falha de suíte. Só o que precisa de privilégio elevado — DDL das migrations, `DELETE` de fixture, adulteração deliberada do ledger — usa `wagering_migrator`.

Estado atual, executado: **178 testes de unidade, 144 de integração e 11 de concorrência**, com `bun run typecheck` limpo.

Testes de unidade cobrem Money, Wallet, state machine, todos os kinds, reversões da opção B, payloadHash, backoffs, envelope SQS, classificação de erro do PostgreSQL, exposição de métricas e o ponto de extensão de identidade. Integração real cobre migrations e constraints, atomicidade entre Wallet/Wager/ledger/Inbox/Outbox, contrato HTTP completo, SQS, pending worker, Outbox, reconciliação, papéis e logging. O conflito de moeda tem caso completo: BET USD contra Wallet BRL termina REJECTED/CURRENCY_MISMATCH com snapshot BRL, sem alterar saldo, version, updatedAt ou ledger.

Os testes de concorrência e crash usam paralelismo real, liberado por barreira explícita, nunca por sorte de escalonamento. Os cenários entregues são:

1. a mesma BET 50 vezes em paralelo: uma Wager, um débito e 49 replays;
2. duas BET de 80.00 sobre saldo 100.00: uma PROCESSED, uma REJECTED e saldo 20.00;
3. Wallets distintas em paralelo, hot wallet e três processos contra o mesmo banco;
4. Wallet travada por outra transação não bloqueia Wallet livre — não há lock global;
5. mensagens distintas para a mesma Wallet, cada uma em seu próprio MessageGroupId, com o lock mantido explicitamente até pelo menos dois workers disputarem a Wallet e com participação confirmada por instância;
6. worker morto entre o commit e o ACK, num processo real: redelivery barrada pela Inbox e efeito financeiro único;
7. restart dos três processos com requisições em voo: as mesmas identidades são reaplicadas nos processos novos, a quantidade exata de commits é consultada no banco e uma operação final é reconciliada; separadamente, a Outbox pendente deixada pelo worker morto é publicada por um publisher novo;
8. dois publishers concorrentes sobre a mesma Outbox, e linha travada que é pulada por SKIP LOCKED em vez de esperada;
9. REFUND entregue pela fila antes da BET que ele reverte, resolvido depois pelo worker de pendências;
10. rollback total: falha real de constraint e falha lançada depois das escritas, sem resíduo em Wallet, Wager, ledger, Inbox ou Outbox;
11. conflito de idempotência sob paralelismo real e reversões concorrentes sobre a mesma referência;
12. tentativas diretas de UPDATE/DELETE/TRUNCATE no ledger e violação direta de constraints por SQL.

Todo teste que movimenta saldo termina verificando:

    wallet.balance == saldo reconstruído pelo ledger
### 13.1 Teste de carga — diferencial opcional escolhido

`bun run test:load` combina k6 (geração HTTP e percentis) com um runner Bun (infraestrutura, produtor SQS, métricas e verificação SQL). Não importa `bun:test`, não roda nas suítes normais e não muda o domínio nem as opções de transação da aplicação. Requer k6 instalado no PATH; não usa extensões ou imports remotos no script de carga.

No modo padrão, `docker-compose.load.yml` mantém PostgreSQL/LocalStack separados das stacks de desenvolvimento e testes normais. Três processos Bun usam todos os papéis, com a mesma role runtime. A credencial de migration aparece somente na aplicação de migrations pendentes. Cada execução cria identidades novas e preserva os históricos; os artefatos registram a quantidade de transações que já existia antes da carga. A configuração e o procedimento para reiniciar com banco vazio estão no README.

Os cinco perfis têm, por padrão, 12 VUs constantes durante 30 s cada, sem think time:

1. **Distribuído:** cada VU possui sua wallet e envia BETs únicas; requisições alternam entre as três instâncias. A separação evita contenção artificial entre VUs. Antes do benchmark, um probe mantém uma wallet travada, verifica a dependência por `pg_blocking_pids` e exige que outra wallet avance enquanto a primeira operação continua bloqueada.
2. **Hot wallet:** mesma operação e concorrência do distribuído, mas todos os VUs disputam uma única wallet. Espera de lock e latência são medidas sem reduzir lock timeout ou mudar regras financeiras.
3. **Idempotência:** todos enviam a mesma key/payload desde a primeira corrida. Cada VU compara suas respostas com a transação canônica persistida. O fechamento exige uma criação, os demais replays, um débito e um par de eventos financeiro/Wallet.
4. **Escasso:** uma wallet aberta com `5.00 BRL` e ciclo BET/BET/WIN, todos os VUs sobre ela. O ciclo drena mais do que credita, então o saldo cai à fronteira em segundos e permanece nela: o excedente vira `REJECTED` com `INSUFFICIENT_FUNDS` sob a mesma contenção de lock, sem lançamento e sem alterar saldo. É o perfil que exercita a decisão de débito no ponto onde uma race produziria saldo negativo ou débito duplicado; o mínimo histórico de `balance_after` é a evidência direta. O perfil reprova se nenhuma rejeição ou nenhum débito ocorrer.
5. **Misto:** sequência BET/BET/WIN/LOSS (50/25/25% em ciclos completos) em várias wallets, com 5 operações SQS/s simultâneas usando os mesmos kinds. IDs de grupo distintos permitem disputa entre workers; a cada cinco operações há uma reentrega autoral com outro deduplication ID do broker para exercitar Inbox. A distribuição realizada e o volume SQS estão no relatório.

Cada operação vale `1.00 BRL` e a abertura é `1000000000.00 BRL`, exceto no perfil escasso; o saldo elevado evita medir rejeições por falta de saldo onde a intenção é medir processamento. Money permanece string; somas, reconstrução líquida e mínimos históricos são calculados no PostgreSQL. A validação cruza contagens aceitas e recusadas pelo k6 e envelopes SQS com transações persistidas, verifica hashes/identidades, estado terminal, correspondência e cardinalidade dos lançamentos, versão, saldo, Inbox e os tipos/quantidades de eventos esperados; uma transação `REJECTED` precisa carregar `failureCode`, não ter lançamento e emitir exatamente um `WagerTransactionRejected`. Após a carga, há um limite explícito de drain (180 s por padrão): Outbox pendente, claim residual ou entrada ainda em voo reprovam o cenário.

O runner salva ambiente e configuração, versão k6/Bun/PostgreSQL, containers ativos, requests totais, throughput, taxa de erro, p50/p95/p99 e duração separada de carga e drain, e com esses dados renderiza `test/load/RESULTS.md`: método e limitações são texto fixo, todo número e toda comparação saem do run, e uma execução reprovada sobrescreve o arquivo com o próprio fracasso em vez de deixar os números anteriores no lugar. A separação existe para que a análise nunca contradiga o artefato — no desenvolvimento deste relatório uma frase interpretativa fixa foi invalidada pelos dados de uma execução, e comparações desse tipo passaram a ser calculadas e condicionais. Salva scrapes por instância antes/depois e a cada 2 s, além de backlog/idade e espera por locks amostrados no PostgreSQL, com o pico de `outbox_oldest_pending_age_seconds` do perfil no relatório. Essa amostragem tem custo: a consulta roda a cada 2 s durante a carga e a cada 200 ms durante o drain, na mesma instância que os publishers usam, e está dentro das durações reportadas — o índice parcial `outbox_pending_ix` a limita ao conjunto pendente, mas o custo não foi isolado. Counters/histogramas usam deltas somados entre instâncias; gauges globais permanecem nos scrapes por instância e não são somados. O p95 de lock derivado do histograma é reportado como limite superior do bucket, não como percentil exato. A freshness dos gauges continua sujeita ao collector de 15 s e suas falhas.

Zero erro de contrato/HTTP e checks válidos são thresholds obrigatórios; erros, inclusive timeouts, entram nos percentis e não são escondidos por retry do gerador. `LOAD_P95_MS` permite uma meta de latência explicitamente escolhida pelo operador. Não existe meta de RPS do challenge. Esse modelo fechado reduz a taxa quando o servidor demora e não mede capacidade sob taxa de chegada aberta. Não há tracing nem suspensão artificial de publisher. O backlog de mensagens já publicadas na fila de eventos é esperado: o produto não tem consumidor downstream dessa fila. Ele não equivale a Outbox não publicada, mas não é inócuo para o experimento — acumulado ao longo de várias execuções, o broker responde mais devagar a `SendMessage` e o drain da Outbox degrada até estourar seu limite. Por isso o runner purga essa fila no modo gerenciado, e a comparação entre execuções deixa de piorar monotonicamente.

## 14. Limitações e escolhas explícitas

- A saída é at-least-once; consumidores deduplicam eventId, e publishers concorrentes podem inverter a ordem de ocorrência.
- Retry bloqueia o grupo FIFO da Wallet; uma falha prolongada pode levar mensagem válida à DLQ e exigir redrive.
- messageId globalmente único é obrigação do produtor; crash entre send da DLQ e delete da origem ainda pode duplicar a mensagem.
- numeric(20,2) tem teto finito, e a reconciliação síncrona cresce com o histórico do ledger.
- Inbox e Outbox crescem indefinidamente: como a role de runtime não tem DELETE, qualquer purga exige a credencial de manutenção, e a política de retenção fica fora desta entrega.
- Triggers e privilégios protegem a role da aplicação, não uma credencial de migration ou superuser.
- Autenticação funcional foi omitida. `ProviderIdentityPort` existe e está no caminho da submissão HTTP, mas o adapter atual confia na identidade declarada: qualquer chamador pode afirmar qualquer `providerId`.
- OpenTelemetry não foi implementado; `bun run test:load` mede HTTP, SQL e Prometheus sem traces.
- Os três Gauges operacionais são amostrados a cada 15 s por processo e aparecem repetidos por instância. Depois de uma falha de coleta, a última amostra permanece exposta sem garantia de freshness até uma coleta voltar a funcionar.
- A opção B permite REFUND e ROLLBACK diretos sobre a mesma referência, inclusive dois créditos sobre uma BET.
- Uma referência opcional de WIN que ainda não existe não transforma a operação em PENDING_REFERENCE.
- O gerador e a aplicação compartilham a máquina no setup local; contenção com Docker e outros processos influencia os números. O relatório registra esse ambiente, sem convertê-lo em promessa de capacidade.
- Resultados do teste de carga valem para o ambiente e workload documentados, não como promessa geral de capacidade.
