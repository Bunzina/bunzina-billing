# Template de microsserviço — Fase 4

Base para o `bunzina-os`, o `bunzina-billing` e o `bunzina-workshop`. Reúne o que
os três precisam ter igual: pipeline, gate de cobertura, chart, bootstrap de
observabilidade e o cliente de mensageria com propagação de trace.

Derivado do `bunzina`: o workflow de deploy veio do `.github/workflows/deploy-k8s.yml`,
o chart do `charts/bunzina-chart` e o `tracing.ts` do `src/infrastructure/observability`.

## Como usar

```bash
./scripts/init-service.sh bunzina-os ../../bunzina-os
cd ../../bunzina-os && bun install && bun test
```

O script copia a pasta, renomeia o chart e substitui dois placeholders:

| Placeholder | Vira | Onde aparece |
| --- | --- | --- |
| `bunzina-billing` | `bunzina-os` | package.json, chart, workflows, compose, Sonar |
| `bunzina_billing` | `bunzina_os` | nomes das métricas Prometheus |

O `__AWS_ACCOUNT_ID__` **não** é substituído pelo script. Ele é injetado pelo
workflow de deploy a partir do secret, como já acontece no `bunzina`.

## O que vem pronto

**Gate de cobertura ligado.** O `bunfig.ci.toml` tem `coverage = true` e
`coverageThreshold` de 80% nas quatro dimensões. É o que o CI executa, então
cobertura abaixo disso reprova o PR. Esta é a correção do problema que o `bunzina`
tinha: lá o arquivo de CI vinha com `coverage = false` e o gate não existia na
prática.

**Dois workflows.** O `ci.yml` roda em PR — lint, formato, testes com cobertura e
scan do SonarCloud. O `deploy-k8s.yml` roda no push para `main` — testes,
migrations por port-forward, build e push no ECR, e `helm upgrade --install`.

**Chart umbrella** consumindo o `app-chart` do `bunzina-chart` por OCI, com HPA,
ServiceMonitor, probes e o Postgres próprio do serviço
([ADR 0012](../../docs/arch/adrs/0012-microservices-split.md)). O `bunzina-workshop`
desliga o `database` e aponta para o MongoDB Atlas
([ADR 0014](../../docs/arch/adrs/0014-mongodb-workshop.md)).

**RabbitMQ no `docker-compose`**, o mesmo broker que roda no cluster. A paridade é
o que permite ensaiar falha e compensação antes de gravar
([ADR 0015](../../docs/arch/adrs/0015-rabbitmq-broker.md)).

## `src/infrastructure/messaging`

A parte que precisa ser **idêntica** nos quatro serviços, e que a
[ADR 0016](../../docs/arch/adrs/0016-code-reuse-between-services.md) marca para virar
pacote npm. Enquanto o pacote não existe, ela vive aqui.

| Arquivo | Responsabilidade |
| --- | --- |
| `envelope.ts` | Schema Zod do envelope e enum de `reason`. Critério de aceite nº 1 do contrato |
| `connection.ts` | Canal único por processo, topologia (exchange topic, fila, DLX, DLQ) e prefetch |
| `publisher.ts` | Publica com o `eventType` como routing key e injeta o `traceparent` nos headers AMQP |
| `consumer.ts` | Extrai o `traceparent`, roda o handler numa transação junto com a guarda de idempotência, repete falhas transitórias (3 tentativas, backoff exponencial) e faz ack/nack |
| `message-store.ts` | Porta `MessageStore` e a implementação Postgres: transação, `processed_events` e outbox |
| `outbox-relay.ts` | Publica o outbox por polling de 1s em lotes com `FOR UPDATE SKIP LOCKED`, esperando o confirm do broker |

O contrato completo está em
[docs/contracts/events-saga-contracts.md](../../docs/contracts/events-saga-contracts.md).

### O que cada serviço precisa implementar

