import type { Tx } from '@/infrastructure/messaging/message-store';
import type { Quote } from './quote';

export interface QuoteRepository {
  findById(id: string): Promise<Quote | null>;
  findActiveByServiceOrder(
    tx: Tx,
    serviceOrderId: string,
  ): Promise<Quote | null>;
  insert(tx: Tx, quote: Quote): Promise<void>;
}
