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
| `consumer.ts` | Extrai o `traceparent`, aplica a guarda de idempotência e faz ack/nack |

O contrato completo está em
[docs/contracts/events-saga-contracts.md](../../docs/contracts/events-saga-contracts.md).

### O que cada serviço precisa implementar

O `consumer.ts` recebe uma `IdempotencyGuard` — o template não a implementa porque
ela depende do banco de cada serviço. A regra é a mesma nos quatro: gravar em
`processed_events` **na mesma transação** da escrita de negócio, e devolver `false`
quando a mensagem já foi processada. Sem isso, um redelivery do RabbitMQ cobra o
cliente duas vezes.

No Postgres é chave primária composta `(event_id, consumer)`. No MongoDB do
`bunzina-workshop` é índice único em `{ eventId, consumer }`.

O `/ready` do `server.ts` também fica em aberto: cada serviço troca o
`checkDependencies` pela checagem do seu próprio banco.

## Checklist do repositório novo

- [ ] Criar `Bunzina/<serviço>` e exigir PR na `main`
- [ ] Checks obrigatórios: `lint-format/check`, `test/coverage` e o quality gate do Sonar
- [ ] Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
      `AWS_ACCOUNT_ID`, `DB_USER`, `DB_PASSWORD`, `RABBITMQ_URL`, `SONAR_TOKEN`
- [ ] Projeto no SonarCloud com a key `Bunzina_<serviço>`
- [ ] README com arquitetura, execução, link do Swagger e evidência de cobertura
