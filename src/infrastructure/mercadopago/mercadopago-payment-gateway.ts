import {
  PaymentGatewayError,
  type PaymentGateway,
  type ProviderOrder,
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

type ProviderPayment = {
  status?: unknown;
  status_detail?: unknown;
  payment_method?: { id?: unknown; type?: unknown };
};

type ProviderOrderBody = {
  status?: unknown;
  status_detail?: unknown;
  last_updated_date?: unknown;
  transactions?: { payments?: ProviderPayment[] };
};

const invalidResponse = (operation: string) =>
  new PaymentGatewayError(
    `mercadopago ${operation} answered an unexpected body`,
    false,
    'invalid_response',
  );

const methodOf = (payment?: ProviderPayment): string => {
  const { id, type } = payment?.payment_method ?? {};
  if (id === 'pix') {
    return 'pix';
  }
  return typeof type === 'string' ? type : 'unknown';
};

const toProviderOrder = (body: ProviderOrderBody): ProviderOrder => {
  const payments = body.transactions?.payments ?? [];
  if (body.status === 'processed' && body.status_detail === 'accredited') {
    const paidAt = new Date(String(body.last_updated_date));
    if (Number.isNaN(paidAt.getTime())) {
      throw invalidResponse('get_order');
    }
    return { state: 'PAID', method: methodOf(payments[0]), paidAt };
  }
  const declined = payments.findLast((payment) => payment.status === 'failed');
  if (declined) {
    return { state: 'DECLINED', detail: String(declined.status_detail) };
  }
  return { state: 'OPEN' };
};

export const createMercadoPagoPaymentGateway = ({
  accessToken,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = fetch,
}: Input): PaymentGateway => {
  const read = async (operation: string, path: string): Promise<Response> => {
    const stopTimer = mercadopagoRequestDurationSeconds.startTimer({
      operation,
    });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {
        throw new PaymentGatewayError(
          `mercadopago ${operation} is unreachable`,
          true,
          'unreachable',
        );
      });
      if (!response.ok && response.status !== 404) {
        throw new PaymentGatewayError(
          `mercadopago ${operation} answered ${response.status}`,
          isRetryableStatus(response.status),
          `http_${response.status}`,
        );
      }
      stopTimer({ result: 'success' });
      return response;
    } catch (error) {
      stopTimer({ result: 'error' });
      throw error;
    }
  };

  return {
    async findPaymentReference(notificationId) {
      const response = await read(
        'get_merchant_order',
        `/merchant_orders/${encodeURIComponent(notificationId)}`,
      );
      const body = (await response.json().catch(() => null)) as {
        external_reference?: unknown;
      } | null;

      return typeof body?.external_reference === 'string' &&
        body.external_reference
        ? body.external_reference
        : null;
    },

    async getOrder(providerPaymentId) {
      const response = await read(
        'get_order',
        `/v1/orders/${encodeURIComponent(providerPaymentId)}`,
      );
      if (!response.ok) {
        throw new PaymentGatewayError(
          'mercadopago get_order answered 404',
          false,
          'http_404',
        );
      }
      const body = (await response
        .json()
        .catch(() => null)) as ProviderOrderBody | null;
      if (!body || typeof body.status !== 'string') {
        throw invalidResponse('get_order');
      }

      return toProviderOrder(body);
    },

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
  };
};
