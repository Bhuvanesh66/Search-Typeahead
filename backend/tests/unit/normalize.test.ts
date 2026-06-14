import { describe, it, expect } from 'vitest';
import { normalize, normalizePrefix, normalizeQuery } from '../../src/utils/normalize.js';

describe('normalize', () => {
  it('lowercases and trims', () => {
    expect(normalize('  IPhone  ')).toBe('iphone');
  });

  it('collapses internal whitespace', () => {
    expect(normalize('iphone\t\t 15   pro')).toBe('iphone 15 pro');
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalize('')).toBe('');
    expect(normalize('   ')).toBe('');
  });

  it('bounds prefix length', () => {
    const long = 'a'.repeat(500);
    expect(normalizePrefix(long).length).toBe(100);
  });

  it('bounds query length', () => {
    const long = 'b'.repeat(500);
    expect(normalizeQuery(long).length).toBe(200);
  });
});
