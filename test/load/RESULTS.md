<!-- Gerado por `bun run test:load`. Não editar à mão: os números e as comparações saem do run
     registrado abaixo, e uma nova execução sobrescreve este arquivo. -->

# Medição local — 2026-09-05

Execução: `bun run test:load`, 12 VUs e 30s por perfil. Run ID: `load-1788626462033-f7170721`. Todos os 5 perfis aprovados. Artefatos brutos ficam em `artifacts/load/load-1788626462033-f7170721/`, ignorados pelo Git.

## Ambiente e método

Windows x64, AMD Ryzen 5 3500X 6-Core Processor (6 CPUs lógicas), 15,91 GiB de RAM e 3,00 GiB livres no início; Bun 1.3.13; k6.exe v2.0.0 (commit/8c3be52cc1, go1.26.3, windows/amd64); PostgreSQL 16.15, com a role de runtime `wagering_app`. 3 processos Bun acumulam api, consumer, pending-worker e outbox-publisher; sem tracing. A base tinha **0 transações** antes desta execução, ou seja, a stack foi recriada vazia. A fila de eventos foi purgada antes de medir; o motivo está em *Limitações*. São números de máquina compartilhada, sem isolamento de CPU e sem extrapolação de capacidade.

Modelo fechado de VUs constantes, sem think time, uma submissão síncrona por VU. Os perfis são sequenciais e cada um espera seu drain antes do seguinte; setup, prova de independência, scrapes e drain ficam fora dos percentis do k6. Cada wager vale `1.00 BRL`. O perfil misto ofereceu 5 operações SQS/s em paralelo, uma em cada cinco reenviada com a mesma identidade autoral e deduplication ID distinto no broker. Sem retry HTTP automático.

## Resultados

| Perfil | HTTP total | Submissões | Submissões/s | Erro | p50 ms | p95 ms | p99 ms | Máx ms | Carga real s | Total do cenário s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Distribuído | 4.507 | 4.507 | 149,84 | 0,00% | 70,11 | 149,86 | 209,54 | 343,87 | 30,31 | 177,00 |
| Hot wallet | 1.580 | 1.580 | 52,25 | 0,00% | 75,95 | 979,76 | 1.616,25 | 2.204,82 | 30,35 | 40,34 |
| Escasso | 1.779 | 1.779 | 58,99 | 0,00% | 121,13 | 533,61 | 666,39 | 956,03 | 30,25 | 33,23 |
| Idempotência | 12.923 | 12.911 | 429,98 | 0,00% | 22,96 | 59,67 | 89,51 | 194,75 | 30,15 | 30,93 |
| Misto | 4.468 | 4.468 | 148,57 | 0,00% | 69,21 | 158,24 | 221,17 | 342,16 | 30,23 | 172,11 |

Throughput e percentis são de submissões e incluem falhas, caso existam. O HTTP total inclui as consultas canônicas do perfil de idempotência, que não entram nos percentis. A carga real inclui a saída do k6 e sua graça para terminar requests; o total do cenário inclui preparação, carga, drain e verificação.

| Perfil | Tentativas de lock | Espera média ms | Limite superior do bucket p95 ms | Timeout/deadlock | Máximo de backends esperando lock |
|---|---:|---:|---:|---:|---:|
| Distribuído | 4.507 | 6,74 | 25 | 0 | 1 |
| Hot wallet | 1.580 | 200,82 | 1.000 | 0 | 11 |
| Escasso | 1.779 | 178,51 | 1.000 | 0 | 11 |
| Idempotência | 1 | 2,01 | 5 | 0 | 0 |
| Misto | 4.618 | 8,31 | 50 | 0 | 2 |

A espera do histograma cobre a chamada de aquisição do lock, incluindo ida e volta ao banco, e não apenas o tempo bloqueado. O p95 de lock é um bucket, não um percentil exato. Backends esperando lock são amostras de todos os locks da role de runtime, não somente de wallet. A prova causal separada confirmou que uma Wallet livre conclui em 35 ms enquanto a operação da Wallet presa permanece bloqueada.

| Perfil | Outbox pendente no fim da carga | Idade máxima da Outbox s | Drain e verificação s | Pendentes depois | Eventos verificados |
|---|---:|---:|---:|---:|---:|
| Distribuído | 8.245 | 26,17 | 146,10 | 0 | 9.038 |
| Hot wallet | 755 | 6,98 | 9,31 | 0 | 3.162 |
| Escasso | 242 | 2,71 | 2,31 | 0 | 2.960 |
| Idempotência | 0 | 0,00 | 0,53 | 0 | 4 |
| Misto | 7.342 | 27,78 | 141,24 | 0 | 8.111 |

A idade máxima é o maior `outbox_oldest_pending_age_seconds` observado nas amostras SQL do perfil, medido direto no banco e não pelo gauge Prometheus. Os eventos verificados incluem os `OPENING` das Wallets do perfil. Nos deltas Prometheus: 0 retries, 0 roteamentos à DLQ e 0 divergências de reconciliação. No misto, 150 Inboxes processadas e 30 duplicatas detectadas pela Inbox.

## Perfil escasso: o caminho de recusa sob contenção

O perfil escasso abre uma Wallet com `5.00 BRL` e cicla BET/BET/WIN sobre ela com 12 VUs. O ciclo debita mais do que credita, então o saldo cai à fronteira em segundos e fica lá: o excedente é recusado, e cada recusa devolve o saldo observado.