O handler de cada mensagem recebe `{ envelope, tx, emit }`. A guarda de idempotência
grava em `processed_events` **na mesma transação** da escrita de negócio, e o `emit`
grava o evento de saída no outbox nessa mesma transação, com o `serviceOrderId` como
`correlationId` e o `eventId` da mensagem de origem como `causationId`. Um redelivery
do RabbitMQ é confirmado sem efeito, então não cobra o cliente duas vezes.

Um handler que considera a mensagem inválida lança `InvalidMessageError`: ela vai
direto para a DLQ, sem retry. Qualquer outro erro é repetido até 3 vezes.

Testes: os unitários usam o `MessageStore` em memória (`src/test`). Os de integração
(`bun run test:integration`, que sobe um Postgres descartável local, o `db-test` na
porta 5433, e nunca roda contra outro banco) provam o
que mock não prova: a transação, o outbox e o `SKIP LOCKED` com duas instâncias. Eles
rodam no job `test/integration` do CI, fora do gate de 80%. O `lcov` deles segue para o
SonarCloud junto com o dos unitários. O `message-store.ts`, que é só SQL, fica fora do
gate unitário (o Bun mede o limite de 80% por arquivo) e é medido apenas pela
integração.

No Postgres é chave primária composta `(event_id, consumer)`. No MongoDB do
`bunzina-workshop` é índice único em `{ eventId, consumer }`.

O `/ready` do `server.ts` também fica em aberto: cada serviço troca o
`checkDependencies` pela checagem do seu próprio banco.

## Emissão do orçamento

O orquestrador manda `cmd.billing.issue-quote` com os itens diagnosticados. O Billing
calcula o total (serviços + peças, `quantidade × preço unitário`, em centavos), fixa os
itens e a validade, grava o **Orçamento**, publica `evt.billing.quote-issued` pelo outbox
e envia o orçamento ao cliente por e-mail.

- **Um orçamento ativo por OS.** Emitido ou aprovado conta como ativo. Um comando novo
  para uma OS que já tem orçamento ativo não cria outro: reemite `quote-issued` do
  existente. Depois de uma recusa a OS pode receber um novo. O índice único parcial
  `uq_quotes_active_per_order` garante isso também com duas réplicas concorrentes.
- **Payload inválido** (sem itens, total zero, campo faltando ou moeda que não seja um código de 3 letras maiúsculas)
  vai direto para a DLQ, sem retry.
- **E-mail depois do commit.** O envio roda só quando a transação confirmou e nunca para
  uma mensagem repetida. Falha de SMTP gera log e `billing_email_failures_total`, e não
  impede a emissão. Para isso o handler recebe `afterCommit(work)` além de `tx` e `emit`.
- **Consulta**: `GET /quotes/:id` com o documento no header `X-Customer-Document`
  devolve itens, totais e situação. Documento divergente, ausente ou id inválido
  respondem 404. Um orçamento emitido e vencido aparece como `EXPIRED`.

### Cobrança (`cmd.billing.charge`)

Depois da aprovação o orquestrador manda `cmd.billing.charge` com o `quoteId` e o total. O
Billing cria o **Pagamento** e a order de Checkout Pro no Mercado Pago
([ADR 0002](docs/adr/0002-checkout-pro-via-orders-api.md)), grava o link, e envia o link ao
cliente por e-mail. O link também sai em `GET /quotes/:id` (`checkoutUrl`, só enquanto o
pagamento está pendente). A confirmação chega pelo webhook, abaixo.

- **Só orçamento aprovado e total igual.** Orçamento desconhecido, de outra OS, que não
  está aprovado, ou com total ou moeda diferentes do comando, vai direto para a DLQ.
- **Um pagamento por orçamento.** O índice único `uq_payments_quote_id` garante isso. Outra
  cobrança para o mesmo orçamento não chama o provedor nem envia outro e-mail.
