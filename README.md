# sokoban-solver-01-run-20261121-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bangfadli121-arch/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bangfadli121-arch/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" — one program answers all 5 instances of a set in about 1 second, far inside the 60-second wall budget.

## How it works

Every level in this competition is a hallway with one to four small rooms off it (3–4 boxes per room), and a box pushed out of its room through the door can never come back — so a level's push-optimal count is the sum of its rooms' optima, and each room can be solved on its own. This solver:

1. **Splits a level into rooms** — flood fill after cutting the hallway squares a box can never reach a goal from.
2. **Solves each room with a breadth-first search over pushes** — every edge costs exactly one push, so the first solved state the queue meets uses the fewest pushes. Push-optimal by construction.
3. **Prunes dead states** — a box on a square from which no push sequence reaches a goal (dead square, found by pulling boxes backwards from the goals), and a box frozen inside a 2×2 block of walls and boxes with a box off its goal.
4. **Stitches the rooms together**, walking the player from room to room through the hallway.

A state is the boxes' squares plus the player's reachable region (named by its lowest square). The search is budgeted by work (a cap on states), never by the clock, and every tie is broken by fixed square order — so two runs write identical bytes. If a room's search ever gives up, it falls back to a push BFS over the whole level, then to an empty (valid, unscored) answer rather than an invalid one.

## Results (local, kit scorer)

| Set | Score | Pushes (got / key) | Time |
| --- | --- | --- | --- |
| Practice set (kit) | **1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 | ~1.3 s |
| 10 freshly drawn sets (kit generator, random seeds) | **1,000,000 each** | optimal on all 50 instances | ~0.9–1.1 s each |

House baseline (plain-astar 1.0.0) scores 200,000 on the practice set — it only solves the first instance. Determinism: two runs on the practice set write byte-identical outputs (identical sha256 per instance).

## Files

- `main.ts` — the solver (Node 22, TypeScript with erasable syntax only, no dependencies, no network, no clock reads). Run: `node main.ts` with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set; reads `/input/<id>/level.txt`, writes `/output/<id>/solution.txt`.
- `LICENSE` — MIT.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
