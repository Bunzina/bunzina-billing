import type {
  PaymentLink,
  PaymentMailer,
} from '@/domain/payment/payment-mailer';

export const createFakePaymentMailer = () => {
  const sent: PaymentLink[] = [];
  let failure: Error | null = null;

  const mailer: PaymentMailer & {
    sent: PaymentLink[];
    failWith: (error: Error | null) => void;
  } = {
    async sendPaymentLink(link) {
      if (failure) {
        throw failure;
      }

      sent.push(link);
    },
    sent,
    failWith: (error) => {
      failure = error;
    },
  };

  return mailer;
};
