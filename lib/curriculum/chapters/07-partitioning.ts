import { budget, chapterTitles, defense, estimate, graph, healthy, lesson, node, rubric, tweak, workload, written, type ChapterFile } from "../shared";

/** Traffic -> balancer -> API replicas -> one database node (single or sharded). */
const stack = (api: Parameters<typeof node>[3], db: Parameters<typeof node>[3]) =>
  graph(
    [
      node("traffic", "traffic", 0),
      node("load-balancer", "balancer", 1),
      node("server", "api", 2, api),
      node("database", "db", 3, db),
    ],
    [
      ["traffic", "balancer"],
      ["balancer", "api"],
      ["api", "db"],
    ],
  );

// ---------------------------------------------------------------- shard-the-writes

const shardStarter = stack({ capacity: 320, replicas: 5 }, { capacity: 250 });
const shardReference = tweak(shardStarter, { db: { dbMode: "sharded", shards: 6, shardStrategy: "hash", capacity: 280 } });

// ---------------------------------------------------------------- hot-shard

const hotShardStarter = stack({ capacity: 250, replicas: 4 }, { capacity: 200, dbMode: "sharded", shards: 6, shardStrategy: "range" });
const hotShardReference = tweak(hotShardStarter, { db: { shardStrategy: "hash", capacity: 260 } });

// ---------------------------------------------------------------- celebrity-problem

const celebrityStarter = stack({ capacity: 250, replicas: 4 }, { capacity: 200, dbMode: "sharded", shards: 4, shardStrategy: "hash" });
const celebrityReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { capacity: 250, replicas: 4 }),
    node("cache", "cache", 3, { capacity: 3000, cacheModel: "keyed", cacheEntries: 2000, coalesce: true }),
    node("database", "db", 4, { capacity: 200, dbMode: "sharded", shards: 4, shardStrategy: "hash" }),
  ],
  [
    ["traffic", "balancer"],
    ["balancer", "api"],
    ["api", "cache"],
    ["cache", "db"],
  ],
);

