export type CheckoutRequest = {
  paymentId: string;
  amountCents: number;
  currency: string;
  description: string;
  expiresInMinutes: number;
};

export type Checkout = {
  providerPaymentId: string;
  checkoutUrl: string;
};

export type ProviderOrder =
  | { state: 'PAID'; method: string; paidAt: Date }
  | { state: 'DECLINED'; detail: string }
  | { state: 'OPEN' };

export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerStatus: string,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

export interface PaymentGateway {
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  findPaymentReference(notificationId: string): Promise<string | null>;
  getOrder(providerPaymentId: string): Promise<ProviderOrder>;
  expireCheckout(providerPaymentId: string): Promise<void>;
}
