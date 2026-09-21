CREATE TABLE IF NOT EXISTS public.migrations (
  name              VARCHAR(255)  PRIMARY KEY,
  run_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);