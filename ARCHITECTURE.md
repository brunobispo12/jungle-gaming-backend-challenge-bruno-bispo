# Architecture

Este documento descreve o desenho pretendido para o serviço antes da implementação. As escolhas abaixo priorizam correção financeira sob duplicação, entrega fora de ordem, concorrência entre processos e falhas entre commit, publicação e ACK.

A stack será Bun 1.x como runtime, package manager e test runner; TypeScript strict; NestJS; PostgreSQL; MikroORM; AWS SQS com LocalStack; e Docker Compose.

## 1. Escopo e prioridades

O serviço receberá operações de apostas por HTTP e SQS, manterá o saldo materializado de cada Wallet, registrará toda movimentação em um ledger imutável e publicará eventos de integração por Transactional Outbox.

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

Ficam fora desta entrega autenticação funcional, double-entry bookkeeping, correção automática de divergências, exactly-once e ordenação global de eventos. Também não entram CQRS, CommandBus, repositórios genéricos, ClickHouse nem dashboards elaborados. OpenTelemetry entra somente para tracing e correlação de contexto; logs continuam em stdout.

ProviderIdentityPort será o único ponto de extensão de autenticação, inicialmente com um adapter no-op. Uma evolução usaria OAuth2 client credentials e validaria o provider_id do token contra o corpo. Health checks continuam públicos; a entrada SQS é interna, mas seus dados ainda passam pelas mesmas validações de domínio.

## 2. Topologia

O mesmo caso de uso financeiro será chamado pelas duas entradas:

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

Um único binário suportará os papéis api, consumer, pending-worker e outbox-publisher por configuração. Docker Compose poderá iniciar três ou mais processos com todos os papéis. O desenho é multi-instance; nenhum papel precisa ser singleton: Inbox, unique indexes, row locks, SKIP LOCKED e leases coordenam instâncias concorrentes.

A indisponibilidade de um papel afeta disponibilidade ou latência, não muda a regra de correção. O estado necessário para recuperar trabalho fica no PostgreSQL ou no SQS, nunca apenas em memória do processo.

O código será separado em domain, application, infrastructure, interface e bootstrap. As portas serão WalletRepository, WagerTransactionRepository, LedgerRepository, InboxRepository, OutboxRepository, UnitOfWork, EventPublisher, IdGenerator, Clock, MetricsPort e ProviderIdentityPort; não haverá abstrações genéricas para operações que o domínio já nomeia melhor.

## 3. Money e domínio

As classes de domínio terão construtor privado ou protegido e estado encapsulado. Factories como create/from validam uma criação ou transição nova; rehydrate apenas recompõe o estado já validado e persistido, sem repetir regras de transição. Não haverá setters públicos para contornar Wallet, WagerTransaction ou WalletLedgerEntry.

### 3.1 Money sem ponto flutuante

Money será imutável e guardará um Decimal de decimal.js com precisão 34. O caminho completo será `decimal string → Money(Decimal) → persistence row string → MikroORM DecimalType('string') → PostgreSQL numeric(20,2)`; a leitura faz o caminho inverso. Nenhuma etapa usa Number, parseFloat, coerção unária, float ou double.

Nos contratos de entrada, 25, 25.0 e 25.00 serão normalizados para 25.00 antes do payloadHash. Notação científica, NaN, Infinity, string vazia, mais de duas casas, valores negativos e valores acima de 999999999999999999.99 serão rejeitados. Money pode representar zero e valores negativos produzidos internamente por `negate`, como a diferença de reconciliação; initialBalance admite zero. O contrato de Wager exige amount maior que zero e rejeita `0.00` com AMOUNT_NOT_POSITIVE antes da reserva. Não existe arredondamento silencioso.

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

PROCESSED, REJECTED e FAILED são terminais. processedAt existe exatamente nesses estados. Um trigger deverá rejeitar UPDATE ou DELETE de uma linha que já estava terminal.

FAILED terá uso restrito: somente uma falha determinística e permanente ao processar uma PENDING_REFERENCE já persistida, com PostgreSQL funcional. Timeout, deadlock, conexão caída ou SQS indisponível são transitórios e não geram FAILED. Não haverá evento de integração para FAILED.

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

