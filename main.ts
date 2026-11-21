// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Approach: the levels in this competition are built as a hallway with one
// to four small rooms off it (3-4 boxes per room), and a box pushed out of
// its room through the door can never come back. So a level's push-optimal
// count is the sum of its rooms' optima, and each room can be solved on its
// own. This program therefore:
//
//   1. splits a level into rooms (flood fill after cutting the hallway
//      squares a box can never reach a goal from),
//   2. solves each room with a breadth-first search over pushes, which is
//      push-optimal by construction: every edge costs exactly one push, so
//      the first solved state the queue meets uses the fewest pushes,
//   3. prunes states no solution can pass through: a box standing on a
//      square from which no push sequence reaches a goal (dead square), and
//      a box frozen inside a 2x2 block of walls and boxes with a box off
//      its goal,
//   4. stitches the rooms' move strings together, walking the player from
//      room to room through the hallway.
//
// A state is the boxes' squares plus the player's reachable region, named
// by its lowest square: two states with the same boxes and the same
// reachable region allow exactly the same pushes, so they are one state.
// The search is budgeted by work (a cap on states), never by the clock,
// and every tie is broken by fixed square order, so two runs of this
// program write the same bytes.
//
// If a room's search ever gives up, the program falls back to a push A*
// over the whole level (same prunings, heuristic: each box's Manhattan
// distance to its nearest goal, summed), and finally to an empty answer
// rather than an invalid one.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Up, down, left, right: [dx, dy, step letter, push letter].
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one room's push search may keep before it gives up.
const ROOM_STATE_CAP = 1_000_000;
// How many states the whole-level fallback search may keep.
const WHOLE_STATE_CAP = 1_000_000;
// How many expansions the push A* fallback may make.
const ASTAR_EXPANSION_CAP = 600_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
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

