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
}
