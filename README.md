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
(`bun run test:integration`, com `DATABASE_URL` apontando para um Postgres) provam o
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

| Variável | Padrão | Uso |
| --- | --- | --- |
| `QUOTE_VALIDITY_HOURS` | `72` | Validade do orçamento; vazio ou inválido volta para 72 |
| `EMAIL_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` | — | Servidor SMTP |
| `EMAIL` | `bunzina@local.com` | Remetente |

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
