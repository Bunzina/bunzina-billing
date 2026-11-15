export type MailTransporter = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
};

export const formatMoney = (cents: number, currency: string): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(
    cents / 100,
  );

export const formatDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
