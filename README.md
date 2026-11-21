# Sokoban Solver — make.fun bounty `sokoban-solver-01-run-20261121`

Push-optimal Sokoban solver in a single `main.ts` (Node 22, no dependencies).
It answers a whole set of 5 instances in one run, writing each instance's
player moves to `/output/<id>/solution.txt`.

## How it works

A level is a hallway with independent rooms off it: a box pushed out of a door
into the hallway can never come back, so each room's boxes stay in their room
and the level's push-optimum P\* is the sum of its rooms' optima. The solver
therefore splits the level into rooms (by cutting the dead squares of the
player's row out of the floor) and solves every room push-optimally, stitching
the rooms' move strings together with walks along the hallway. Only pushes
count toward the score, so walking between rooms is free.

Each room is solved with a breadth-first search over pushes: a state is the
sorted box squares plus the player's reachable region, named by its lowest
square. States expand in push order, so the first solved state met is
push-optimal. Two deadlocks are pruned: a box on a dead square (no push from
there ever reaches a goal) and a box caught in a frozen 2×2 block of walls and
boxes with a box off its goal. The search budget is a fixed count of states
(250,000 per room), never the clock, so two runs answer byte for byte alike.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice score

| instance | pushes | P\* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Score: 1,000,000 / 1,000,000** (all five instances solved in exactly P\*
pushes), in ~0.8 s for the whole set, deterministic across runs. The house
baseline (plain-astar 1.0.0) scores 200,000 on the same practice set.
