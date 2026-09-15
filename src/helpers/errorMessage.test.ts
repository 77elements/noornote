import { describe, expect, it } from 'vitest';
import { errMessage } from './errorMessage';

describe('errMessage', () => {
  it('returns the message of an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('returns subclasses of Error via instanceof (DOMException)', () => {
    expect(errMessage(new DOMException('denied', 'NotAllowedError'))).toBe(
      'denied'
    );
  });

  it('returns plain strings as-is', () => {
    expect(errMessage('timeout')).toBe('timeout');
  });

  it('stringifies non-Error values without recursing', () => {
    expect(errMessage(42)).toBe('42');
    expect(errMessage({ code: 1 })).toBe('[object Object]');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
  });
});
