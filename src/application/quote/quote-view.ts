import {
  effectiveStatus,
  type Quote,
  type QuoteItems,
  type QuoteStatus,
} from '@/domain/quote/quote';

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

export const toQuoteView = (quote: Quote, now: Date): QuoteView => ({
  id: quote.id,
  serviceOrderId: quote.serviceOrderId,
  status: effectiveStatus(quote, now),
  items: quote.items,
  servicesTotalCents: quote.servicesTotalCents,
  autoPartsTotalCents: quote.autoPartsTotalCents,
  totalCents: quote.totalCents,
  currency: quote.currency,
  expiresAt: quote.expiresAt.toISOString(),
});
