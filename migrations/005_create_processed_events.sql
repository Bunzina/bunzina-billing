CREATE TABLE IF NOT EXISTS bunzina.processed_events (
  event_id   UUID        NOT NULL,
  consumer   TEXT        NOT NULL,
  handled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer)
);
