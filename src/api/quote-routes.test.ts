import { beforeEach, describe, expect, it } from 'bun:test';
import Elysia from 'elysia';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { quoteRoutes } from './quote-routes';

const NOW = new Date('2026-09-17T14:03:22.115Z');

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
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
  app = new Elysia().use(quoteRoutes({ quotes, clock: () => now }));
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
    });
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