- **Erro do provedor.** Erro transitório (rede, 429, 5xx) é repetido até 3 vezes dentro do
  handler, com backoff. Esgotadas as tentativas, ou diante de um erro que não adianta repetir
  (outro 4xx), o pagamento fica `FAILED` com `PROVIDER_ERROR` e sai `evt.billing.payment-failed`.
  Esse pagamento não é cobrado de novo: reenviar o comando só reemite o evento. O
  `providerStatus` do evento é `http_<código>` ou `unreachable`, e fica em `failure_detail`.
- **Mercado Pago por HTTP direto**, sem SDK (`src/infrastructure/mercadopago`). Os centavos viram
  o decimal do provedor (`"210.05"`) só ali. A order sai com `expiration_time` em ISO 8601 e
  `not_allowed_types: ["ticket"]` (boleto fora), e o id do Pagamento como `external_reference`
  e `X-Idempotency-Key`. Só `BRL` é aceita.
- **E-mail depois do commit**, como no orçamento: falha vira log e
  `billing_email_failures_total{template="payment-link"}`, e não desfaz a cobrança.

### Webhook (`POST /webhooks/mercadopago`)

O Mercado Pago notifica o webhook configurado no painel da aplicação
([ADR 0002](docs/adr/0002-checkout-pro-via-orders-api.md)). O corpo nunca decide nada.

- **Assinatura.** Sem `x-signature` válido (HMAC-SHA256 do manifest `id;request-id;ts` com
  `MP_WEBHOOK_SECRET`) a resposta é `401`. Isso inclui o formato antigo (`?topic=&id=`), que não
  traz `data.id`. Sem `MP_WEBHOOK_SECRET` ou `MP_ACCESS_TOKEN` a rota nem é servida.
- **Estado vem da API.** O Billing consulta a `merchant_order` (traz o `external_reference`, o id
  do Pagamento), acha o Pagamento e consulta a order pelo `provider_payment_id`.
- **Tudo fica em `payment_events`.** Cada notificação grava `webhook-received` ou
  `webhook-rejected` antes de qualquer consulta (o corpo gravado é cortado em 8 KiB). O desfecho vira outra linha com o
  `payment_id`: `payment-confirmed`, `payment-approval-ignored` (o pagamento já não estava
  pendente), `payment-declined` ou `webhook-unmatched`.
- **Confirma uma vez.** `UPDATE ... WHERE status = 'PENDING'` e o `payment-confirmed` entram na
  mesma transação. Duplicata, notificação fora de ordem ou duas réplicas ao mesmo tempo: só quem
  muda a linha publica. `payment-confirmed` leva o id do provedor (a order), o método
  (`pix`, `credit_card`...) e `paidAt`, que é a última atualização da order.
- **Cartão recusado** só entra no registro: não publica `payment-failed` e não altera o Pagamento
  ([ADR 0001](docs/adr/0001-payment-failure-and-late-payment.md)).
- **Provedor fora do ar**, ou `merchant_order` ainda não consultável (`404`), responde `502`, para o Mercado Pago entregar de novo. Notificação sem
  Pagamento correspondente responde `200` (não adianta repetir).
- **Pagamento tardio.** Aprovação que chega com o Pagamento já `FAILED` (cancelamento, timeout
  ou expiração) é estornada na hora, com o id do Pagamento como chave de idempotência. O
  Pagamento continua `FAILED`, ganha `provider_refund_id` e `refunded_at`, e o estorno entra em
  `payment_events` como `late-payment-refunded`. Não publica evento de saga
  ([ADR 0001](docs/adr/0001-payment-failure-and-late-payment.md)). Se o provedor falhar, responde
  `502` e o Mercado Pago entrega de novo; uma notificação repetida depois do estorno só é
  registrada (`payment-approval-ignored`).

Métricas: `billing_payments_total{status}`, `billing_late_payments_refunded_total` e
`billing_mercadopago_request_duration_seconds{operation,result}` (`operation` é `create_order`,
`get_merchant_order`, `get_order`, `cancel_order` ou `refund_order`; `result` é `success` ou
`error`).

## Estorno (`cmd.billing.refund`)