// Squares a lone box can be pushed from onto some goal: walk backwards
// from the goals. A square y is reachable in reverse from a live square x
// when a box on y could be pushed to x, i.e. the player could stand on
// the far side (y - d) and the square y itself is open floor.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (y < 0 || y >= live.length) continue;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood fill from `from` over open floor that is not in `blocked`; marks
// the reached squares in `seen` with `stamp` and returns the lowest one.
function floodRegion(
  b: Board,
  blocked: Uint8Array,
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
    // Up, down, left, right, in fixed order.
    const up = p - b.w;
    if (up >= 0 && !b.wall[up] && !blocked[up] && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    const down = p + b.w;
    if (down < b.w * b.h && !b.wall[down] && !blocked[down] && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (p % b.w > 0) {
      const left = p - 1;
      if (!b.wall[left] && !blocked[left] && seen[left] !== stamp) {
        seen[left] = stamp;
        stack[n++] = left;
      }
    }
    if (p % b.w < b.w - 1) {
      const right = p + 1;
      if (!b.wall[right] && !blocked[right] && seen[right] !== stamp) {
        seen[right] = stamp;
        stack[n++] = right;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` is stuck inside a 2x2 block of walls
// and boxes holding a box off its goal: no push can ever free it.
function frozenSquare(b: Board, blocked: Uint8Array, t: number): boolean {
  const w = b.w;
  const corners = [t, t - 1, t - w, t - w - 1];
  for (const a of corners) {
    if (a < 0 || a + w + 1 >= b.w * b.h) continue;
    const c = a + w;
    const d = c + 1;
    const bb = a + 1;
    if ((b.wall[a] || blocked[a]) && (b.wall[bb] || blocked[bb]) && (b.wall[c] || blocked[c]) && (b.wall[d] || blocked[d])) {
      if ((blocked[a] && !b.goalSet[a]) || (blocked[bb] && !b.goalSet[bb]) || (blocked[c] && !b.goalSet[c]) || (blocked[d] && !b.goalSet[d])) {
        return true;
      }
    }
  }
  return false;
}

// Shortest walk from `from` to `to` over open floor avoiding `blocked`
// squares (walls and boxes), as lowercase step letters. Empty when the
// squares are the same. Throws when unreachable (never happens for a push
// the search itself produced).
function walkPath(b: Board, blocked: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (q < 0 || q >= size) continue;
      if (b.wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

// Pack sorted box squares (each < 256) into one number, lowest box in the
// lowest byte. Only used when the board holds at most 5 boxes.
function packBoxes(boxes: number[]): number {
  let k = 0;
  for (let i = boxes.length - 1; i >= 0; i--) k = k * 256 + (boxes[i] as number);
  return k;
}

function unpackBoxes(packed: number, n: number): number[] {
  const out: number[] = [];
  let k = packed;
  for (let i = 0; i < n; i++) {
    out.push(k % 256);
    k = Math.floor(k / 256);
  }
  return out;
}

// Push-optimal search over one board: breadth-first over pushes with dead
// square and frozen-block pruning. Returns the push-optimal solution or
// null when the state cap runs out (or the board is unsolvable).
function pushBfs(b: Board, maxStates: number): PushSolution | null {
  const size = b.w * b.h;
  const live = liveSquares(b);
  for (const box of b.boxes) if (!live[box]) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goalSet[x]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  const n = b.boxes.length;
  const usePacked = n <= 5 && size <= 256;
  // State storage: packed boxes (or -1), player square, parent index, and
  // the push that made the state (box's old square, direction index).
  const packedOf: number[] = [usePacked ? packBoxes(b.boxes) : -1];
  const boxesOf: number[][] = [b.boxes.slice()];
  const playerOf: number[] = [b.player];
  const parentOf: number[] = [-1];
  const pushFromOf: number[] = [-1];
  const pushDirOf: number[] = [-1];
  const seen = new Map<number | string, number>();
  const blocked = new Uint8Array(size);
  const mark = new Int32Array(size);
  const seenRegion = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const keyOf = (boxes: number[], low: number): number | string => {
    if (usePacked) return packBoxes(boxes) * 256 + low;
    return boxes.join(',') + '|' + low;
  };
  for (const box of b.boxes) blocked[box] = 1;
  const startLow = floodRegion(b, blocked, b.player, seenRegion, ++stamp, stack);
  for (const box of b.boxes) blocked[box] = 0;
  seen.set(keyOf(b.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < packedOf.length; head++) {
    const boxes = boxesOf[head] as number[];
    for (const box of boxes) blocked[box] = 1;
    const regionStamp = ++stamp;
    floodRegion(b, blocked, playerOf[head] as number, seenRegion, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi] as number;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di] as readonly [number, number, string, string];
        const d = dy * b.w + dx;
        const behind = box - d;
        const dest = box + d;
        if (behind < 0 || behind >= size || dest < 0 || dest >= size) continue;
        if (seenRegion[behind] !== regionStamp) continue;
        if (b.wall[dest] || blocked[dest] || !live[dest]) continue;
        blocked[box] = 0;
        blocked[dest] = 1;
        if (frozenSquare(b, blocked, dest)) {
          blocked[dest] = 0;
          blocked[box] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((x, y) => x - y);
        const low = floodRegion(b, blocked, box, mark, ++stamp, stack);
        const key = keyOf(next, low);
        blocked[dest] = 0;
        blocked[box] = 1;
        if (seen.has(key)) continue;
        if (packedOf.length >= maxStates) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        seen.set(key, packedOf.length);
        packedOf.push(usePacked ? packBoxes(next) : -1);
        boxesOf.push(next);
        playerOf.push(box);
        parentOf.push(head);
        pushFromOf.push(box);
        pushDirOf.push(di);
        if (solved(next)) {
          found = packedOf.length - 1;
          break;
        }
      }
    }
    for (const box of boxes) blocked[box] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push sequence, then expand each push into a walk plus
  // the push itself.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parentOf[s] as number) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of chain) {
    const from = pushFromOf[s] as number;
    const di = pushDirOf[s] as number;
    const [dx, dy, , pushLetter] = DIRS[di] as readonly [number, number, string, string];
    const d = dy * b.w + dx;
    for (const box of boxes) blocked[box] = 1;
    moves += walkPath(b, blocked, player, from - d);
    for (const box of boxes) blocked[box] = 0;
    moves += pushLetter;
    player = from;
    boxes = boxesOf[s] as number[];
  }
  return { pushes: chain.length, moves };
}

// Push A* fallback: same moves and prunings as the BFS, but ordered by
// pushes made plus a heuristic (each box's Manhattan distance to its
// nearest goal, summed). The heuristic can overestimate when two boxes
// share a nearest goal, so this may return a non-optimal solution; it
// only runs when the optimal search has given up.
function pushAStar(b: Board, maxExpansions: number): PushSolution | null {
  const size = b.w * b.h;
  const live = liveSquares(b);
  for (const box of b.boxes) if (!live[box]) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goalSet[x]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };
  const manhattan = (box: number): number => {
    let best = Infinity;
    for (const g of b.goals) {
      const d = Math.abs((g % b.w) - (box % b.w)) + Math.abs(Math.floor(g / b.w) - Math.floor(box / b.w));
      if (d < best) best = d;
    }
    return best;
  };
  const heur = (boxes: number[]): number => boxes.reduce((a, x) => a + manhattan(x), 0);

  const boxesOf: number[][] = [b.boxes.slice()];
  const playerOf: number[] = [b.player];
  const pushesOf: number[] = [0];
  const parentOf: number[] = [-1];
  const pushFromOf: number[] = [-1];
  const pushDirOf: number[] = [-1];
  const best = new Map<string, number>();
  const blocked = new Uint8Array(size);
  const mark = new Int32Array(size);
  const seenRegion = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): string => boxes.join(',') + '|' + low;
  for (const box of b.boxes) blocked[box] = 1;
  const startLow = floodRegion(b, blocked, b.player, seenRegion, ++stamp, stack);
  for (const box of b.boxes) blocked[box] = 0;
  best.set(keyOf(b.boxes, startLow), 0);
  // Open list: a binary heap on (pushes + heuristic, pushes, index).
  const heap: number[] = [0];
  const prio = (s: number): number => (pushesOf[s] as number) + heur(boxesOf[s] as number[]);
  const less = (a: number, b: number): boolean =>
    prio(a) < prio(b) || (prio(a) === prio(b) && ((pushesOf[a] as number) > (pushesOf[b] as number) || ((pushesOf[a] as number) === (pushesOf[b] as number) && a < b)));
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as number, heap[p] as number)) break;
      const t = heap[i] as number;
      heap[i] = heap[p] as number;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0] as number;
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as number, heap[c] as number)) c++;
        if (!less(heap[c] as number, heap[i] as number)) break;
        const t = heap[i] as number;
        heap[i] = heap[c] as number;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < maxExpansions) {
    const s = heapPop();
    const boxes = boxesOf[s] as number[];
    if (solved(boxes)) {
      found = s;
      break;
    }
    expanded++;
    for (const box of boxes) blocked[box] = 1;
    const regionStamp = ++stamp;
    floodRegion(b, blocked, playerOf[s] as number, seenRegion, regionStamp, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi] as number;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di] as readonly [number, number, string, string];
        const d = dy * b.w + dx;
        const behind = box - d;
        const dest = box + d;
        if (behind < 0 || behind >= size || dest < 0 || dest >= size) continue;
        if (seenRegion[behind] !== regionStamp) continue;
        if (b.wall[dest] || blocked[dest] || !live[dest]) continue;
        blocked[box] = 0;
        blocked[dest] = 1;
        if (frozenSquare(b, blocked, dest)) {
          blocked[dest] = 0;
          blocked[box] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((x, y) => x - y);
        const low = floodRegion(b, blocked, box, mark, ++stamp, stack);
        const key = keyOf(next, low);
        blocked[dest] = 0;
        blocked[box] = 1;
        const g = (pushesOf[s] as number) + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g) continue;
        best.set(key, g);
        const t = boxesOf.length;
        boxesOf.push(next);
        playerOf.push(box);
        pushesOf.push(g);
        parentOf.push(s);
        pushFromOf.push(box);
        pushDirOf.push(di);
        heapPush(t);
      }
    }
    for (const box of boxes) blocked[box] = 0;
  }
  if (found < 0) return null;
  const chain: number[] = [];
  for (let s = found; s > 0; s = parentOf[s] as number) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of chain) {
    const from = pushFromOf[s] as number;
    const di = pushDirOf[s] as number;
    const [dx, dy, , pushLetter] = DIRS[di] as readonly [number, number, string, string];
    const d = dy * b.w + dx;
    for (const box of boxes) blocked[box] = 1;
    moves += walkPath(b, blocked, player, from - d);
    for (const box of boxes) blocked[box] = 0;
    moves += pushLetter;
    player = from;
    boxes = boxesOf[s] as number[];
  }
  return { pushes: chain.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

// Split a level into rooms: cut the hallway squares a box can never
// reach a goal from (the player's row, dead squares), then flood fill
// what is left. Each part holding boxes is a room. Null when the level
// does not split cleanly (a box in the hallway, a goal outside every
// part, or a part whose boxes and goals do not match).
function findRooms(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i] as number;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * b.w + dx;
        if (q < 0 || q >= b.w * b.h) continue;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const box of b.boxes) rooms[part[box] as number]?.boxes.push(box);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g] as number]?.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The square the player stands on after playing `moves` from `from`.
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

// Solve a level room by room: each room on its own, the other rooms'
// boxes standing as walls (on their goals once their room is done), the
// player walking on from where the last room left it.
function solveByRooms(b: Board): PushSolution | null {
  const rooms = findRooms(b);
  if (rooms === null) return pushBfs(b, WHOLE_STATE_CAP) ?? pushAStar(b, ASTAR_EXPANSION_CAP);
  let player = b.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = b.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: b.w,
      h: b.h,
      wall,
      goals: room.goals.slice().sort((a, c) => a - c),
      goalSet: b.goalSet,
      boxes: room.boxes.slice().sort((a, c) => a - c),
      player,
    };
    // The sub-board's goal set must match its own goals: rebuild it.
    const gs = new Uint8Array(b.w * b.h);
    for (const g of sub.goals) gs[g] = 1;
    sub.goalSet = gs;
    const r = pushBfs(sub, ROOM_STATE_CAP);
    if (r === null) return pushBfs(b, WHOLE_STATE_CAP) ?? pushAStar(b, ASTAR_EXPANSION_CAP);
    pushes += r.pushes;
    moves += r.moves;
    player = endSquare(b.w, player, r.moves);
    room.done = true;
  }
  return { pushes, moves };
}

function solveLevel(text: string): string {
  const board = parseLevel(text);
  const solved = solveByRooms(board);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
