# Curriculum 2.0 authoring guide

Read with the design spec (`2026-09-10-systemlab-v2-design.md`, sections 3, 4, 6, 7). This file is the contract for every chapter file under `lib/curriculum/chapters/`.

## Files and helpers

- One file per chapter: `lib/curriculum/chapters/NN-name.ts` exporting `export const chapter: ChapterFile = { title: chapterTitles[i], lessons: [...] }`.
- Import helpers from `../shared`: `node`, `chain`, `graph`, `tweak`, `workload`, `objective`, `healthy`, `budget`, `queueDepth`, `staleReads`, `rejected`, `p99`, `estimate`, `rubric`, `defense`, `readingsFor`, `clarification`, `lesson`, `brief`, `written`, `allKinds`, `chapterTitles`.
- `lesson()` fills `kind: "sim"`, `remixable: true`, `readings` from `lib/readings` by lesson id, `estimation` default `["p95", "throughput"]`. Override when the lesson needs `dbLoad`, `cost`, `bottleneckCapacity`, or `queueDepth`.
- Numbers are assigned by `lib/curriculum/index.ts`; leave `number` out. `chapter` is set by the index too.
- Node ids inside an architecture are short and stable (`traffic`, `balancer`, `api`, `cache`, `db`); the reference should be built from the starter with `tweak()` or by adding nodes with `graph()`, so alternatives and hints line up with what the learner sees.

## Rules enforced by `lib/curriculum/curriculum.test.ts`

1. **Hints never reveal numbers.** No hint may contain a number followed by req/s, ms, credits, %, replicas, shards, entries. Hint 1 says where to look; hint 2 names the method ("compute the traffic that still reaches storage: writes plus read misses"); hint 3 names the mechanism to add or the setting to change, still without values.
2. **The reference passes every objective on seeds [lesson seed, 123, 2026]** and is valid for the lesson's rules (`validateMissionArchitecture` returns null; every kind used is in `allowedKinds`).
3. **The starter fails at least one objective** (except lesson 1).
4. `learning` ≥ 3 paragraphs; `brief` ≥ 25 words; `readings` ≥ 2; `defense.followUps` ≥ 2; rubric ≥ 3 rows, weights sum to 100; `modelAnswer` ≥ 80 words; reflection ≥ 3 options.
5. Sim lessons: ≥ 2 objectives, ≥ 2 hints, ≥ 2 estimation prompts. Briefs: ≥ 4 clarifications, ≥ 2 relevant. Written: no objectives, not remixable.
6. **Remix:** the reference scaled by the remix factor must satisfy the derived objectives. Keep references with ~20-30% headroom over the objectives so a 1.6× traffic scaling of both traffic and capacities still passes; avoid objectives that only pass by a hair.

Run a subset while iterating: `LESSON_FILTER="hot-keys,cold-start-and-stampede" npx vitest run lib/curriculum`.

## Voice and depth

- Scenario first: a concrete product situation with real numbers in the brief (the brief may contain numbers; hints may not).
- `learning` teaches the mechanism the way a staff engineer would explain it in an interview debrief: cause, effect, the general rule, and one sentence on what the model idealizes. Reference real-world practice (2-3× headroom, health-check intervals of seconds, retry budgets) and name the production pattern (token bucket, cache-aside, leader election) so the learner can go read about it.
- `defense.followUps` probe the lesson's real weak point: "traffic 10×'s overnight", "the cache restarts cold at peak", "the product now needs read-your-writes", "the on-call gets paged at 3 am, what fires first", "how would you know this is happening in production".
- `defense.rubric` rows are observable claims a grader can tick: names the bottleneck with a number; states the alternative and why it loses; quantifies headroom; identifies the failure mode the design still has; mentions how they would detect it.
- `modelAnswer` is a strong senior answer (120-200 words), including the arithmetic.
- `reflection` tests a misconception, with plausible distractors.
- Tiers: Beginner (foundations), Intermediate (one mechanism), Advanced (two interacting mechanisms or a failure), Expert (briefs and capstones).

## Chapter and lesson intent

Existing v1 ids keep their ids. Every lesson below is `sim` unless marked WRITTEN or BRIEF.

### 01 Foundations (Beginner, 8-12 min)
- `first-request`: baseline read of one request; starter passes (allowed). Estimate p95 and throughput before running. Follow-ups: what happens if the DB latency doubles.
- `find-the-bottleneck`: API saturated; learner must locate it via utilization and queue depth. Estimation: bottleneckCapacity.
- `share-the-load`: replicas idle without a balancer; `requiredBalancedReplicas: 2`.
- `littles-law` (NEW): steady 300 req/s with a DB at ~90% utilization; learner predicts queue depth from λ × W then measures (estimation: queueDepth, p95). Objective: p95 and maxQueueDepth after adding capacity.

