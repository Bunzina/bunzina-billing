import type { Quote } from '@/domain/quote/quote';
import type { QuoteMailer } from '@/domain/quote/quote-mailer';
import {
  formatDateTime,
  formatMoney,
  type MailTransporter,
} from './mail-format';

type Input = {
  transporter: MailTransporter;
  from: string;
};

const buildText = (quote: Quote): string => {
  const money = (cents: number) => formatMoney(cents, quote.currency);

  const services = quote.items.services.map(
    (service) => `- ${service.description}: ${money(service.priceCents)}`,
  );
  const autoParts = quote.items.autoParts.map(
    (part) =>
      `- ${part.quantity} x ${part.description}: ${money(part.quantity * part.unitPriceCents)}`,
  );

  return [
    `Olá, ${quote.customer.name}!`,
    '',
    'O orçamento do seu veículo está pronto.',
    '',
    'Serviços',
    ...services,
    '',
    'Peças',
    ...autoParts,
    '',
    `Total: ${money(quote.totalCents)}`,
    `Válido até: ${formatDateTime(quote.expiresAt)}`,
    '',
    `Orçamento: ${quote.id}`,
  ].join('\n');
};

export const createNodemailerQuoteMailer = ({
  transporter,
  from,
}: Input): QuoteMailer => ({
  async sendQuoteIssued(quote) {
    await transporter.sendMail({
      from,
      to: quote.customer.email,
      subject: 'Orçamento do seu veículo',
      text: buildText(quote),
    });
  },
});
