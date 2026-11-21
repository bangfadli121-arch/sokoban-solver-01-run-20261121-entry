// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Idea, from the shape of the levels in this competition: every level is
// one hallway (the row the player starts on) with one to four small rooms
// off it, each room holding 3 or 4 boxes and the same number of goals, and
// opening onto the hallway through a single door. A box pushed out of its
// room through the door lands in the hallway, where it can never be pushed
// back in -- so in any solution every box stays in its own room, and the
// level's push-optimal count is the sum of its rooms' optima. The solver
// therefore splits a level into rooms and solves each room on its own,
// push-optimally, then walks the player from room to room.
//
// Each room is solved by breadth-first search over pushes: a state is the
// boxes' squares plus the region the player can reach (named by its lowest
// square -- two states with the same boxes and the same reachable region
// allow exactly the same pushes, so they are one state). Every edge costs
// exactly one push, so the first solved state the queue meets uses the
// fewest pushes. States are pruned when they cannot lead anywhere: a box
// standing on a square from which no sequence of pushes can reach a goal
// (a dead square, found by pulling boxes backwards from the goals), and a
// box frozen inside a 2x2 block of walls and boxes with a box off its goal.
//
// Everything is budgeted by work (a cap on states), never by the clock,
// and every tie is broken by fixed square order, so two runs of this
// program write the same bytes. If splitting into rooms fails, or a room's
// search gives up, the program falls back to the same push search over the
// whole level, and finally to an empty answer rather than an invalid one.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Up, down, left, right: dx, dy, step letter, push letter.
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

// Squares a lone box can be pushed from onto some goal, found by pulling
// backwards from the goals: a box on y can be pulled to x (one step toward
// a goal) when the square past y, where the player must stand, is open.
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
      const behind = y - d;
      if (y < 0 || y >= live.length) continue;
      if (behind < 0 || behind >= live.length) continue;
      if (!b.wall[y] && !b.wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Whether the box just pushed to t sits in a frozen 2x2 block: four
// squares, each a wall or a box, holding a box that is off its goal. Such
// a box can never move again, so the state is dead.
function frozenBlock(b: Board, occupied: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= b.wall.length) continue;
    const cells = [a, a + 1, a + w, a + w + 1];
    let allBlocked = true;
    let offGoalBox = false;
    for (const c of cells) {
      if (!b.wall[c] && !occupied[c]) {
        allBlocked = false;
        break;
      }
      if (occupied[c] && !b.goalSet[c]) offGoalBox = true;
    }
    if (allBlocked && offGoalBox) return true;
  }
  return false;
}

