/** A client with more than this queued is not reading fast enough: skip its snapshots. */
export const SKIP_ABOVE = 64 * 1024;
/** A client with more than this queued is not reading at all: drop it. */
export const DROP_ABOVE = 1024 * 1024;

export type Backpressure = 'send' | 'skip' | 'drop';

/** Decides what to do with the next snapshot given how many bytes are still queued for a socket. */
export function backpressure(bufferedAmount: number): Backpressure {
  if (bufferedAmount > DROP_ABOVE) return 'drop';
  if (bufferedAmount > SKIP_ABOVE) return 'skip';
  return 'send';
}
