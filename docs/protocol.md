# sidescroll-net

Version 1 · little-endian · u8 opcode

Clients send buttons, the server answers with snapshots of every player in view. Receivers reject a message that is shorter or longer than its fields (Input is exactly 10 bytes with the opcode, Welcome 4) and a snapshot that lists the same entity id twice.

Every packet starts with its opcode, followed by the fields below in order.
Strings are UTF-8; their length prefix counts bytes, not characters.

## Packets

| Opcode | Packet                          | Direction       | Body size |
| ------ | ------------------------------- | --------------- | --------- |
| `0x01` | [Input](#input)                 | client → server | 9         |
| `0x02` | [Welcome](#welcome)             | server → client | 3         |
| `0x03` | [Snapshot](#snapshot)           | server → client | 10+       |
| `0x04` | [SnapshotDelta](#snapshotdelta) | server → client | 14+       |

### Input

Opcode `0x01` · client → server

Buttons for one client tick. Every input moves the player exactly one step.

| Field       | Type | Size (bytes) | Description                                                                     |
| ----------- | ---- | ------------ | ------------------------------------------------------------------------------- |
| `seq`       | u32  | 4            |                                                                                 |
| `buttons`   | u8   | 1            | Bit 0 left, bit 1 right, bit 2 jump, bit 3 down, bit 4 attack, bit 5 up.        |
| `view_tick` | u32  | 4            | Server tick the client was showing other players at. Used to rewind hit checks. |

### Welcome

Opcode `0x02` · server → client

First message after connecting.

| Field       | Type | Size (bytes) | Description |
| ----------- | ---- | ------------ | ----------- |
| `player_id` | u16  | 2            |             |
| `tick_rate` | u8   | 1            |             |

### Snapshot

Opcode `0x03` · server → client

Sent every other tick.

| Field      | Type                            | Size (bytes) | Description                                             |
| ---------- | ------------------------------- | ------------ | ------------------------------------------------------- |
| `tick`     | u32                             | 4            |                                                         |
| `ack_seq`  | u32                             | 4            | Last input sequence the server applied for this client. |
| `entities` | [Entity](#entity)[] (u16 count) | 2 + 29n      |                                                         |

### SnapshotDelta

Opcode `0x04` · server → client

Snapshot sent as the changes from an earlier one, usually the previous one sent on the connection. Followed by `count` entities, each a u16 id, a u16 mask and then only the Entity fields after the id whose mask bit is set, bit 0 for x up to bit 11 for rope_cooldown, in Entity order. Bits 12 to 15 must be 0. Every entity of the snapshot is listed once, an entity that was not in the base has every bit set, and the message ends right after the last entity. The entity list is left out here because its fields depend on the mask.

| Field       | Type | Size (bytes) | Description                                             |
| ----------- | ---- | ------------ | ------------------------------------------------------- |
| `tick`      | u32  | 4            |                                                         |
| `ack_seq`   | u32  | 4            | Last input sequence the server applied for this client. |
| `base_tick` | u32  | 4            | Tick of the snapshot the changes are from.              |
| `count`     | u16  | 2            |                                                         |

## Structs

### Entity

One player as of the snapshot tick.

| Field           | Type | Size (bytes) | Description                                                    |
| --------------- | ---- | ------------ | -------------------------------------------------------------- |
| `id`            | u16  | 2            |                                                                |
| `x`             | f32  | 4            |                                                                |
| `y`             | f32  | 4            | Feet position, y grows downward.                               |
| `vx`            | f32  | 4            |                                                                |
| `vy`            | f32  | 4            |                                                                |
| `foothold`      | u16  | 2            | Foothold the player stands on, 0 when airborne.                |
| `flags`         | u8   | 1            | Bit 0 facing left, bit 1 jump held.                            |
| `drop_foothold` | u16  | 2            | Foothold being dropped through.                                |
| `drop_ticks`    | u8   | 1            | Ticks left before the dropped foothold can be landed on again. |
| `attack_ticks`  | u8   | 1            | Ticks left in the current swing.                               |
| `hurt_ticks`    | u8   | 1            | Ticks left of knockback.                                       |
| `rope`          | u16  | 2            | Rope the player is climbing, 0 when not on a rope.             |
| `rope_cooldown` | u8   | 1            | Ticks before a rope can be grabbed again.                      |
