import { describe, expect, it } from 'bun:test';
import { parseValidityHours } from './quote';

describe('parseValidityHours', () => {
  it.each([
    ['48', 48],
    ['1.5', 1.5],
  ])('uses a configured value of %s', (raw, expected) => {
    expect(parseValidityHours(raw)).toBe(expected);
  });

  it.each([undefined, '', '  ', 'abc', '0', '-5', 'Infinity'])(
    'falls back to 72 hours for %p',
    (raw) => {
      expect(parseValidityHours(raw)).toBe(72);
    },
  );
});
