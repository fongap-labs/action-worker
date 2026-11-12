# Centrally managed test packs

Each directory in `tests/packs/` belongs to one target repository. The pack lives in trusted
Action Worker history and runs against a separate target checkout. Target code must not change
which tests run or inject host credentials.

The manifest `pack.json` declares a schema version, exact pack name, runtime, and optional
environment names. Node suites are discovered from the trusted pack directory by the declared
suffix. `tiers.gate` lists the gate suites explicitly; every remaining Node suite is `unit`.
Running `all` runs both tiers. A missing listed suite, duplicate gate name or empty selection
is an error, never a successful fallback to Node's default test discovery.

Python packs currently support `all` and `--filter=...` (pytest `-k`). They must not claim
to run `unit` or `gate` until a partition is explicitly defined. The Python import path
contains only the target checkout and trusted test kit, not the host `PYTHONPATH`.

The control repository's own tests remain in `tests/*.test.ts` and `tests/kit/*.test.mjs`,
while private sandbox integration stays in `tests/integration/`. The existing `npm test`,
full contract Job, separate private sandbox Job, and mandatory `validate-merge` gate
continue running without test removal or scope reduction.
