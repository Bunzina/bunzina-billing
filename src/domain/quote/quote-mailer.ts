import type { Quote } from './quote';

export interface QuoteMailer {
  sendQuoteIssued(quote: Quote): Promise<void>;
}
