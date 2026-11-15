import type { Tx } from '@/infrastructure/messaging/message-store';

export type PaymentEvent = {
  paymentId?: string;
  type: string;
  payload: Record<string, unknown>;
};

export interface PaymentEventLog {
  record(tx: Tx, event: PaymentEvent): Promise<void>;
}
