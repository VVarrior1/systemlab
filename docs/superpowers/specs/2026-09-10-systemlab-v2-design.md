# Systemlab v2 design: from tuner to system-design trainer

Date: 2026-09-10. Status: approved for build (user: "fix it all the way till it's 8-10/10"; "more content, more difficulty, more knowledge, source websites where better").

## 1. Goal and bar

An expert judge scored v1 at 3/10 against this bar: "a learner who works through it can pass senior/staff system-design interviews and make sound real-world architecture decisions." v2 must score 8+ on the same bar. The judge's gaps, in order:

1. No verbal skills practised: no requirement clarification, no written justification, no adversarial follow-ups, no rubric.
2. Estimation is done for the learner (hint 3 hands over the numbers).
3. Concept surface is ~15-20% of an interview (five node kinds, one topology).
4. Twelve fixed problems, solvable once. No generator, no reps.
5. Failure model cannot teach failure intuition (one scripted death, instant detection, no retries, no recovery).
6. Overload always resolves as timeouts, never shedding.
7. Cost is one linear formula; no cache-vs-replica-vs-scale-up tradeoff.
8. Feedback is mechanical, never comparative.
9. Progress is gameable and records no depth.

Wrong lessons the model currently teaches: flat ±15% service time (thin tails), instant free failover, DB replica = write availability, caching as a probability dial, trial-and-error rerun loop, green metrics = good design.

## 2. Product shape after v2

