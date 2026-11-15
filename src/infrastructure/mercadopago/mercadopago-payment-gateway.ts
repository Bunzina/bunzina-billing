import {
  PaymentGatewayError,
  type PaymentGateway,
} from '@/domain/payment/payment-gateway';
import { mercadopagoRequestDurationSeconds } from '@/infrastructure/observability/metrics';

const DEFAULT_BASE_URL = 'https://api.mercadopago.com';
const REQUEST_TIMEOUT_MS = 10_000;
const SUPPORTED_CURRENCY = 'BRL';

type Input = {
  accessToken: string;
  baseUrl?: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const toProviderAmount = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

export const createMercadoPagoPaymentGateway = ({
  accessToken,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = fetch,
}: Input): PaymentGateway => ({
  async createCheckout(request) {
    if (request.currency !== SUPPORTED_CURRENCY) {
      throw new PaymentGatewayError(
        `mercadopago create_order does not support ${request.currency}`,
        false,
        'unsupported_currency',
      );
    }

    const amount = toProviderAmount(request.amountCents);
    const stopTimer = mercadopagoRequestDurationSeconds.startTimer({
      operation: 'create_order',
    });

    try {
      const response = await fetchImpl(`${baseUrl}/v1/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': request.paymentId,
        },
        body: JSON.stringify({
          type: 'online',
          processing_mode: 'manual',
          total_amount: amount,
          external_reference: request.paymentId,
          expiration_time: `PT${request.expiresInMinutes}M`,
          items: [
            { title: request.description, unit_price: amount, quantity: 1 },
          ],
          config: { payment_method: { not_allowed_types: ['ticket'] } },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {
        throw new PaymentGatewayError(
          'mercadopago create_order is unreachable',
          true,
          'unreachable',
        );
      });

      if (!response.ok) {
        throw new PaymentGatewayError(
          `mercadopago create_order answered ${response.status}`,
          isRetryableStatus(response.status),
          `http_${response.status}`,
        );
      }

      const order = (await response.json().catch(() => null)) as {
        id?: unknown;
        checkout_url?: unknown;
      } | null;

      if (
        typeof order?.id !== 'string' ||
        typeof order.checkout_url !== 'string'
      ) {
        throw new PaymentGatewayError(
          'mercadopago create_order answered without an order id or checkout link',
          false,
          'invalid_response',
        );
      }

      stopTimer({ result: 'success' });

      return { providerPaymentId: order.id, checkoutUrl: order.checkout_url };
    } catch (error) {
      stopTimer({ result: 'error' });
      throw error;
    }
  },
});
