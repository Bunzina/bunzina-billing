import { describe, expect, it } from 'bun:test';
import { createPendingPayment, parsePaymentValidityMinutes } from './payment';

describe('parsePaymentValidityMinutes', () => {
  it('uses a configured value', () => {
    expect(parsePaymentValidityMinutes('45')).toBe(45);
  });

  it.each([undefined, '', '  ', 'abc', '0', '-5', '1.5', 'Infinity'])(
    'falls back to 30 minutes for %p',
    (raw) => {
      expect(parsePaymentValidityMinutes(raw)).toBe(30);
    },
  );
});

describe('createPendingPayment', () => {
  const input = {
    quoteId: '0193f2a1-4c7e-7000-8000-0000000000bb',
    serviceOrderId: '0193f2a1-4c7e-7000-8000-0000000000aa',
    amountCents: 21000,
    currency: 'BRL',
    now: new Date('2026-09-17T14:03:22.115Z'),
    validityMinutes: 30,
  };

  it('gives the same payment the same id every time it is created for a quote', () => {
    expect(createPendingPayment(input).id).toBe(
      createPendingPayment({ ...input, now: new Date() }).id,
    );
  });

  it('expires the payment after its validity', () => {
    expect(createPendingPayment(input).expiresAt).toEqual(
      new Date('2026-09-17T14:33:22.115Z'),
    );
  });

  it('gives different quotes different ids, shaped as UUIDs', () => {
    const other = createPendingPayment({
      ...input,
      quoteId: '0193f2a1-4c7e-7000-8000-0000000000bc',
    });

    expect(other.id).not.toBe(createPendingPayment(input).id);
    expect(other.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