Das 1.779 submissões, 1.179 foram aplicadas (587 WIN, 592 BET) e **600 recusadas** (600 BET), todas com `INSUFFICIENT_FUNDS`. Tentativas por tipo: 587 WIN, 1.192 BET.

O fechamento no PostgreSQL:

- menor `balance_after` histórico: **`0.00`**;
- saldo final `0.00`, com 1.180 lançamentos e `version` 1.180 — um lançamento e uma versão por efeito, nenhum a mais;
- as 600 recusas não produziram lançamento nem mudança de saldo, e emitiram exatamente um `WagerTransactionRejected` cada, dentro dos 2.960 eventos do perfil;
- `wallet.balance` igual ao saldo reconstruído pelo ledger, como nos demais perfis.

É a evidência direta contra as duas primeiras falhas eliminatórias: VUs concorrentes disputando a decisão de débito no ponto exato onde uma race produziria saldo negativo ou débito duplicado. Os outros perfis abrem com saldo alto de propósito e por isso não conseguem demonstrar isso — neles a folga é grande por construção.

## Interpretação

Concentrar a carga numa Wallet só derrubou o throughput de 149,84 para 52,25 submissões/s, 2,9 vezes. A espera média de lock foi de 6,74 ms no distribuído para 200,82 ms na hot wallet, 29,8 vezes, e a cauda chegou a p99 de 1.616,25 ms e máximo de 2.204,82 ms, sem `lock_timeout` nem deadlock. É serialização deliberada por Wallet, e nenhum saldo se perdeu nela.

O perfil escasso mediu 58,99 submissões/s e espera média de 178,51 ms: mesmo recusada, toda operação continua tomando o lock da Wallet, porque a decisão de saldo acontece sob o lock e não antes dele.

A publicação da Outbox não acompanhou a entrada nos perfis com backlog:

- **Distribuído**: 9.038 eventos gerados e 769 publicados durante a carga (25,37/s), deixando 8.245 pendentes, drenados em 146,10 s (56,44/s aparentes), com idade máxima de 26,17 s.
- **Misto**: 8.111 eventos gerados e 745 publicados durante a carga (24,65/s), deixando 7.342 pendentes, drenados em 141,24 s (51,98/s aparentes), com idade máxima de 27,78 s.
- **Hot wallet**: 3.162 eventos gerados e 2.405 publicados durante a carga (79,24/s), deixando 755 pendentes, drenados em 9,31 s (81,09/s aparentes), com idade máxima de 6,98 s.
- **Escasso**: 2.960 eventos gerados e 2.716 publicados durante a carga (89,79/s), deixando 242 pendentes, drenados em 2,31 s (104,94/s aparentes), com idade máxima de 2,71 s.

A vazão de drenagem é aparente, não medida: o intervalo inclui a verificação SQL e as consultas de fila do próprio runner. Em 4 de 4 perfis com backlog ela superou a taxa de publicação observada durante a carga, o que é compatível com o publisher disputando banco, CPU e broker com o tráfego HTTP em vez de bater num teto fixo — esta execução não isola essa causa.
O publisher publica uma mensagem por iteração, com claim, send e completion. Não houve perfil de CPU nem tracing para atribuir o custo entre rede, broker, banco e escalonamento da máquina. O benchmark torna o backlog visível, sem mudar o publisher.

Na tempestade de replay houve 1 criação, 12.910 replays e 1 débito persistido.

Todas as Wallets fecharam com saldo igual ao ledger líquido. As contagens de primeiras aplicações e de recusas coincidiram com o banco, hashes e identidades foram verificados, LOSS não criou ledger, e cada efeito criou exatamente um lançamento e os eventos esperados.

## Limitações e custo de observação

**A fila de eventos degrada a medição se não for limpa.** Nada consome `wager-events.fifo` neste produto, então ela cresce a cada execução e o broker fica progressivamente mais lento aceitando `SendMessage`, até o drain da Outbox estourar seu limite e reprovar o cenário. Por isso o runner a purga no modo gerenciado. O backlog remanescente nessa fila **não** equivale a Outbox não publicada: são mensagens já publicadas sem consumidor downstream.

**O monitor tem custo dentro do que ele mede.** As amostras SQL de backlog, idade e espera por lock rodam a cada 2 s durante a carga e a cada 200 ms durante o drain, no mesmo PostgreSQL que os publishers usam. O índice parcial `outbox_pending_ix` limita a consulta ao conjunto pendente, mas o custo não foi isolado e está dentro das durações de drain acima.

**A variância entre execuções é grande.** Os números valem para o ambiente e o workload registrados no topo deste arquivo, não como promessa de capacidade. O modelo é fechado: quando o serviço fica lento, o cliente reduz a taxa, e isso não mede chegada aberta. Os gauges Prometheus continuam sujeitos ao collector de 15 s; são as amostras SQL que estabelecem o backlog do cenário.

Integridade não tem estado mensurável de "quase falhar": ou uma invariante foi violada, ou não foi. Só o perfil escasso mede folga nula por construção; nos demais o menor saldo histórico fica muito acima de zero. O teste obrigatório de duas apostas de 80 sobre 100 continua na suíte de concorrência.

## Como reproduzir

```bash
bun run test:load
```

Um `LOAD_P95_MS` deliberadamente impossível reprova os perfis por latência e mantém as invariantes financeiras aprovadas em separado, o que confirma que os dois critérios falham de forma independente. As variáveis de ambiente e o modo de stack externa estão no `README.md`; a metodologia e as decisões estão no `ARCHITECTURE.md`, seção 13.1.
