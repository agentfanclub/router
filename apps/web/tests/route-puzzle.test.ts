import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectedTiles,
  DESTINATION,
  hintTile,
  isSolved,
  makePuzzle,
  SIZE,
  SOURCE,
} from "../src/lib/route-puzzle.ts";

test("generated puzzles have simple valid routes, start unsolved, and can be completed using hints", () => {
  for (let seed = 0; seed < 2000; seed++) {
    const puzzle = makePuzzle(seed);
    assert.equal(puzzle.path[0], SOURCE);
    assert.equal(puzzle.path.at(-1), DESTINATION);
    assert.equal(new Set(puzzle.path).size, puzzle.path.length);
    for (let i = 1; i < puzzle.path.length; i++) {
      const a = puzzle.path[i - 1],
        b = puzzle.path[i];
      assert.equal(
        Math.abs(Math.floor(a / SIZE) - Math.floor(b / SIZE)) +
          Math.abs((a % SIZE) - (b % SIZE)),
        1,
      );
    }
    assert.equal(isSolved(puzzle.tiles), false, `seed ${seed} starts solved`);
    const solution = puzzle.tiles.map((tile) => ({ ...tile, rotation: 0 }));
    assert.equal(
      isSolved(solution),
      true,
      `seed ${seed} has no intended solution`,
    );
    assert.equal(hintTile(puzzle, solution), undefined);
    const tiles = structuredClone(puzzle.tiles);
    let rotations = 0;
    while (!isSolved(tiles) && rotations < 75) {
      const hint = hintTile(puzzle, tiles);
      assert.notEqual(hint, undefined, `seed ${seed} has no hint`);
      tiles[hint!].rotation = (tiles[hint!].rotation + 1) % 4;
      rotations++;
    }
    assert.equal(isSolved(tiles), true, `seed ${seed} hints never finish`);
    assert.ok(rotations <= puzzle.metrics.rotations);
  }
});

test("seeds reproduce boards, produce varied paths, and cover all difficulty estimates", () => {
  const paths = new Set<string>();
  const boards = new Set<string>();
  const difficulties = new Set<string>();
  for (let seed = 0; seed < 1000; seed++) {
    const puzzle = makePuzzle(seed);
    assert.deepEqual(puzzle, makePuzzle(seed));
    paths.add(puzzle.path.join(","));
    boards.add(JSON.stringify(puzzle.tiles));
    difficulties.add(puzzle.difficulty);
    assert.equal(puzzle.metrics.length, puzzle.path.length);
    assert.ok(puzzle.metrics.rotations > 0);
  }
  assert.ok(paths.size > 200, `only ${paths.size} distinct paths`);
  assert.equal(boards.size, 1000);
  assert.deepEqual([...difficulties].sort(), ["Easy", "Hard", "Medium"]);
});

test("disconnected edges cannot wrap around the board or count as a delivery", () => {
  const tiles = Array.from({ length: 25 }, () => ({
    ports: [0, 2],
    rotation: 0,
  }));
  assert.equal(connectedTiles(tiles).size, 0);
  tiles[SOURCE] = { ports: [1, 3], rotation: 0 };
  tiles[DESTINATION] = { ports: [1, 3], rotation: 0 };
  assert.deepEqual([...connectedTiles(tiles)], [SOURCE]);
  assert.equal(isSolved(tiles), false);
  for (let i = SOURCE; i <= DESTINATION; i++)
    tiles[i] = { ports: [1, 3], rotation: 0 };
  assert.equal(isSolved(tiles), true);
  tiles[DESTINATION] = { ports: [0, 3], rotation: 0 };
  assert.ok(connectedTiles(tiles).has(DESTINATION));
  assert.equal(
    isSolved(tiles),
    false,
    "destination must also connect to the outside outlet",
  );
});
