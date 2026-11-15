import type { Tx } from '@/infrastructure/messaging/message-store';
import type { Payment } from './payment';

export interface PaymentRepository {
  findByQuoteId(quoteId: string): Promise<Payment | null>;
  findByQuoteIdForUpdate(tx: Tx, quoteId: string): Promise<Payment | null>;
  insert(tx: Tx, payment: Payment): Promise<void>;
}
