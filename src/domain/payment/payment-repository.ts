import type { Tx } from '@/infrastructure/messaging/message-store';
import type { Payment } from './payment';

export interface PaymentRepository {
  findById(id: string): Promise<Payment | null>;
  findByIdForUpdate(tx: Tx, id: string): Promise<Payment | null>;
  findByQuoteId(quoteId: string): Promise<Payment | null>;
  findByQuoteIdForUpdate(tx: Tx, quoteId: string): Promise<Payment | null>;
  insert(tx: Tx, payment: Payment): Promise<void>;
  confirmIfPending(tx: Tx, confirmed: Payment): Promise<boolean>;
  failIfPending(tx: Tx, failed: Payment): Promise<boolean>;
  refundIfConfirmed(tx: Tx, refunded: Payment): Promise<boolean>;
  markLateRefunded(tx: Tx, refunded: Payment): Promise<boolean>;
  claimExpired(tx: Tx, now: Date, limit: number): Promise<Payment[]>;
}
