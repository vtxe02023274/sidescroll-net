import { Button } from './physics.js';

/**
 * Input for a simple bot. It walks right for a while so bots spread over the
 * map, then wanders left and right, jumps and swings now and then.
 */
export function botInput(tick: number, seed: number): number {
  if (tick < seed * 3) return Button.Right;
  const phase = Math.floor((tick + seed * 37) / 60) % 3;
  let b = phase === 0 ? Button.Right : phase === 1 ? Button.Left : 0;
  if ((tick + seed) % 50 < 3) b |= Button.Jump;
  if ((tick + seed * 7) % 40 === 0) b |= Button.Attack;
  return b;
}
