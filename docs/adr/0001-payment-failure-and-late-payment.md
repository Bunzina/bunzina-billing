# `payment-failed` é terminal e pagamento tardio é estornado automaticamente

No Checkout Pro, um cartão recusado não encerra o checkout: o cliente pode tentar outro meio na mesma preferência. Por isso o Billing só publica `evt.billing.payment-failed` em dois casos, expiração da preferência (`EXPIRED`) e erro do provedor (`PROVIDER_ERROR`). Tentativa recusada fica registrada em `payment_events` e não afeta a saga. Um orçamento tem no máximo um pagamento, e `payment-failed` leva a OS ao cancelamento, sem nova cobrança.

Se uma aprovação chegar para um pagamento que já não está `PENDING` (por `cancel-quote`, timeout ou expiração), o Billing estorna sozinho, registra em `payment_events`, incrementa `billing_late_payments_refunded_total` e não publica evento de saga, porque a OS já foi encerrada.

## Considered Options

- **Falhar na primeira recusa.** Mais simples, mas cancelaria a OS enquanto o cliente ainda está pagando e deixaria o pagamento seguinte sem dono, com dinheiro retido.
- **Permitir nova cobrança após `payment-failed`.** Exigiria que o orquestrador reabrisse a saga, algo que o contrato congelado não prevê.

## Consequences

- O Billing precisa de um job que varre pagamentos `PENDING` vencidos, além do timeout do OS que serve de rede de segurança.
- O estorno automático não gera evento, então o OS nunca vê esse estorno. A trilha fica só no Billing.
