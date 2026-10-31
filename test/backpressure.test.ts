import { describe, expect, it } from 'vitest';
import { backpressure, DROP_ABOVE, SKIP_ABOVE } from '../src/server/backpressure.js';

describe('backpressure', () => {
  it('sends while the queue is small', () => {
    expect(backpressure(0)).toBe('send');
    expect(backpressure(SKIP_ABOVE)).toBe('send');
  });

  it('skips snapshots for a client that falls behind', () => {
    expect(backpressure(SKIP_ABOVE + 1)).toBe('skip');
    expect(backpressure(DROP_ABOVE)).toBe('skip');
  });

  it('drops a client that stopped reading', () => {
    expect(backpressure(DROP_ABOVE + 1)).toBe('drop');
  });
});
