// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The levels in this competition are one hallway (where the player starts)
// with one to four small rooms off it, 3-4 boxes and as many goals per room.
// A box pushed out of its room through the door can never be pushed back:
// the hallway is one square wide, so there is no room for the player to get
// behind a box that sits in it. Every box therefore stays in its own room,
// and a level's push-optimal count is the sum of its rooms' optima. This
// solver exploits that directly:
//
//   1. Split the level into rooms. The hallway squares are the floor squares
//      on the player's row from which a box can never reach a goal (dead
//      squares, see below). Cutting them out of the floor leaves the rooms
//      as separate connected components.
//   2. Solve each room on its own with a breadth-first search over pushes.
//      Every edge costs exactly one push, so the first solved state the
//      queue reaches uses the fewest pushes: push-optimal by construction.
//      The other rooms' boxes are treated as walls while a room is solved
//      (a finished room's boxes sit on its goals and stay put), and the
//      player's walk between rooms is stitched in afterwards.
//   3. Prune states no solution can pass through:
//        - a box on a dead square: a square from which no sequence of
//          pushes, ignoring the other boxes, can bring a box onto a goal
//          (found by walking backwards from the goals);
//        - a box frozen in a 2x2 block of walls and boxes that holds a box
//          off its goal: nothing in such a block can ever move again.
//   4. If the room split ever fails, fall back to the same push search over
//      the whole level, and if that gives up too, answer with an empty (valid,
//      unscored) solution rather than an invalid one.
//
// A search state is the boxes' squares plus the player's reachable region,
// named by its lowest square: two states with the same boxes and the same
// reachable region allow exactly the same pushes, so they are one state.
// The search is budgeted by a cap on the number of states kept, never by
// the clock, and every tie is broken by fixed square order, so two runs of
// this program write identical bytes. It reads no clock, no randomness and
// no environment beyond the input/output directories.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four moves, in a fixed order: [dx, dy, walk letter, push letter].
// The order is the tie-break everywhere (search expansion, shortest walks).
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one room's push search may keep before it gives up.
// The generator only keeps rooms solvable well inside this budget, so the
// cap is a safety net, not a tuning knob.
const ROOM_STATE_CAP = 500_000;
// How many states the whole-level fallback search may keep.
const WHOLE_STATE_CAP = 500_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

interface Solved {
  pushes: number;
  moves: string;
}

// Parse one XSB level: '#' wall, ' ' floor, '.' goal, '$' box, '*' box on a
// goal, '@' player, '+' player on a goal. Short rows are padded with walls,
// and the outermost frame is a wall whatever it shows.
function parseLevel(text: string): Board {
  const rows = text
    .split('\n')
    .map((r) => r.replace(/\r$/, ''))
    .filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  return { w, h, wall, goals, goalSet, boxes, player };
}

