import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  RotateCw,
  Lightbulb,
  Network,
} from "lucide-react";
import { Button } from "./button";
import {
  connectedTiles,
  DESTINATION,
  hintTile,
  isSolved,
  makePuzzle,
  ports,
  SOURCE,
  type Tile,
} from "../lib/route-puzzle";
import "./route-game.css";

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// Keep server rendering and hydration deterministic. Puzzles are created only
// after the browser mounts, using fresh browser entropy for every new board.
export function RouteGame() {
  const [initialSeed, setInitialSeed] = useState<number>();
  useEffect(() => {
    setInitialSeed(randomSeed());
  }, []);
  return initialSeed === undefined ? (
    <div
      className="route-game route-loading"
      role="status"
      aria-label="Preparing a puzzle"
    >
      <Network size={20} strokeWidth={1.5} />
      <span>Finding a new route…</span>
    </div>
  ) : (
    <PlayableRouteGame initialSeed={initialSeed} />
  );
}

function PlayableRouteGame({ initialSeed }: { initialSeed: number }) {
  const [routeNumber, setRouteNumber] = useState(1);
  const [puzzle, setPuzzle] = useState(() => makePuzzle(initialSeed));
  const [tiles, setTiles] = useState<Tile[]>(() => puzzle.tiles);
  const [hint, setHint] = useState<number>();
  const [message, setMessage] = useState("");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const connected = connectedTiles(tiles);
  const solved = isSolved(tiles);
  function rotate(index: number) {
    if (solved) return;
    const next = tiles.map((tile, i) =>
      i === index ? { ...tile, rotation: (tile.rotation + 1) % 4 } : tile,
    );
    setTiles(next);
    setHint(undefined);
    setMessage("");
  }
  function nextPuzzle() {
    const next = makePuzzle(randomSeed());
    setPuzzle(next);
    setTiles(next.tiles);
    setRouteNumber((n) => n + 1);
    setHint(undefined);
    setMessage("");
  }

  function reset() {
    setTiles(puzzle.tiles);
    setHint(undefined);
    setMessage("");
  }
  function showHint() {
    const index = hintTile(puzzle, tiles);
    setHint(index);
    setMessage(
      index === undefined
        ? "Follow the connected line to the destination."
        : `Try rotating the highlighted tile in row ${Math.floor(index / 5) + 1}, column ${(index % 5) + 1}.`,
    );
    if (index !== undefined) buttons.current[index]?.focus();
  }
  function navigate(event: KeyboardEvent, index: number) {
    const directions: Record<string, number> = {
      ArrowUp: -5,
      ArrowRight: 1,
      ArrowDown: 5,
      ArrowLeft: -1,
    };
    if (!(event.key in directions)) return;
    event.preventDefault();
    const next = index + directions[event.key];
    if (
      next < 0 ||
      next > 24 ||
      (event.key === "ArrowRight" && index % 5 === 4) ||
      (event.key === "ArrowLeft" && index % 5 === 0)
    )
      return;
    buttons.current[next]?.focus();
  }
  return (
    <div className="route-game">
      <header className="route-header">
        <a href="/" aria-label="Router home">
          <img
            src="/agent-fan-club.png"
            alt="Agent fan club"
            width="980"
            height="202"
          />
        </a>
        <a href="/" className="route-home">
          <ArrowLeft size={13} /> Back to dashboard
        </a>
      </header>
      <main className="route-main">
        <div className="route-heading">
          <div className="route-kicker">
            <span className="route-code">404</span> Destination not found
          </div>
          <h1>
            A wrong turn.
            <br />A little detour?
          </h1>
          <p>
            This page is missing. Your packet doesn't have to be.
            <br className="route-desktop-break" /> Reconnect the route and send
            it home.
          </p>
        </div>
        <section
          className={`route-panel ${solved ? "is-solved" : ""}`}
          aria-label="Route the packet game"
        >
          <div className="route-panel-heading">
            <span>
              <Network size={15} strokeWidth={1.5} /> Route the packet
            </span>
            <span className="route-level">
              Route {String(routeNumber).padStart(2, "0")}
              <span aria-hidden="true"> · </span>
              <span title="Estimated from route length, bends, and starting rotations">
                {puzzle.difficulty}
              </span>
            </span>
          </div>
          <div className="route-play-area">
            <div className="route-board-area">
              <div className="route-board-labels">
                <span>
                  <i /> You are here
                </span>
                <span>
                  Home <ArrowRight size={11} />
                </span>
              </div>
              <div className="route-board-wrap">
                <span className="route-port route-input" aria-hidden="true" />
                <div
                  className="route-board"
                  role="group"
                  aria-label="Network grid. Click or press Enter to rotate a tile. Arrow keys move between tiles."
                >
                  {tiles.map((tile, index) => {
                    const active = connected.has(index);
                    const directions = ports(tile)
                      .map((p) => ["north", "east", "south", "west"][p])
                      .join(" and ");
                    return (
                      <button
                        key={index}
                        type="button"
                        ref={(el) => {
                          buttons.current[index] = el;
                        }}
                        className={`route-tile ${active ? "connected" : ""} ${hint === index ? "hinted" : ""}`}
                        data-index={index}
                        data-rotation={tile.rotation}
                        onClick={() => rotate(index)}
                        onKeyDown={(e) => navigate(e, index)}
                        aria-label={`Row ${Math.floor(index / 5) + 1}, column ${(index % 5) + 1}, ${directions}${index === SOURCE ? ", source" : index === DESTINATION ? ", destination" : ""}. Rotate clockwise.`}
                        aria-disabled={solved}
                      >
                        <svg viewBox="0 0 64 64" aria-hidden="true">
                          <g
                            className="route-pipe"
                            style={{
                              transform: `rotate(${tile.rotation * 90}deg)`,
                            }}
                          >
                            {tile.ports.map((port) => (
                              <path
                                key={port}
                                d={
                                  [
                                    "M32 32V0",
                                    "M32 32H64",
                                    "M32 32V64",
                                    "M32 32H0",
                                  ][port]
                                }
                              />
                            ))}
                            <circle cx="32" cy="32" r="3" />
                          </g>
                          {active && (
                            <circle
                              className="route-packet"
                              cx="32"
                              cy="32"
                              r="3.5"
                            />
                          )}
                        </svg>
                        {(index === SOURCE || index === DESTINATION) && (
                          <span className="route-endpoint">
                            {index === SOURCE ? "IN" : "OUT"}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <span
                  className={`route-port route-output ${solved ? "delivered" : ""}`}
                  aria-hidden="true"
                />
              </div>
              <div className="route-board-instruction">
                <RotateCw size={12} /> Click a tile to rotate it clockwise
              </div>
            </div>
          </div>
          {(solved || message) && (
            <p
              className={`route-feedback ${solved ? "success" : ""}`}
              role="status"
              aria-live="polite"
            >
              {solved ? "Route restored. 200 OK." : message}
            </p>
          )}
          <div className="route-controls">
            <div>
              <button
                type="button"
                onClick={reset}
                disabled={solved}
                className="route-secondary"
              >
                <RotateCcw size={13} /> Reset
              </button>
              <button
                type="button"
                onClick={showHint}
                disabled={solved}
                className="route-secondary"
              >
                <Lightbulb size={13} /> Hint
              </button>
            </div>
            <Button onClick={nextPuzzle} arrow>
              {solved ? "Next route" : "New puzzle"}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
