// Sokoban solver for make.fun — sokoban-solver-01-run-20261121.
//
// Strategy: a level is a hallway with independent rooms off it (a box pushed
// out of a door into the hallway can never come back, so each room's boxes
// stay in their room and the level's push-optimum is the sum of its rooms').
// Every room is solved push-optimally with a breadth-first search over
// pushes, and the rooms' move strings are stitched together with walks along
// the hallway. Only pushes count toward the score, so walking between rooms
// is free. A push-optimal room costs exactly its share of P*, which is what
// the score needs: one push over P* more than halves a level's points.
//
// The search is a plain BFS over pushes (no clock, no randomness): a state is
// the sorted box squares plus the player's reachable region, named by its
// lowest square. States expand in push order, so the first solved state met
// is push-optimal. Two deadlocks are pruned: a box on a dead square (no push
// from there, ignoring the other boxes, ever reaches a goal) and a box caught
// in a frozen 2x2 block of walls and boxes with a box off its goal. Neither
// prunes a solvable state. The state budget is a fixed count of states, never
// the clock, so two runs answer byte for byte alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions, fixed order: [dx, dy, move letter]. The fixed order is
// part of the determinism: every tie in the search breaks the same way.
const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// The most states one push search keeps before it gives up: work, never the
// clock. The generator's rooms are kept only when they solve within this many.
const MAX_STATES = 250000;

/** A level in XSB text: width, height, walls (1 a wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // The outer frame is wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can be pushed from onto some goal, found by pulling boxes
 * back from the goals: a box on a square outside this set can never be solved,
 * so any push landing there is dead. A pull from x to y = x - d needs y open
 * for the box and y - d open for the player standing behind it.
 */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from`, with the squares in
 * `occupied` (boxes) as obstacles. Marks them in `seen` with `stamp` and
 * returns the lowest reached square: the region's name, which is all a push
 * state needs to remember of the player's position.
 */
function floodRegion(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    const down = p + w;
    if (wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    const left = p - 1;
    if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    const right = p + 1;
    if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` is caught in a frozen 2x2 block: four
 * squares of walls and boxes, with a box off its goal among them. Such a box
 * can never move again, so the state is dead.
 */
function isFrozen(level, occupied, isGoal, t) {
  const { w, wall } = level;
  const tops = [t, t - 1, t - w, t - w - 1];
  for (const a of tops) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const blocked = (s) => wall[s] || occupied[s];
    if (!blocked(a) || !blocked(b) || !blocked(c) || !blocked(d)) continue;
    if (
      (occupied[a] && !isGoal[a]) ||
      (occupied[b] && !isGoal[b]) ||
      (occupied[c] && !isGoal[c]) ||
      (occupied[d] && !isGoal[d])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and boxes, in lower-case
 * LURD letters (first direction first on ties). Throws when `to` is out of
 * reach: the caller only asks for reachable push squares.
 */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * The push-optimal solution of `level`: { pushes, moves } (moves in lower-case
 * LURD; the checker replays them and counts the pushes itself), or null when
 * the state budget runs out or the level has no solution.
 *
 * BFS over pushes: states are stored in the order found, and each state's
 * parent and the push that made it are kept, so the move string is rebuilt by
 * walking back from the first solved state met.
 */
function solvePushOptimal(level, maxStates) {
  const budget = maxStates === undefined ? MAX_STATES : maxStates;
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  for (const b of level.boxes) if (!live[b]) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key: the region's lowest square, then the box squares, as
  // digits in base `size`. Exact while size ** (boxes + 1) stays under 2 ** 53.
  const keyOf = (boxes, low) => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const solved = (boxes) => {
    for (const b of boxes) if (!isGoal[b]) return false;
    return true;
  };

  const stateBoxes = [level.boxes.slice()];
  const statePlayer = [level.player];
  const parent = [-1];
  const pushFrom = [0];
  const pushTo = [0];
  const index = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = floodRegion(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);
  let found = solved(level.boxes) ? 0 : -1;

  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    floodRegion(level, occupied, statePlayer[head], seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const behind = b - d;
        const t = b + d;
        if (seen[behind] !== regionStamp) continue; // player cannot get behind the box
        if (wall[t] || occupied[t] || !live[t]) continue; // target blocked or dead
        occupied[b] = 0;
        occupied[t] = 1;
        if (isFrozen(level, occupied, isGoal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const low = floodRegion(level, occupied, b, mark, ++stamp, stack);
        const key = keyOf(next, low);
        occupied[t] = 0;
        occupied[b] = 1;
        if (index.has(key)) continue;
        if (stateBoxes.length >= budget) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, stateBoxes.length);
        stateBoxes.push(next);
        statePlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s];
    const to = pushTo[s];
    const d = to - from;
    const dir = DIRS.find((dd) => dd[1] * w + dd[0] === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = from;
    boxes = stateBoxes[s];
  }
  return { pushes: path.length, moves };
}

/**
 * A level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room, with its boxes and goals. Null when some part holds more or
 * fewer boxes than goals, a box starts in the hallway, or a goal is left
 * outside every part: then the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k][1] * w + DIRS[k][0];
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r].boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r].goals.push(g);
  }
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` (lower-case LURD) from `from`. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's: { pushes,
 * moves }, or null when a room's search gives up. When the level is no set of
 * rooms, the whole level is searched instead (with a smaller budget).
 */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, 100000);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done = new Set();
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (let rj = 0; rj < rooms.length; rj++) {
      if (rj === ri) continue;
      const src = done.has(rj) ? rooms[rj].goals : rooms[rj].boxes;
      for (const b of src) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice(),
      boxes: room.boxes.slice(),
      player,
    };
    const solved = solvePushOptimal(sub);
    if (solved === null) return solvePushOptimal(level, 100000);
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done.add(ri);
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r. */
const solve = (levelText) => {
  const level = parseLevel(levelText);
  const result = solveByRooms(level);
  return result ? result.moves : '';
};

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solve(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
