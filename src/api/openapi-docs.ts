import openapi from '@elysiajs/openapi';
import type { DocumentDecoration } from 'elysia';
import type { OpenAPIV3 } from 'openapi-types';
import z from 'zod';

type ApiResponse = NonNullable<DocumentDecoration['responses']>[string];

export const errorResponse = (description: string): ApiResponse => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
});

const quoteSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    serviceOrderId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['ISSUED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED'],
    },
    items: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              serviceId: { type: 'string', format: 'uuid' },
              description: { type: 'string' },
              priceCents: { type: 'integer' },
            },
          },
        },
        autoParts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              autoPartId: { type: 'string', format: 'uuid' },
              description: { type: 'string' },
              quantity: { type: 'integer' },
              unitPriceCents: { type: 'integer' },
            },
          },
        },
      },
    },
    servicesTotalCents: { type: 'integer' },
    autoPartsTotalCents: { type: 'integer' },
    totalCents: { type: 'integer' },
    currency: { type: 'string', example: 'BRL' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

const quoteWithCheckoutSchema: OpenAPIV3.SchemaObject = {
  ...quoteSchema,
  properties: {
    ...quoteSchema.properties,
    checkoutUrl: {
      type: 'string',
      nullable: true,
      description:
        'Link do Checkout Pro; só vem enquanto o pagamento está pendente.',
    },
  },
};

export const quoteResponse = (
  description: string,
  withCheckoutUrl = false,
): ApiResponse => ({
  description,
  content: {
    'application/json': {
      schema: withCheckoutUrl ? quoteWithCheckoutSchema : quoteSchema,
    },
  },
});

export const openapiDocs = () =>
  openapi({
    documentation: {
      info: {
        title: 'bunzina-billing API',
        version: '1.0.0',
        description: 'Microsserviço do Bunzina — Fase 4.',
      },
      tags: [
        { name: 'Health', description: 'Verificação de saúde do serviço' },
        { name: 'Quotes', description: 'Orçamentos emitidos pelo Billing' },
        {
          name: 'Webhooks',
          description: 'Notificações do Mercado Pago',
        },
      ],
    },
    path: '/swagger',
    mapJsonSchema: { zod: z.toJSONSchema },
  });
