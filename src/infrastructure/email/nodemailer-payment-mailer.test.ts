import { describe, expect, it, mock } from 'bun:test';
import type { Quote } from '@/domain/quote/quote';
import { createNodemailerPaymentMailer } from './nodemailer-payment-mailer';

const quote = {
  id: '0193f2a1-4c7e-7000-8000-0000000000bb',
  customer: {
    id: crypto.randomUUID(),
    name: 'Maria Souza',
    document: '12345678901',
    email: 'maria@example.com',
  },
  totalCents: 21000,
  currency: 'BRL',
} as Quote;

const link = {
  quote,
  checkoutUrl: 'https://www.mercadopago.com.br/checkout/v1/redirect?x=1',
  expiresAt: new Date('2026-09-17T17:33:22.115Z'),
};

describe('createNodemailerPaymentMailer', () => {
  it('sends the checkout link with the total and the deadline to the customer', async () => {
    const sendMail = mock(async (_message: unknown) => ({}));
    const mailer = createNodemailerPaymentMailer({
      transporter: { sendMail },
      from: 'oficina@example.com',
    });

    await mailer.sendPaymentLink(link);

    const [message] = sendMail.mock.calls[0] as [
      { from: string; to: string; subject: string; text: string },
    ];

    expect(message.from).toBe('oficina@example.com');
    expect(message.to).toBe('maria@example.com');
    expect(message.subject).toContain('pagamento');
    expect(message.text).toContain('Maria Souza');
    expect(message.text).toContain(link.checkoutUrl);
    expect(message.text).toContain('210,00');
    expect(message.text).toContain('17/09/2026');
  });

  it('lets a delivery failure reach the caller', async () => {
    const mailer = createNodemailerPaymentMailer({
      transporter: {
        sendMail: async () => {
          throw new Error('ECONNECTION');
        },
      },
      from: 'oficina@example.com',
    });

    await expect(mailer.sendPaymentLink(link)).rejects.toThrow('ECONNECTION');
  });
});
