import { z } from 'zod';
import {
  approveQuote,
  belongsToCustomer,
  effectiveStatus,
  expireQuote,
  normalizeDocument,
  rejectQuote,
  type Quote,
  type QuoteStatus,
} from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import type { MessageStore } from '@/infrastructure/messaging/message-store';
import { quotesTotal } from '@/infrastructure/observability/metrics';
import { toQuoteView, type QuoteView } from './quote-view';

export const decisionSchema = z.object({
  document: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED']),
});

export type DecideQuoteResult =
  | { outcome: 'not-found' }
  | { outcome: 'conflict'; status: QuoteStatus; expiredNow: boolean }
  | { outcome: 'decided'; quote: QuoteView };

type Dependencies = {
  quotes: QuoteRepository;
  store: MessageStore;
  clock: () => Date;
};

const quoteApprovedData = (quote: Quote) => ({
  serviceOrderId: quote.serviceOrderId,
  quoteId: quote.id,
  totalCents: quote.totalCents,
  currency: quote.currency,
  approvedBy: quote.approvedBy,
  approvedAt: quote.approvedAt?.toISOString(),
});

const quoteRejectedData = (quote: Quote) => ({
  serviceOrderId: quote.serviceOrderId,
  quoteId: quote.id,
  reason: quote.rejectionReason,
  detail: 'Rejected by the customer',
  rejectedBy: normalizeDocument(quote.customer.document),
});

export const createDecideQuote =
  ({ quotes, store, clock }: Dependencies) =>
  async (
    id: string,
    input: z.infer<typeof decisionSchema>,
  ): Promise<DecideQuoteResult> => {
    if (!z.uuid().safeParse(id).success) {
      return { outcome: 'not-found' };
    }

    const result = await store.transact(
      async (tx): Promise<DecideQuoteResult> => {
        const quote = await quotes.findByIdForUpdate(tx, id);

        if (!quote || !belongsToCustomer(quote, input.document)) {
          return { outcome: 'not-found' };
        }

        const now = clock();

        const current = effectiveStatus(quote, now);

        if (current !== 'ISSUED') {
          const expiredNow = quote.status === 'ISSUED';

          if (expiredNow) {
            await quotes.update(tx, expireQuote(quote));
          }

          return { outcome: 'conflict', status: current, expiredNow };
        }

        const decided =
          input.decision === 'APPROVED'
            ? approveQuote(quote, { approvedBy: input.document, now })
            : rejectQuote(quote, { now });

        await quotes.update(tx, decided);
        await store.enqueue(
          tx,
          buildEnvelope({
            eventType:
              decided.status === 'APPROVED'
                ? 'evt.billing.quote-approved'
                : 'evt.billing.quote-rejected',
            correlationId: decided.serviceOrderId,
            data:
              decided.status === 'APPROVED'
                ? quoteApprovedData(decided)
                : quoteRejectedData(decided),
          }),
        );

        return { outcome: 'decided', quote: toQuoteView(decided, now) };
      },
    );

    if (result.outcome === 'decided') {
      quotesTotal.inc({ status: result.quote.status });
    }

    if (result.outcome === 'conflict' && result.expiredNow) {
      quotesTotal.inc({ status: 'EXPIRED' });
    }

    return result;
  };
