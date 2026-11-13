import { z } from 'zod';
import {
  belongsToCustomer,
  effectiveStatus,
  type QuoteItems,
  type QuoteStatus,
} from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';

export type QuoteView = {
  id: string;
  serviceOrderId: string;
  status: QuoteStatus;
  items: QuoteItems;
  servicesTotalCents: number;
  autoPartsTotalCents: number;
  totalCents: number;
  currency: string;
  expiresAt: string;
};

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

    return {
      id: quote.id,
      serviceOrderId: quote.serviceOrderId,
      status: effectiveStatus(quote, clock()),
      items: quote.items,
      servicesTotalCents: quote.servicesTotalCents,
      autoPartsTotalCents: quote.autoPartsTotalCents,
      totalCents: quote.totalCents,
      currency: quote.currency,
      expiresAt: quote.expiresAt.toISOString(),
    };
  };