WIN não passa a exigir referência. Se uma referência opcional for resolvida, deverá ser validada. Se o identificador opcional ainda não existir, o WIN será processado sem vínculo interno, com log e métrica dessa escolha.

### 3.5 Reversões — opção B

REFUND e ROLLBACK exigem referenceExternalTransactionId. A referência será resolvida por providerId e externalTransactionId e deverá coincidir em provider, player, Wallet, moeda e rodada. O valor precisa ser exatamente igual em magnitude; reversão parcial está fora de escopo.

REFUND referencia apenas BET PROCESSED. ROLLBACK referencia BET, WIN ou REFUND PROCESSED. ROLLBACK de BET produz crédito; ROLLBACK de WIN ou REFUND produz débito e será REJECTED com REVERSAL_WOULD_OVERDRAW se deixar saldo negativo.

Adoto a opção B como interpretação candidata da frase “uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação”:

- uma referência pode ter no máximo um REFUND PROCESSED;
- a mesma referência pode ter no máximo um ROLLBACK PROCESSED;
- o banco impedirá repetição do mesmo kind;
- REFUND e ROLLBACK podem referenciar diretamente a mesma transação.

A constraint correspondente será:

    UNIQUE (reference_transaction_id, kind)
    WHERE status = 'PROCESSED'
      AND kind IN ('REFUND', 'ROLLBACK')

Portanto, BET → REFUND(BET) → ROLLBACK(BET) é aceito e pode gerar dois créditos. Essa consequência será mantida explícita porque é o custo da leitura textualmente mais próxima do enunciado. Não há cascata: reverter REFUND não reabre BET, e reverter BET não altera WIN.

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

Escolhi MikroORM porque seu Unit of Work, Identity Map e suporte a transações/locks deixam explícita a fronteira que importa neste desafio. EntitySchema mapeará persistence rows POJO; mappers dedicados farão domínio ↔ persistência. Assim Money, Wallet e WagerTransaction não recebem decorators do ORM ou do NestJS. Cada requisição, mensagem ou iteração de worker usa um EntityManager forkado.

Reservas com ON CONFLICT, row locks e claims podem usar QueryBuilder ou SQL encapsulado nos repositórios quando a operação precisa acontecer imediatamente, sem depender do flush tardio do Unit of Work. O custo é algum código de mapeamento, aceito para não acoplar as invariantes do domínio ao formato das tabelas.

Migrations serão versionadas, terão up/down e rodarão com uma credencial separada. A role da aplicação terá apenas os privilégios necessários ao runtime. Todas as constraints terão nomes estáveis, usados para classificar um SQLSTATE 23505 residual.

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

WagerTransaction não terá FK simples obrigatória de wallet_id para permitir que WALLET_NOT_FOUND permaneça auditável. A FK composta com result_balance_currency é ignorada pelo MATCH SIMPLE quando o snapshot é nulo e valida a Wallet quando ele existe. Toda WalletLedgerEntry, que representa efeito financeiro real, terá FK para Wallet e WagerTransaction.

A igualdade entre Wallet.balance e a soma do ledger atravessa linhas e tabelas, portanto não cabe em um CHECK local. Ela será protegida pela transação financeira única, pelo lançamento criado pela própria Wallet e pela reconciliação.

A reversão de uma migration é operação sobre schema, não um caminho runtime para apagar ledger. A role da aplicação não recebe DELETE nas tabelas financeiras/auditáveis e só atualiza as colunas mutáveis de cada lifecycle. Em wallet_ledger_entry, não recebe UPDATE, DELETE nem TRUNCATE; manutenção destrutiva exige a credencial separada de migration/operação.

IDs de Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage e eventId serão UUID v7 gerados por IdGenerator. O desenho usa sua unicidade, não supõe ordem temporal pelo UUID.

## 5. Fronteira transacional e concorrência

Operações financeiras normais usarão READ COMMITTED. Esse nível permite que uma nova consulta após o INSERT concorrente veja a transação vencedora, enquanto o row lock da Wallet serializa o saldo. Em READ COMMITTED o próprio `SELECT … FOR UPDATE` reavalia a linha quando o bloqueio termina e devolve a versão que a vencedora commitou: por isso, no cenário obrigatório, a segunda BET lê `20.00` e não os `100.00` visíveis no início da sua transação. É esse comportamento — não a coluna `version` — que elimina o lost update.

