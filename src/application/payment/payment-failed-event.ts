import type { Payment, PaymentFailureReason } from '@/domain/payment/payment';

const DETAIL: Record<PaymentFailureReason, string> = {
  PROVIDER_ERROR: 'The payment provider could not create the checkout',
  EXPIRED: 'The payment was not made before the checkout expired',
  TIMEOUT: 'The quote was canceled before the payment was made',
};

export const paymentFailedData = (payment: Payment) => ({
  serviceOrderId: payment.serviceOrderId,
  paymentId: payment.id,
  quoteId: payment.quoteId,
  reason: payment.failureReason,
  detail: payment.failureReason ? DETAIL[payment.failureReason] : undefined,
  providerStatus: payment.failureDetail,
});
