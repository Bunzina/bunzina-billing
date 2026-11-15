import { describe, expect, it } from 'bun:test';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { mercadopagoRequestDurationSeconds } from '@/infrastructure/observability/metrics';
import orderCreated from '../../../docs/mercadopago/fixtures/order-create.json';
import { createMercadoPagoPaymentGateway } from './mercadopago-payment-gateway';

const PAYMENT_ID = '0193f2a1-4c7e-7000-8000-0000000000cc';

const request = {
  paymentId: PAYMENT_ID,
  amountCents: 21005,
  currency: 'BRL',
  description: 'Orçamento 0193f2a1',
  expiresInMinutes: 30,
};

type Call = { url: string; init: RequestInit };

const gatewayAnswering = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const gateway = createMercadoPagoPaymentGateway({
    accessToken: 'TEST-TOKEN',
    baseUrl: 'https://api.mercadopago.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond();
    },
  });

  return { gateway, calls };
};

const histogramCount = async (labels: Record<string, string>) => {
  const { values } = await mercadopagoRequestDurationSeconds.get();

  return (
    values.find(
      (entry) =>
        entry.metricName?.endsWith('_count') &&
        Object.entries(labels).every(
          ([key, value]) =>
            (entry.labels as Record<string, unknown>)[key] === value,
        ),
    )?.value ?? 0
  );
};

describe('MercadoPagoPaymentGateway.createCheckout', () => {
  it('creates a Checkout Pro order over HTTP and returns the order id and checkout link', async () => {
    const { gateway, calls } = gatewayAnswering(() =>
      Response.json(orderCreated.response, { status: 201 }),
    );

    const checkout = await gateway.createCheckout(request);

    expect(checkout).toEqual({
      providerPaymentId: orderCreated.response.id,
      checkoutUrl: orderCreated.response.checkout_url,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.mercadopago.test/v1/orders');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer TEST-TOKEN',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': PAYMENT_ID,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: 'online',
      processing_mode: 'manual',
      total_amount: '210.05',
      external_reference: PAYMENT_ID,
      expiration_time: 'PT30M',
      items: [
        { title: 'Orçamento 0193f2a1', unit_price: '210.05', quantity: 1 },
      ],
      config: { payment_method: { not_allowed_types: ['ticket'] } },
    });
  });

  it.each([
    [5, '0.05'],
    [100, '1.00'],
    [123456789, '1234567.89'],
  ])(
    'converts %d cents to the provider amount %s only at the edge',
    async (cents, expected) => {
      const { gateway, calls } = gatewayAnswering(() =>
        Response.json(orderCreated.response, { status: 201 }),
      );

      await gateway.createCheckout({ ...request, amountCents: cents });

      expect(JSON.parse(String(calls[0]?.init.body)).total_amount).toBe(
        expected,
      );
    },
  );

  it.each([
    [500, true, 'http_500'],
    [503, true, 'http_503'],
    [429, true, 'http_429'],
    [400, false, 'http_400'],
    [401, false, 'http_401'],
  ])(
    'maps a %d answer to a retryable=%s error',
    async (status, retryable, providerStatus) => {
      const { gateway } = gatewayAnswering(() =>
        Response.json({ message: 'nope' }, { status }),
      );

      const error = await gateway.createCheckout(request).catch((e) => e);

      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect(error).toMatchObject({ retryable, providerStatus });
      expect(error.message).not.toContain('TEST-TOKEN');
    },
  );

  it('treats a network failure as retryable', async () => {
    const { gateway } = gatewayAnswering(() => {
      throw new TypeError('fetch failed');
    });

    const error = await gateway.createCheckout(request).catch((e) => e);

    expect(error).toMatchObject({
      retryable: true,
      providerStatus: 'unreachable',
    });
  });

  it('rejects an answer without the order id or the checkout link', async () => {
    const { gateway } = gatewayAnswering(() =>
      Response.json({ id: 'ORD1' }, { status: 201 }),
    );

    const error = await gateway.createCheckout(request).catch((e) => e);

    expect(error).toMatchObject({
      retryable: false,
      providerStatus: 'invalid_response',
    });
  });

  it('refuses a currency other than BRL without calling the provider', async () => {
    const { gateway, calls } = gatewayAnswering(() =>
      Response.json(orderCreated.response, { status: 201 }),
    );

    const error = await gateway
      .createCheckout({ ...request, currency: 'USD' })
      .catch((e) => e);

    expect(error).toMatchObject({
      retryable: false,
      providerStatus: 'unsupported_currency',
    });
    expect(calls).toHaveLength(0);
  });

  it('records the call duration by operation and result', async () => {
    const success = { operation: 'create_order', result: 'success' };
    const failure = { operation: 'create_order', result: 'error' };
    const beforeSuccess = await histogramCount(success);
    const beforeFailure = await histogramCount(failure);

    await gatewayAnswering(() =>
      Response.json(orderCreated.response, { status: 201 }),
    ).gateway.createCheckout(request);
    await gatewayAnswering(() => Response.json({}, { status: 500 }))
      .gateway.createCheckout(request)
      .catch(() => {});

    expect(await histogramCount(success)).toBe(beforeSuccess + 1);
    expect(await histogramCount(failure)).toBe(beforeFailure + 1);
  });
});