### 02 Performance (Intermediate)
- `make-reads-cheaper`: add a cache; estimation dbLoad.
- `survive-the-spike`: spike pattern; headroom; queueDepth objective.
- `spend-your-budget`: cost objective with the new nonlinear pricing (a cache is cheap; a bigger DB is expensive). Estimation: cost, dbLoad.
- `the-tail-at-scale` (NEW): gateway fans out in parallel to three services, one with `variance: "high"`; p99 objective. Fix: lower variance (better-behaved dependency) and a timeout with one retry on the gateway. Learning: the tail amplifies with fan-out width.
- `flash-crowd` (NEW): `pattern: "flash"` (6× burst). Starter times out for seconds after the burst. Two valid fixes: enough capacity, or a bounded queue/rate limiter that sheds; objectives p95 for accepted traffic, rejectedRate ≤ 25%, errorRate ≤ 1%, cost cap that makes pure over-provisioning fail.

### 03 Workloads & queues (Intermediate)
- `jobs-in-the-queue`, `drain-the-backlog`, `when-caches-cannot-help`: as v1 with method-only hints and estimation.
- `bounded-queues` (NEW): a 2× overload on a worker pool; unbounded queue → everything times out; bounded queue (`maxQueue`) → accepted jobs finish fast and overflow is rejected. Objectives: p95 ≤ X, rejectedRate ≤ 55%, errorRate ≤ 1%.

### 04 Caching deep dive (Advanced)
- `hot-keys`: keyed cache (`cacheModel: "keyed"`), keySpace 20000, keySkew 0.7; starter cache too small (`cacheEntries` 200) → low hit rate. Learner sizes the cache; estimation dbLoad. Learning: hit rate emerges from key distribution and capacity, not a knob.
- `cold-start-and-stampede`: keyed cache, `failures: [{ kind: "cache-flush", at: 0.5 }]`; the DB collapses during warm-up. Fix: `coalesce: true` (and DB headroom). Objectives: errorRate, p95, maxQueueDepth on the DB.
- `ttl-and-staleness`: keyed cache with writes to hot keys; starter has no TTL and a high stale rate; objective `staleReadRate ≤ 5%` and dbLoad-bounded via cost cap. Learner sets a TTL and sees the hit-rate/staleness tradeoff.
- `edge-caching`: 60% of readers are in a far region (`regions`, `crossRegionLatencyMs: 90`); p95 dominated by the round trip. Fix: a CDN edge in that region for cacheable reads. allowedKinds includes cdn.

### 05 Reliability (Advanced)
- `lose-a-server`: as v1, but the balancer has `healthCheckMs: 2000`; the reference needs surviving capacity AND a shorter interval. Explain detection windows.
- `protect-the-database`: DB is `leader-follower`; leader dies; starter has one replica → all writes fail; reference adds a follower and reasonable `failoverMs`. Learning: replicas ≠ write availability, failover takes time.
- `detection-delay` (NEW): the same failure with `healthCheckMs` 5000 vs 500; error budget objective; explain cost of aggressive checks in prose.
- `retry-storm` (NEW): `slow-database` brownout for 6 s, gateway with `retries: 3` and no timeout; amplification > 2 and cascading timeouts. Reference: `timeoutMs`, `retries: 1`, DB headroom. Objectives: errorRate, p95, amplification cannot be an objective (not in the enum), so use errorRate + maxQueueDepth.
- `circuit-breaker` (NEW): brownout that lasts; without a breaker the API's queues fill; with `circuitBreaker: true` requests fail fast (rejected) and the API stays responsive for cache hits. Objectives: p95 of accepted ≤ X, rejectedRate ≤ 40%, errorRate ≤ 2%.
- `cascading-failure` (NEW): gateway → three services in parallel; one service's DB browns out; without timeouts every request stalls. Reference: timeouts + breaker on the gateway. Objectives: p95, errorRate, rejectedRate cap.
- `launch-day`: capstone rewritten: spike + server failure + cost cap + healthCheckMs; allowedKinds all.

### 06 Replication & consistency (Advanced)
- `read-replicas`: 90% reads at 600 req/s; single DB saturated; reference `leader-follower` with 3 replicas. Estimation: dbLoad per follower. Learning: followers scale reads; writes still land on one leader.
- `replication-lag`: same design, `replicationLagMs: 400`, 30% writes to hot keys; starter stale rate high; objective `staleReadRate ≤ 2%`; fix `consistency: "read-your-writes"` and observe extra leader load.
- `leader-failover`: leader dies at 0.5 with `failoverMs` 3000 vs 800; objective errorRate ≤ 3%; learner also needs enough followers.
- WRITTEN `choosing-consistency`: linearizability, sequential, causal, eventual; CAP and PACELC; where each fits (payments vs feeds); defense follow-ups on a concrete product.

