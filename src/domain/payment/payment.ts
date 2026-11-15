export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED';

export type PaymentFailureReason = 'PROVIDER_ERROR';

export type Payment = {
  id: string;
  quoteId: string;
  serviceOrderId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  provider: string;
  providerPaymentId?: string;
  checkoutUrl?: string;
  method?: string;
  paidAt?: Date;
  failureReason?: PaymentFailureReason;
  failureDetail?: string;
  createdAt: Date;
};

type CreateInput = {
  quoteId: string;
  serviceOrderId: string;
  amountCents: number;
  currency: string;
  now: Date;
};

const paymentIdFor = (quoteId: string): string => {
  const bytes = new Bun.CryptoHasher('sha1')
    .update(`payment:${quoteId}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createPendingPayment = ({
  quoteId,
  serviceOrderId,
  amountCents,
  currency,
  now,
}: CreateInput): Payment => ({
  id: paymentIdFor(quoteId),
  quoteId,
  serviceOrderId,
  status: 'PENDING',
  amountCents,
  currency,
  provider: 'mercadopago',
  createdAt: now,
});

export const attachCheckout = (
  payment: Payment,
  {
    providerPaymentId,
    checkoutUrl,
  }: {
    providerPaymentId: string;
    checkoutUrl: string;
  },
): Payment => ({ ...payment, providerPaymentId, checkoutUrl });

export const confirmPayment = (
  payment: Payment,
  { method, paidAt }: { method: string; paidAt: Date },
): Payment => ({ ...payment, status: 'CONFIRMED', method, paidAt });

export const failPayment = (
  payment: Payment,
  { reason, detail }: { reason: PaymentFailureReason; detail: string },
): Payment => ({
  ...payment,
  status: 'FAILED',
  failureReason: reason,
  failureDetail: detail,
});

export const DEFAULT_PAYMENT_VALIDITY_MINUTES = 30;

export const parsePaymentValidityMinutes = (
  raw: string | undefined,
): number => {
  const minutes = Number(raw);

  return raw?.trim() && Number.isInteger(minutes) && minutes > 0
    ? minutes
    : DEFAULT_PAYMENT_VALIDITY_MINUTES;
};
