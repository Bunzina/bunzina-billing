import { beforeEach, describe, expect, it } from 'bun:test';
import Elysia from 'elysia';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import { createPendingPayment, attachCheckout } from '@/domain/payment/payment';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { quoteRoutes } from './quote-routes';

const NOW = new Date('2026-09-17T14:03:22.115Z');

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let now: Date;
let app: { handle: (request: Request) => Response | Promise<Response> };
let quote: Quote;

const get = (id: string, document?: string) =>
  app.handle(
    new Request(`http://localhost/quotes/${id}`, {
      headers: document ? { 'X-Customer-Document': document } : {},
    }),
  );

beforeEach(() => {
  now = NOW;
  quotes = createInMemoryQuoteRepository();
  payments = createInMemoryPaymentRepository();
  database = createInMemoryMessageStore();
  app = new Elysia().use(
    quoteRoutes({
      quotes,
      payments,
      store: database.store,
      clock: () => now,
    }),
  );
  quote = issueQuote({
    serviceOrderId: crypto.randomUUID(),
    customer: {
      id: crypto.randomUUID(),
      name: 'Maria Souza',
      document: '12345678901',
      email: 'maria@example.com',
    },
    items: {
      services: [
        {
          serviceId: crypto.randomUUID(),
          description: 'Troca de óleo',
          priceCents: 12000,
        },
      ],
      autoParts: [
        {
          autoPartId: crypto.randomUUID(),
          description: 'Filtro de óleo',
          quantity: 2,
          unitPriceCents: 4500,
        },
      ],
    },
    currency: 'BRL',
    now: NOW,
    validityHours: 72,
  });
  quotes.save(quote);
});

describe('GET /quotes/:id', () => {
  it('returns items, totals and status to the customer who owns the quote', async () => {
    const response = await get(quote.id, '12345678901');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: quote.id,
      serviceOrderId: quote.serviceOrderId,
      status: 'ISSUED',
      items: quote.items,
      servicesTotalCents: 12000,
      autoPartsTotalCents: 9000,
      totalCents: 21000,
      currency: 'BRL',
      expiresAt: '2026-09-20T14:03:22.115Z',
      checkoutUrl: null,
    });
  });

  it('returns the checkout link once the quote has a pending payment', async () => {
    payments.save(
      attachCheckout(
        createPendingPayment({
          quoteId: quote.id,
          serviceOrderId: quote.serviceOrderId,
          amountCents: quote.totalCents,
          currency: 'BRL',
          now: NOW,
          validityMinutes: 30,
        }),
        {
          providerPaymentId: 'ORDTST1',
          checkoutUrl:
            'https://www.mercadopago.com.br/checkout/v1/redirect?x=1',
        },
      ),
    );

    const body = (await (await get(quote.id, '12345678901')).json()) as {
      checkoutUrl: string | null;
    };

    expect(body.checkoutUrl).toBe(
      'https://www.mercadopago.com.br/checkout/v1/redirect?x=1',
    );
  });

  it('returns no checkout link when the payment failed', async () => {
    payments.save({
      ...createPendingPayment({
        quoteId: quote.id,
        serviceOrderId: quote.serviceOrderId,
        amountCents: quote.totalCents,
        currency: 'BRL',
        now: NOW,
        validityMinutes: 30,
      }),
      status: 'FAILED',
      failureReason: 'PROVIDER_ERROR',
    });

    const body = (await (await get(quote.id, '12345678901')).json()) as {
      checkoutUrl: string | null;
    };

    expect(body.checkoutUrl).toBeNull();
  });

  it('accepts the document with punctuation', async () => {
    expect((await get(quote.id, '123.456.789-01')).status).toBe(200);
  });

  it('answers 404 when the document does not match, as if the quote did not exist', async () => {
    const response = await get(quote.id, '99999999999');

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Maria');
  });

  it('answers 404 when the document header is missing', async () => {
    expect((await get(quote.id)).status).toBe(404);
  });

  it('answers 404 for an unknown quote', async () => {
    expect((await get(crypto.randomUUID(), '12345678901')).status).toBe(404);
  });

  it('answers 404 for an id that is not a UUID', async () => {
    expect((await get('abc', '12345678901')).status).toBe(404);
  });

  it('reports an issued quote past its validity as expired', async () => {
    now = new Date('2026-09-20T14:03:22.116Z');

    const body = (await (await get(quote.id, '12345678901')).json()) as {
      status: string;
    };

    expect(body.status).toBe('EXPIRED');
  });

  it('keeps the stored status of a quote that is not issued, even past its validity', async () => {
    quotes.save({ ...quote, status: 'APPROVED' });
    now = new Date('2026-10-01T00:00:00.000Z');

    const body = (await (await get(quote.id, '12345678901')).json()) as {
      status: string;
    };

    expect(body.status).toBe('APPROVED');
  });
});

