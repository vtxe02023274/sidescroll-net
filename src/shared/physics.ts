import { footholdContains, footholdY, type GameMap, type LinkedFoothold } from './map.js';

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export const Button = {
  Left: 1,
  Right: 2,
  Jump: 4,
  Down: 8,
  Attack: 16,
  Up: 32,
} as const;

export const Physics = {
  walkSpeed: 125,
  groundAccel: 1000,
  groundFriction: 1400,
  airAccel: 400,
  gravity: 2000,
  maxFall: 670,
  jumpSpeed: 600,
  dropThroughTicks: 8,
  attackTicks: 10,
  hurtTicks: 12,
  knockbackX: 300,
  knockbackY: 350,
  climbSpeed: 100,
  /** How far from a rope a player can be and still grab it. */
  ropeReach: 8,
  /** Ticks after letting go of a rope before grabbing one again. */
  ropeCooldown: 10,
  ropeJumpSpeed: 360,
} as const;

/** Everything the simulation needs to step one player. Plain data so it can be copied and sent. */
export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Foothold id the player stands on, 0 when airborne. */
  foothold: number;
  facing: 1 | -1;
  /** Foothold being dropped through and how many ticks it stays ignored. */
  dropFoothold: number;
  dropTicks: number;
  /** Jump needs a fresh press, holding the button does not bounce. */
  jumpHeld: boolean;
  /** Ticks left in the current swing. A new attack can start at 0. */
  attackTicks: number;
  /** Ticks left of knockback, during which input is ignored. */
  hurtTicks: number;
  /** Rope id the player is climbing, 0 when not on a rope. */
  rope: number;
  ropeCooldown: number;
}

export function spawnPlayer(map: GameMap): PlayerState {
  return {
    x: map.data.spawn.x,
    y: map.data.spawn.y,
    vx: 0,
    vy: 0,
    foothold: 0,
    facing: 1,
    dropFoothold: 0,
    dropTicks: 0,
    jumpHeld: false,
    attackTicks: 0,
    hurtTicks: 0,
    rope: 0,
    ropeCooldown: 0,
  };
}

/** True on the tick a swing begins, which is when the server checks for hits. */
export function attackStarted(prev: PlayerState, next: PlayerState): boolean {
  return prev.attackTicks === 0 && next.attackTicks === Physics.attackTicks;
}

/** Knocks a player away from the attacker. Only the server calls this. */
export function applyHit(target: PlayerState, attackerFacing: 1 | -1): PlayerState {
  return {
    ...target,
    vx: Math.fround(attackerFacing * Physics.knockbackX),
    vy: Math.fround(-Physics.knockbackY),
    foothold: 0,
    hurtTicks: Physics.hurtTicks,
  };
}

function approach(value: number, target: number, delta: number): number {
  if (value < target) return Math.min(value + delta, target);
  return Math.max(value - delta, target);
}

function inputDirection(buttons: number): number {
  return (buttons & Button.Right ? 1 : 0) - (buttons & Button.Left ? 1 : 0);
}

/**
 * Advances a player by one fixed tick. The same function runs on the server
 * and on the client for prediction, so it must stay deterministic: no clocks,
 * no randomness, only the state, the buttons and the map.
 */
export function step(map: GameMap, prev: PlayerState, buttons: number): PlayerState {
  const s: PlayerState = { ...prev };
  const stunned = s.hurtTicks > 0;
  const dir = stunned ? 0 : inputDirection(buttons);
  const jumpPressed = !stunned && (buttons & Button.Jump) !== 0 && !s.jumpHeld;
  s.jumpHeld = (buttons & Button.Jump) !== 0;
  if (dir !== 0) s.facing = dir > 0 ? 1 : -1;

  if (s.dropTicks > 0 && --s.dropTicks === 0) s.dropFoothold = 0;
  if (s.hurtTicks > 0) s.hurtTicks--;
  if (s.attackTicks > 0) s.attackTicks--;
  else if (!stunned && buttons & Button.Attack) s.attackTicks = Physics.attackTicks;

  if (s.ropeCooldown > 0) s.ropeCooldown--;
  if (s.rope === 0 && !stunned) grabRope(map, s, buttons);

  if (s.rope !== 0) {
    stepRope(map, s, dir, buttons, jumpPressed);
  } else if (s.foothold !== 0) {
    stepGround(map, s, dir, buttons, jumpPressed);
  } else {
    stepAir(map, s, dir);
  }

  const { left, right, bottom } = map.data;
  if (s.x < left) {
    s.x = left;
    s.vx = 0;
  } else if (s.x > right) {
    s.x = right;
    s.vx = 0;
  }
  if (s.y > bottom) {
    // Fell out of the map, put the player back at the spawn point.
    Object.assign(s, spawnPlayer(map), { facing: s.facing, jumpHeld: s.jumpHeld });
  }

  // Snapshots carry f32, so keep the simulation on f32 values too. Then a
  // client replaying from a snapshot ends up exactly where the server did.
  s.x = Math.fround(s.x);
  s.y = Math.fround(s.y);
  s.vx = Math.fround(s.vx);
  s.vy = Math.fround(s.vy);

  return s;
}

