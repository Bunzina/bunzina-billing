CREATE TABLE IF NOT EXISTS bunzina.outbox_messages (
  event_id       UUID        PRIMARY KEY,
  event_type     TEXT        NOT NULL,
  correlation_id UUID        NOT NULL,
  payload        JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_messages_pending
  ON bunzina.outbox_messages(created_at, event_id)
  WHERE published_at IS NULL;