### 07 Partitioning (Advanced)
- `shard-the-writes`: 80% writes at 900 req/s; single DB cannot scale (cost cap prevents a giant DB); reference `sharded` with 4-6 shards, hash strategy.
- `hot-shard`: `shardStrategy: "range"` with `keySkew: 0.85` → shard 0 hot; switch to hash. Objective p95 + errorRate; insight shows shard spread.
- `celebrity-problem`: `keySkew: 0.95` (one ultra-hot key); even hash leaves one shard hot; reference adds a keyed cache with coalescing in front. allowedKinds: cache, database, server, load-balancer.
- WRITTEN `indexes-and-rebalancing`: secondary indexes (local vs global), rebalancing strategies (fixed partitions, dynamic, consistent hashing), hot-spot mitigation (key salting).

### 08 Traffic control (Advanced)
- `rate-limit-the-api`: abusive traffic 2× the API's capacity; without a limiter everything degrades; reference `rate-limiter` with `limit` near capacity. Objectives: p95 accepted, rejectedRate ≤ 55%, errorRate ≤ 1%.
- `burst-allowance`: spike pattern; `burst` too small rejects a legitimate burst; learner sizes burst vs capacity headroom; objectives rejectedRate ≤ 5% and p95.
- `backpressure-end-to-end`: intake → bounded queue → workers → DB; overload; reference bounds the queue AND limits intake so the system degrades gracefully; objectives p95, rejectedRate ≤ 30%, errorRate ≤ 1%, maxQueueDepth.
- WRITTEN `rate-limiting-algorithms`: token bucket, leaky bucket, sliding window log/counter, distributed limiters, fairness and per-tenant isolation.

### 09 Multi-region (Advanced)
- `far-away-users`: `regions` 50/50, one stack in `us-east`, `crossRegionLatencyMs: 100`; far users' p95 is bad. Fix: CDN edges per region (reads) and accept that writes cross regions. Objective p95 ≤ X, cost cap.
- `active-active`: two regional app stacks with geo routing and a leader DB in one region; learner must place caches/edges to keep reads local; objectives p95, cost.
- `region-outage`: `failures: [{ kind: "region", region: "us-east", at: 0.5, duration: 10 }]`; surviving region must have capacity; objective errorRate ≤ 5%, p95.

### 10 Interview toolkit (WRITTEN, Intermediate)
- `framing-and-requirements`: functional vs non-functional, clarifying questions that matter, SLOs, scale numbers, out of scope. Defense: frame a given prompt.
- `numbers-everyone-should-know`: latency numbers, throughput per server, storage math; links to the gym (`/gym`). Defense: estimate a described system.
- `api-design-and-idempotency`: REST vs RPC, pagination, versioning, idempotency keys, retries safety. Defense: design an API for a described feature.
- `storage-engines-and-indexing`: B-tree vs LSM, indexes, read/write amplification, when to pick which store. Defense: choose a store for three workloads.
- `observability-and-slos`: golden signals, SLIs/SLOs/error budgets, alerting on symptoms, tracing. Defense: SLOs and alerts for the launch-day system.

### 11 Design briefs (BRIEF, Expert, 25-35 min)
Each brief: an ambiguous one-paragraph prompt; 6-8 clarifications (≥ 4 relevant: read/write ratio, peak factor, latency SLO, consistency need, data retention, region mix; some irrelevant: team size, programming language, brand colours); a workload and objectives that are only sensible once the relevant answers are known; a starter with a bare stack; a reference that passes; estimation on dbLoad, bottleneckCapacity, cost; 3 follow-ups; a rubric that rewards requirement framing and tradeoff articulation.
- `url-shortener`: read-heavy (100:1), hot links (skew), cache + read replicas; follow-up on custom aliases and analytics writes.
- `news-feed`: fan-out on write vs on read; the sim builds the read path with cache and sharded storage; follow-ups on celebrities and ranking.
- `ticket-sale`: flash crowd (`flash`), rate limiting, bounded queues, one hot item; follow-ups on overselling and fairness.
- `chat-and-notifications`: queue + workers, bounded backlog, region mix; follow-ups on ordering and offline delivery.
- `metrics-ingestion`: write-heavy sharded ingest, a slow-database brownout, backpressure; follow-ups on late data and retention.
