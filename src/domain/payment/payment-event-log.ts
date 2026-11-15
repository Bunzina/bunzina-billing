import type { Tx } from '@/infrastructure/messaging/message-store';

export type PaymentEventType =
  | 'webhook-received'
  | 'webhook-rejected'
  | 'webhook-unmatched'
  | 'payment-confirmed'
  | 'payment-approval-ignored'
  | 'payment-declined'
  | 'payment-expired'
  | 'payment-canceled'
  | 'checkout-expiry-failed';

export type PaymentEvent = {
  paymentId?: string;
  type: PaymentEventType;
  payload: Record<string, unknown>;
};

export interface PaymentEventLog {
  record(tx: Tx, event: PaymentEvent): Promise<void>;
}
