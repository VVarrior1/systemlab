# Systemlab

A Next.js system design playground with a guided curriculum, an editable architecture canvas, and a deterministic simulation engine. The first screen opens a working lesson.

## Run locally

Use Node.js 22 LTS or newer and npm. Install the locked dependencies, then start the app:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). To select another port, run `npm run dev -- --port 3001`.

No credentials are required for lessons, simulations, saved designs, or browser progress. Optional cloud account settings are listed in `.env.example`.

## Included

- Twelve lessons across foundations, performance, workloads and queues, and reliability, with objectives, graduated hints, and reflection questions.
- React Flow architecture editing with application servers, load balancers, databases, caches, queues, and a built-in traffic source. Application servers can act as workers.
- Configurable traffic, seeds, spike and ramp patterns, component capacity, replica counts, and injected failures.
- Latency, throughput, errors, utilization, queue depth, sampled request traces, run comparisons, and explanations derived from simulation measurements.
- Sandbox templates, saved designs, JSON import and export, browser autosave, and persistent lesson completion.
- Optional Supabase email sign-in and explicit synchronization of saved designs and completed lessons.

## Architecture

`app/` contains Next.js App Router pages. `components/` contains the learning workspace, React Flow canvas, result views, and account controls. `lib/editor-store.ts` owns editing state with Zustand. `lib/curriculum.ts` and `lib/templates.ts` define authored lessons and starting architectures.

`lib/simulation/` is independent of React and uses SIM.JS for discrete event scheduling. `lib/simulation.worker.ts` runs the engine in a browser worker so simulation does not block the editor. `lib/types.ts` defines the contracts shared by the editor, curriculum, simulator, and persistence.

`lib/persistence.ts` validates imported and stored data, versions the storage format, bounds payload sizes, and reports storage failures. Drafts are separate for each lesson and the sandbox. Saved designs are limited to 100 per browser or account. Browser storage is specific to the current browser and deployment origin; clearing it removes local saves. Exported design files provide portable copies.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

Vitest covers simulation behavior and reproducibility, curriculum consistency, and persistence failure cases. Every lesson's hinted solution is checked against all objectives across three seeds. A routing regression verifies that the Share the Load workload overloads two application replicas without a load balancer and succeeds with explicit balancing at the same server capacity. Persistence tests exercise corrupt data, unsafe imports, quota failures, deletion markers, draft isolation, and progress merging. Browser interaction and responsive layout checks should run against the built app before each release.

For a production server locally:

```sh
npm run build
npm run start
```

## Optional cloud accounts

Without cloud environment variables, the account dialog shows an honest local workspace. Email sign-in and cloud sync become available when a Supabase project is configured.

1. Create a Supabase project and apply `supabase/migrations/202609070001_playground.sql` using the SQL editor or your Supabase migration workflow.
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` and in the matching Vercel environment. Use the public anon or publishable key; never use a service-role or secret key in these variables.
3. Enable email authentication. Configure the Site URL and allowed redirect URLs for the app, including `http://localhost:3000/learn` for local development and the deployed `/learn` URL. Configure an email provider suitable for your production traffic.
4. Restart or rebuild the app after changing public environment variables. Open Account & storage, request a sign-in link, then use Sync saved work.

The migration enables row-level security on designs and progress. A transactional, authenticated `sync_playground` function merges newer designs, retains deletion markers, and preserves the earliest lesson completion and best latency result with its associated cost. Cloud sync is manual; drafts remain local. Browser saves remain on the device after sign-out, so shared computers require the usual care with browser data.

Cloud merging uses saved timestamps, so device clocks should be reasonably synchronized. Progress records are learning aids, not tamper-proof credentials. There is no public sharing service or server-verified certification.

No Supabase project or credentials are included. Live email delivery, deployed database migrations, and isolation between two real users require verification against your configured project before enabling cloud accounts for users. Official references: [email sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithotp) and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Vercel

Import the repository as a Next.js project. The build command is `npm run build`; Vercel detects the framework output automatically. The guest experience needs no environment variables. Configure the optional Supabase variables for each environment that should offer cloud accounts, and include that deployment's sign-in redirect URL in Supabase.

## Simulation assumptions and scope

The simulator teaches relationships and tradeoffs; it is not a real infrastructure benchmark. Each result includes the assumptions and engine version used for that run.

- Identical ordered architecture, workload, seed, and engine version reproduce results. Each request is simulated individually.
- Capacity determines average service time per replica, with seeded variation; configured latency adds transit or dependency delay outside the occupied processing lane. Provisioning capacity and routing requests to it are separate operations.
- Starting with engine 1.1.0, a direct connection to an application server addresses only its first replica. An explicit load balancer selects healthy application replica endpoints in round-robin order. Requests wait in the selected replica's FIFO queue; extra application replicas are idle without a route to them. Real infrastructure may use proxies, service networking, or client-side balancing, but this model does not assume those mechanisms implicitly.
- Worker replicas pull work from a shared FIFO queue. The queue provides work distribution, so this modeled worker pool does not require an HTTP load balancer.
- Database, cache, and load-balancer replicas are idealized managed service pools with implicit dispatch across equivalent healthy service slots. Database slots accept both reads and writes; this is a capacity abstraction, not a claim that real database replicas automatically scale writes or provide immediate failover. Replication lag, read-only replicas, leader election, write coordination, consistency, sharding, and consensus are not modeled.
- Supported runs use 1-2,000 base requests per second for 1-60 seconds, with up to 48 components. Every request has a five-second completion deadline. Outstanding work is observed for up to five additional seconds.
- Latency percentiles describe successful requests. Errors are reported separately. Headline throughput counts successful completions during the configured arrival window; charts also show the subsequent drain period.
- Cache hits apply only to reads. Writes and misses visit the database. Cache warm-up, invalidation, stale data, key skew, and eviction are not simulated.
- Queued jobs are measured through worker completion, not queue acknowledgment. Durability, retry policies, duplicate delivery, and idempotency are not simulated.
- A failure removes the first replica from the first matching enabled component halfway through a run. Load balancers immediately avoid that application endpoint for new requests; direct traffic keeps targeting the failed first replica. Application work already processing or waiting at that endpoint can fail rather than migrate. Managed pools can dispatch waiting work to surviving slots. Health-detection delays, retries, recovery, and network partitions are not simulated.
- Costs are authored scenario credits, not cloud provider prices. Every provisioned replica is billed, including application replicas that receive no traffic.

The advanced lessons in this release cover capacity tradeoffs and failure tolerance within this model. Full distributed data semantics, collaboration, AI explanations, and production observability integrations remain future work. The core lessons and result explanations do not call an AI service.
