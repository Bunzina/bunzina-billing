import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createIssueQuoteHandler } from '@/application/quote/issue-quote';
import {
  approveQuote,
  cancelQuote,
  issueQuote,
  rejectQuote,
} from '@/domain/quote/quote';
import {
  startConsumer,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import { postgresMessageStore } from '@/infrastructure/messaging/message-store';
import {
  applyMigrations,
  countRows,
  db,
  resetQuoteTables,
} from '@/test/integration-database';
import { createFakeMailer } from '@/test/fake-mailer';
import { postgresPaymentRepository } from './postgres-payment-repository';
import { postgresQuoteRepository } from './postgres-quote-repository';

const NOW = new Date('2026-09-17T14:03:22.115Z');

const ack = mock(() => {});
const nack = mock(() => {});

let consumeCallback: ((message: unknown) => Promise<void>) | null = null;

const channel = {
  ack,
  nack,
  bindQueue: mock(async () => ({}) as never),
  consume: mock(async (_queue: string, callback: never) => {
    consumeCallback = callback as unknown as (
      message: unknown,
    ) => Promise<void>;
    return { consumerTag: 'tag' };
  }),
};

const startWith = (handler: MessageHandler) =>
  startConsumer({
    handlers: { 'cmd.billing.issue-quote': handler },
    bindings: ['cmd.billing.*'],
    channel: channel as never,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
  });

const issueQuoteMessage = (serviceOrderId: string) => {
  const envelope = buildEnvelope({
    eventType: 'cmd.billing.issue-quote',
    correlationId: serviceOrderId,
    data: {
      serviceOrderId,
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
    },
  });

  return {
    properties: { type: envelope.eventType, headers: {} },
    content: Buffer.from(JSON.stringify(envelope)),
  };
};

const issueHandler = createIssueQuoteHandler({
  quotes: postgresQuoteRepository,
  mailer: createFakeMailer(),
  clock: () => NOW,
  validityHours: 72,
});

const deliver = (message: unknown) => consumeCallback?.(message);

const newQuote = (serviceOrderId: string) =>
  issueQuote({
    serviceOrderId,
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
          priceCents: 100,
        },
      ],
      autoParts: [],
    },
    currency: 'BRL',
    now: NOW,
    validityHours: 72,
  });

