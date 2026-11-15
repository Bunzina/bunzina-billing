ALTER TABLE bunzina.payments
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE bunzina.payments
SET expires_at = created_at + INTERVAL '30 minutes'
WHERE expires_at IS NULL AND status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_payments_pending_expires_at
  ON bunzina.payments(expires_at)
  WHERE status = 'PENDING';
