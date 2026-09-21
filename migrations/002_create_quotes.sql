-- Dinheiro em centavos inteiros, com moeda explícita. O domínio do monólito
-- usava NUMERIC com decimais, o que funcionava dentro de um processo só;
-- atravessando JSON entre três serviços e o Mercado Pago vira erro de
-- arredondamento. A fronteira é o lugar de corrigir.
CREATE TABLE IF NOT EXISTS bunzina.quotes (
  id                     UUID                 PRIMARY KEY,
  service_order_id       UUID                 NOT NULL,

  customer_id            UUID                 NOT NULL,
  customer_name          TEXT                 NOT NULL,
  customer_document      TEXT                 NOT NULL,
  customer_email         TEXT,

  status                 bunzina.quote_status NOT NULL DEFAULT 'ISSUED',
  services_total_cents   BIGINT               NOT NULL DEFAULT 0 CHECK (services_total_cents >= 0),
  auto_parts_total_cents BIGINT               NOT NULL DEFAULT 0 CHECK (auto_parts_total_cents >= 0),
  total_cents            BIGINT               NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  currency               CHAR(3)              NOT NULL DEFAULT 'BRL',

  items                  JSONB                NOT NULL DEFAULT '[]'::jsonb,

  expires_at             TIMESTAMPTZ          NOT NULL,
  approved_at            TIMESTAMPTZ,
  approved_by            TEXT,
  rejected_at            TIMESTAMPTZ,
  rejection_reason       bunzina.failure_reason,
  canceled_at            TIMESTAMPTZ,

  created_at             TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

-- Um orçamento vigente por ordem de serviço. Sem isso, um redelivery de
-- cmd.billing.issue-quote que escape da idempotência gera dois orçamentos e o
-- cliente aprova o errado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quotes_active_per_order
  ON bunzina.quotes(service_order_id)
  WHERE status IN ('ISSUED', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_quotes_service_order_id ON bunzina.quotes(service_order_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON bunzina.quotes(status);
