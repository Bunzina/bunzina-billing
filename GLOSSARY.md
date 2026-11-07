# Billing

Contexto responsável por emitir o orçamento de uma ordem de serviço depois do diagnóstico, registrar a decisão do cliente sobre ele e cobrar, receber e estornar o valor aprovado.

## Language

**Orçamento** (`Quote`):
Documento emitido depois do diagnóstico que fixa os itens e o total de uma ordem de serviço e tem validade. É diferente do "Orçamento" do monólito, que era apenas o valor total calculado da OS.
_Avoid_: Cotação, proposta, valor da OS

**Aprovação** (`Approval`):
Decisão do cliente sobre um orçamento emitido, que pode ser aceite ou recusa.
_Avoid_: Confirmação, aceite

**Pagamento** (`Payment`):
Tentativa única de quitar um orçamento aprovado, representada por um link de checkout. Cada orçamento tem no máximo um.
_Avoid_: Transação, fatura

**Cobrança** (`charge`):
Ato de criar o pagamento de um orçamento aprovado, ordenado pelo orquestrador da saga.
_Avoid_: Pedido de pagamento, checkout

**Estorno** (`Refund`):
Devolução integral do valor de um pagamento confirmado.
_Avoid_: Reembolso, chargeback, cancelamento do pagamento

**Pagamento tardio**:
Pagamento aprovado que chega quando o pagamento correspondente já não está pendente, por cancelamento ou expiração. É estornado automaticamente.
_Avoid_: Pagamento atrasado, pagamento órfão