Escolhi lock pessimista porque o cenário central é contenção sobre um saldo mutável. Dentro da transação, a implementação executará um único SELECT … FOR UPDATE bloqueante na Wallet. Não haverá probe não bloqueante seguido de retry, nem comparação otimista por version.

Cada entrada limitará o lock abaixo do próprio prazo. No SQS, lock_timeout não excederá 20 s e o orçamento total da transação será de até 45 s, deixando margem no VisibilityTimeout de 60 s para finalizar e enviar ACK. No HTTP, lock e transação terminarão antes do timeout da requisição. Timeout, deadlock e indisponibilidade causam rollback e são classificados como transitórios.

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

A ordem será:

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

O business payloadHash será SHA-256 hexadecimal de JSON canônico, com chaves ordenadas por code unit, campos ausentes omitidos e Money já normalizado. Participam providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId quando presente.

Idempotency-Key e metadados de transporte não participam. Assim HTTP e SQS produzem o mesmo hash para o mesmo fato.

### 6.2 Algoritmo da primeira submissão

1. Validar o contrato, normalizar Money e calcular payloadHash.
2. No HTTP, consultar providerId+idempotencyKey antes da transação e devolver replay/conflito quando já existir.
3. Iniciar READ COMMITTED; no SQS, reservar a Inbox antes de qualquer consulta de negócio.
4. Inserir WagerTransaction em PENDING com INSERT … ON CONFLICT DO NOTHING RETURNING.
5. Se não inseriu, executar uma nova consulta em READ COMMITTED:
   - procurar providerId+idempotencyKey;
   - hash igual: replay;
   - hash divergente: IDEMPOTENCY_KEY_CONFLICT;
   - sem key, procurar providerId+externalTransactionId;
   - external existente: EXTERNAL_TRANSACTION_ID_REUSED;
   - nada encontrado: erro transitório anômalo e alerta.
6. Somente quem inseriu trava a Wallet.
7. Resolver referência, decidir o resultado e persistir saldo, ledger, resultBalance e Outbox quando aplicáveis.
8. Sair de PENDING para PROCESSED, REJECTED ou PENDING_REFERENCE; no SQS, marcar a Inbox processada.
9. Commit; só depois responder ou enviar ACK.

O INSERT concorrente espera a decisão da unique index. Se a vencedora commitar, a consulta seguinte a enxerga; se abortar, uma concorrente assume a inserção. Em 50 requisições idênticas, uma única transação toca a Wallet.

Corridas esperadas não usarão SQLSTATE 23505 como controle normal. Um 23505 residual aborta e é classificado por constraint_name depois do rollback: idempotência/identidade viram leitura limpa e replay/conflito; Wallet vira WALLET_ALREADY_EXISTS; ledger, eventId, reversão inesperada ou nome desconhecido geram alerta e erro seguro, sem repetir efeito financeiro.

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

consumerName será wager-transactions-consumer. messageId é o campo autoral do envelope; broker MessageId será guardado apenas para diagnóstico. O contrato assume que messageId é globalmente único dentro desse consumidor lógico.

O inboxPayloadHash é diferente do business payloadHash. Ele cobre type, occurredAt e data completa já canonizada, incluindo idempotencyKey, e exclui metadata do broker.

Ao consumir:

1. validar JSON, messageId, type, occurredAt e data;
2. calcular rawBodyHash, inboxPayloadHash e business payloadHash;
3. iniciar transação;
4. reservar Inbox com INSERT … ON CONFLICT DO NOTHING RETURNING;
5. se perdeu:
   - mesmo hash e processedAt preenchido: redelivery, sem efeito;
   - hash divergente: erro permanente, sem chegar ao caso de uso;
   - processedAt ausente: estado anômalo, rollback e alerta;
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
| Unknown | exceção não classificada | rollback | transient + alerta |

Para erro permanente descoberto depois de reservar Inbox, a transação será revertida antes do envio à DLQ. O SendMessage para wager-transactions-dlq.fifo precede o DeleteMessage da origem.

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

