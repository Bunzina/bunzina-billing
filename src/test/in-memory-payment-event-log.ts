import type {
  PaymentEvent,
  PaymentEventLog,
} from '@/domain/payment/payment-event-log';

export const createInMemoryPaymentEventLog = () => {
  const events: PaymentEvent[] = [];

  const log: PaymentEventLog & { all: () => PaymentEvent[] } = {
    async record(_tx, event) {
      events.push(event);
    },
    all: () => [...events],
  };

  return log;
};
