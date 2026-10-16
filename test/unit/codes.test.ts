import { describe, expect, it } from 'vitest';
import { formatRecordCode, isRecordCode } from '../../src/contracts/codes.js';

describe('record codes', () => {
  it('formats a code with zero padding', () => {
    expect(formatRecordCode('DMD', 7)).toBe('DMD-000007');
    expect(formatRecordCode('POL', 1234567)).toBe('POL-1234567');
  });

  it('rejects invalid prefixes and sequences', () => {
    expect(() => formatRecordCode('dmd', 1)).toThrow();
    expect(() => formatRecordCode('D', 1)).toThrow();
    expect(() => formatRecordCode('DMD', 0)).toThrow();
    expect(() => formatRecordCode('DMD', 1.5)).toThrow();
  });

  it('recognises valid codes', () => {
    expect(isRecordCode('DSL-000001')).toBe(true);
    expect(isRecordCode('DSL-1')).toBe(false);
    expect(isRecordCode('dsl-000001')).toBe(false);
  });
});
