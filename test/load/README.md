# Teste de carga — método

Este arquivo descreve o que `bun run test:load` mede, como mede e o que a validação confere depois de cada perfil. Os comandos, as variáveis de ambiente e o modo de stack externa estão no [`README.md`](../../README.md) da raiz; a escolha do teste de carga como diferencial está no [`ARCHITECTURE.md` §14.1](../../ARCHITECTURE.md#141-teste-de-carga--diferencial-opcional-escolhido); os números da última execução estão em [`RESULTS.md`](RESULTS.md), gerado pelo runner.

`bun run test:load` combina k6 (geração HTTP e percentis) com um runner Bun (infraestrutura, produtor SQS, métricas e verificação SQL). Não importa `bun:test`, não roda nas suítes normais e não muda o domínio nem as opções de transação da aplicação. Requer k6 instalado no PATH; não usa extensões ou imports remotos no script de carga.

No modo padrão, `docker-compose.load.yml` mantém PostgreSQL/LocalStack separados das stacks de desenvolvimento e testes normais. Três processos Bun usam todos os papéis, com a mesma role runtime. A credencial de migration aparece somente na aplicação de migrations pendentes. Cada execução cria identidades novas e preserva os históricos; os artefatos registram a quantidade de transações que já existia antes da carga. A configuração e o procedimento para reiniciar com banco vazio estão no README da raiz.

## Perfis

Os cinco perfis têm, por padrão, 12 VUs constantes durante 30 s cada, sem think time:

1. **Distribuído:** cada VU possui sua wallet e envia BETs únicas; requisições alternam entre as três instâncias. A separação evita contenção artificial entre VUs. Antes do benchmark, um probe mantém uma wallet travada, verifica a dependência por `pg_blocking_pids` e exige que outra wallet avance enquanto a primeira operação continua bloqueada.
2. **Hot wallet:** mesma operação e concorrência do distribuído, mas todos os VUs disputam uma única wallet. Espera de lock e latência são medidas sem reduzir lock timeout ou mudar regras financeiras.
3. **Idempotência:** todos enviam a mesma key/payload desde a primeira corrida. Cada VU compara suas respostas com a transação canônica persistida. O fechamento exige uma criação, os demais replays, um débito e um par de eventos financeiro/Wallet.
4. **Escasso:** uma wallet aberta com `5.00 BRL` e ciclo BET/BET/WIN, todos os VUs sobre ela. O ciclo drena mais do que credita, então o saldo cai à fronteira em segundos e permanece nela: o excedente vira `REJECTED` com `INSUFFICIENT_FUNDS` sob a mesma contenção de lock, sem lançamento e sem alterar saldo. É o perfil que exercita a decisão de débito no ponto onde uma race produziria saldo negativo ou débito duplicado; o mínimo histórico de `balance_after` é a evidência direta. O perfil reprova se nenhuma rejeição ou nenhum débito ocorrer.
5. **Misto:** sequência BET/BET/WIN/LOSS (50/25/25% em ciclos completos) em várias wallets, com 5 operações SQS/s simultâneas usando os mesmos kinds. IDs de grupo distintos permitem disputa entre workers; a cada cinco operações há uma reentrega autoral com outro deduplication ID do broker para exercitar Inbox. A distribuição realizada e o volume SQS estão no relatório.

Cada operação vale `1.00 BRL` e a abertura é `1000000000.00 BRL`, exceto no perfil escasso; o saldo elevado evita medir rejeições por falta de saldo onde a intenção é medir processamento.

## O que a validação confere

Money permanece string; somas, reconstrução líquida e mínimos históricos são calculados no PostgreSQL. A validação cruza contagens aceitas e recusadas pelo k6 e envelopes SQS com transações persistidas, verifica hashes/identidades, estado terminal, correspondência e cardinalidade dos lançamentos, versão, saldo, Inbox e os tipos/quantidades de eventos esperados; uma transação `REJECTED` precisa carregar `failureCode`, não ter lançamento e emitir exatamente um `WagerTransactionRejected`. Após a carga, há um limite explícito de drain (180 s por padrão): Outbox pendente, claim residual ou entrada ainda em voo reprovam o cenário.

Zero erro de contrato/HTTP e checks válidos são thresholds obrigatórios; erros, inclusive timeouts, entram nos percentis e não são escondidos por retry do gerador. `LOAD_P95_MS` permite uma meta de latência explicitamente escolhida pelo operador. Não existe meta de RPS do challenge.

## O que o runner registra

O runner salva ambiente e configuração, versão k6/Bun/PostgreSQL, containers ativos, requests totais, throughput, taxa de erro, p50/p95/p99 e duração separada de carga e drain, e com esses dados renderiza `RESULTS.md`: método e limitações são texto fixo, todo número e toda comparação saem do run, e uma execução reprovada sobrescreve o arquivo com o próprio fracasso em vez de deixar os números anteriores no lugar. A separação existe para que a análise nunca contradiga o artefato. Durante o desenvolvimento deste relatório, uma frase interpretativa fixa foi invalidada pelos dados de uma execução; desde então, comparações desse tipo são calculadas e condicionais.

Salva scrapes por instância antes/depois e a cada 2 s, além de backlog/idade e espera por locks amostrados no PostgreSQL, com o pico de `outbox_oldest_pending_age_seconds` do perfil no relatório. Essa amostragem tem custo: a consulta roda a cada 2 s durante a carga e a cada 200 ms durante o drain, na mesma instância que os publishers usam, e está dentro das durações reportadas. O índice parcial `outbox_pending_ix` limita a consulta ao conjunto pendente, mas o custo não foi isolado. Counters/histogramas usam deltas somados entre instâncias; gauges globais permanecem nos scrapes por instância e não são somados. O p95 de lock derivado do histograma é reportado como limite superior do bucket, não como percentil exato. A freshness dos gauges continua sujeita ao collector de 15 s e suas falhas.

## Limites do experimento

O modelo é fechado: reduz a taxa quando o servidor demora e não mede capacidade sob taxa de chegada aberta. Não há tracing nem suspensão artificial de publisher. O backlog de mensagens já publicadas na fila de eventos é esperado: o produto não tem consumidor downstream dessa fila. Ele não equivale a Outbox não publicada, mas afeta o experimento: acumulado ao longo de várias execuções, faz o broker responder mais devagar a `SendMessage`, e o drain da Outbox degrada até estourar seu limite. Por isso o runner purga essa fila no modo gerenciado, e a comparação entre execuções deixa de piorar monotonicamente.