// The squares from which a lone box can be pushed onto some goal, ignoring
// the other boxes: walk backwards from the goals. A square y is live when
// some live square x sits one push ahead of it, i.e. a box on y can be
// pushed in that direction onto x, which needs open floor at y itself and
// at the square the player must stand on, y - d.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const dir of DIRS) {
      const d = dir[1] * b.w + dir[0];
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= live.length || behind < 0 || behind >= live.length) continue;
      if (b.wall[y] === 0 && b.wall[behind] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood fill from `from` around walls and the boxes in `occupied`, marking
// the region in `seen` with `stamp`, and return the region's lowest square.
// The stamp is left in place so the caller can test whether a square is in
// this region by comparing seen[square] with the returned stamp's value
// (the caller keeps the stamp it passed in).
function reachLow(
  b: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n] as number;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir[1] * b.w + dir[0];
      if (q < 0 || q >= seen.length) continue;
      if (b.wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed onto `t` sits in a frozen 2x2 block: four
// squares, each a wall or a box, holding at least one box off its goal.
// Nothing in such a block can move again, so the state is dead.
function frozenAt(b: Board, occupied: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if (a < 0 || c3 >= b.wall.length) continue;
    if (
      (b.wall[a] || occupied[a]) &&
      (b.wall[c1] || occupied[c1]) &&
      (b.wall[c2] || occupied[c2]) &&
      (b.wall[c3] || occupied[c3])
    ) {
      if (
        (occupied[a] && !b.goalSet[a]) ||
        (occupied[c1] && !b.goalSet[c1]) ||
        (occupied[c2] && !b.goalSet[c2]) ||
        (occupied[c3] && !b.goalSet[c3])
      ) {
        return true;
      }
    }
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters, ties broken by DIRS order (first direction first).
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Array<string>(b.w * b.h);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir[1] * b.w + dir[0];
      if (q < 0 || q >= prev.length) continue;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir[2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

// The push-optimal solution of a board, searching at most `maxStates`
// states: {pushes, moves}, or null when the search gives up (or the board
// has no solution). Breadth-first over pushes: states are expanded in the
// order they are found, so the first solved state met uses the fewest
// pushes. Moves are in LURD, a lower letter for a step, an upper one for
// a push.
function solvePush(b: Board, maxStates: number): Solved | null {
  const size = b.w * b.h;
  const goal = b.goalSet;
  const live = liveSquares(b);
  for (const box of b.boxes) if (!live[box]) return null;
  const isSolved = (boxes: number[]): boolean => boxes.every((x) => goal[x] === 1);
  const startBoxes = b.boxes.slice().sort((a, c) => a - c);
  if (isSolved(startBoxes)) return { pushes: 0, moves: '' };

  // A state's key: its region's lowest square followed by its boxes'
  // squares. Small boards fit in one exact number; larger ones fall back
  // to a string key.
  const useNumberKey = Math.pow(size, b.boxes.length + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (useNumberKey) {
      let k = low;
      for (const x of boxes) k = k * size + x;
      return k;
    }
    return low + '|' + boxes.join(',');
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const statesBoxes: number[][] = [startBoxes];
  const statesPlayer: number[] = [b.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const x of startBoxes) occupied[x] = 1;
  const startLow = reachLow(b, occupied, b.player, seen, ++stamp, stack);
  for (const x of startBoxes) occupied[x] = 0;
  index.set(keyOf(startBoxes, startLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head] as number[];
    for (const x of boxes) occupied[x] = 1;
    reachLow(b, occupied, statesPlayer[head] as number, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi] as number;
      for (const dir of DIRS) {
        const d = dir[1] * b.w + dir[0];
        const stand = box - d;
        const target = box + d;
        if (stand < 0 || stand >= size || target < 0 || target >= size) continue;
        if (seen[stand] !== here) continue;
        if (b.wall[target] || occupied[target] || !live[target]) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = frozenAt(b, occupied, target);
        let nextBoxes: number[] | null = null;
        let key: number | string = '';
        if (!frozen) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = target;
          nextBoxes.sort((x, y) => x - y);
          key = keyOf(nextBoxes, reachLow(b, occupied, box, mark, ++stamp, stack));
        }
        occupied[target] = 0;
        occupied[box] = 1;
        if (frozen || nextBoxes === null || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(nextBoxes);
        statesPlayer.push(box);
        parent.push(head);
        if (isSolved(nextBoxes)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Walk the parent chain back to the start, then turn each state's push
  // into moves: walk to the push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s] as number[];
    let from = -1;
    let to = -1;
    for (const x of boxes) if (!nextBoxes.includes(x)) from = x;
    for (const x of nextBoxes) if (!boxes.includes(x)) to = x;
    const d = to - from;
    const dir = DIRS.find((dd) => dd[1] * b.w + dd[0] === d) as readonly [
      number,
      number,
      string,
      string,
    ];
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the dead squares of the player's row (the hallway:
// a box there reaches no goal) out of the floor, and each remaining part
// that holds a box is a room. Null when a box starts in the hallway, a goal
// is cut off, or some part holds a different number of boxes than goals:
// then the level is no set of rooms.
function roomsOf(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let x = 0; x < b.w; x++) {
    const i = row * b.w + x;
    if (b.wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  for (const box of b.boxes) if (cut[box]) return null;
  const part = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i] as number;
      for (const dir of DIRS) {
        const q = p + dir[1] * b.w + dir[0];
        if (q < 0 || q >= part.length) continue;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const box of b.boxes) {
    const r = part[box];
    if (r < 0) return null;
    (rooms[r] as Room).boxes.push(box);
  }
  for (const g of b.goals) {
    const r = part[g];
    if (r < 0) return null;
    (rooms[r] as Room).goals.push(g);
  }
  for (const r of rooms) {
    if (r.boxes.length === 0 && r.goals.length > 0) return null;
    if (r.boxes.length > 0 && r.boxes.length !== r.goals.length) return null;
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

// The square the player stands on after `moves` (LURD, case aside) from
// `from` on a board `w` wide.
function endPlayer(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

// Solve a level room by room: each room's push-optimal solution in turn,
// the other rooms' boxes standing as walls (on their goals once their room
// is done), the player walking on from where the last room left it. A box
// never leaves its room, so the rooms' optima add up to the level's. Falls
// back to a push search over the whole level when the room split fails or
// a room's search gives up, and to an empty answer when that gives up too.
function solveLevel(b: Board): string {
  const rooms = roomsOf(b);
  if (rooms !== null) {
    let player = b.player;
    let moves = '';
    let allDone = true;
    for (const room of rooms) {
      const wall = b.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const blocks = other.done ? other.goals : other.boxes;
        for (const x of blocks) wall[x] = 1;
      }
      const goalSet = new Uint8Array(b.w * b.h);
      for (const g of room.goals) goalSet[g] = 1;
      const sub: Board = {
        w: b.w,
        h: b.h,
        wall,
        goals: room.goals.slice().sort((x, y) => x - y),
        goalSet,
        boxes: room.boxes.slice().sort((x, y) => x - y),
        player,
      };
      const solved = solvePush(sub, ROOM_STATE_CAP);
      if (solved === null) {
        allDone = false;
        break;
      }
      moves += solved.moves;
      player = endPlayer(b.w, player, solved.moves);
      room.done = true;
    }
    if (allDone) return moves;
  }
  const whole = solvePush(b, WHOLE_STATE_CAP);
  return whole === null ? '' : whole.moves;
}

function main(): void {
  const ids = readdirSync(IN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    let moves = '';
    try {
      const text = readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8');
      moves = solveLevel(parseLevel(text));
    } catch {
      // Never let one instance sink the rest of the set: an empty answer
      // is valid, just unscored.
      moves = '';
    }
    const outDir = join(OUT_DIR, id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'solution.txt'), moves + '\n', 'utf8');
  }
}

main();
