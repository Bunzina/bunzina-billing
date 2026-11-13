import { beforeEach, describe, expect, it } from 'bun:test';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createFakeMailer } from '@/test/fake-mailer';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import {
  emailFailuresTotal,
  quotesTotal,
} from '@/infrastructure/observability/metrics';
import { createIssueQuoteHandler } from './issue-quote';

const counterValue = async (
  counter: typeof quotesTotal | typeof emailFailuresTotal,
  labels: Record<string, string>,
) => {
  const { values } = await counter.get();

  return (
    values.find((entry) =>
      Object.entries(labels).every(
        ([key, value]) =>
          (entry.labels as Record<string, unknown>)[key] === value,
      ),
    )?.value ?? 0
  );
};

const NOW = new Date('2026-09-17T14:03:22.115Z');
const SERVICE_ORDER_ID = '0193f2a1-4c7e-7000-8000-0000000000aa';

const issueQuoteData = (overrides: Record<string, unknown> = {}) => ({
  serviceOrderId: SERVICE_ORDER_ID,
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
      {
        serviceId: crypto.randomUUID(),
        description: 'Alinhamento',
        priceCents: 8000,
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
  ...overrides,
});

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let mailer: ReturnType<typeof createFakeMailer>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;

beforeEach(async () => {
  quotes = createInMemoryQuoteRepository();
  database = createInMemoryMessageStore();
  mailer = createFakeMailer();
  harness = await createConsumerHarness(
    {
      'cmd.billing.issue-quote': createIssueQuoteHandler({
        quotes,
        mailer,
        clock: () => NOW,
        validityHours: 72,
      }),
    },
    database.store,
  );
});

describe('cmd.billing.issue-quote', () => {
  it('issues the quote with totals computed from the items and publishes quote-issued', async () => {
    const command = buildCommand({
      eventType: 'cmd.billing.issue-quote',
      correlationId: SERVICE_ORDER_ID,
      data: issueQuoteData(),
    });

    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(1);

    const [event] = database.pendingEvents();

    expect(event).toMatchObject({
      eventType: 'evt.billing.quote-issued',
      correlationId: SERVICE_ORDER_ID,
      causationId: command.eventId,
      data: {
        serviceOrderId: SERVICE_ORDER_ID,
        servicesTotalCents: 20000,
        autoPartsTotalCents: 9000,
        totalCents: 29000,
        currency: 'BRL',
        expiresAt: '2026-09-20T14:03:22.115Z',
      },
    });

    const stored = await quotes.findById(String(event?.data.quoteId));

    expect(stored).toMatchObject({
      serviceOrderId: SERVICE_ORDER_ID,
      status: 'ISSUED',
      totalCents: 29000,
    });
  });

  it.each([
    ['without any item', { items: { services: [], autoParts: [] } }],
    [
      'with a zero total',
      {
        items: {
          services: [
            {
              serviceId: crypto.randomUUID(),
              description: 'Cortesia',
              priceCents: 0,
            },
          ],
          autoParts: [],
        },
      },
    ],
    ['with a malformed customer', { customer: { name: 'Maria' } }],
    ['with a lowercase currency', { currency: 'brl' }],
  ])(
    'sends a payload %s straight to the DLQ without retrying',
    async (_label, overrides) => {
      await harness.deliver(
        buildCommand({
          eventType: 'cmd.billing.issue-quote',
          correlationId: SERVICE_ORDER_ID,
          data: issueQuoteData(overrides),
        }),
      );

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect(harness.ack).not.toHaveBeenCalled();
      expect(harness.sleep).not.toHaveBeenCalled();
      expect(quotes.all()).toHaveLength(0);
      expect(database.outboxEvents()).toHaveLength(0);
    },
  );

  it('does not create a second quote when the same command is redelivered', async () => {
    const command = buildCommand({
      eventType: 'cmd.billing.issue-quote',
      correlationId: SERVICE_ORDER_ID,
      data: issueQuoteData(),
    });

    await harness.deliver(command);
    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(quotes.all()).toHaveLength(1);
    expect(database.outboxEvents()).toHaveLength(1);
  });

  it('re-emits quote-issued for the active quote when a new command arrives for the same service order', async () => {
    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );
    const resend = buildCommand({
      eventType: 'cmd.billing.issue-quote',
      correlationId: SERVICE_ORDER_ID,
      data: issueQuoteData(),
    });

    await harness.deliver(resend);

    const [first, second] = database.outboxEvents();

    expect(quotes.all()).toHaveLength(1);
    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({
      eventType: 'evt.billing.quote-issued',
      causationId: resend.eventId,
      data: first?.data,
    });
  });

  it('issues a new quote once the previous one was rejected', async () => {
    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );
    const [rejected] = quotes.all();
    quotes.save({ ...rejected!, status: 'REJECTED' });

    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );

    expect(quotes.all()).toHaveLength(2);
    expect(
      quotes.all().filter((quote) => quote.status === 'ISSUED'),
    ).toHaveLength(1);
  });

  it('emails the quote to the customer once it is issued', async () => {
    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      serviceOrderId: SERVICE_ORDER_ID,
      totalCents: 29000,
      customer: { email: 'maria@example.com' },
    });
  });

  it('does not email again when the active quote is re-emitted', async () => {
    const data = issueQuoteData();

    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data,
      }),
    );
    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data,
      }),
    );

    expect(mailer.sent).toHaveLength(1);
  });

  it('still issues the quote when the email cannot be sent, and counts the failure', async () => {
    mailer.failWith(new Error('smtp down'));
    const before = await counterValue(emailFailuresTotal, {
      template: 'quote-issued',
    });

    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );

    expect(harness.ack).toHaveBeenCalledTimes(1);
    expect(quotes.all()).toHaveLength(1);
    expect(database.outboxEvents()).toHaveLength(1);
    expect(
      await counterValue(emailFailuresTotal, { template: 'quote-issued' }),
    ).toBe(before + 1);
  });

  it('counts issued quotes by status', async () => {
    const before = await counterValue(quotesTotal, { status: 'ISSUED' });

    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );

    expect(await counterValue(quotesTotal, { status: 'ISSUED' })).toBe(
      before + 1,
    );
  });

  it('sends an invalid command to the DLQ even when the service order already has an active quote', async () => {
    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData(),
      }),
    );

    await harness.deliver(
      buildCommand({
        eventType: 'cmd.billing.issue-quote',
        correlationId: SERVICE_ORDER_ID,
        data: issueQuoteData({ items: { services: [], autoParts: [] } }),
      }),
    );

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect(database.outboxEvents()).toHaveLength(1);
  });
});