// The squares the player reaches from `from` with `occupied` in the way,
// marked in `seen` with `stamp`; returns the lowest square reached.
function flood(
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
    for (const [dx, dy] of DIRS) {
      const q = p + dy * b.w + dx;
      if (q < 0 || q >= b.wall.length) continue;
      if (b.wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters. Directions are tried up, down, left, right, so ties break
// the same way on every run.
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how = new Array<string>(b.wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (q < 0 || q >= b.wall.length) continue;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

// Push-optimal solution of `board`, searching at most `maxStates` states,
// or null when the search gives up (or the board has no solution).
function solvePushes(board: Board, maxStates: number): PushSolution | null {
  const { w, goalSet } = board;
  const size = board.wall.length;
  const live = liveSquares(board);
  const solved = (boxes: number[]): boolean => boxes.every((x) => goalSet[x] === 1);
  if (board.boxes.some((x) => !live[x])) return null;
  if (solved(board.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  // Two flood-fill mark arrays: one keeps the current state's player
  // region (checked for every push), the other is scratch for a child's
  // region. Sharing one array would let a child's flood overwrite the
  // parent region's marks and wrongly reject the state's other pushes.
  const regionSeen = new Int32Array(size);
  const childSeen = new Int32Array(size);
  const stack = new Int32Array(size);
  let regionStamp = 0;
  let childStamp = 0;
  for (const x of board.boxes) occupied[x] = 1;
  if (board.boxes.some((x) => frozenBlock(board, occupied, x))) {
    for (const x of board.boxes) occupied[x] = 0;
    return null;
  }
  for (const x of board.boxes) occupied[x] = 0;

  // States in discovery order: boxes, player square, and the push that
  // made the state from its parent (from square, to square, direction).
  const stateBoxes: number[][] = [board.boxes.slice()];
  const statePlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<string, number>();
  const keyOf = (boxes: number[], low: number): string => boxes.join(',') + '|' + low;
  for (const x of board.boxes) occupied[x] = 1;
  const firstLow = flood(board, occupied, board.player, regionSeen, ++regionStamp, stack);
  for (const x of board.boxes) occupied[x] = 0;
  index.set(keyOf(board.boxes, firstLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head] as number[];
    const player = statePlayer[head] as number;
    for (const x of boxes) occupied[x] = 1;
    const stampHere = ++regionStamp;
    flood(board, occupied, player, regionSeen, stampHere, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi] as number;
      for (let di = 0; di < DIRS.length; di++) {
        const [dx, dy] = DIRS[di] as readonly [number, number, string, string];
        const d = dy * w + dx;
        const stand = box - d;
        const target = box + d;
        if (stand < 0 || stand >= size || target < 0 || target >= size) continue;
        if (regionSeen[stand] !== stampHere) continue;
        if (board.wall[target] || occupied[target] || !live[target]) continue;
        occupied[box] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(board, occupied, target);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((a, b) => a - b);
          const low = flood(board, occupied, box, childSeen, ++childStamp, stack);
          key = keyOf(next, low);
        }
        occupied[target] = 0;
        occupied[box] = 1;
        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, stateBoxes.length);
        stateBoxes.push(next as number[]);
        statePlayer.push(box);
        parent.push(head);
        pushFrom.push(box);
        pushTo.push(target);
        pushDir.push(di);
        if (solved(next as number[])) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: for each push in order, walk to the square
  // behind the box, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s] as number;
    const to = pushTo[s] as number;
    const di = pushDir[s] as number;
    const [dx, dy, , pushLetter] = DIRS[di] as readonly [number, number, string, string];
    const d = dy * w + dx;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += pushLetter;
    player = from;
    const at = boxes.indexOf(from);
    boxes[at] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

// Split a level into rooms: cut the hallway row's dead squares (a box
// there reaches no goal) out of the floor, and each remaining component
// holding boxes is a room. Returns null when the level is no set of rooms
// (a box starts in the hallway, a goal is cut off, or a component's boxes
// and goals do not match).
function roomsOf(board: Board): Room[] | null {
  const live = liveSquares(board);
  const hallRow = Math.floor(board.player / board.w);
  const cut = new Uint8Array(board.wall.length);
  for (let i = hallRow * board.w; i < (hallRow + 1) * board.w; i++) {
    if (!board.wall[i] && !live[i]) cut[i] = 1;
  }
  if (board.boxes.some((x) => cut[x])) return null;
  if (board.goals.some((x) => cut[x])) return null;
  const part = new Int32Array(board.wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < board.wall.length; s++) {
    if (board.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i] as number;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * board.w + dx;
        if (q < 0 || q >= board.wall.length) continue;
        if (!board.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const x of board.boxes) {
    const r = part[x];
    if (r < 0) return null;
    (rooms[r] as Room).boxes.push(x);
  }
  for (const g of board.goals) {
    const r = part[g];
    if (r < 0) return null;
    (rooms[r] as Room).goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The level solved room by room: each room's push-optimal solution in
// turn, the other rooms' boxes standing as walls (on their goals once
// their room is done), the player walking on from where the last room
// left it. Returns null when a room's search gives up.
function solveByRooms(board: Board): PushSolution | null {
  const rooms = roomsOf(board);
  if (rooms === null) return null;
  let player = board.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const spots = other.done ? other.goals : other.boxes;
      for (const x of spots) wall[x] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      goalSet: board.goalSet,
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_STATE_CAP);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    // The player's square after the moves: every step moves it one square.
    for (const ch of solved.moves.toLowerCase()) {
      player += ch === 'u' ? -board.w : ch === 'd' ? board.w : ch === 'l' ? -1 : 1;
    }
    room.done = true;
  }
  return { pushes, moves };
}

function solveLevel(board: Board): string {
  if (board.boxes.every((x) => board.goalSet[x] === 1)) return '';
  const byRooms = solveByRooms(board);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushes(board, WHOLE_STATE_CAP);
  if (whole !== null) return whole.moves;
  return '';
}

function main(): void {
  const ids = readdirSync(IN_DIR).sort();
  for (const id of ids) {
    const outDir = join(OUT_DIR, id);
    mkdirSync(outDir, { recursive: true });
    let moves = '';
    try {
      const text = readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8');
      moves = solveLevel(parseLevel(text));
    } catch {
      moves = '';
    }
    writeFileSync(join(outDir, 'solution.txt'), moves + '\n', 'utf8');
  }
}

main();
