#!/usr/bin/env python3
"""Copy production D1 into local development. Stop the dev server first."""
import json
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
from datetime import datetime, timezone

api = Path(__file__).resolve().parents[1] / "apps/api"
for port in (3000, 8787):
    try:
        connection = socket.create_connection(("localhost", port), timeout=1)
    except OSError:
        continue
    connection.close()
    raise SystemExit(f"Stop the dev server on port {port} before cloning production.")

snapshot = api / ".wrangler/snapshots" / datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
snapshot.mkdir(parents=True, mode=0o700)


def query(sql):
    result = subprocess.run(
        ["bunx", "--no-install", "wrangler", "d1", "execute", "DB", "--remote", "--json", "--command", sql],
        cwd=api, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


schema = query("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY name")[0]["results"]
tables = [row for row in schema if row["type"] == "table"]
# One read-only batch fetches the current table contents. Nothing writes to production.
data = query("; ".join('SELECT * FROM "' + table["name"].replace('"', '""') + '"' for table in tables))
if len(data) != len(tables) or any(not result.get("success") for result in data):
    raise SystemExit("Production query was incomplete. Local data was not changed.")

# Initialize the local D1 file if this is a fresh checkout.
subprocess.run(["bunx", "--no-install", "wrangler", "d1", "execute", "DB", "--local", "--command", "SELECT 1"], cwd=api, check=True, stdout=subprocess.DEVNULL)
state = api / ".wrangler/state"
shutil.copytree(state, snapshot / "local-state")
local_files = [p for p in (state / "v3/d1/miniflare-D1DatabaseObject").glob("*.sqlite") if p.name != "metadata.sqlite"]
if len(local_files) != 1:
    raise SystemExit("Expected one local D1 database. Local data was not changed.")

with sqlite3.connect(local_files[0]) as local, sqlite3.connect(snapshot / "production.sqlite") as cloned:
    local.backup(cloned)
    cloned.execute("PRAGMA foreign_keys = OFF")
    old_tables = cloned.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").fetchall()
    for (name,) in old_tables:
        cloned.execute('DROP TABLE "' + name.replace('"', '""') + '"')
    for table in tables:
        cloned.execute(table["sql"])
    for table, result in zip(tables, data):
        rows = result["results"]
        if rows:
            columns = list(rows[0])
            names = ", ".join('"' + name.replace('"', '""') + '"' for name in columns)
            placeholders = ", ".join("?" for _ in columns)
            cloned.executemany('INSERT INTO "' + table["name"].replace('"', '""') + f'" ({names}) VALUES ({placeholders})', [[row[name] for name in columns] for row in rows])
        print(f'{table["name"]}: {len(rows)} rows')
    for row in schema:
        if row["type"] != "table":
            cloned.execute(row["sql"])
    violations = cloned.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise SystemExit("Cloned data has foreign key violations. Local data was not changed.")
    cloned.commit()
    cloned.backup(local)

# Local usage objects rebuild their counters from the cloned request journal.
shutil.rmtree(state / "v3/do", ignore_errors=True)
subprocess.run(["bun", "run", "db:migrate:local"], cwd=api, check=True)
print(f"Production copied locally. Previous local state backed up at {snapshot / 'local-state'}")
print("Start localhost with: bun run dev")
