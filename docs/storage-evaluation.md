# Storage evaluation: Google Sheets vs local store

**Date:** 2026-04-19
**Context:** Step 3 of Smartico Bridge asks whether Google Sheets is a viable solution for managing imported datasets and applying rules. You picked Sheets as the preferred store — this doc is an honest look at the tradeoffs so we can commit (or pivot) before building deeper.

---

## The three candidates

1. **Google Sheets as source of truth** — every dataset and rule lives in Sheets; the app reads/writes via the Sheets API.
2. **Local JSON files on disk** — datasets and rules saved as JSON in a `/data` directory on the server.
3. **SQLite file on disk** — single `smartico.db` holds datasets, rules, schedules.

All three can produce the same UX for you in the dashboard. The difference is where the data actually lives, who else can touch it, and what breaks at scale.

---

## What Sheets buys you

- **Familiar editing surface.** You and the team can open a spreadsheet and edit rows directly. No CRUD UI required for quick fixes.
- **Shareable without login to our app.** Drop a link into Slack and people can view/filter.
- **Column mapping and sorting are "free."** Sheets already does renames, sorting, and basic totals natively.
- **Zero infrastructure.** No disk volume to configure on Railway, no DB backup to worry about.
- **Collaborative editing.** Multiple people can be in the same dataset at once.
- **Audit trail.** Sheets' built-in version history is real and useful.

## Where Sheets hurts

- **API rate limits.** Sheets API is 300 requests/minute/project and 60 read-requests/minute/user. A rules engine that loops over datasets and computes totals hits this fast. For a single user with a few datasets it's fine; at 10+ datasets with frequent rule recalculation, you'll get throttled.
- **Latency.** Each API call is ~300–1500ms. A page that loads a list of datasets and their totals can take 5–10 seconds if done naively. You'll need to cache aggressively.
- **Row limits.** Sheets caps at 10 million cells per workbook and ~40k characters per cell. Your winners data is small, so this won't bite unless you scale to dozens of datasets in one sheet.
- **Auth complexity.** Service account with domain-wide delegation, OR OAuth flow for each user. Railway env vars need the JSON key. First-time setup is fiddly; key rotation is annoying.
- **Concurrency gotchas.** If the app writes at the same time someone edits in the browser, conflict resolution is "last write wins" — user edits can get silently overwritten.
- **Schema drift.** Nothing stops someone from inserting a column in Sheets that the app doesn't know about, or renaming a header that the rules depend on. The app has to defensively re-parse headers on every read.
- **Offline / CI.** You can't run the app without an internet connection, and tests need either a sandbox sheet or mocked client.
- **Cron reliability.** Scheduled jobs pulling from Smartico and pushing to Sheets will occasionally fail on API hiccups. Need retry logic.

## Where local JSON/SQLite win

- **Speed.** Sub-millisecond reads. A list of 100 datasets loads instantly.
- **No rate limits.** Calculate totals on every render if you want.
- **Simpler code path.** `fs.readFile` + `JSON.parse` vs an auth'd API call.
- **Deterministic tests.** Easy to seed fixtures.

## Where local JSON/SQLite lose

- **No shared editing surface.** You have to build the edit UI yourself, or accept that edits only happen in the app.
- **Single-node.** Railway web dynos are ephemeral — you'd need a persistent volume. SQLite needs WAL mode and careful handling if you ever scale to >1 process.
- **No audit trail without building one.**

---

## Recommendation

**Hybrid: local JSON as source of truth, Sheets as a sync target.**

- The app stores datasets and rules in `/data/*.json`. Fast, deterministic, works offline, no rate limits, no auth headaches for the core workflow.
- A **"Sync to Sheet"** action (manual button + cron option) pushes a dataset into a named Google Sheet. Changes made in Sheets can be pulled back via a **"Pull from Sheet"** action that reconciles against the local copy.
- Rules run locally against the JSON store. Results can optionally be written back to the Sheet for viewing.

**Why this beats pure-Sheets:**

- The interactive bits (list view, rule evaluation, Figma plugin fetches) stay fast because they hit local disk.
- You still get the Sheets editing surface and shareable link when you want it.
- If the Sheets API is down or rate-limited, the app keeps working.
- Migrating later (to SQLite, Postgres, whatever) only touches the storage adapter.

**Why this beats pure-JSON:**

- You keep the "I want to eyeball this in a spreadsheet and tweak a row" workflow.
- The Sheets integration becomes an optional feature, not a core dependency.

**Why this beats pure-SQLite:**

- JSON files are easier to inspect/backup/git-diff while the schema is still evolving. Once the shape settles, swapping JSON → SQLite is a half-day job.

## Decision needed from you

Pick one before I build step 3:

1. **Hybrid (recommended).** Local JSON source of truth + optional Sheets sync.
2. **Pure Sheets.** Sheets is the store; accept the rate-limit and latency tradeoffs. I'll add aggressive caching.
3. **Pure local JSON.** Skip the Sheets integration entirely for now. Fastest to build.

If you go with (2) pure Sheets, I'd want to also add: a Redis-like in-memory cache layer on top, a queue for write operations, and explicit conflict-resolution logic. That's ~2x the build effort of the hybrid.

---

## Open questions before I commit either way

- Is the app single-user (just you) or will the team log in and edit?
- Roughly how many datasets do you expect in a month? 10? 100? 1000?
- Do winners datasets ever need to be edited *after* import, or are they immutable once ingested?
- Do you already have a Google service account for this project, or will we set one up?
