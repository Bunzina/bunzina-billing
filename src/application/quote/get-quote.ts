import { z } from 'zod';
import { belongsToCustomer } from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import { toQuoteView, type QuoteView } from './quote-view';

export type { QuoteView };

type Dependencies = {
  quotes: QuoteRepository;
  clock: () => Date;
};

export const createGetQuote =
  ({ quotes, clock }: Dependencies) =>
  async (id: string, document: string | null): Promise<QuoteView | null> => {
    if (!document || !z.uuid().safeParse(id).success) {
      return null;
    }

    const quote = await quotes.findById(id);

    if (!quote || !belongsToCustomer(quote, document)) {
      return null;
    }

    return toQuoteView(quote, clock());
  };