export const chapter: ChapterFile = {
  title: chapterTitles[6],
  lessons: [
    lesson({
      id: "shard-the-writes",
      chapter: chapterTitles[6],
      title: "Shard the writes",
      subtitle: "One writer is a ceiling. Partitioning removes it.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Horizontal partitioning",
      brief:
        "An event-ingestion service takes 1,200 requests per second and 80% of them are writes: device telemetry, one row per sample. Replicas cannot help here — every follower would still be fed by the same leader, and the leader is the thing that is saturated. The storage tier is at 100% utilization with a six-thousand-request backlog and is dropping almost everything. There is a hard budget on the storage tier, and simply buying one enormous machine blows through it. Split the data instead.",
      learning: [
        "Partitioning (sharding) splits one logical dataset into independent physical pieces, each with its own storage, its own write path and its own lock manager. Unlike replication, which copies every write to every replica, partitioning sends each write to exactly one shard, so aggregate write capacity grows roughly linearly with shard count. That is the only structural way to get past a single writer's ceiling: replication scales reads, partitioning scales writes, and no amount of the first substitutes for the second.",
        "The shard key decides everything. It is chosen at design time, it is expensive to change, and it determines both how evenly load spreads and which queries stay cheap. A hash of a high-cardinality identifier — device id, user id, tenant id — spreads writes uniformly and keeps single-entity lookups on one shard. A monotonically increasing key such as a timestamp or an auto-increment id is the classic mistake: every new row lands on the newest range, so one shard takes all the writes while the rest idle. High cardinality, even frequency, and non-monotonicity are the three properties to check.",
        "Shard count is a capacity calculation with a headroom multiplier. Take the peak write rate, divide by the write throughput one shard can actually sustain — not its benchmark number — and then multiply by two or three so a shard sits well below its knee and the fleet survives losing one. Over-provisioning shard count is much cheaper than adding shards later, which is why systems often start with far more logical partitions than physical nodes and map many logical partitions onto each node.",
        "What you give up is the cross-shard operation. A query without the shard key becomes a scatter-gather across every shard, and its latency is the slowest shard's latency, not the average. Transactions spanning shards need two-phase commit or a saga. Joins across shards usually have to be denormalized away. Uniqueness constraints that are not on the shard key need a separate coordination store. If a design needs many of these, the shard key is probably wrong.",
        "What this model idealizes: shards here are independent pools with no rebalancing, no cross-shard transactions, no secondary indexes and no routing tier of their own. Real deployments need a coordinator or a client-side routing table, a plan for splitting and moving partitions while serving traffic, and a story for what happens when a shard is down — because with the data split, a single shard's outage takes out that fraction of your users completely rather than degrading everyone a little.",
      ],
      hints: [
        "Run the baseline and look at where the backlog sits. Then ask what replication would actually change for a workload dominated by writes.",
        "Size the fleet from the write rate: divide the peak arrival rate by the throughput you are willing to run one storage unit at, and keep a healthy multiple in reserve. Check the result against the cost objective before you build it.",
        "Switch the database to a partitioned mode and pick a key strategy that spreads a high-cardinality identifier evenly rather than by ordered ranges.",
      ],
      objectives: [...healthy(1140, 120), budget(105)],
      architecture: shardStarter,
      reference: shardReference,
      workload: workload({ requestRate: 1200, readRatio: 0.2, duration: 30, seed: 701, keySpace: 10000, keySkew: 0.3 }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("bottleneckCapacity", "cost", "p95"),
      defense: defense({
        followUps: [
          "Traffic grows ten times over the next year. Does your shard count scale linearly, and what has to happen operationally to get there?",
          "A product manager asks for a dashboard that counts events across all devices in the last minute. What does that query cost in your design, and what would you do instead?",
          "One shard's host dies. What is the blast radius, and how is it different from losing one node in a replicated tier?",
        ],
        rubric: rubric([
          ["why", "Explains why replication cannot fix a write-bound tier — every follower is fed by the one leader — and why partitioning can", 20],
          ["arith", "Sizes the shard count from peak write rate divided by sustainable per-shard throughput, with a stated headroom multiple", 25],
          ["key", "Justifies the shard key strategy: high cardinality, even frequency, non-monotonic, and single-entity lookups stay on one shard", 25],
          ["cost", "Compares the sharded fleet's cost against scaling one machine and shows the sharded design fits the budget", 15],
          ["risk", "Names what sharding costs: scatter-gather queries, cross-shard transactions, per-shard blast radius, or rebalancing", 15],
        ]),
        modelAnswer:
          "The baseline is write-bound: 80% of 1,200 requests per second is 960 writes, all of which have to be ordered on one storage lane that tops out far below that, so it runs at 100% utilization with a six-thousand-request backlog and completes about 50 requests per second. Replication is the wrong tool — followers only absorb reads, and every write would still funnel through one leader. I partitioned the store into six shards keyed by a hash of the device id. Each shard now receives roughly 1,200 divided by six, or 200 requests per second, and at 280 capacity per shard that is about 71% utilization, which leaves the fleet about 1.4× headroom and keeps p95 at 66 ms with zero errors. The six-shard fleet costs about 89 credits against the 105 budget; one machine large enough to absorb 1,200 requests per second would have cost well over 118, because storage capacity is priced superlinearly. I chose a hash of a high-cardinality id rather than a timestamp range precisely so no shard becomes the newest one. The cost is cross-shard work: a fleet-wide count is now a scatter-gather whose latency is the slowest shard's, which I would serve from a rollup table instead.",
      }),
      reflection: {
        question: "A write-saturated database is switched from a single node to a leader with five read replicas. What happens to the write backlog?",
        options: [
          "It drops by roughly a factor of six, because writes now spread across six nodes",
          "It is unchanged, because every write still has to be applied on the one leader",
          "It drops by roughly half, because replicas absorb some of the write work",
          "It grows, because the leader also has to ship the log to five followers",
        ],
        answer: 1,
        explanation:
          "Replicas serve reads. Every write is still ordered and committed on the single leader, so the write ceiling and the backlog behind it are exactly where they were. (In a real system the answer is closer to the fourth option — log shipping costs the leader something — but the structural point is that replication never divides write work. Partitioning does.)",
      },
    }),

    lesson({
      id: "hot-shard",
      chapter: chapterTitles[6],
      title: "The shard that runs hot",
      subtitle: "Six shards, one of them on fire.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Shard key skew",
      brief:
        "The store is already partitioned into six shards, so the capacity math says 600 requests per second across six shards is 100 each and everything should be comfortable. It is not. Throughput has collapsed to about 240 requests per second, six out of ten requests are failing, and the fleet-wide utilization number looks almost idle. The shard key is an ordered range over identifiers that were assigned in order of signup, and the oldest accounts are also the busiest. Open the per-shard view before you touch anything.",
      learning: [
        "Average utilization is a liar for a partitioned tier. A fleet where one shard is at 100% and five are at 15% reports the same mean as a fleet where all six sit at 29%, and only one of those is on fire. The metric that matters is the ratio of the maximum shard's load to the mean — if that is much above one, you have a distribution problem, not a capacity problem, and adding shards will not fix it. Always instrument per-partition, and alert on the spread rather than the average.",
        "Range partitioning assigns contiguous key intervals to shards. It is genuinely useful: a range scan touches one shard, and time-series queries for a window stay local. But it fails badly whenever key frequency correlates with key order, which it very often does — sequential ids mean the oldest accounts are the largest, timestamps mean today's partition takes every write, and alphabetical keys mean the letter S is three times the letter Q. The result is a hotspot that no amount of extra shards dilutes, because the extra shards are added to the cold end.",
        "Hash partitioning applies a hash to the key before choosing the shard, which destroys the correlation between key order and key frequency. Uniformly random keys spread uniformly, and the maximum-to-mean ratio collapses toward one. The price is that ordered scans become scatter-gather, because adjacent keys now live on different shards. That is the whole trade: range keeps locality and risks hotspots; hash gives up locality and buys balance.",
        "Hashing spreads keys, not requests to one key. If the distribution is skewed because a small number of individual keys are extremely popular, hashing moves the problem rather than solving it — that single key still resolves to exactly one shard. Look at the shape of the skew before choosing: many moderately hot keys clustered in one range is a hash problem, one blazing key is a caching or key-splitting problem. The next lesson is the second case.",
        "What this model idealizes: the shard map here is static and the strategy is a single setting you can flip. In production, changing a shard key is a data migration — usually a double-write to a new cluster, a backfill, a verification pass, and a cutover — measured in weeks. That is why the shard key deserves more design time than almost any other decision in the system, and why teams reach for salting (appending a bucket suffix to hot keys) as an in-place mitigation rather than re-keying.",
      ],
      hints: [
        "Do not trust the fleet-wide utilization number. Open the per-shard breakdown in the insights and compare the busiest shard with the quietest.",
        "Work out why the busiest shard is busiest: relate how the key is mapped to a partition to how request frequency is distributed over the key space.",
        "Change the strategy that maps keys to partitions so that key order stops predicting key popularity, then give the fleet a little headroom for the residual imbalance.",
      ],
      objectives: [...healthy(570, 100), budget(95)],
      architecture: hotShardStarter,
      reference: hotShardReference,
      workload: workload({ requestRate: 600, readRatio: 0.4, duration: 30, seed: 702, keySpace: 10000, keySkew: 0.8 }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("bottleneckCapacity", "p95"),
      defense: defense({
        followUps: [
          "Adding two more shards to the range-partitioned fleet does not help at all. Explain precisely why, in terms of where the new shards sit in the key space.",
          "The analytics team relies on scanning a contiguous id range in one query. Your change breaks that. What do you offer them instead?",
          "How would you have caught this before it reached production, and what alert would you write?",
        ],
        rubric: rubric([
          ["diagnose", "Identifies the hot shard from the per-shard breakdown and quantifies the imbalance as a max-to-mean ratio rather than quoting the fleet average", 25],
          ["mechanism", "Explains the cause mechanically: range mapping plus a key frequency that correlates with key order concentrates load on one interval", 25],
          ["fix", "States that hashing decorrelates order from frequency, and gives the resulting per-shard load after the change", 25],
          ["tradeoff", "Names what hashing costs — ordered scans become scatter-gather — and offers a mitigation", 15],
          ["detect", "Describes the metric or alert that surfaces partition skew in production", 10],
        ]),
        modelAnswer:
          "The fleet-wide database utilization reads about 0.32, which is why the capacity math looked fine, but the per-shard view shows shard zero pinned at 1.00 and shards four and five near 0.11 — a max-to-mean ratio of roughly three. The cause is the key mapping: ranges assign contiguous id intervals, ids were issued in signup order, and the oldest accounts generate most of the traffic, so about seventy percent of 600 requests per second — over 400 — lands on the interval that holds the lowest ids, against a per-shard capacity of 200. Everything queues behind that one shard and six requests in ten fail. Adding shards does not help because new shards extend the cold end of the range. I switched the strategy to hash, which decorrelates key order from key frequency: the busiest shard now takes about 160 requests per second and the quietest about 90, and I raised per-shard capacity to 260 so even the hot shard sits near 0.67. Throughput returns to 599 with no errors and p95 falls from about 4,000 ms to 59 ms. The cost is that contiguous id scans are now scatter-gather; I would serve those from an analytics replica instead. In production I would alert on max-shard utilization divided by mean, not on the mean.",
      }),
      reflection: {
        question: "A partitioned tier reports 32% average utilization while two-thirds of requests are failing. What is the most likely explanation?",
        options: [
          "The load balancer in front of the API tier is misconfigured",
          "One partition is saturated and the average is diluted by idle partitions",
          "The database is under-provisioned overall and needs more total capacity",
          "The failures are happening in the API tier, not in storage",
        ],
        answer: 1,
        explanation:
          "An average over partitions hides the maximum. When key frequency correlates with key order under range partitioning, one interval absorbs most of the traffic and saturates while the rest idle. Total capacity is not the problem — the distribution is — which is why more shards would not help and rehashing does.",
      },
    }),

    lesson({
      id: "celebrity-problem",
      chapter: chapterTitles[6],
      title: "The celebrity problem",
      subtitle: "One key that no partition scheme can split.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Hot keys beyond partitioning",
      brief:
        "A social profile service is partitioned into four shards with a hash of the account id, which is exactly the right key. It still falls over: one account — a musician who just announced a tour — draws the majority of the 500 requests per second on its own, 90% of them reads of the same profile row. Shard zero is at 100% while the other three idle, and rehashing changes nothing because a single key always lands on a single shard. There is a tight budget, so buying four enormous shards is not an option.",
      learning: [
        "Partitioning divides the key space, not the traffic to one key. Any deterministic mapping — hash, range, consistent hashing, anything — sends a given key to exactly one partition, so the maximum throughput available to a single key is the throughput of one partition. When one key's request rate exceeds that, the partitioning strategy is no longer the variable; you have to stop the requests from reaching storage at all, or stop them from being the same key.",
        "A cache in front of storage is the direct answer, and the skew that caused the problem is what makes it work. The hotter the key, the higher its hit rate, so a small cache absorbs a disproportionate share of the load: sizing for the hot few thousand keys out of a much larger space typically captures the large majority of reads. Read-through or cache-aside both work; the number to compute is the residual traffic that still reaches storage — every write, plus the reads that miss — because that is what actually sizes the shards. Watch the stale-read number after you add the cache: the hot key is also the most-written key, so a large share of hits now serve a row that a write has already superseded. That is the bill for the throughput, and a TTL is how you cap it.",
        "Request coalescing (also called single-flight or request collapsing) handles the moment the cache does not have the key. When an entry expires or the cache node restarts, every concurrent reader for the hot key misses at once and they all stampede the same shard. Coalescing lets the first miss go to storage and parks the rest on its result, turning a burst of hundreds of identical calls into one. It costs almost nothing and it is the difference between a cold cache being a blip and being an outage, which is why it is standard in production caching layers.",
        "When a cache is not enough there are two more moves. Key splitting or salting writes the hot entity as several sub-keys — profile:42:0 through profile:42:9 — so it occupies several partitions and readers pick one at random; the price is that writers must update all of them and readers may see slightly different versions. Alternatively, replicate the hot entity to every shard, or serve it from a dedicated tier or a CDN edge. All three trade consistency or write cost for the ability to spread a single logical entity's reads.",
        "What this model idealizes: the cache here never evicts under memory pressure, has no network of its own, and cannot itself become the hot spot. In production a single hot key can saturate one cache node's network interface, which is why real systems add a small local in-process cache in front of the shared one, or shard the cache and replicate the hot key across its nodes. The general lesson holds: every layer you add has its own single-key ceiling, and you push the ceiling up by adding layers, not by re-partitioning.",
      ],
      hints: [
        "Open the per-shard view and confirm the imbalance survives the hash. Then ask what fraction of all traffic a single key is drawing.",
        "Compute the traffic that must still reach storage once repeated reads are absorbed somewhere else: every write, plus the reads that miss. Size the storage tier from that number, not from the arrival rate.",
        "Put a keyed cache between the application and the storage tier, size it to hold the hot end of the key space, and turn on the setting that collapses concurrent misses for the same key into one upstream call.",
      ],
      objectives: [...healthy(475, 100), budget(65)],
      architecture: celebrityStarter,
      reference: celebrityReference,
      workload: workload({ requestRate: 500, readRatio: 0.9, duration: 30, seed: 703, keySpace: 10000, keySkew: 0.95 }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("dbLoad", "cost", "p95"),
      defense: defense({
        followUps: [
          "The cache node restarts at the peak of the announcement. Walk me through the next two seconds, second by second.",
          "The celebrity's profile is now edited every few seconds by their publicist. What breaks, and what is the weakest guarantee you can ship?",
          "Traffic to that one key grows another ten times. Your cache is now the hot spot. What is your next move?",
        ],
        rubric: rubric([
          ["limit", "States the structural limit: a deterministic shard map sends one key to one partition, so no strategy spreads a single key's traffic", 25],
          ["arith", "Computes the residual storage load — writes plus read misses — and sizes the shards from it rather than from the arrival rate", 25],
          ["coalesce", "Explains coalescing as the guard against a stampede when the entry is missing, and why the hot key is exactly the one that stampedes", 20],
          ["alt", "Names a rejected alternative (more shards, bigger shards, or key salting) and why it loses on cost or complexity here", 15],
          ["risk", "Identifies the remaining failure mode: the cache becomes the single hot spot, or staleness on a frequently edited hot key", 15],
        ]),
        modelAnswer:
          "The per-shard view shows shard zero at 1.00 and the other three near 0.25 even though the shard key is a hash of the account id — which is correct and irrelevant, because a deterministic map sends one key to one shard. One account draws roughly sixty percent of the 500 requests per second, about 300, against a per-shard capacity of 200, so shard zero saturates and the tier completes only about 216 requests per second with 57% errors. I put a keyed cache between the API and storage, sized to hold two thousand entries out of a ten-thousand-key space, with coalescing on. Because the skew is extreme, those two thousand keys cover the large majority of reads: storage now receives only the 50 writes per second plus the residual misses, about 120 requests per second in total, and the busiest shard drops to about 0.26 utilization. Throughput returns to 499 with zero errors, p95 is 56 ms, and the fleet costs 48 credits against a 65 budget — where scaling all four shards to absorb 300 requests per second each would have cost over 90. Coalescing matters at the moment the entry is absent: without it every concurrent reader for that key stampedes shard zero simultaneously. The remaining risk is that the cache is now the single hot spot for that key, which I would answer with a small in-process cache in front of it.",
      }),
      reflection: {
        question: "A single account draws sixty percent of all traffic to a hash-partitioned store. Which change reduces that account's load on any one shard?",
        options: [
          "Doubling the number of shards, so the key space spreads wider",
          "Switching from hash partitioning to range partitioning",
          "Writing the account as several salted sub-keys that readers pick between at random",
          "Increasing the replica count of each shard",
        ],
        answer: 2,
        explanation:
          "Doubling shards or changing strategy still maps the one key to exactly one shard, and replicas of a shard only help reads of that shard if the engine spreads them — the write path is unchanged. Salting is the move that actually makes one logical entity occupy several partitions, at the cost of fanning writes out to every sub-key. Caching in front is the cheaper first answer; salting is what you do when the cache is no longer enough.",
      },
    }),

    written({
      id: "indexes-and-rebalancing",
      chapter: chapterTitles[6],
      title: "Indexes and rebalancing",
      subtitle: "Secondary indexes, moving data, and keeping a partitioned cluster even.",
      difficulty: "Advanced",
      minutes: 20,
      concept: "Secondary indexes and partition rebalancing",
      brief:
        "Partitioning by a primary key is the easy half. The hard half is everything that does not use that key: the query that searches by email when you shard by user id, the cluster that has to grow from six nodes to nine without an outage, and the hot partition that has to be split while it is on fire. This lesson covers the two mechanisms an interviewer will push on once you say the word 'sharded'.",
      learning: [
        "A secondary index lets you find rows by something other than the shard key, and in a partitioned system it comes in two shapes. A local (document-partitioned) index lives on the same shard as the rows it describes: writes are cheap because a row and its index entries are updated together in one shard-local transaction, but a query by the indexed attribute has to be sent to every shard and the results merged — scatter-gather, whose latency is the slowest shard's. This is what Elasticsearch, Cassandra's secondary indexes, and MongoDB's default indexes do.",
        "A global (term-partitioned) index is itself partitioned, by the indexed term rather than by the row's shard key. A query by that term goes to exactly one index partition, which makes reads fast and cheap. The cost moves to writes: a single row update now touches its own shard plus one or more index partitions on other shards, so the write is distributed and either needs a cross-shard transaction or becomes asynchronous — which means the index is briefly out of date. DynamoDB's global secondary indexes are exactly this, and their eventual consistency is not an implementation detail, it is the trade.",
        "So the index decision is the same read-versus-write trade as everything else in this course, and it is decided by the query mix. A write-heavy table with occasional analytical lookups wants local indexes and scatter-gather. A read-heavy lookup path that is on the critical path of every request — find the user by email at login — wants a global index, or a separate lookup table keyed by email that maps to the user id, which is often simpler to reason about than the database's own global index and gives you explicit control over when it is updated.",
        "Rebalancing is moving partitions between nodes as the cluster grows, shrinks, or develops a hotspot. The naive scheme — hash the key modulo the number of nodes — is the one to be able to criticize on sight: adding a node changes the modulus, so almost every key moves, and the cluster spends its bandwidth shuffling data instead of serving. Every real strategy exists to avoid that.",
        "Fixed partitions is the simplest workable answer: create far more partitions than nodes at the start — say a thousand partitions on six nodes — and assign whole partitions to nodes. Growing the cluster means moving some partitions to the new node; the mapping from key to partition never changes, so no key is ever re-keyed. Dynamic partitioning instead splits a partition when it exceeds a size threshold and merges when it shrinks, which is what HBase and MongoDB do and what suits datasets whose size is unknown up front. Consistent hashing places nodes and keys on a ring so that adding a node moves only the keys between it and its predecessor — the fraction that must move is roughly one over the node count — and virtual nodes smooth the resulting imbalance.",
        "Rebalancing is an operational event, not just an algorithm. Moving a partition means copying data while it is being written to, then cutting over reads and writes without losing an update, and doing it slowly enough that the migration does not starve production traffic — which is why balancers throttle themselves, run one migration per shard at a time, and are often restricted to a nightly window. Automatic rebalancing plus automatic failure detection is a famous foot-gun: a node that is merely slow gets declared dead, its partitions are moved, the copying makes the cluster slower, and more nodes are declared dead. Keeping a human in the loop for the final go-ahead is a common and defensible design choice.",
        "Hot-spot mitigation deserves its own vocabulary because rebalancing does not solve it. A partition that is hot because it holds too much data can be split; a partition that is hot because it holds one blazing key cannot, and the answers are the ones from the celebrity lesson — a cache in front, salting the key across sub-keys, or replicating the hot entity everywhere. The diagnostic question to ask first is always the same: is this partition hot because of its size, or because of one key inside it? The two have completely different fixes.",
      ],
      defense: {
        prompt:
          "You run a multi-tenant SaaS product sharded by tenant id. Design the indexing and rebalancing strategy: how do you support login by email address, how do you grow the cluster from six nodes to nine without downtime, and what do you do when one enterprise tenant grows to five times the size of any other?",
        followUps: [
          "Compare a global secondary index against a separate lookup table keyed by email. Which would you ship, and what does the loser cost you?",
          "Your cluster uses hash-modulo-node-count routing today. Describe the migration to a scheme that does not reshuffle everything, and what you would do about traffic during it.",
          "The balancer starts migrating partitions during your busiest hour because one node briefly stopped answering health checks. Describe what happens next and how you would prevent it.",
          "The oversized tenant is hot because of one dashboard query that runs every second. Does splitting their partition help? Justify.",
        ],
        rubric: rubric([
          ["indextypes", "Distinguishes local (document-partitioned) from global (term-partitioned) indexes and states the read-versus-write cost of each", 25],
          ["querymix", "Chooses an index shape from the actual query mix and latency requirement rather than by default, and names the consistency consequence", 15],
          ["modulo", "Identifies hash-modulo-node-count as the scheme to avoid and explains that adding a node re-keys almost everything", 15],
          ["strategy", "Describes at least two real rebalancing strategies — fixed partitions, dynamic splitting, consistent hashing with virtual nodes — accurately", 25],
          ["ops", "Treats rebalancing as an operational event: throttling, cutover without lost writes, and the automatic-rebalance-plus-failure-detection foot-gun", 10],
          ["hotspot", "Separates a partition that is too large from a partition with one hot key, and gives the right mitigation for each", 10],
        ]),
        modelAnswer:
          "I shard by tenant id with a fixed-partition scheme — a thousand logical partitions mapped onto six nodes — so growing to nine nodes moves roughly a third of the partitions and never re-keys a single row. Hash modulo node count is the thing to avoid: adding a ninth node would relocate almost every key and saturate the cluster's own bandwidth. For login by email I would not use a global secondary index; I would ship an explicit lookup table keyed by email hash that maps to a tenant and user id, because the write path then has exactly one extra, idempotent write that I control, and I can decide when it is repaired. A global index would give the same single-partition read but makes every user update a distributed write with eventual index visibility. Within a tenant, indexes on non-key attributes are local and queried by scatter-gather, which is acceptable because those queries are already tenant-scoped. The five-times-larger enterprise tenant is a partition-splitting problem only if it is large; if it is hot because of one dashboard query, splitting does nothing and the answer is a cache plus a materialized rollup. I would keep the balancer throttled to one migration at a time, out of peak hours, with a human approving any migration triggered by a node that failed health checks — automatic rebalancing on top of automatic failure detection is how a slow node becomes a cluster-wide outage.",
      },
      reflection: {
        question: "Why does a global (term-partitioned) secondary index usually end up eventually consistent?",
        options: [
          "Because the index is stored on slower disks than the primary data",
          "Because a single row write must also update index partitions on other nodes, and doing that synchronously would require a cross-shard transaction",
          "Because global indexes are only rebuilt during scheduled maintenance windows",
          "Because term partitioning cannot guarantee that two rows with the same term land on the same partition",
        ],
        answer: 1,
        explanation:
          "Partitioning the index by term means a row's index entries live on different nodes from the row itself. Keeping them in lockstep would need a distributed transaction on every write, so real systems update the index asynchronously and accept a short window where a query by that term misses a just-written row. That window is the price of the fast single-partition read.",
      },
    }),
  ],
};