O consumer aplicará ChangeMessageVisibility e não apagará a mensagem. Uma mensagem em retry bloqueia temporariamente outras do mesmo walletId; grupos de outras Wallets continuam avançando. Uma indisponibilidade longa pode levar uma mensagem válida à DLQ após cinco recebimentos, exigindo alarme e redrive operacional.

O consumer é ativado apenas nas instâncias configuradas para o papel de worker. Durante o graceful shutdown, deixa de buscar novas mensagens, aguarda até 25 s pelos itens em processamento e reserva a janela restante até 30 s para devolver imediatamente a visibilidade dos itens que não concluíram. Mensagens recebidas em lote que ainda não iniciaram processamento também têm a visibilidade devolvida, evitando mantê-las indisponíveis durante o drain. O que não commitou não é marcado como processado.

## 8. Pending references e reversões

Para REFUND ou ROLLBACK, referência ausente significa que referenceExternalTransactionId foi fornecido, mas a transação ainda não existe. WIN mantém a escolha da seção 3.4: sua referência é opcional e, se ainda não existir, segue sem vínculo interno.

Na submissão, a transação reserva a Wager, trava a Wallet e grava PENDING_REFERENCE com attempts=0, expiresAt=createdAt+6h, primeira tentativa em aproximadamente 5 s e resultBalance do aceite. O evento WagerTransactionPendingReference entra na mesma Outbox; depois do commit, HTTP responde 202 ou o consumer envia ACK.

Cada instância executará ticks de 5 s, sem líder. Uma iteração:

1. abre transação e seleciona uma Wager elegível por nextAttemptAt/id com FOR UPDATE SKIP LOCKED LIMIT 1;
2. mantém esse row lock até o commit;
3. se a referência continuar ausente, incrementa attempts e reagenda; ao atingir 6 h ou 100 tentativas, trava a Wallet e relê a referência. Se ela apareceu durante a espera, segue o processamento normal; somente se ainda estiver ausente atualiza o snapshot e conclui como REJECTED/REFERENCE_NOT_FOUND com evento;
4. se a referência existir, trava a Wallet, relê e valida status, kind, provider, player, Wallet, moeda, rodada, magnitude e reversão anterior do mesmo kind;
5. processa ou rejeita, atualiza resultBalance, cria ledger e eventos quando aplicável e commita.

Após uma busca ausente, o atraso será:

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

Não existe limite terminal para um evento confirmado. attempts serve para telemetria e backoff; o item continua elegível até publicação. Outbox lag crescente gera alerta.

O token do claim é o INSTANCE_ID do processo, o mesmo que identifica a instância nos logs, então uma linha ainda travada aponta para quem a segurava.

O laço reclama uma mensagem por vez. Depois de publicar tenta a próxima imediatamente; sem nada elegível espera 500 ms; depois de um erro inesperado espera 2 s. O desligamento interrompe a espera ociosa em vez de aguardá-la, e o envio em andamento termina antes de o processo sair. Só a instância com o papel outbox-publisher roda o laço, e só o papel api abre porta HTTP; os demais carregam o mesmo binário sem iniciar o laço.

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

A fila de saída será wager-events.fifo. MessageDeduplicationId será eventId. MessageGroupId seguirá aggregateId: transactionId nos eventos da Wager e walletId em WalletBalanceChanged.

Eventos mínimos:

| Evento | Quando | aggregateId | Dados principais |
|---|---|---|---|
| WagerTransactionProcessed | qualquer operação aplicada, inclusive OPENING e LOSS | transactionId | identificação da Wager/provider/Wallet, player, round, game, kind, money, processedAt e referência opcional |
| WagerTransactionRejected | regra de negócio, inclusive expiração de pending | transactionId | identificação da Wager/provider/Wallet, kind, money, failureCode e processedAt |
| WagerTransactionPendingReference | referência ainda ausente | transactionId | identificação da Wager/provider/Wallet, kind, referência externa e money |
| WalletBalanceChanged | somente quando balance muda | walletId | transactionId, direction, money, balanceBefore, balanceAfter e walletVersion |

