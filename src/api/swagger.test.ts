import { beforeAll, describe, expect, it } from 'bun:test';
import Elysia from 'elysia';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { openapiDocs } from './openapi-docs';
import { quoteRoutes } from './quote-routes';
import { webhookRoutes } from './webhook-routes';

type Operation = {
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: {
    content: Record<string, { schema?: { properties?: object } }>;
  };
  responses?: Record<string, unknown>;
};

let paths: Record<string, Record<string, Operation>>;

beforeAll(async () => {
  const app = new Elysia()
    .use(openapiDocs())
    .use(
      quoteRoutes({
        quotes: createInMemoryQuoteRepository(),
        payments: createInMemoryPaymentRepository(),
        store: createInMemoryMessageStore().store,
        clock: () => new Date(),
      }),
    )
    .use(
      webhookRoutes({
        secret: 'test-secret',
        handleNotification: async () => 'processed' as const,
      }),
    );
  const response = await app.handle(
    new Request('http://localhost/swagger/json'),
  );

  ({ paths } = (await response.json()) as { paths: typeof paths });
});

describe('Swagger document', () => {
  it('documents GET /quotes/:id with the customer document header and its responses', () => {
    const operation = paths['/quotes/{id}']?.get;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'x-customer-document',
        in: 'header',
        required: true,
      }),
    );
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404']),
    );
  });

  it('documents POST /quotes/:id/approval with the decision body and its responses', () => {
    const operation = paths['/quotes/{id}/approval']?.post;

    expect(operation).toBeDefined();
    expect(
      Object.keys(
        operation?.requestBody?.content['application/json']?.schema
          ?.properties ?? {},
      ),
    ).toEqual(expect.arrayContaining(['document', 'decision']));
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '404', '409']),
    );
  });

  it('documents POST /webhooks/mercadopago with the signature headers and its responses', () => {
    const operation = paths['/webhooks/mercadopago']?.post;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'x-signature', in: 'header' }),
        expect.objectContaining({ name: 'x-request-id', in: 'header' }),
      ]),
    );
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '502']),
    );
  });
});