- **~50 lessons in 11 chapters** (was 12 in 4). Four tiers: Beginner, Intermediate, Advanced, Expert.
- Three lesson kinds: `sim` (build and measure), `brief` (open-ended interview problem: clarify → estimate → build → defend), `written` (knowledge lesson: readings + written defense, no simulation).
- Every lesson: method-only hints (no numbers), a **pre-check estimation commitment**, a **written design defense** with adversarial follow-ups graded by rubric (Claude-graded when `ANTHROPIC_API_KEY` is set, self-assessed against a model answer otherwise), curated **deep-dive readings** with verified URLs, and a **Remix** that re-rolls the workload so the lesson can be replayed at novel numbers.
- **Engine 2.0**: heavy-tailed service times, keyed caches (hot keys, cold start, stampede, TTL, staleness), leader-follower and sharded databases (lag, failover, hot shards), retries/timeouts/circuit breakers, bounded queues and rate limiters (shedding), load-balancer health-check delay and least-connections, parallel fan-out (tail amplification), regions with cross-region latency and geo routing, multiple failure events with recovery (server, database, cache flush, slow database, region outage).
- **Cost 2.0**: per-kind nonlinear pricing so cache vs read replica vs scale-up vs queue are genuinely different strategies, with a cost breakdown.
- **Comparative feedback**: after a check, the app runs alternatives (scale the bottleneck, add a cache, trim replicas, the reference solution) and shows where the learner's design sits on cost vs p95 and what the cheaper/better alternative did.
- **Estimation gym**: randomized back-of-envelope drills (QPS, storage, bandwidth, server count, cache sizing, Little's law, latency numbers) with tolerance grading.
- **Progress 2.0**: attempts, hints used, estimation score, defense score and mode, remixes completed. Assessment version 3 invalidates v1 completions (the review banner already handles this).

## 3. Contracts (lib/types.ts)

All new node and workload fields are optional with defaults so v1 saved designs still load. `normalizeNode` / `normalizeWorkload` in `lib/templates.ts` apply defaults.

```ts
export type NodeKind = "traffic" | "server" | "load-balancer" | "database" | "cache" | "queue" | "cdn" | "rate-limiter";
export type Region = string; // free text, default "primary"

export interface SystemNode {
  id: string; kind: NodeKind; label: string; position: { x: number; y: number };
  capacity: number; latency: number; replicas: number; cacheHitRate: number; enabled: boolean; cost: number;
  role?: "application" | "worker";
  region?: Region;                                   // default "primary"
  variance?: "low" | "medium" | "high";             // service-time lognormal sigma 0.2 / 0.4 / 0.8, default medium
  // server
  timeoutMs?: number;        // dependency-call timeout; 0 = none (default 0)
  retries?: number;          // 0-3 retries after timeout/failure (default 0)
  retryBackoffMs?: number;   // base for exponential backoff with full jitter (default 50)
  circuitBreaker?: boolean;  // default false
  maxQueue?: number;         // per-replica queue bound; 0 = unbounded (default 0). Arrivals beyond it are rejected fast.
  fanout?: "parallel" | "sequential"; // when a server has >1 dependency (default parallel)
  // load balancer
  algorithm?: "round-robin" | "least-connections"; // default round-robin
  healthCheckMs?: number;    // dead-endpoint detection interval; 0 = immediate (default 0)
  // database
  dbMode?: "single" | "leader-follower" | "sharded"; // default single
  shards?: number;           // sharded: default 4
  shardStrategy?: "hash" | "range"; // sharded: default hash
  replicationLagMs?: number; // leader-follower: default 200
  failoverMs?: number;       // leader-follower: time to promote a follower after leader death, default 3000
  consistency?: "eventual" | "read-your-writes"; // leader-follower: read-your-writes routes reads of recently written keys to the leader (default eventual)
  // cache
  cacheModel?: "probabilistic" | "keyed"; // default probabilistic
  cacheEntries?: number;     // keyed: LRU capacity in keys (default 1000)
  ttlMs?: number;            // keyed: 0 = no expiry (default 0)
  coalesce?: boolean;        // keyed: collapse concurrent misses for one key into one origin fetch (default false)
  warmupSeconds?: number;    // probabilistic: hit rate ramps 0 → cacheHitRate over N s at start and after a cache flush (default 0)
  // rate limiter
  limit?: number;            // token-bucket refill, req/s (default 500)
  burst?: number;            // bucket size (default = limit)
}

export interface FailureEvent {
  kind: "server" | "database" | "cache-flush" | "slow-database" | "region";
  at: number;         // fraction of duration, 0..1 (default 0.5)
  duration?: number;  // seconds until recovery; 0/undefined = no recovery (server/database); slow-database default 5; region default 0
  factor?: number;    // slow-database service-time multiplier (default 5)
  target?: string;    // node id; default first enabled matching component
  region?: Region;    // region outage target
}

export interface Workload {
  requestRate: number; readRatio: number; duration: number; seed: number;
  pattern: "steady" | "spike" | "ramp" | "flash";   // flash: 6x for 8% of the run starting at 40%
  failure: "none" | "server" | "database";          // legacy; ignored when `failures` is set
  failures?: FailureEvent[];
  keySpace?: number;          // distinct keys (default 10000)
  keySkew?: number;           // 0 uniform … 0.95 extreme (default 0.6)
  regions?: { name: Region; share: number }[];  // traffic origin mix; default [{primary, 1}]
  crossRegionLatencyMs?: number;               // added to any hop that crosses regions (default 80)
}
```

Result additions:

```ts
export interface SimulationResult {
  … existing …
  rejected: number;        // shed by rate limiter, bounded queue, or open circuit (fast, deliberate)
  rejectedRate: number;    // rejected / requestCount
  errorRate: number;       // (failed − rejected) / requestCount   ← redefined: unexpected failures only
  successRate: number;     // completed / requestCount
  p99: number;
  staleReads: number; staleReadRate: number;   // reads served with data older than the last write to that key (keyed cache TTL, follower lag)
  retriesIssued: number; amplification: number; // dependency calls / requests that reached that dependency
  costBreakdown: { nodeId: string; label: string; cost: number }[];
  events: { time: number; title: string; detail: string; nodeId?: string }[]; // failures, recoveries, breaker open/close, failover
}
export type ObjectiveMetric = "p95" | "p99" | "throughput" | "errorRate" | "rejectedRate" | "successRate" | "cost" | "maxQueueDepth" | "staleReadRate";
export type TraceStatus = "ok" | "error" | "hit" | "miss" | "bypass" | "rejected" | "timeout" | "retry" | "coalesced" | "stale" | "open-circuit";
```

Lesson contract:

```ts
export interface Reading { title: string; url: string; source: string; why: string; minutes?: number }
export interface EstimationPrompt { id: "p95" | "throughput" | "cost" | "dbLoad" | "bottleneckCapacity" | "queueDepth"; label: string; unit: string; tolerance: number }
export interface DefenseSpec {
  prompt: string;                // "Explain your design and two alternatives you rejected."
  followUps: string[];           // 2-3 adversarial questions
  rubric: { id: string; criterion: string; weight: number }[];   // weights sum to 100
  modelAnswer: string;           // shown in self-assessment mode after submission
}
export interface Clarification { question: string; answer: string; relevant: boolean }
export interface Lesson {
  id: string; number: number; chapter: string; title: string; subtitle: string;
  kind: "sim" | "brief" | "written";
  difficulty: "Beginner" | "Intermediate" | "Advanced" | "Expert"; minutes: number;
  concept: string; brief: string; learning: string[]; hints: string[];
  objectives: Objective[]; architecture: Architecture; workload: Workload; allowedKinds: NodeKind[];
  requiredBalancedReplicas?: number;
  reference: Architecture;       // hidden solution; must pass all objectives on the three seeds (test-enforced)
  estimation: EstimationPrompt[];
  defense: DefenseSpec;
  readings: Reading[];
  reflection: { question: string; options: string[]; answer: number; explanation: string };
  clarifications?: Clarification[];   // briefs only: workload is hidden until ≥ half of the relevant questions are asked
  remixable: boolean;
}
export interface ProgressRecord {
  lessonId: string; completedAt: string; bestP95: number; cost: number; assessmentVersion?: number;
  attempts?: number; hintsUsed?: number; estimationScore?: number; defenseScore?: number;
  defenseMode?: "graded" | "self"; remixes?: number;
}
```

Hint rule (test-enforced): no hint may contain a number followed by req/s, ms, credits, %, or "replicas". Hints name methods ("compute the non-cacheable fraction: writes plus read misses"), never results.

## 4. Engine 2.0 (lib/simulation/)

Files: `index.ts` (orchestration and metrics), `distributions.ts` (xorshift RNG, lognormal, power-law key sampler), `cache.ts` (keyed LRU with TTL and coalescing), `cost.ts` stays in `lib/cost.ts`, `insights.ts` (insight rules), `validate.ts` (topology rules), `scheduler.ts` unchanged. `ENGINE_VERSION = "2.0.0"`.

Call/return model. Each hop is `enter(request, runtime, done: (ok: boolean) => void)`. Traffic's `done` finishes the request. A server lane is occupied only while processing; dependency waits are asynchronous (as in v1).

- **Arrivals.** As v1, plus `flash` pattern. Each request draws `read`, `key` (power law: `key = floor(keySpace * u^(1/(1-skew)))`), and `region` (from `regions` shares).
- **Service time.** `1000/capacity × lognormal(σ)` normalized to mean 1, σ by `variance`. Slow-database events multiply the target's service time by `factor` for `duration` seconds.
- **Servers.** Per-replica FIFO queue; `maxQueue > 0` rejects arrivals when the chosen replica's queue is full (status `rejected`). After service, call dependencies: parallel (all at once; continue when all done; fail if any fails) or sequential. Each dependency call: if `timeoutMs > 0` and no response within it, abandon (the downstream work continues and still consumes capacity: zombie work) and retry after `retryBackoffMs × 2^attempt × jitter` while retries remain; otherwise fail. `circuitBreaker`: per server, rolling 1 s window of dependency outcomes; ≥ 20 calls and ≥ 50% failures/timeouts → open for 5 s: calls fail fast with `open-circuit`, counted as rejected; half-open lets one probe through; success closes. Event emitted on open/close.
- **Load balancer.** Endpoints = (server, replica) pairs of application servers. `round-robin` over endpoints the balancer believes healthy; `least-connections` picks the lowest (busy + queued). Health view refreshes every `healthCheckMs` (0 = immediate); a request routed to a dead endpoint fails after `min(10, latency)` ms. Recovery is also noticed at the next check.
- **Database.** `single`: managed pool as v1. `leader-follower`: lane 0 is the leader; writes go to the leader; reads go round-robin to followers (leader if none). A follower read of a key written within `replicationLagMs` counts as `stale` (unless `consistency = read-your-writes`, which routes such reads to the leader). Leader death: writes fail for `failoverMs`, then the first healthy follower is promoted (event); no followers → all DB requests fail until recovery. `sharded`: `shards` independent pools of `replicas` lanes each; shard = `key % shards` (hash) or `floor(key / (keySpace/shards))` (range). A database failure event kills lane 0 of shard 0 / the leader / lane 0 of the pool.
- **Cache.** `probabilistic`: as v1, plus warm-up ramp and cache-flush resets. `keyed`: LRU `cacheEntries` with `ttlMs`; read hit if present and unexpired; write goes to the DB and then sets the key (write-through); miss goes to the DB and sets the key on return; `coalesce` joins concurrent misses for the same key (status `coalesced`, counts as a hit for the DB's sake). A read served from the cache after a write to that key that happened after the entry was set counts as `stale`. `cache-flush` event clears entries (cold start; stampede if hot keys and no coalescing).
- **Queue / worker.** As v1; a queue may set `maxQueue` (bounded; overflow rejected).
- **Rate limiter.** Token bucket (`limit`, `burst`); pass through with its own latency, else reject immediately (status `rejected`).
- **CDN.** Probabilistic edge hit for reads (`cacheHitRate`), finishing at the edge; misses forward. The CDN is treated as being in the request's own region.
- **Regions.** Every node has a region. A hop whose target region differs from the source region adds `crossRegionLatencyMs`. Traffic may connect to several targets; a request goes to the target in its own region, else the first target; if that target's region is fully down (region event) it fails over to another target. Region event: all replicas of all nodes in that region die at `at` and return after `duration`.
- **Failures.** `failures[]` (legacy `failure` maps to one event at 0.5 with no recovery). Server/database events kill one replica (or the leader) at `at`, with in-flight and pinned queued work failing as v1, and recovery after `duration` (replica returns idle). `events[]` in the result records every transition.
- **Deadline.** 5 s end-to-end as v1.
- **Metrics.** As v1 plus §3 additions. `amplification` = calls received by the busiest dependency ÷ requests its callers processed. Utilization accounts for dead time as v1.
- **Validation.** Extend v1 rules: traffic → 1..n targets (server, load-balancer, cdn, rate-limiter); cdn/rate-limiter → exactly one of server/load-balancer/cdn/rate-limiter; server → up to 4 dependencies (cache, database, queue, server, rate-limiter); cache → exactly one database; queue → exactly one worker; databases terminal. Limits: ≤ 48 nodes, ≤ 96 edges, rate ≤ 3000 req/s, duration ≤ 60 s, ≤ 6 failure events, keySpace ≤ 100000, shards ≤ 16.
- **Insights (lib/simulation/insights.ts).** Keep v1 rules; add: retry amplification (dependency received X× its callers' load), breaker opened N times, shed N requests (and that accepted requests' p95 stayed at Y), stale reads %, hot shard (max/mean shard utilization), cold-cache stampede (DB load in the 3 s after a flush vs steady state), detection window (failures between death and the next health check), cross-region share of p95, zombie work (abandoned calls that still consumed capacity).
- **Assumptions[]** rewritten for 2.0, still listing what is not modeled (consensus, network partitions inside a region, connection pools, data size, real pricing).

Tests (`lib/simulation/simulation.test.ts`, rewritten): determinism; v1 routing regression preserved; lognormal tail (p99/p50 > 1.8 at low utilization); bounded queue rejects and keeps accepted p95 low under 2× overload; rate limiter passes ≤ limit + burst per second; retries without timeout cause amplification > 1.5 during a slow-database event and a timeout + breaker keeps errorRate below the no-breaker run; leader-follower: writes fail during failoverMs then recover, follower reads scale; stale reads appear with lag and disappear with read-your-writes; sharded range + skew yields a hot shard (max/mean > 2) and hash does not; keyed cache hit rate rises with cacheEntries and coalescing cuts DB load after a flush; health-check delay produces failures proportional to the interval; region outage fails over; parallel fan-out p95 > any single dependency's p95.

## 5. Cost 2.0 (lib/cost.ts)

```
rates = {
  server:        { base: 3, cap: 200,   exp: 1.0, fixed: 0.4 },
  database:      { base: 4, cap: 150,   exp: 1.35, fixed: 1.0 },   // write capacity is expensive
  cache:         { base: 2, cap: 2500,  exp: 0.6, fixed: 0.4 },
  "load-balancer": { base: 1, cap: 5000, exp: 0.3, fixed: 0.5 },
  queue:         { base: 1, cap: 10000, exp: 0.4, fixed: 0.3 },
  cdn:           { base: 2, cap: 5000,  exp: 0.5, fixed: 0.6 },
  "rate-limiter": { base: 1, cap: 5000, exp: 0.3, fixed: 0.3 },
}
componentCost(node) = fixed + base × (capacity / cap) ^ exp          // per replica
nodeCost(node) = componentCost × replicas × shards(if sharded) × (1 + 0.15 × followers) (if leader-follower)
```

Results carry `costBreakdown`. The canvas inspector shows the per-node cost; `node.cost` stays as a display cache and is ignored by the engine.

## 6. Curriculum 2.0 (lib/curriculum/)

Split into one file per chapter under `lib/curriculum/` with `index.ts` exporting `chapters`, `lessons`, `getLesson`. Chapter order and lessons:

1. **Foundations** (Beginner): first-request; find-the-bottleneck; share-the-load; NEW little's-law (predict queue depth from λ×W, then measure).
2. **Performance** (Intermediate): make-reads-cheaper; survive-the-spike; spend-your-budget; NEW the-tail-at-scale (parallel fan-out to three services, p99 amplification, fix with variance and timeouts); NEW flash-crowd (6× burst: capacity vs shedding).
3. **Workloads & queues**: jobs-in-the-queue; drain-the-backlog; when-caches-cannot-help; NEW bounded-queues (shed to protect latency; rejectedRate cap).
4. **Caching deep dive** (Advanced): NEW hot-keys (keyed cache, skew, size the cache); NEW cold-start-and-stampede (cache flush, coalescing); NEW ttl-and-staleness (hit rate vs staleReadRate); NEW edge-caching (CDN for remote readers).
5. **Reliability**: lose-a-server (now with a health-check interval); protect-the-database (now leader-follower with failover); NEW detection-delay; NEW retry-storm; NEW circuit-breaker; NEW cascading-failure (fan-out with one slow dependency); launch-day (capstone rewritten).
6. **Replication & consistency**: NEW read-replicas; NEW replication-lag (read-your-writes); NEW leader-failover; WRITTEN choosing-consistency (CAP/PACELC, linearizability vs eventual, when each is right).
7. **Partitioning**: NEW shard-the-writes; NEW hot-shard (range vs hash); NEW celebrity-problem (one ultra-hot key, cache + coalescing in front of a shard); WRITTEN indexes-and-rebalancing.
8. **Traffic control**: NEW rate-limit-the-api; NEW burst-allowance; NEW backpressure-end-to-end; WRITTEN rate-limiting-algorithms.
9. **Multi-region**: NEW far-away-users; NEW active-active; NEW region-outage.
10. **Interview toolkit** (WRITTEN): framing-and-requirements; numbers-everyone-should-know (links to the gym); api-design-and-idempotency; storage-engines-and-indexing; observability-and-slos.
11. **Design briefs** (Expert, kind `brief`): url-shortener; news-feed; ticket-sale; chat-and-notifications; metrics-ingestion.

Authoring rules: every `sim`/`brief` lesson ships a `reference` architecture that passes all objectives on seeds [lesson seed, 123, 2026] (test-enforced); objectives are set so the starter fails at least one; hints obey the no-numbers rule; `learning` explains the mechanism and states what the model idealizes; `defense.followUps` probe the lesson's real weak points (10× traffic, cold cache, write bottleneck, detection delay); `readings` are 2-4 verified links with a one-line "why". Written lessons have `objectives: []`, `architecture`/`reference` = a minimal placeholder, and completion = defense only.

## 7. Learning loop in the workspace

Order of stages for a `sim` lesson: Mission → (Hints, opt-in) → **Estimate** → Check (3 seeds) → **Alternatives** shown → Reflection MCQ (options shuffled per attempt) → **Defend** → Complete. For a `brief`: **Clarify** first. For `written`: Readings → Defend → Complete.

- **Estimate** (`components/estimation-panel.tsx`): numeric inputs for the lesson's prompts; must be filled before Check unlocks (sandbox exempt). After Check: actual, delta, and a score (within tolerance = 1, within 2× = 0.5). Saved as `estimationScore` (mean).
- **Alternatives** (`lib/alternatives.ts` + Results tab): generate variants of the learner's design: scale-the-bottleneck (+50% capacity on the highest-pressure node), add-a-cache (insert a probabilistic cache before the first database if none), trim-replicas (−1 on nodes with ≥ 2), and the lesson `reference`. Run each on the lesson seed in the worker, list cost / p95 / errorRate / objectives passed, and print a one-sentence comparison ("The reference meets every target at 22% lower cost by caching instead of a bigger database").
- **Defend** (`components/defense-stage.tsx`): textarea for the design justification (≥ 60 words), then the follow-ups one at a time. Submit → `POST /api/grade`. Response `{ mode: "graded", items: [{ id, score: 0|1|2, note }], total: 0-100, critique }` or HTTP 501 `{ mode: "self" }` → self-assessment: show the model answer and rubric checkboxes; the learner ticks what they covered; total = weighted ticks. Completion requires total ≥ 60 (graded) or self-assessment submitted. Saved as `defenseScore`, `defenseMode`.
- **Clarify** (`components/clarification-stage.tsx`): the brief shows an ambiguous prompt and a list of questions; each click reveals its answer; once at least half of the relevant ones are asked, the workload and objectives are revealed and set. Count of irrelevant questions is shown, not penalized.
- **Remix**: button on sim lessons. `lib/remix.ts` scales `requestRate` by a seeded factor in [0.7, 1.6], shifts `readRatio` by ±0.15 (clamped), keeps the pattern and failures, scales the reference's server/worker/database capacities by the same factor (rounded to 10), runs the reference on the three seeds in the worker, and derives objectives: p95 ≤ round(1.2 × max ref p95), throughput ≥ 0.95 × requestRate for steady (0.9 for spike/ramp/flash), errorRate ≤ 0.01, cost ≤ round(1.1 × ref cost), any queue-depth or stale objective kept at 1.5× the reference value. The reference is never shown; hints are shown unchanged.
- **Attempts**: every Check increments `attempts` for the lesson (stored locally under `attempts:<lessonId>`, merged into the progress record on completion).

## 8. Grading endpoint (app/api/grade/route.ts)

Server-side only. Reads the rubric from the curriculum by `lessonId` (never from the client). Validates: answers are strings ≤ 4000 chars, ≤ 4 answers. In-memory rate limit 20 requests / minute / IP. If `process.env.ANTHROPIC_API_KEY` is unset, respond `501 { mode: "self" }`. Otherwise call Claude with the official SDK (`@anthropic-ai/sdk`, `client.messages.parse` with `zodOutputFormat`), model `process.env.GRADER_MODEL ?? "claude-opus-5"`, `max_tokens: 4000`, `output_config: { effort: "medium" }`, a frozen system prompt (staff interviewer, grade each rubric item 0-2 with a one-line note, then a 3-5 sentence critique that names the strongest point and the biggest gap; be calibrated, not generous). Errors map to 502 with a short message; the client falls back to self-assessment on any non-200.

`.env.example` gains `ANTHROPIC_API_KEY=` and `GRADER_MODEL=` with a comment. README documents the two modes.

## 9. Estimation gym (lib/drills.ts, app/gym/page.tsx, components/gym.tsx)

Drill templates with seeded parameters and a checker: average and peak QPS from DAU; storage per year from writes/day × size; bandwidth from QPS × payload; servers needed from QPS / capacity with 30% headroom; cache size for the hot 20% of a dataset; Little's law (queue depth or wait); replication lag → RPO; latency-numbers quiz (memory, SSD, disk, same-DC RTT, cross-continent RTT; multiple choice with orders of magnitude); read/write DB load after a cache; sharding count from write QPS / per-shard capacity. ≥ 14 templates. Tolerance ±20% (latency quiz exact choice). Progress stored under `gym` (solved count per template, streak). The "numbers-everyone-should-know" lesson links here.

## 10. UI changes

- `components/playground.tsx` is split: it keeps orchestration and hands the mission panel to `components/mission-panel.tsx` (tabs Mission / Learn / Deep dive; objectives; hints; estimation; check; remix), the completion flow to `components/defense-stage.tsx` (MCQ + defense), and briefs to `components/clarification-stage.tsx`.
- `components/architecture-canvas.tsx`: icons, colors, labels for `cdn` and `rate-limiter`; inspector fields per kind as in §3 (grouped, with one-line notes); region field on every node; palette descriptions updated.
- `components/results.tsx`: Overview adds p99, rejected, stale; new Alternatives tab; Events list in Insights; cost breakdown in Overview.
- `components/library.tsx` and `components/shell.tsx`: chapter counts computed (v1 hard-codes "/ 3"); tier filter; lesson kind badges; Gym and Briefs entries; readings count.
- `lib/templates.ts`: defaults for new kinds; new sandbox templates: microservices fan-out, leader-follower, sharded writes, rate-limited API, multi-region.
- `lib/persistence.ts`: validate new fields; progress v2 fields; attempts and gym keys. `supabase/migrations/202609100001_v2_progress.sql` adds a `details jsonb` column to progress and passes it through `sync_playground` (documented, not run).
- CSS appended to `app/globals.css` (minified single-line file; append new rules at the end, reuse existing tokens).

## 11. Verification

- `npm test`, `npm run typecheck`, `npm run build` must pass. New tests: engine (§4), cost, curriculum (reference passes; hint rule; every lesson has ≥ 2 readings, ≥ 2 follow-ups, rubric weights sum to 100; ids unique; numbers contiguous), remix (derived objectives are satisfiable by the scaled reference), drills (checkers accept their own answers), persistence (v1 records still load), grade route (501 without a key; input validation).
- Readings: every URL fetched during authoring; dead links removed.
- Browser smoke: build and start the app, load a lesson, run the estimation → check → alternatives → defend (self mode) flow, a brief, a written lesson, the gym, and the sandbox with a new kind.
- Re-run the pedagogy judge (same prompt as the 3/10 review) and iterate until ≥ 8.

## 12. Build plan (workflows)

Model use: engine core and integration on opus; content authoring on opus (quality matters); readings verification, drills, cost, persistence, canvas, results, library, CSS on sonnet; final adversarial review and the judge on opus; design decisions and synthesis by the session model.

1. **Foundation (sequential, me):** types.ts, templates defaults, cost.ts, assessment-version 3. Commit.
2. **Workflow A (parallel):** engine core + tests (opus); insights (sonnet, after core); readings research per topic with WebFetch verification (sonnet ×4); drills (sonnet); alternatives + remix (sonnet, after core); persistence + migration (sonnet); grade route (sonnet).
3. **Workflow B (parallel, after A):** curriculum chapters (opus ×6, one agent per 1-2 chapters, each running the curriculum test until its references pass); canvas inspector (sonnet); results (sonnet); library/shell (sonnet); mission panel + estimation + defense + clarification + gym UI (sonnet ×3); then integration of playground.tsx (opus); then a fix loop on typecheck/test/build (opus).
4. **Workflow C:** adversarial code review (opus ×3 lenses: correctness of engine semantics vs §4, UI flow completeness vs §7, content quality vs §6) → fixes → browser smoke → judge re-run → iterate.
