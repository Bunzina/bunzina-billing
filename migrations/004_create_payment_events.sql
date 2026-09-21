-- Trilha de auditoria do que o Mercado Pago mandou, crua. Quando um estorno não
-- fecha e o caso vira problema humano, é isto que se lê.
CREATE TABLE IF NOT EXISTS bunzina.payment_events (
  id          UUID        PRIMARY KEY,
  payment_id  UUID        REFERENCES bunzina.payments(id) ON DELETE CASCADE,
  provider    TEXT        NOT NULL DEFAULT 'mercadopago',
  event_type  TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON bunzina.payment_events(payment_id);