const decide = (id: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost/quotes/${id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('POST /quotes/:id/approval', () => {
  it('approves an issued quote and publishes quote-approved', async () => {
    now = new Date('2026-09-17T14:20:00.000Z');

    const response = await decide(quote.id, {
      document: '123.456.789-01',
      decision: 'APPROVED',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: quote.id,
      status: 'APPROVED',
    });
    expect((await quotes.findById(quote.id))?.status).toBe('APPROVED');

    const [event, ...others] = database.pendingEvents();

    expect(others).toHaveLength(0);
    expect(event).toMatchObject({
      eventType: 'evt.billing.quote-approved',
      correlationId: quote.serviceOrderId,
      data: {
        serviceOrderId: quote.serviceOrderId,
        quoteId: quote.id,
        totalCents: 21000,
        currency: 'BRL',
        approvedBy: '12345678901',
        approvedAt: '2026-09-17T14:20:00.000Z',
      },
    });
  });

  it('rejects an issued quote and publishes quote-rejected as a customer request', async () => {
    const response = await decide(quote.id, {
      document: '12345678901',
      decision: 'REJECTED',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'REJECTED' });
    expect((await quotes.findById(quote.id))?.status).toBe('REJECTED');

    const [event, ...others] = database.pendingEvents();

    expect(others).toHaveLength(0);
    expect(event).toMatchObject({
      eventType: 'evt.billing.quote-rejected',
      correlationId: quote.serviceOrderId,
      data: {
        serviceOrderId: quote.serviceOrderId,
        quoteId: quote.id,
        reason: 'CUSTOMER_REQUEST',
        rejectedBy: '12345678901',
      },
    });
  });

  it('answers 404 and changes nothing when the document does not match', async () => {
    const response = await decide(quote.id, {
      document: '99999999999',
      decision: 'APPROVED',
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Maria');
    expect((await quotes.findById(quote.id))?.status).toBe('ISSUED');
    expect(database.outboxEvents()).toHaveLength(0);
  });

  it('answers 404 for an unknown quote and for an id that is not a UUID', async () => {
    const body = { document: '12345678901', decision: 'APPROVED' };

    expect((await decide(crypto.randomUUID(), body)).status).toBe(404);
    expect((await decide('abc', body)).status).toBe(404);
  });

  it.each([
    ['without a decision', { document: '12345678901' }],
    [
      'with an unknown decision',
      { document: '12345678901', decision: 'MAYBE' },
    ],
    ['without a document', { decision: 'APPROVED' }],
  ])('answers 400 for a body %s', async (_label, body) => {
    expect((await decide(quote.id, body)).status).toBe(400);
    expect(database.outboxEvents()).toHaveLength(0);
  });

  it.each(['APPROVED', 'REJECTED', 'CANCELED', 'EXPIRED'] as const)(
    'answers 409 for a quote that is already %s, without publishing anything',
    async (status) => {
      quotes.save({ ...quote, status });

      const response = await decide(quote.id, {
        document: '12345678901',
        decision: 'APPROVED',
      });

      expect(response.status).toBe(409);
      expect((await quotes.findById(quote.id))?.status).toBe(status);
      expect(database.outboxEvents()).toHaveLength(0);
    },
  );

  it('answers 409 when the same quote is decided a second time, and publishes only one event', async () => {
    const body = { document: '12345678901', decision: 'APPROVED' };

    expect((await decide(quote.id, body)).status).toBe(200);
    expect((await decide(quote.id, body)).status).toBe(409);
    expect(database.outboxEvents()).toHaveLength(1);
  });

  it('marks an issued quote as expired when it is decided after its validity, with no event', async () => {
    now = new Date('2026-09-20T14:03:22.116Z');

    const response = await decide(quote.id, {
      document: '12345678901',
      decision: 'APPROVED',
    });

    expect(response.status).toBe(409);
    expect((await quotes.findById(quote.id))?.status).toBe('EXPIRED');
    expect(database.outboxEvents()).toHaveLength(0);
  });

  it('still accepts the decision exactly at the expiry instant', async () => {
    now = new Date('2026-09-20T14:03:22.115Z');

    const response = await decide(quote.id, {
      document: '12345678901',
      decision: 'APPROVED',
    });

    expect(response.status).toBe(200);
  });

  it('does not expire the quote for a customer who does not own it', async () => {
    now = new Date('2026-09-20T14:03:22.116Z');

    const response = await decide(quote.id, {
      document: '99999999999',
      decision: 'APPROVED',
    });

    expect(response.status).toBe(404);
    expect((await quotes.findById(quote.id))?.status).toBe('ISSUED');
  });
});