describe('quotes against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetQuoteTables();
    ack.mockClear();
    nack.mockClear();
    consumeCallback = null;
  });

  it('stores the quote, the outbox event and the processed marker in one transaction', async () => {
    await startWith(issueHandler);
    const serviceOrderId = crypto.randomUUID();

    await deliver(issueQuoteMessage(serviceOrderId));

    const [event] = await db`
      SELECT payload FROM bunzina.outbox_messages
    `;
    const stored = await postgresQuoteRepository.findById(
      event?.payload.data.quoteId,
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(await countRows('bunzina.processed_events')).toBe(1);
    expect(stored).toMatchObject({
      serviceOrderId,
      status: 'ISSUED',
      servicesTotalCents: 12000,
      autoPartsTotalCents: 9000,
      totalCents: 21000,
      currency: 'BRL',
      customer: { document: '12345678901', email: 'maria@example.com' },
    });
    expect(stored?.items.autoParts[0]?.quantity).toBe(2);
    expect(stored?.expiresAt.toISOString()).toBe('2026-09-20T14:03:22.115Z');
  });

  it('rolls the quote back with the outbox event when the handler fails afterwards', async () => {
    await startWith(async (context) => {
      await issueHandler(context);
      throw new Error('boom');
    });

    await deliver(issueQuoteMessage(crypto.randomUUID()));

    expect(nack).toHaveBeenCalledTimes(1);
    expect(await countRows('bunzina.quotes')).toBe(0);
    expect(await countRows('bunzina.outbox_messages')).toBe(0);
    expect(await countRows('bunzina.processed_events')).toBe(0);
  });

  it('refuses a second active quote for the same service order, but allows one after a rejection', async () => {
    const serviceOrderId = crypto.randomUUID();
    const first = newQuote(serviceOrderId);

    await postgresMessageStore.transact((tx) =>
      postgresQuoteRepository.insert(tx, first),
    );

    await expect(
      postgresMessageStore.transact((tx) =>
        postgresQuoteRepository.insert(tx, newQuote(serviceOrderId)),
      ),
    ).rejects.toThrow();

    await db`UPDATE bunzina.quotes SET status = 'REJECTED' WHERE id = ${first.id}`;

    await postgresMessageStore.transact((tx) =>
      postgresQuoteRepository.insert(tx, newQuote(serviceOrderId)),
    );

    expect(await countRows('bunzina.quotes')).toBe(2);
  });

  it('persists each decision and reads it back, locking the row inside the transaction', async () => {
    const approved = newQuote(crypto.randomUUID());
    const rejected = newQuote(crypto.randomUUID());
    const canceled = newQuote(crypto.randomUUID());

    for (const quote of [approved, rejected, canceled]) {
      await postgresMessageStore.transact((tx) =>
        postgresQuoteRepository.insert(tx, quote),
      );
    }

    await postgresMessageStore.transact(async (tx) => {
      const locked = await postgresQuoteRepository.findByIdForUpdate(
        tx,
        approved.id,
      );

      await postgresQuoteRepository.update(
        tx,
        approveQuote(locked ?? approved, {
          approvedBy: '123.456.789-01',
          now: NOW,
        }),
      );
      await postgresQuoteRepository.update(
        tx,
        rejectQuote(rejected, { now: NOW }),
      );
      await postgresQuoteRepository.update(
        tx,
        cancelQuote(canceled, { now: NOW }),
      );
    });

    expect(await postgresQuoteRepository.findById(approved.id)).toMatchObject({
      status: 'APPROVED',
      approvedBy: '12345678901',
      approvedAt: NOW,
    });
    expect(await postgresQuoteRepository.findById(rejected.id)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'CUSTOMER_REQUEST',
      rejectedAt: NOW,
    });
    expect(await postgresQuoteRepository.findById(canceled.id)).toMatchObject({
      status: 'CANCELED',
      canceledAt: NOW,
    });
  });

  it('reads the status of the payment of a quote, locking it', async () => {
    const quote = newQuote(crypto.randomUUID());

    await postgresMessageStore.transact((tx) =>
      postgresQuoteRepository.insert(tx, quote),
    );
    await db`
      INSERT INTO bunzina.payments (id, quote_id, service_order_id, amount_cents)
      VALUES (${crypto.randomUUID()}, ${quote.id}, ${quote.serviceOrderId}, 100)
    `;

    expect(
      await postgresMessageStore.transact((tx) =>
        postgresPaymentRepository.findByQuoteIdForUpdate(tx, quote.id),
      ),
    ).toMatchObject({ status: 'PENDING' });

    await db`UPDATE bunzina.payments SET status = 'CONFIRMED' WHERE quote_id = ${quote.id}`;

    expect(
      await postgresMessageStore.transact((tx) =>
        postgresPaymentRepository.findByQuoteIdForUpdate(tx, quote.id),
      ),
    ).toMatchObject({ status: 'CONFIRMED' });
  });

  it('keeps a single quote when two commands for the same service order race', async () => {
    await startWith(issueHandler);
    const serviceOrderId = crypto.randomUUID();

    await Promise.all([
      deliver(issueQuoteMessage(serviceOrderId)),
      deliver(issueQuoteMessage(serviceOrderId)),
    ]);

    const events = await db`
      SELECT payload FROM bunzina.outbox_messages
    `;

    expect(ack).toHaveBeenCalledTimes(2);
    expect(await countRows('bunzina.quotes')).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.data.quoteId).toBe(
      events[1]?.payload.data.quoteId,
    );
  });

  it('finds nothing for an unknown quote', async () => {
    expect(
      await postgresQuoteRepository.findById(crypto.randomUUID()),
    ).toBeNull();
  });
});
