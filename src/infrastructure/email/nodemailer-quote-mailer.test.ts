import { describe, expect, it, mock } from 'bun:test';
import type { Quote } from '@/domain/quote/quote';
import { createNodemailerQuoteMailer } from './nodemailer-quote-mailer';

const quote: Quote = {
  id: '0193f2a1-4c7e-7000-8000-0000000000bb',
  serviceOrderId: '0193f2a1-4c7e-7000-8000-0000000000aa',
  customer: {
    id: crypto.randomUUID(),
    name: 'Maria Souza',
    document: '12345678901',
    email: 'maria@example.com',
  },
  status: 'ISSUED',
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
  servicesTotalCents: 12000,
  autoPartsTotalCents: 9000,
  totalCents: 21000,
  currency: 'BRL',
  expiresAt: new Date('2026-09-20T17:03:22.115Z'),
  createdAt: new Date('2026-09-17T17:03:22.115Z'),
};

describe('createNodemailerQuoteMailer', () => {
  it('sends the quote to the customer with items, total and validity', async () => {
    const sendMail = mock(async (_message: unknown) => ({}));
    const mailer = createNodemailerQuoteMailer({
      transporter: { sendMail },
      from: 'oficina@example.com',
    });

    await mailer.sendQuoteIssued(quote);

    expect(sendMail).toHaveBeenCalledTimes(1);

    const [message] = sendMail.mock.calls[0] as [
      { from: string; to: string; subject: string; text: string },
    ];

    expect(message.from).toBe('oficina@example.com');
    expect(message.to).toBe('maria@example.com');
    expect(message.subject).toContain('Orçamento');
    expect(message.text).toContain('Maria Souza');
    expect(message.text).toContain('Troca de óleo');
    expect(message.text).toContain('2 x Filtro de óleo');
    expect(message.text).toContain('210,00');
    expect(message.text).toContain('20/09/2026');
  });

  it('lets a delivery failure reach the caller', async () => {
    const mailer = createNodemailerQuoteMailer({
      transporter: {
        sendMail: async () => {
          throw new Error('ECONNECTION');
        },
      },
      from: 'oficina@example.com',
    });

    await expect(mailer.sendQuoteIssued(quote)).rejects.toThrow('ECONNECTION');
  });
});