IntegrationEvent<T> será uma classe abstrata que concentra eventId, aggregateId, correlationId, causationId, occurredAt, data e toJSON. Cada evento da tabela será uma subclasse concreta; eventType e version pertencem ao tipo, não a strings soltas no call site.

Os payloads usam MoneyProps, nunca a instância Money. Cada tipo começa em version 1; mudança aditiva preserva versão e mudança incompatível cria nova versão coexistente.

HTTP usa X-Correlation-Id válido ou gera um; causationId é o request ID. SQS deriva correlationId deterministicamente de consumerName+messageId e usa messageId como causationId. O pending worker herda o correlationId persistido.

## 10. Contrato HTTP

O contrato distingue erro de protocolo de resultado de negócio:

| Resultado | HTTP | Persistência |
|---|---:|---|
| Payload/header inválido | 400 | nada |
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

O cursor do ledger será base64url opaco de createdAt+id. A busca usa keyset por (created_at,id) descendente e não depende da ordenação do UUID v7. limit tem default 50, mínimo 1 e máximo 200.

A página de ledger terá items, nextCursor e hasMore. As consultas de Wager devolverão uma TransactionView com status, failureCode e resultBalance persistidos.

GET /health/live verifica somente processo. GET /health/ready verifica PostgreSQL e SQS separadamente e retorna 200 ou 503. Ambos são públicos.

## 11. Reconciliação

Wallet.balance é o saldo materializado para processamento rápido; wallet_ledger_entry é a trilha auditável.

POST /wallets/:walletId/reconciliation abrirá:

    BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY

No mesmo snapshot, a consulta lerá o saldo da Wallet e calculará:

    COALESCE(SUM(CASE
      WHEN direction = 'CREDIT' THEN amount
      WHEN direction = 'DEBIT'  THEN -amount
    END), 0.00)

O COALESCE é necessário porque uma Wallet aberta com saldo zero não possui OPENING nem ledger; o saldo reconstruído nesse caso é 0.00, não NULL.

A resposta contém storedBalance, calculatedBalance, difference, consistent e checkedEntries. Wallet inexistente retorna 404. Wallet existente retorna 200 mesmo quando há divergência.

Reconciliação nunca atualiza saldo ou ledger. Reparar automaticamente esconderia o defeito e exigiria escolher uma fonte como correta sem contexto operacional. Uma diferença gera resposta explícita, log e métrica. O custo cresce linearmente com o histórico da Wallet; não haverá snapshot incremental nesta entrega.

## 12. Observabilidade

O desenho separa três sinais porque eles respondem a perguntas diferentes:

| Sinal | Responsabilidade |
|---|---|
| JSON logs em stdout | eventos discretos e erros classificados |
| Prometheus em GET /metrics | comportamento agregado e alertas |
| OpenTelemetry traces | caminho e latência de uma execução individual |

Logs carregarão correlationId e, quando existirem, messageId, transactionId, walletId e providerId. Com um span ativo, também receberão traceId e spanId. Assim um erro encontrado no log leva ao trace correspondente sem trocar o backend de logs. Payload financeiro completo, amount, balance, credenciais e dados sensíveis ficam de fora.

Os três identificadores de correlação têm papéis distintos:

- correlationId é controlado pela aplicação e acompanha a operação de negócio;
- traceId/spanId pertencem ao contexto técnico do OpenTelemetry;
- causationId identifica a causa imediata de um IntegrationEvent.

Nenhum deles substitui messageId, a chave da Inbox ou a Idempotency-Key. HTTP aceita ou gera correlationId e abre o contexto do request. SQS transporta trace context em message attributes quando presente, preservando o envelope da aplicação. Em saltos duráveis, como Outbox e pending reference, traceparent/tracestate podem ser persistidos como metadata técnica nullable junto ao trabalho, fora do payloadHash e do contrato financeiro. O publisher liga seu span ao contexto armazenado e injeta o contexto atual nos attributes da mensagem de saída; outros workers criam spans ou links quando o contexto é válido e iniciam novo trace quando ele não existe. Processar nunca depende dessa metadata.

A topologia de tracing será:

    Application
    ├─ JSON logs ───────────────→ stdout
    ├─ Prometheus metrics ──────→ GET /metrics
    └─ OpenTelemetry SDK ─OTLP─→ OpenTelemetry Collector ─→ trace backend

