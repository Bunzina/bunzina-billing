# O Billing usa o Checkout Pro pela API de Orders, não por preferência

O Billing cria a cobrança com `POST /v1/orders` (`type: online`, `processing_mode: manual`) e estorna com `POST /v1/orders/{id}/refund`. A criação por preferência (`POST /checkout/preferences`) e o estorno por `POST /v1/payments/{id}/refunds` ficam fora. É o mesmo produto, Checkout Pro, com o mesmo checkout hospedado para PIX e cartão.

No sandbox o estorno pela API de pagamentos devolveu `401 Unauthorized use of live credentials` em todas as tentativas, com o token de teste da aplicação, e o pagamento nasceu com `live_mode: true`. O mesmo token estornou sem erro pela API de Orders, e a order nasceu com prefixo `ORDTST`. O Mercado Pago não documenta a causa do 401, então isso é uma observação do spike (issue #4), não uma regra conhecida. Sem essa decisão, a compensação da saga (estorno registrado no Mercado Pago) não seria demonstrável.

## Como as quatro operações da porta `PaymentGateway` se mapeiam

| Operação | Chamada | Observações |
|---|---|---|
| Criar | `POST /v1/orders` | `external_reference` = id do Pagamento. O link é `checkout_url`. `expiration_time` em ISO 8601 (`PT30M`). Boleto fora com `config.payment_method.not_allowed_types: ["ticket"]`. |
| Consultar | `GET /v1/orders/{id}` | O pagamento está em `transactions.payments[]`. Pago é `status: processed`, `status_detail: accredited`. |
| Estornar | `POST /v1/orders/{id}/refund` | Corpo vazio é estorno total. Mesma `X-Idempotency-Key` repete a resposta sem estornar de novo. Chave nova numa order já estornada devolve `409 order_already_refunded`, que o adaptador trata como "já estornado". |
| Expirar | `POST /v1/orders/{id}/cancel` | Só para order não paga. Repetir devolve `409 order_already_canceled`. |

`provider_payment_id` guarda o **id da order** (`ORD...`), porque estorno, cancelamento e consulta usam esse id. O `provider_refund_id` guarda o id do estorno (`REF...`).

## Webhook

- O endereço do webhook é o configurado no painel da aplicação, não um campo da order: a criação por Orders não tem `notification_url`.
- Chegaram notificações `type=topic_merchant_order_wh`, com `data_id` na query. Notificação de pagamento ou de Orders não chegou, mas o painel pode ter sido configurado só com esse evento.
- Assinatura confirmada: HMAC-SHA256 em hex do manifest `id:<data_id>;request-id:<x-request-id>;ts:<ts>;`, com a assinatura secreta como chave, comparada com o `v1` do header `x-signature`. Notificações no formato antigo (`?topic=...&id=...`), que também chegam quando se usa preferência, **não** validam nesse esquema e devem ser ignoradas.
- O corpo da notificação não traz `external_reference`. O handler consulta a `merchant_order` (`GET /merchant_orders/{id}`), que traz `external_reference`, `order_status` e `payments[].id`, e então consulta a order. É o que o spec já pedia: não confiar só no corpo.
- Chegam notificações duplicadas e atrasadas (uma repetiu 17 minutos depois). A idempotência por atualização condicional do spec cobre isso.

## Não confirmado no spike

- **Expiração por `expiration_time`:** uma order de `PT1M` continuava `created` mais de três minutos depois. Até isso ser observado, o job de expiração de pagamentos pendentes continua obrigatório e chama o cancelamento.
- **Boleto fora do checkout:** a API aceitou `not_allowed_types: ["ticket"]`, mas a tela não foi inspecionada.
- **`notification_url` em HTTP na preferência:** o Mercado Pago aceitou e entregou em HTTP, mas esse caminho deixou de ser usado. Para Orders o endereço vem do painel, e foi um endereço HTTP que recebeu as notificações.

Respostas reais para o gateway fake estão em `docs/mercadopago/fixtures/`.

## Considered Options

- **Preferência com webhook simulado para o estorno.** Mantém o desenho original do spec, mas o estorno deixaria de ser registrado no Mercado Pago e a demonstração da compensação ficaria menos convincente.
- **Preferência para cobrar e Orders só para estornar.** Um pagamento criado por preferência não é uma order, então não há `order_id` para estornar.

## Consequences

- O spec #2 e o ADR 0001 falam em "preferência". Onde se lê preferência, leia-se order.
- A porta `PaymentGateway` não muda de forma, só de implementação: continua com criar, consultar, estornar e expirar.
- O token usado em teste continua sendo o da aplicação. O wizard deixa de afirmar que ele começa com `TEST-`.
