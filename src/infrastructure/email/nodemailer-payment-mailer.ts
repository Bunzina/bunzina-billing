import type { PaymentMailer } from '@/domain/payment/payment-mailer';
import {
  formatDateTime,
  formatMoney,
  type MailTransporter,
} from './mail-format';

type Input = {
  transporter: MailTransporter;
  from: string;
};

export const createNodemailerPaymentMailer = ({
  transporter,
  from,
}: Input): PaymentMailer => ({
  async sendPaymentLink({ quote, checkoutUrl, expiresAt }) {
    await transporter.sendMail({
      from,
      to: quote.customer.email,
      subject: 'Link de pagamento do seu orçamento',
      text: [
        `Olá, ${quote.customer.name}!`,
        '',
        'Seu orçamento foi aprovado. Pague por PIX ou cartão pelo link abaixo.',
        '',
        `Total: ${formatMoney(quote.totalCents, quote.currency)}`,
        `Link válido até: ${formatDateTime(expiresAt)}`,
        '',
        checkoutUrl,
        '',
        `Orçamento: ${quote.id}`,
      ].join('\n'),
    });
  },
});