O Collector delimita a aplicação do armazenamento. Um backend local leve, como Jaeger, pode ser escolhido na implementação, mas não faz parte do contrato nem da correção do serviço. Não haverá ClickHouse, export obrigatório de logs pelo OTel, substituição de Prometheus por OTel Metrics ou dashboard elaborado nesta entrega.

Auto-instrumentação padrão será preferida, quando madura e compatível, para HTTP server/client, PostgreSQL e AWS SDK/SQS. Instrumentação manual fica restrita aos limites que explicam o desafio: wager.submit, idempotency.reserve, wallet.lock, inbox.process, pending_reference.process, outbox.publish e reconciliation. Não vale duplicar cada span de infraestrutura nem instrumentar cada função do ORM.

Os spans podem ter wager.kind, wager.source, wager.status, idempotent_replay, transaction.id, wallet.id, message.id e outbox.event_type. IDs de alta cardinalidade ajudam numa execução individual, mas nunca viram labels Prometheus.

GET /metrics exporá métricas Prometheus com labels fechadas: requisições e latência HTTP; transações por status/kind/origem e duplicatas; latência, retries e DLQ do SQS; tentativas de pending; tentativas, duração, quantidade e idade da Outbox; e reconciliação. `wallet_lock_wait_seconds` observa toda tentativa de adquirir o `FOR UPDATE`, inclusive a espera que termina em falha; `wallet_lock_conflicts_total{reason="lock_timeout"|"deadlock"}` conta falhas classificadas pelo PostgreSQL. Aquisições que esperaram e tiveram sucesso ficam na distribuição do histograma, sem um limiar arbitrário de “contenção”. A DLQ expõe `sqs_dlq_visible_messages` a partir dos atributos da fila e `sqs_dlq_routed_total{reason}` para roteamentos diretos. Outbox pending e lag serão lidos do PostgreSQL no scrape ou por coletor independente do publisher, para continuarem visíveis quando a publicação parar.

Sampling de traces será configurável. Desenvolvimento pode usar amostragem alta; runtime normal usa uma razão definida; todo teste de carga registra a configuração. Um benchmark pesado não será automaticamente traçado a 100%, porque a telemetria também custa CPU, rede e armazenamento. É válido comparar uma execução diagnóstica com tracing e outra com amostragem menor, desde que a metodologia não misture os resultados.

Exemplars ligando histogramas de latência HTTP, espera de Wallet lock ou publicação da Outbox a um trace são uma melhoria opcional. Só entram se a integração escolhida os fornecer sem redesenhar as métricas.

Liveness não consulta dependências. Readiness diferencia PostgreSQL e SQS para tornar a falha operacionalmente diagnosticável. Se SDK, Collector ou backend de traces estiverem indisponíveis, todas as garantias financeiras, de Inbox, ACK, locks e Outbox permanecem iguais.

## 13. Estratégia de testes

O caminho principal será docker-compose.test.yml controlado por scripts Bun. PostgreSQL 16 e LocalStack serão serviços reais em containers. O estado deverá ser isolado ou resetado deterministicamente entre suítes. Três processos reais serão iniciados com Bun.spawn contra a mesma infraestrutura.

Nenhum resultado é declarado agora; estes são comportamentos que os testes deverão comprovar.

Testes de unidade cobrirão Money, Wallet, state machine, todos os kinds, reversões da opção B e payloadHash. Integração real cobrirá migrations e constraints, atomicidade entre Wallet/Wager/ledger/Inbox/Outbox, contrato HTTP, SQS, pending worker, Outbox e reconciliação. O conflito de moeda terá um caso completo: BET USD contra Wallet BRL termina REJECTED/CURRENCY_MISMATCH com snapshot BRL, sem alterar saldo, version, updatedAt ou ledger.

Os testes de concorrência e crash usarão paralelismo real, não mocks sequenciais. Os cenários centrais serão:

