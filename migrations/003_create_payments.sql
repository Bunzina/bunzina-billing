CREATE TABLE IF NOT EXISTS bunzina.payments (
  id                  UUID                   PRIMARY KEY,
  quote_id            UUID                   NOT NULL REFERENCES bunzina.quotes(id),
  service_order_id    UUID                   NOT NULL,

  status              bunzina.payment_status NOT NULL DEFAULT 'PENDING',
  amount_cents        BIGINT                 NOT NULL CHECK (amount_cents >= 0),
  currency            CHAR(3)                NOT NULL DEFAULT 'BRL',

  provider            TEXT                   NOT NULL DEFAULT 'mercadopago',
  provider_payment_id TEXT,
  provider_refund_id  TEXT,
  method              TEXT,
  checkout_url        TEXT,

  failure_reason      bunzina.failure_reason,
  failure_detail      TEXT,

  paid_at             TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

-- O webhook do Mercado Pago chega pelo id do provedor; é por ele que a
-- confirmação encontra o pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment_id
  ON bunzina.payments(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_service_order_id ON bunzina.payments(service_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON bunzina.payments(status);
