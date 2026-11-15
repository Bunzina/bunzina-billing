import type { Tx } from '@/infrastructure/messaging/message-store';

export interface PaymentReader {
  hasConfirmedPayment(tx: Tx, quoteId: string): Promise<boolean>;
}