1. a mesma BET 50 vezes em paralelo: uma Wager e um débito;
2. duas BET de 80.00 sobre saldo 100.00: uma PROCESSED, uma REJECTED e saldo 20.00;
3. Wallets distintas em paralelo e três processos contra o mesmo banco;
4. a mesma operação por HTTP e SQS, incluindo redelivery idêntica e Inbox divergente;
5. crash antes do commit, depois do commit HTTP e depois do commit SQS antes do ACK;
6. REFUND/ROLLBACK antes da referência, referência confirmada durante a decisão de expiração, dois pending workers e reversões concorrentes;
7. dois publishers, crash após claim e crash após publish antes de publishedAt;
8. PostgreSQL/SQS indisponíveis e restart com estado pendente;
9. tentativas diretas de UPDATE/DELETE no ledger e constraints violadas;
10. reconciliação durante atividade concorrente.

Todo teste financeiro termina verificando:

    wallet.balance == saldo reconstruído pelo ledger

### 13.1 Teste de carga — diferencial opcional escolhido

O desafio não exige teste de carga nem define meta de RPS, mas esta entrega implementará o diferencial com k6 por:

    bun run test:load

O objetivo é produzir um experimento reproduzível e explicar o resultado, não maximizar um número isolado. O relatório registrará máquina/ambiente, quantidade de processos da aplicação, topologias de PostgreSQL e LocalStack/SQS, configuração do gerador, duração, VUs/concorrência, perfil do workload e razão de sampling OpenTelemetry.

Serão quatro cenários:

1. **Carga distribuída:** pelo menos três processos, muitas Wallets, mix realista e percentual controlado de replay. Mede concorrência entre agregados independentes.
2. **Hot Wallet:** muitas operações disputam uma Wallet. O resultado esperado é maior wallet-lock wait, maior latência e menor throughput daquela Wallet, porque o desenho prefere serializar decisões de saldo a usar estado obsoleto.
3. **Duplicate storm:** muitas submissões representam o mesmo fato. Deve existir uma aplicação financeira e uma WalletLedgerEntry; as demais respostas são replay.
4. **Pressão e recuperação da Outbox:** tráfego financeiro sustentado acompanha backlog e idade. Uma suspensão temporária do publisher pode ser usada; eventos confirmados permanecem persistidos e a publicação volta a drenar depois da recuperação. Duplicatas continuam possíveis pela semântica at-least-once.

A análise separará quatro camadas:

- cliente: throughput, p50, p95, p99 e taxa de erro;
- Prometheus: lock wait, timeouts/conflitos, outcomes, replay, retries, outbox_pending_messages, outbox_oldest_pending_age_seconds e duração de publish;
- traces: poucas amostras para explicar cauda de latência, contenção, replay e publicação, sem tratá-las como fonte das métricas agregadas;
- correção: reconciliação após cada experimento significativo, busca por Wallet negativa, efeito financeiro duplicado e evento confirmado silenciosamente abandonado.

Não haverá limiar artificial de sucesso em RPS. O relatório explicará gargalos e o overhead da configuração de tracing usada. Velocidade só conta depois de preservadas as invariantes financeiras.

## 14. Limitações e escolhas explícitas

- A saída é at-least-once; consumidores deduplicam eventId, e publishers concorrentes podem inverter a ordem de ocorrência.
- Retry bloqueia o grupo FIFO da Wallet; uma falha prolongada pode levar mensagem válida à DLQ e exigir redrive.
- messageId globalmente único é obrigação do produtor; crash entre send da DLQ e delete da origem ainda pode duplicar a mensagem.
- numeric(20,2) tem teto finito, e a reconciliação síncrona cresce com o histórico do ledger.
- Inbox e Outbox crescem indefinidamente: como a role de runtime não tem DELETE, qualquer purga exige a credencial de manutenção, e a política de retenção fica fora desta entrega.
- Triggers e privilégios protegem a role da aplicação, não uma credencial de migration ou superuser.
- Autenticação funcional foi omitida e ficou atrás de ProviderIdentityPort.
- A opção B permite REFUND e ROLLBACK diretos sobre a mesma referência, inclusive dois créditos sobre uma BET.
- Uma referência opcional de WIN que ainda não existe não transforma a operação em PENDING_REFERENCE.
- Tracing adiciona overhead e mostra apenas a amostra definida; toda análise de carga precisa declarar essa configuração.
- Resultados do teste de carga valem para o ambiente e workload documentados, não como promessa geral de capacidade.