/**
 * Up grabs a rope the player overlaps. Down grabs one whose top is under a
 * player standing on a foothold, so ladders can be climbed down from above.
 */
function grabRope(map: GameMap, s: PlayerState, buttons: number): void {
  if (s.ropeCooldown > 0 || !(buttons & (Button.Up | Button.Down))) return;
  for (const rope of map.ropes.values()) {
    if (Math.abs(s.x - rope.x) > Physics.ropeReach) continue;
    const fromBelow = buttons & Button.Up && s.y > rope.y1 && s.y <= rope.y2;
    const fromAbove =
      buttons & Button.Down &&
      s.foothold !== 0 &&
      Math.abs(s.y - rope.y1) < 2 &&
      !(buttons & Button.Up);
    if (fromBelow || fromAbove) {
      s.rope = rope.id;
      s.x = rope.x;
      s.vx = 0;
      s.vy = 0;
      s.foothold = 0;
      return;
    }
  }
}

function stepRope(
  map: GameMap,
  s: PlayerState,
  dir: number,
  buttons: number,
  jumpPressed: boolean,
): void {
  const rope = map.ropes.get(s.rope)!;
  // Jump off sideways; a jump without a direction keeps holding on.
  if (jumpPressed && dir !== 0) {
    s.rope = 0;
    s.ropeCooldown = Physics.ropeCooldown;
    s.vx = dir * Physics.walkSpeed;
    s.vy = -Physics.ropeJumpSpeed;
    return;
  }

  const climb = (buttons & Button.Down ? 1 : 0) - (buttons & Button.Up ? 1 : 0);
  s.y += climb * Physics.climbSpeed * DT;
  s.vx = 0;
  s.vy = 0;

  if (s.y <= rope.y1) {
    s.y = rope.y1;
    // Reached the top: step onto the foothold there, or stay at the end.
    const top = [...map.footholds.values()].find(
      (fh) => footholdContains(fh, s.x) && Math.abs(footholdY(fh, s.x) - rope.y1) < 2,
    );
    if (top) {
      s.rope = 0;
      s.ropeCooldown = Physics.ropeCooldown;
      s.foothold = top.id;
      s.y = footholdY(top, s.x);
    }
  } else if (s.y > rope.y2) {
    s.rope = 0;
    s.ropeCooldown = Physics.ropeCooldown;
  }
}

function stepGround(
  map: GameMap,
  s: PlayerState,
  dir: number,
  buttons: number,
  jumpPressed: boolean,
): void {
  if (jumpPressed) {
    if (buttons & Button.Down) {
      s.dropFoothold = s.foothold;
      s.dropTicks = Physics.dropThroughTicks;
      s.vy = 0;
    } else {
      s.vy = -Physics.jumpSpeed;
    }
    s.foothold = 0;
    stepAir(map, s, dir);
    return;
  }

  if (dir !== 0) {
    s.vx = approach(s.vx, dir * Physics.walkSpeed, Physics.groundAccel * DT);
  } else {
    s.vx = approach(s.vx, 0, Physics.groundFriction * DT);
  }
  s.vy = 0;

  let fh = map.footholds.get(s.foothold) as LinkedFoothold;
  const x = s.x + s.vx * DT;

  // Follow linked footholds; walking past an unlinked end means falling off.
  while (x > fh.x2 || x < fh.x1) {
    const nextId = x > fh.x2 ? fh.next : fh.prev;
    const next = nextId ? map.footholds.get(nextId) : undefined;
    if (!next) {
      s.foothold = 0;
      s.x = x;
      s.y = footholdY(fh, x > fh.x2 ? fh.x2 : fh.x1);
      return;
    }
    fh = next;
  }

  s.foothold = fh.id;
  s.x = x;
  s.y = footholdY(fh, x);
}

function stepAir(map: GameMap, s: PlayerState, dir: number): void {
  if (dir !== 0) {
    s.vx = approach(s.vx, dir * Physics.walkSpeed, Physics.airAccel * DT);
  }
  s.vy = Math.min(s.vy + Physics.gravity * DT, Physics.maxFall);

  const x0 = s.x;
  const y0 = s.y;
  const x1 = x0 + s.vx * DT;
  const y1 = y0 + s.vy * DT;

  s.x = x1;
  s.y = y1;
  if (s.vy < 0) return;

  // Land on the highest foothold the feet crossed during this tick.
  let best: LinkedFoothold | undefined;
  let bestY = Infinity;
  for (const fh of map.footholds.values()) {
    if (fh.id === s.dropFoothold) continue;
    if (!footholdContains(fh, x1)) continue;
    const before = footholdY(fh, Math.min(Math.max(x0, fh.x1), fh.x2));
    const after = footholdY(fh, x1);
    if (y0 <= before + 0.01 && y1 >= after && after < bestY) {
      best = fh;
      bestY = after;
    }
  }

  if (best) {
    s.foothold = best.id;
    s.y = bestY;
    s.vy = 0;
  }
}
