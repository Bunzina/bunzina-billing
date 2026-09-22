CREATE SCHEMA IF NOT EXISTS bunzina;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quote_status') THEN
    CREATE TYPE bunzina.quote_status AS ENUM (
      'ISSUED',
      'APPROVED',
      'REJECTED',
      'EXPIRED',
      'CANCELED'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    CREATE TYPE bunzina.payment_status AS ENUM (
      'PENDING',
      'CONFIRMED',
      'FAILED',
      'REFUNDED'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'failure_reason') THEN
    CREATE TYPE bunzina.failure_reason AS ENUM (
      'PART_UNAVAILABLE',
      'EXPIRED',
      'REJECTED',
      'TIMEOUT',
      'PROVIDER_ERROR',
      'CUSTOMER_REQUEST',
      'UNREPAIRABLE'
    );
  END IF;
END $$;