O orquestrador manda estornar um Pagamento `CONFIRMED` (`serviceOrderId`, `paymentId`,
`amountCents`, `currency`, `reason`). O Billing estorna o valor integral em
`POST /v1/orders/{id}/refund`, com o id do Pagamento como `X-Idempotency-Key`, marca o
Pagamento como `REFUNDED` com `provider_refund_id` e `refunded_at`, registra
`payment-refunded` em `payment_events` e publica `evt.billing.payment-refunded` com
`providerRefundId`.

- **Repetido:** num Pagamento já `REFUNDED` não chama o provedor e reemite
  `payment-refunded` com o estorno original.
- **Não confirmado:** Pagamento `PENDING` ou `FAILED`, valor ou moeda diferentes do Pagamento,
  OS que não confere ou Pagamento inexistente vão para a DLQ, e o alerta da DLQ dispara.
- **Provedor fora do ar:** o consumidor repete com espera e, esgotadas as tentativas, a mensagem
  vai para a DLQ com o Pagamento ainda `CONFIRMED`. A chave de idempotência torna a repetição
  segura. Se a order já estiver estornada sob outra chave (`409 order_already_refunded`), o
  adaptador lê o estorno existente na order.

Métrica: `billing_refunds_total` (estornos mandados pela saga; os tardios têm a sua própria).

| Variável | Padrão | Uso |
| --- | --- | --- |
| `QUOTE_VALIDITY_HOURS` | `72` | Validade do orçamento; vazio ou inválido volta para 72 |
| `EMAIL_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` | — | Servidor SMTP |
| `EMAIL` | `bunzina@local.com` | Remetente |
| `PAYMENT_LINK_VALIDITY_MINUTES` | `30` | Validade do link de pagamento, em minutos inteiros; vazio ou inválido volta para 30 |
| `MP_ACCESS_TOKEN` | — | Token do Mercado Pago (secret). Sem ele o `cmd.billing.charge` e o `cmd.billing.refund` não são consumidos e vão para a DLQ, e o webhook não é servido |
| `MP_WEBHOOK_SECRET` | — | Segredo de assinatura do webhook do Mercado Pago (secret) |
| `PUBLIC_BASE_URL` | — | Endereço público do ALB, base das URLs que o Mercado Pago chama |

No cluster o host, a porta e o remetente vêm do `values.yaml` (mailcatcher do release
`bunzina-observability`, sem autenticação). Para um SMTP real, cadastre os secrets
opcionais `EMAIL_SMTP_USER` e `EMAIL_SMTP_PASSWORD`: o deploy só os injeta quando
`EMAIL_SMTP_USER` existe.

`MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` são secrets do repositório e `PUBLIC_BASE_URL` é uma
variável (`vars`), porque o endereço do ALB só existe depois do primeiro deploy. O
deploy só injeta cada um quando está preenchido.

O SMTP usa TLS implícito só na porta 465; nas demais, STARTTLS quando o servidor oferece.

Métrica: `billing_quotes_total{status}`.

Alerta: o chart publica `templates/grafana-alerts.yaml`, um ConfigMap com o label
`grafana_alert: "1"` que dispara quando alguma mensagem vai para a DLQ
(`bunzina_billing_messages_consumed_total{result=~"invalid|failure|unhandled"}`). Ele só
chega ao Grafana se o release `bunzina-observability` tiver `grafana.sidecar.alerts.enabled`.

## Checklist do repositório novo

- [ ] Criar `Bunzina/<serviço>` e exigir PR na `main`
- [ ] Checks obrigatórios: `lint-format/check`, `test/coverage` e o quality gate do Sonar
- [ ] Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
      `AWS_ACCOUNT_ID`, `DB_USER`, `DB_PASSWORD`, `RABBITMQ_URL`, `SONAR_TOKEN`
- [ ] Projeto no SonarCloud com a key `Bunzina_<serviço>`
- [ ] README com arquitetura, execução, link do Swagger e evidência de cobertura
