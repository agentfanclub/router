// Directions run clockwise: north, east, south, west.
export const SIZE = 5;
export const SOURCE = 10;
export const DESTINATION = 14;
export type Tile = { ports: number[]; rotation: number };
export type Puzzle = {
  tiles: Tile[];
  path: number[];
  difficulty: "Easy" | "Medium" | "Hard";
  metrics: { length: number; turns: number; rotations: number; score: number };
};
function direction(from: number, to: number) {
  if (to === from - SIZE) return 0;
  if (to === from + SIZE) return 2;
  return to > from ? 1 : 3;
}
export function ports(tile: Tile) {
  return tile.ports.map((p) => (p + tile.rotation) % 4);
}
function randomSource(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
function neighbors(index: number) {
  const row = Math.floor(index / SIZE),
    column = index % SIZE;
  return [
    row > 0 ? index - SIZE : -1,
    column < SIZE - 1 ? index + 1 : -1,
    row < SIZE - 1 ? index + SIZE : -1,
    column > 0 ? index - 1 : -1,
  ].filter((n) => n >= 0);
}
function generatePath(random: () => number) {
  const targetLength = 7 + Math.floor(random() * 8) * 2;
  const path = [SOURCE];
  const visited = new Set(path);
  let best: number[] = [];
  let budget = 6000;
  function visit(index: number): boolean {
    if (--budget < 0) return false;
    if (index === DESTINATION) {
      if (path.length > best.length) best = [...path];
      return path.length === targetLength;
    }
    const distance =
      Math.abs(Math.floor(index / SIZE) - Math.floor(DESTINATION / SIZE)) +
      Math.abs((index % SIZE) - (DESTINATION % SIZE));
    if (path.length + distance > targetLength) return false;
    const options = neighbors(index);
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    for (const next of options) {
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (visit(next)) return true;
      path.pop();
      visited.delete(next);
      if (budget < 0) break;
    }
    return false;
  }
  visit(SOURCE);
  // The bounded search usually reaches its target. If it exhausts its budget
  // before finding any route, a short random walk toward home always terminates.
  if (!best.length) {
    best = [SOURCE];
    while (best[best.length - 1] !== DESTINATION) {
      const current = best[best.length - 1];
      const towardHome = neighbors(current).filter(
        (next) =>
          Math.abs(Math.floor(next / SIZE) - 2) + 4 - (next % SIZE) <
          Math.abs(Math.floor(current / SIZE) - 2) + 4 - (current % SIZE),
      );
      best.push(towardHome[Math.floor(random() * towardHome.length)]);
    }
  }
  return best;
}
export function makePuzzle(seed: number): Puzzle {
  const random = randomSource(seed);
  const path = generatePath(random);
  const tiles = Array.from({ length: SIZE * SIZE }, (_, i) => {
    const step = path.indexOf(i);
    const connections =
      step < 0
        ? random() > 0.5
          ? [0, 1]
          : [0, 2]
        : [
            step === 0 ? 3 : direction(i, path[step - 1]),
            step === path.length - 1 ? 1 : direction(i, path[step + 1]),
          ];
    return { ports: connections, rotation: Math.floor(random() * 4) };
  });
  // Decoys may create an alternative solution. Break the source connection
  // if the scramble accidentally starts solved, without changing tile shapes.
  if (isSolved(tiles)) {
    while (ports(tiles[SOURCE]).includes(3))
      tiles[SOURCE].rotation = (tiles[SOURCE].rotation + 1) % 4;
  }
  const turns = path.filter(
    (i) => (tiles[i].ports[0] + 2) % 4 !== tiles[i].ports[1],
  ).length;
  const rotations = path.reduce((sum, i) => {
    const tile = tiles[i];
    let clicks = 0;
    while (
      !tile.ports.every((p) =>
        ports({ ...tile, rotation: tile.rotation + clicks }).includes(p),
      )
    )
      clicks++;
    return sum + clicks;
  }, 0);
  const score = Math.round(path.length - 5 + turns * 1.5 + rotations * 0.5);
  return {
    tiles,
    path,
    difficulty: score < 20 ? "Easy" : score < 36 ? "Medium" : "Hard",
    metrics: { length: path.length, turns, rotations, score },
  };
}
export function connectedTiles(tiles: Tile[]) {
  const reached = new Set<number>();
  if (!ports(tiles[SOURCE]).includes(3)) return reached;
  const queue = [SOURCE];
  while (queue.length) {
    const i = queue.shift()!;
    if (reached.has(i)) continue;
    reached.add(i);
    for (const port of ports(tiles[i])) {
      const row = Math.floor(i / SIZE),
        column = i % SIZE;
      if (
        (port === 0 && row === 0) ||
        (port === 1 && column === 4) ||
        (port === 2 && row === 4) ||
        (port === 3 && column === 0)
      )
        continue;
      const next = i + [-SIZE, 1, SIZE, -1][port];
      if (ports(tiles[next]).includes((port + 2) % 4) && !reached.has(next))
        queue.push(next);
    }
  }
  return reached;
}
export function isSolved(tiles: Tile[]) {
  return (
    connectedTiles(tiles).has(DESTINATION) &&
    ports(tiles[DESTINATION]).includes(1)
  );
}
export function hintTile(puzzle: Puzzle, tiles: Tile[]) {
  return puzzle.path.find((i) => {
    const expected = puzzle.tiles[i].ports;
    return !expected.every((p) => ports(tiles[i]).includes(p));
  });
}
