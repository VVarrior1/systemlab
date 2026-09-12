# Systemlab

A Next.js system design trainer: a 57-lesson curriculum across 12 chapters, an editable architecture canvas, a deterministic discrete-event simulation engine that models the things that actually break systems, and a learning loop that makes you estimate before you run, defend your design in writing, and replay lessons at new numbers.

## Run locally

Use Node.js 22 LTS or newer and npm. Install the locked dependencies, then start the app:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). To select another port, run `npm run dev -- --port 3001`.

No credentials are required for lessons, simulations, saved designs, the estimation gym, or browser progress. Optional settings for design-defense grading and cloud accounts are listed in `.env.example`.

## Included

- **57 lessons in 12 chapters**, four tiers from Beginner to Expert: Foundations, Performance, Workloads & queues, Caching deep dive, Reliability, Replication & consistency, Partitioning, Traffic control, Multi-region, Data systems (delivery semantics, dead-letter queues, quorums, lost writes, gray failure, connection pools, transactions and sagas, streams and search), an Interview toolkit of written knowledge lessons, and five open-ended Design briefs on a blank canvas.
- **Three lesson kinds.** `sim` lessons are built and measured on the canvas. `brief` lessons start ambiguous and empty: you type your own clarifying questions to an interviewer (matched to the hidden facts, or answered by Claude when a key is set) to reveal the workload, then estimate, build from a blank canvas, and defend. `written` lessons teach a topic through curated readings and a written exercise.
- **A learning loop that trains interview skills.** Hints name methods, never numbers. You commit numeric estimates (latency, throughput, database load, cost) before Check unlocks and see how calibrated you were. After passing, the app runs alternatives (scale the bottleneck, add a cache, trim replicas, the hidden reference) and shows where your design sits on cost versus latency. Then you defend the design in interview mode: a clock per stage, dictation through the browser's speech recognition, follow-up questions generated from the weakest claims in your own answer when a key is set, and a rubric grade with deductions for hints, wrong reflection attempts, and overtime. Without a key you self-assess blind: rubric first, model answer only afterwards.
- **Remix.** Every sim lesson can be replayed with a re-rolled workload; targets are derived from a hidden reference solution so the remix is always solvable and never the same numbers twice.
- **Curated deep-dive readings** for every lesson: verified links to the Google SRE book, PostgreSQL and Redis docs, AWS architecture articles, Jepsen, The Tail at Scale, and engineering blogs, each with a one-line reason to read it.
- **Estimation gym** at `/gym`: randomized back-of-envelope drills (QPS from DAU, storage growth, bandwidth, server counts, cache sizing, Little's law, retry amplification, availability of serial dependencies, latency numbers) with tolerance grading and streaks.
- **Engine 2.1.** Heavy-tailed service times; at-least-once delivery with visibility timeouts, redelivery, duplicates, idempotent workers and dead-letter queues; quorum databases with tunable W and R; lost writes on leader failover; gray failures (slow servers, flapping replicas, error bursts that health checks miss); connection pools that starve on slow dependencies; tunable circuit breakers and deadlines; keyed caches with hot keys, TTLs, cold starts and request coalescing; leader-follower databases with replication lag, read-your-writes and failover; sharded databases with hash or range partitioning and hot shards; timeouts, retries with backoff and jitter, circuit breakers; bounded queues and token-bucket rate limiters that shed instead of timing out; load balancers with health-check delay and least-connections; parallel fan-out; regions with cross-region latency and geo routing; failure events that recover (server, database, cache flush, slow database, region outage).
- **Cost 2.1.** Per-kind nonlinear provisioned pricing plus usage-based cost from measured traffic (database operations, cache and CDN hits, queue deliveries, cross-region crossings), so a cache, a read replica, a bigger database and a queue are genuinely different strategies, with a per-component breakdown of both.
- Sandbox templates (web app, cached service, background jobs, microservices fan-out, leader and read replicas, sharded writes, rate-limited API, multi-region), saved designs, JSON import and export, browser autosave, and persistent progress that records attempts, hints used, estimation accuracy and defense scores.
- Optional Supabase email sign-in and explicit synchronization of saved designs and completed lessons.

## Architecture

`app/` contains Next.js App Router pages, including `app/gym` and the `app/api/grade` route handler. `components/` contains the learning workspace (`playground.tsx`), the mission panel with estimation and readings, the clarification and defense stages, the React Flow canvas, result views with alternatives, the library, the gym, and account controls. `lib/editor-store.ts` owns editing state with Zustand.

`lib/curriculum/` holds the curriculum: one file per chapter under `chapters/`, shared authoring helpers in `shared.ts`, and the index that numbers lessons. `lib/readings/` holds the verified reading lists keyed by lesson id. `lib/templates.ts` defines component defaults, field defaults and sandbox templates. `lib/drills.ts` defines the gym. `lib/estimation.ts`, `lib/alternatives.ts` and `lib/remix.ts` implement the estimation scoring, counterfactual designs and remix derivation. `lib/grading.ts` builds and scores the design-defense grading request.

`lib/simulation/` is independent of React and uses SIM.JS for discrete event scheduling: `index.ts` (engine), `distributions.ts` (seeded RNG, lognormal service times, power-law keys), `cache.ts` (keyed LRU with TTL and coalescing), `insights.ts` (mechanistic explanations), `validate.ts` (topology and limits). `lib/simulation.worker.ts` runs the engine in a browser worker so simulation does not block the editor. `lib/types.ts` defines the contracts shared by the editor, curriculum, simulator, and persistence.

`lib/persistence.ts` validates imported and stored data, versions the storage format, bounds payload sizes, and reports storage failures. Drafts are separate for each lesson and the sandbox. Saved designs are limited to 100 per browser or account. Browser storage is specific to the current browser and deployment origin; clearing it removes local saves. Exported design files provide portable copies.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

Vitest covers the engine (determinism, heavy tails, shedding, retries and amplification, breakers, leader failover and stale reads, sharding, keyed caches, health-check delay, regions, fan-out), cost, curriculum rules (every reference solution passes its objectives on three seeds, every starter fails at least one, hints contain no numbers, rubric weights sum to 100, remixed references satisfy their derived targets), estimation scoring, alternatives, remix, drills, grading request validation, and persistence failure cases. Browser interaction and responsive layout checks should run against the built app before each release.

For a production server locally:

```sh
npm run build
npm run start
```

## Design defense grading

Every lesson ends with a written design defense: the learner justifies their architecture and answers a few adversarial follow-up questions against the lesson's rubric.

- **Self-assessment mode (default).** With no `ANTHROPIC_API_KEY` set, `POST /api/grade` responds `501 { mode: "self" }`, the follow-ups are the lesson's static ones, and the learner grades their own answer blind: rubric first, the model answer only afterwards, with one revision allowed. Completions are tagged self-assessed.
- **Graded mode.** With `ANTHROPIC_API_KEY` set, Claude (`GRADER_MODEL`, default `claude-opus-5`) first generates three follow-up questions aimed at the weakest claims in the learner's own design text, then grades the answers against the rubric: a 0-2 score and one-line note per rubric item, a weighted 0-100 total, and a short critique. In briefs, typed clarifying questions the hidden facts do not cover are answered in character by the same model through `POST /api/clarify`. The model answer used as the grader's reference is never sent to the client.

Set `ANTHROPIC_API_KEY` and, optionally, `GRADER_MODEL` in `.env.local` (and in the Vercel environment for deployments) to turn on graded mode; leave them unset to keep self-assessment.

## Optional cloud accounts

Without cloud environment variables, the account dialog shows an honest local workspace. Email sign-in and cloud sync become available when a Supabase project is configured.

1. Create a Supabase project and apply `supabase/migrations/202609070001_playground.sql` followed by `supabase/migrations/202609100001_v2_progress.sql` using the SQL editor or your Supabase migration workflow.
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` and in the matching Vercel environment. Use the public anon or publishable key; never use a service-role or secret key in these variables.
3. Enable email authentication. Configure the Site URL and allowed redirect URLs for the app, including `http://localhost:3000/learn` for local development and the deployed `/learn` URL. Configure an email provider suitable for your production traffic.
4. Restart or rebuild the app after changing public environment variables. Open Account & storage, request a sign-in link, then use Sync saved work.

The migrations enable row-level security on designs and progress. A transactional, authenticated `sync_playground` function merges newer designs, retains deletion markers, preserves the earliest lesson completion and best latency result with its associated cost, and keeps the highest attempt, estimation and defense scores. Cloud sync is manual; drafts, attempts and gym progress remain local. Browser saves remain on the device after sign-out, so shared computers require the usual care with browser data.

Cloud merging uses saved timestamps, so device clocks should be reasonably synchronized. Progress records are learning aids, not tamper-proof credentials. There is no public sharing service or server-verified certification.

No Supabase project or credentials are included. Live email delivery, deployed database migrations, and isolation between two real users require verification against your configured project before enabling cloud accounts for users. Official references: [email sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithotp) and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Vercel

Import the repository as a Next.js project. The build command is `npm run build`; Vercel detects the framework output automatically. The guest experience needs no environment variables. Configure `ANTHROPIC_API_KEY` for graded defenses and the optional Supabase variables for each environment that should offer cloud accounts, and include that deployment's sign-in redirect URL in Supabase.

## Simulation assumptions and scope

The simulator teaches relationships and tradeoffs; it is not a real infrastructure benchmark. Each result includes the full list of assumptions and the engine version used for that run (the Model tab). In short:

- Identical ordered architecture, settings, seed and engine version reproduce results byte for byte. Every request is simulated individually, with a five-second end-to-end deadline; supported runs are 1-60 seconds at 1-3,000 requests per second with up to 48 components.
- Service time is 1,000 / capacity ms multiplied by a lognormal draw (low, medium or high variance), so tails are heavy and p99 is not p50 plus a constant. Configured latency is added after the processing lane is released. A lane is busy only while processing; dependency waits are asynchronous, and connection pools, thread limits and memory pressure are not modeled.
- Requests carry a key drawn from a power law over the configured key space and skew, a read/write flag, and an origin region. Hot keys are what make keyed caches, shards and coalescing behave differently from a hit-rate dial.
- A direct connection to an application server reaches replica 1 only; a load balancer spreads requests over (server, replica) endpoints, round robin or least connections, and refreshes its health view on the configured interval. Workers pull from a shared queue.
- Keyed caches are an LRU with optional TTL, populated write-through; a read served after a later write to the same key counts as stale. Probabilistic caches only model a hit rate and a warm-up ramp.
- Leader-follower databases send writes to the leader and reads to followers; reads inside the replication lag are stale unless read-your-writes routes them to the leader; losing the leader fails writes for the failover time, then promotes a follower. Sharded databases are independent pools keyed by hash or range. Consensus, quorum reads, cross-shard transactions, rebalancing and secondary indexes are not modeled.
- Timeouts abandon a dependency call while the downstream work keeps consuming capacity; retries back off with full jitter; a circuit breaker opens after a second of mostly failing calls and closes on a successful probe. Rate limiters and bounded queues reject on arrival, and rejections are reported separately from errors.
- Cross-region hops add the configured latency; a CDN is treated as being in the caller's region; a region outage removes every replica in that region until it recovers.
- Costs are teaching credits from a per-kind nonlinear curve, not provider prices; data size, egress and storage are not priced.

Network partitions inside a region, consensus protocols, connection pooling, payload size, and real billing remain out of scope. The lessons, simulation and result explanations run entirely in the browser; only the optional design-defense grader calls an AI service.
