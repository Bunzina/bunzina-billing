import { z } from 'zod';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { belongsToCustomer } from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import { toQuoteView, type QuoteView } from './quote-view';

export type QuoteWithCheckout = QuoteView & { checkoutUrl: string | null };

type Dependencies = {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  clock: () => Date;
};

export const createGetQuote =
  ({ quotes, payments, clock }: Dependencies) =>
  async (
    id: string,
    document: string | null,
  ): Promise<QuoteWithCheckout | null> => {
    if (!document || !z.uuid().safeParse(id).success) {
      return null;
    }

    const quote = await quotes.findById(id);

    if (!quote || !belongsToCustomer(quote, document)) {
      return null;
    }

    const payment = await payments.findByQuoteId(quote.id);

    return {
      ...toQuoteView(quote, clock()),
      checkoutUrl:
        payment?.status === 'PENDING' ? (payment.checkoutUrl ?? null) : null,
    };
  };
