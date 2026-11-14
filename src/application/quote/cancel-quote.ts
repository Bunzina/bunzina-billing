import { z } from 'zod';
import { cancelQuote, type Quote } from '@/domain/quote/quote';
import type { PaymentReader } from '@/domain/payment/payment-reader';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import {
  InvalidMessageError,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import { quotesTotal } from '@/infrastructure/observability/metrics';

const commandSchema = z.object({
  serviceOrderId: z.uuid(),
  quoteId: z.uuid(),
  reason: z.string().min(1),
  detail: z.string().optional(),
});

const quoteCanceledData = (quote: Quote) => ({
  serviceOrderId: quote.serviceOrderId,
  quoteId: quote.id,
  canceledAt: quote.canceledAt?.toISOString(),
});

type Dependencies = {
  quotes: QuoteRepository;
  payments: PaymentReader;
  clock: () => Date;
};

export const createCancelQuoteHandler =
  ({ quotes, payments, clock }: Dependencies): MessageHandler =>
  async ({ envelope, tx, emit, afterCommit }) => {
    const parsed = commandSchema.safeParse(envelope.data);

    if (!parsed.success) {
      throw new InvalidMessageError(z.prettifyError(parsed.error));
    }

    const quote = await quotes.findByIdForUpdate(tx, parsed.data.quoteId);

    if (!quote || quote.serviceOrderId !== parsed.data.serviceOrderId) {
      throw new InvalidMessageError('quote not found for the service order');
    }

    if (quote.status === 'CANCELED') {
      await emit('evt.billing.quote-canceled', quoteCanceledData(quote));
      return;
    }

    if (quote.status !== 'ISSUED' && quote.status !== 'APPROVED') {
      throw new InvalidMessageError(
        `a ${quote.status} quote cannot be canceled`,
      );
    }

    if (await payments.hasConfirmedPayment(tx, quote.id)) {
      throw new InvalidMessageError(
        'quote has a confirmed payment and needs a refund, not a cancellation',
      );
    }

    const canceled = cancelQuote(quote, { now: clock() });

    await quotes.update(tx, canceled);
    await emit('evt.billing.quote-canceled', quoteCanceledData(canceled));

    afterCommit(async () => {
      quotesTotal.inc({ status: canceled.status });
    });
  };
