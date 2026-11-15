import type { Quote } from '@/domain/quote/quote';

export type PaymentLink = {
  quote: Quote;
  checkoutUrl: string;
  expiresAt: Date;
};

export interface PaymentMailer {
  sendPaymentLink(link: PaymentLink): Promise<void>;
}
