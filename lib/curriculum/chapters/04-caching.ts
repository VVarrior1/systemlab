import { budget, chapterTitles, defense, estimate, graph, healthy, lesson, node, objective, queueDepth, rubric, staleReads, tweak, workload, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- hot keys

const profileStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Profile API", capacity: 400, replicas: 2 }),
    node("cache", "cache", 3, { label: "Profile cache", cacheModel: "keyed", cacheEntries: 200 }),
    node("database", "db", 4, { label: "Profile database", capacity: 420 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- cold start and stampede

const catalogStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Catalog API", capacity: 400, replicas: 2 }),
    node("cache", "cache", 3, { label: "Catalog cache", cacheModel: "keyed", cacheEntries: 5000 }),
    node("database", "db", 4, { label: "Catalog database", capacity: 240 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- ttl and staleness

const inventoryStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Inventory API", capacity: 400, replicas: 2 }),
    node("cache", "cache", 3, { label: "Inventory cache", cacheModel: "keyed", cacheEntries: 250, ttlMs: 0 }),
    node("database", "db", 4, { label: "Inventory database", capacity: 250, latency: 120 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- edge caching

const docsStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { region: "us-east" }),
    node("server", "api", 2, { label: "Docs API", capacity: 300, replicas: 2, region: "us-east" }),
    node("cache", "cache", 3, { label: "Origin cache", cacheHitRate: 0.85, region: "us-east" }),
    node("database", "db", 4, { label: "Docs database", capacity: 250, region: "us-east" }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

const docsReference = graph(
  [
    node("traffic", "traffic", 0),
    node("cdn", "edge-us", 1, { label: "Virginia edge", region: "us-east", cacheHitRate: 0.95 }, -1),
    node("cdn", "edge-ap", 1, { label: "Mumbai edge", region: "ap-south", cacheHitRate: 0.95 }, 1),
    node("load-balancer", "balancer", 2, { region: "us-east" }),
    node("server", "api", 3, { label: "Docs API", capacity: 300, replicas: 2, region: "us-east" }),
    node("cache", "cache", 4, { label: "Origin cache", cacheHitRate: 0.85, region: "us-east" }),
    node("database", "db", 5, { label: "Docs database", capacity: 250, region: "us-east" }),
  ],
  [
    ["traffic", "edge-us"],
    ["traffic", "edge-ap"],
    ["edge-us", "balancer"],
    ["edge-ap", "balancer"],
    ["balancer", "api"],
    ["api", "cache"],
    ["cache", "db"],
  ],
);

export const chapter: ChapterFile = {
  title: chapterTitles[3],
  lessons: [
    lesson({
      id: "hot-keys",
      chapter: chapterTitles[3],
      title: "Hot keys",
      subtitle: "Hit rate is an outcome of key distribution and capacity.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Keyed caches and working-set size",
      brief:
        "A profile service takes 500 requests per second, 95% of them reads, spread over 20,000 profile ids with heavy skew: a small set of accounts is read constantly and the long tail almost never. The cache in front of the database holds only 200 keys, so the database runs at 100% utilization and p95 sits above a second.",
      learning: [
        "A keyed cache does not have a hit rate; it has a capacity, and the hit rate falls out of how your traffic is distributed over keys. This cache is an LRU over a fixed number of entries: a read that finds its key returns at cache speed, a read that does not goes to the database and installs the key on the way back, evicting whatever was least recently used. Whether that produces a 25% or a 90% hit rate depends entirely on how much of the request stream lands on keys that are still resident.",
        "Skewed traffic is what makes caching cheap. Requests here follow a power law over the key space, so the busiest few percent of keys carry most of the reads: sizing the cache to hold that working set buys almost all of the achievable hit rate, and every entry after it buys progressively less. The practical method is to sort keys by request rate, find the smallest prefix that covers the share of traffic you want to absorb, and size for that prefix plus room for churn. Doubling the cache again past the knee is wasted memory, which is why real cache sizing is an inspection of the key-frequency curve rather than a round number.",
        "Database load after a cache is writes plus reads times (1 - hit rate), and that is the number that decides whether storage survives. Here writes are only 5% of traffic, so the whole design hinges on the miss rate: at a 25% hit rate the database sees hundreds of requests per second and saturates; hold the hot working set and it sees a fraction of that. Note the asymmetry - the cache is priced far below the database's write capacity in this cost model, exactly as memory is priced below durable IOPS in reality, so sizing memory correctly is the cheapest lever on the board.",
        "The model idealizes the key distribution as stationary and the cache as a single shared LRU with no replication, no per-key expiry and no per-shard limits. Production caches partition keys across nodes, which reintroduces hot keys as a per-node throughput problem, and they see the popular set drift through the day. Both push you towards headroom in the working-set estimate rather than a tight fit.",
      ],
      hints: [
        "Compare the cache's reported reads and hits with the database's utilization: the hit rate is a measurement here, not a setting you can type in.",
        "Estimate how much of the read stream lands on the busiest keys, then size the cache to hold that working set; compute the database load left over as writes plus the reads that still miss.",
        "Grow the cache's key capacity rather than the database's throughput, and watch where the extra entries stop buying hits.",
      ],
      objectives: [...healthy(470, 110), budget(45)],
      architecture: profileStarter,
      reference: tweak(profileStarter, { cache: { cacheEntries: 4000 } }),
      workload: workload({ requestRate: 500, readRatio: 0.95, duration: 30, seed: 85, keySpace: 20000, keySkew: 0.7 }),
      allowedKinds: ["server", "load-balancer", "cache", "database"],
      estimation: estimate("dbLoad", "p95", "throughput"),
      defense: defense({
        followUps: [
          "Traffic stays flat but the key distribution flattens too, so reads spread evenly over all 20,000 profiles. What happens to your design?",
          "One celebrity profile alone takes 10% of all reads and the cache node serving it saturates. What do you change?",
          "How would you pick this cache's size in production, and what would you measure to know it is still right in six months?",
        ],
        rubric: rubric([
          ["bottleneck", "Names the database as the saturated component and links it to the cache's measured hit rate, not to a hit-rate setting", 25],
          ["arith", "Computes database load as writes plus reads times the miss rate, and ties the miss rate to the working set the cache can hold", 30],
          ["sizing", "Explains why capacity past the working-set knee stops buying hits, and sizes with headroom for churn", 20],
          ["alt", "States a rejected alternative (buying database throughput) and why it loses on cost here", 15],
          ["risk", "Names a residual risk: distribution drift, a single ultra-hot key, or cache node loss", 10],
        ]),
        modelAnswer:
          "The baseline database is pinned at 100% with a queue in the hundreds while the API sits near 60%, so storage is the constraint. The cause is upstream: 200 entries out of 20,000 keys captures only about a quarter of a skewed read stream, so roughly 475 reads per second times a 75% miss rate, plus 25 writes, is about 380 requests per second against a database rated 420 - saturated once variance is included. Because the traffic is power-law distributed, the busiest few percent of keys carry most reads, so I sized the cache to hold that working set: 4,000 entries lifts the hit rate past 80%, which leaves writes plus roughly 90 misses per second, near 70% database utilization, and p95 drops from about 1,600 ms to 60 ms. This costs nothing in the budget because cache entries are memory, not throughput, while buying the equivalent database capacity would have blown the cap. The residual risks are distribution drift and a single celebrity key, which more entries cannot fix; that needs coalescing or a dedicated hot-key path.",
      }),
      reflection: {
        question: "You double a keyed cache from 4,000 to 8,000 entries on this workload and the hit rate barely moves. Why?",
        options: [
          "The cache is evicting entries before they can be reused, so more space cannot help",
          "The first few thousand entries already hold the keys that carry most of the skewed traffic; the extra entries hold keys that are rarely re-read",
          "The database is the bottleneck, so cache size cannot change the hit rate",
          "Hit rate is a fixed property of the cache and is not affected by capacity",
        ],
        answer: 1,
        explanation:
          "Under a power law, the marginal value of an entry falls off steeply. Once the working set is resident, additional entries are spent on tail keys that are usually requested once, and a key requested once is a miss no matter how big the cache is. The knee in that curve is where you should stop paying.",
      },
    }),

    lesson({
      id: "cold-start-and-stampede",
      chapter: chapterTitles[3],
      title: "Cold start and stampede",
      subtitle: "Protect the origin when the cache empties at peak.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Thundering herd and request coalescing",
      brief:
        "A catalog service serves 500 requests per second, 95% reads, over 5,000 heavily skewed product ids, and the keyed cache normally absorbs almost all of them. Halfway through this run the cache is flushed - a deploy, a failover, an eviction storm - and the database, sized for the steady-state miss traffic, is buried under a queue of hundreds while p95 jumps past 800 ms.",
      learning: [
        "A cache flush does not just remove a benefit, it inverts the workload. In the steady state the database sees only misses and writes; the instant the cache is empty every read is a miss, so storage briefly faces the full read rate it was never sized for. Worse, popular keys are requested by many callers at once, so the same key is fetched dozens of times before the first fetch returns and installs it - the thundering herd. That is why the danger window is not the flush itself but the seconds after it.",
        "Coalescing is the direct fix. When a miss for a key is already in flight, later readers for that key wait on the same fetch instead of issuing their own; one origin call serves all of them, and the herd for hot keys collapses to a single request per key per refill. nginx exposes this as proxy_cache_lock, and the AWS Builders' Library describes the same technique as request collapsing. Because traffic is skewed, coalescing is worth the most exactly where the stampede is worst.",
        "Coalescing alone is not enough, because the cold cache still has to be refilled key by key. The refill cost is roughly the number of distinct keys requested in the warm-up window, so the database needs enough headroom to absorb that spike over a few seconds without queueing past the caller's deadline. The practical rule is to combine the two: coalesce so the herd cannot multiply the refill, and keep enough origin headroom that the refill itself is survivable. Warming the cache before taking traffic, or restarting cache nodes in a staggered fashion, are the operational versions of the same idea.",
        "The model idealizes the flush as instantaneous and total across the cache, with a refill that costs one origin read per key and no negative caching. Real incidents are messier: a partial eviction, a mass TTL expiry all landing on the same second, or a cache node lost from a ring so its share of keys goes cold. Each produces the same shape - a sudden miss spike against an origin sized for steady state - and each is handled with the same two levers.",
      ],
      hints: [
        "Watch the database's queue depth around the moment the cache empties, and compare its request rate in that window with its steady-state rate.",
        "Count the work the refill really needs: one origin fetch per distinct hot key, not one per request. The gap between those two numbers is the herd you can remove.",
        "Make concurrent misses for the same key share a single origin fetch, then give storage just enough headroom to absorb the refill inside the budget.",
      ],
      objectives: [
        objective("p95", "lte", 170),
        objective("throughput", "gte", 475),
        objective("errorRate", "lte", 0.01),
        queueDepth(60),
        budget(36),
      ],
      architecture: catalogStarter,
      reference: tweak(catalogStarter, { cache: { coalesce: true }, db: { capacity: 300 } }),
      workload: workload({
        requestRate: 500,
        readRatio: 0.95,
        duration: 30,
        seed: 96,
        keySpace: 5000,
        keySkew: 0.8,
        failures: [{ kind: "cache-flush", at: 0.5 }],
      }),
      allowedKinds: ["server", "load-balancer", "cache", "database"],
      estimation: estimate("dbLoad", "p95", "queueDepth"),
      defense: defense({
        followUps: [
          "The cache node restarts cold during your traffic peak instead of mid-run. Walk me through the next thirty seconds of your design.",
          "Your team wants to set a five-minute TTL on every entry. What new failure does that introduce, and how do you avoid it?",
          "How would you detect a stampede in production, and what would you put on the alert?",
        ],
        rubric: rubric([
          ["mechanism", "Explains why an empty cache converts the read rate into origin load, and why hot keys multiply that into a herd", 25],
          ["arith", "Quantifies the refill as one fetch per distinct key versus one per request, and compares both with the origin's capacity", 30],
          ["fix", "Names coalescing as the fix for the herd and origin headroom as the fix for the refill, and explains why both are needed", 25],
          ["alt", "States a rejected alternative (buying enough origin capacity for the whole read rate) and why it loses on cost", 10],
          ["risk", "Names a residual risk: synchronized TTL expiry, a lost cache node, or cold starts after deploys", 10],
        ]),
        modelAnswer:
          "In the steady state the database sees only writes and the few reads that miss, well under half its capacity. When the cache is flushed, every one of about 475 reads per second becomes a miss, and because the key distribution is skewed the same popular ids are fetched by many callers at once, so the origin sees far more calls than there are distinct keys to refill. Measured, the queue behind the database jumps past 200 and p95 goes to roughly 800 ms. I turned on coalescing so concurrent misses for a key wait on one in-flight fetch - the refill then costs about one read per distinct key - and lifted the database from 240 to 300 requests per second so that refill fits in a couple of seconds without queueing. p95 in the flush window lands near 100 ms, peak queue depth drops to about 40, and the cost stays inside the cap; buying enough origin capacity for the entire cold read rate would have cost half again as much and still stampeded. The remaining risk is synchronized expiry, so I would jitter TTLs and stagger cache restarts.",
      }),
      reflection: {
        question: "During a cold start, 5,000 keys are requested by 500 readers per second. What does request coalescing change?",
        options: [
          "It reduces the number of keys that must be fetched from the origin",
          "It removes duplicate concurrent fetches for the same key, so the refill costs about one origin call per key instead of one per waiting reader",
          "It serves stale data while the cache refills, so the origin sees no traffic at all",
          "It spreads the refill over a longer period by rate limiting misses",
        ],
        answer: 1,
        explanation:
          "Coalescing collapses the herd, not the working set. Every distinct key still has to be fetched once to be installed, which is why the origin still needs headroom for the refill - coalescing just prevents the fifty simultaneous readers of one popular key from turning that single fetch into fifty.",
      },
    }),

    lesson({
      id: "ttl-and-staleness",
      chapter: chapterTitles[3],
      title: "TTL and staleness",
      subtitle: "Buy freshness with origin load, deliberately.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Freshness, TTL and hit-rate cost",
      brief:
        "An inventory service takes 300 requests per second over only 250 SKUs, one in five of them a stock write, and the durable store adds 120 ms to every call. The cache holds every SKU and never expires an entry, so nearly nine percent of reads answer with a count the database has already superseded. The product needs stale reads under five percent without breaking the latency budget.",
      learning: [
        "Staleness has a window. A write is accepted at the cache, travels to the database, and only refreshes the cached entry when the store confirms it; every read of that key inside that window is answered from an entry the database has already superseded. So the stale read rate is roughly the write-visibility window times the read rate on the keys being written - which is why staleness is worst exactly where caching pays best, on the hot keys that get both the reads and the writes.",
        "A TTL bounds how long any entry may be believed. It does not shorten the write-visibility window, but it caps the damage from every invalidation that never arrives - a failed write-through, a missed invalidation message, a value changed by a job that does not know about your cache. That is why production caches carry a TTL even when they invalidate explicitly: the TTL is the backstop, and its length is a statement about how much divergence the product tolerates.",
        "The cost of a TTL is measured in hit rate, and the exchange rate is the request rate per key. An entry that expires before the next read of that key produces a guaranteed miss, so as the TTL falls below the typical gap between reads of a key, the hit rate collapses towards zero and every read becomes an origin call. Here the origin also adds a fixed 120 ms, so a short TTL both loads storage and moves the median latency from cache speed to store speed. Pick the TTL from the freshness requirement, then size the origin for the miss traffic that TTL implies, and check the budget before you shorten it further.",
        "The model idealizes freshness as a per-key comparison against the last accepted write, with no explicit invalidation channel, no negative caching, no soft-TTL 'serve stale while revalidating', and no versioning or compare-and-set. Real systems reach for exactly those when this tradeoff gets tight: stale-while-revalidate keeps the hit rate while bounding staleness, and event-driven invalidation shrinks the window without paying for expiry, at the cost of a delivery guarantee you now have to operate.",
      ],
      hints: [
        "Read the stale-read insight next to the cache's hit rate, and note which keys receive both the reads and the writes.",
        "Work out how often a typical key is read, then reason about what an expiry shorter than that gap does to your hit rate and to the traffic arriving at the store.",
        "Set an expiry on cached entries derived from the freshness the product needs, then size storage for the misses that expiry creates, staying inside the budget.",
      ],
      objectives: [
        staleReads(0.05),
        objective("p95", "lte", 190),
        objective("throughput", "gte", 285),
        objective("errorRate", "lte", 0.01),
        budget(42),
      ],
      architecture: inventoryStarter,
      reference: tweak(inventoryStarter, { cache: { ttlMs: 150 }, db: { capacity: 400 } }),
      workload: workload({ requestRate: 300, readRatio: 0.8, duration: 30, seed: 107, keySpace: 250, keySkew: 0.6 }),
      allowedKinds: ["server", "load-balancer", "cache", "database"],
      estimation: estimate("dbLoad", "p95", "cost"),
      defense: defense({
        followUps: [
          "The business now wants read-your-writes for the customer who just placed an order. Does a shorter TTL give you that, and what would?",
          "Traffic grows ten times but the SKU count stays at 250. What happens to your stale rate and to your origin load?",
          "Your TTL is the only thing keeping stale reads in budget and the origin is at eighty percent. What is your next move, and what does it cost?",
        ],
        rubric: rubric([
          ["mechanism", "Explains staleness as a write-visibility window times the read rate on written keys, not as a cache bug", 25],
          ["arith", "Relates the chosen expiry to the per-key read rate and computes the resulting miss traffic at the origin", 30],
          ["tradeoff", "States the exchange explicitly: freshness is bought with hit rate, origin load and median latency", 25],
          ["alt", "States a rejected alternative (bigger origin with no expiry, or removing the cache) and why it fails the freshness goal or the budget", 10],
          ["risk", "Names a residual risk or a better production mechanism: stale-while-revalidate, explicit invalidation, or versioned reads", 10],
        ]),
        modelAnswer:
          "Baseline stale reads are about 8.7% because entries never expire: with 60 writes per second landing on the same skewed keys that take most of the 240 reads, and a store that takes over 120 ms to confirm a write, a large slice of reads is answered inside the write-visibility window. Buying a bigger database does not fix this - I measured a much larger store and staleness barely moved, because the window is dominated by fixed latency, not queueing. The lever that works is expiry. Setting a 150 ms TTL caps how long any entry can be believed and brings stale reads to about 3%. The price is hit rate: with only 250 SKUs each read roughly once a second, an expiry that short means most reads now miss, so origin load rises from about 70 to nearly 270 requests per second, and I raised the database to 400 to keep it near 60% utilization and hold p95 around 150 ms inside the budget. In production I would prefer stale-while-revalidate plus event-driven invalidation to keep the hit rate.",
      }),
      reflection: {
        question: "Each SKU is read about once per second. You cut the cache TTL from one second to 100 ms to improve freshness. What is the main consequence?",
        options: [
          "Stale reads fall to zero, because entries are always fresh",
          "Almost every read now misses, so the cache stops absorbing load and the origin sees nearly the full read rate",
          "Nothing changes, because the TTL only applies to writes",
          "Latency improves, because expired entries are cheaper to look up",
        ],
        answer: 1,
        explanation:
          "A TTL shorter than the gap between reads of a key guarantees the entry has expired by the time the next reader arrives. The cache degrades into a pass-through proxy: staleness improves, but you have paid for it with hit rate, origin load and the origin's latency on the median request.",
      },
    }),

    lesson({
      id: "edge-caching",
      chapter: chapterTitles[3],
      title: "Edge caching",
      subtitle: "Serve distant readers without crossing the ocean.",
      difficulty: "Advanced",
      minutes: 14,
      concept: "CDN edges and cross-region round trips",
      brief:
        "A documentation site serves 400 requests per second, almost all reads, and 60% of readers are in Asia while the whole stack runs in Virginia. Every request from that region pays a 90 ms crossing before the origin even starts working, so p95 is above 140 ms no matter how much origin capacity you buy.",
      learning: [
        "Distance is latency you cannot optimize away in the application. Each hop that leaves a region adds the cross-region penalty to the request, so a reader in Asia hitting a Virginia origin pays that penalty before any server does work - and no amount of extra capacity in Virginia changes it. When most of your users are far away, the first question is not how fast the origin is, but how many of their requests need to reach it at all.",
        "A CDN edge answers cacheable reads inside the reader's own region and forwards the rest. That splits your traffic into a local path measured in single-digit milliseconds and a remote path that still pays the crossing, so p95 is decided by what fraction still crosses: writes, plus reads that miss at the edge. If that fraction stays under the tail you are measuring, the percentile lands entirely on the local path - which is why edge hit rate and write share, not origin speed, are the numbers to quote for a p95 target.",
        "Edges also unload the origin, and that is the second win. Serving most reads at the edge cuts origin traffic dramatically, so you can run a smaller, cheaper origin and keep it far from saturation for the traffic that genuinely needs it. The pattern is standard: long TTLs and immutable, versioned URLs for static content; short TTLs or bypass for anything personalized; and explicit purges for the rare edit. Anything you cannot make cacheable stays on the slow path by definition, so the design conversation is really about how much of the response body can be made public and versioned.",
        "The model idealizes the edge as one hit-rate roll per read with the origin one hop away, no per-object TTLs, no purge propagation, and a single symmetric penalty per crossing rather than a real round trip with TCP and TLS setup. It also assumes writes are rare. Where writes are frequent or reads must be personalized, the honest answer in an interview is that edges help less and you need regional replicas or a different consistency story, which the multi-region chapter takes up.",
      ],
      hints: [
        "Split the latency by where the request came from: compare the readers in the distant region with the local ones before you touch any capacity.",
        "Work out what share of all traffic must still reach the origin - writes plus the reads the edge cannot answer - and compare it with the percentile you have to hit.",
        "Terminate reads inside the reader's own region with an edge in front of the existing stack, and let only the misses and writes cross.",
      ],
      objectives: [
        objective("p95", "lte", 75),
        objective("throughput", "gte", 380),
        objective("errorRate", "lte", 0.01),
        budget(32),
      ],
      architecture: docsStarter,
      reference: docsReference,
      workload: workload({
        requestRate: 400,
        readRatio: 0.98,
        duration: 30,
        seed: 118,
        regions: [
          { name: "us-east", share: 0.4 },
          { name: "ap-south", share: 0.6 },
        ],
        crossRegionLatencyMs: 90,
      }),
      allowedKinds: ["server", "load-balancer", "cache", "database", "cdn"],
      estimation: estimate("p95", "throughput", "cost"),
      defense: defense({
        followUps: [
          "The site adds per-user personalization to every page. What happens to your edge hit rate and your p95, and what do you do about it?",
          "An author publishes a correction and it must be visible worldwide within a minute. How does that work in your design?",
          "Your edge in Asia goes down entirely. What do readers there experience, and what is your recovery plan?",
        ],
        rubric: rubric([
          ["diagnosis", "Attributes the baseline p95 to the cross-region hop rather than to origin capacity, using the regional split", 25],
          ["arith", "Computes the share of traffic that still crosses (writes plus edge misses) and ties it to the percentile being targeted", 30],
          ["mechanism", "Explains that an edge terminates cacheable reads in the reader's region and unloads the origin at the same time", 20],
          ["alt", "States a rejected alternative (more origin capacity, a full regional stack, a bigger origin cache) and why it loses here", 15],
          ["risk", "Names a residual risk: uncacheable or personalized responses, purge latency, or edge outage", 10],
        ]),
        modelAnswer:
          "The origin was never the problem: it sits around a third utilized while p95 is about 143 ms, and the split by region explains it - sixty percent of readers are in Asia and every one of their requests pays a 90 ms crossing to Virginia before work begins. Since 98% of traffic is cacheable reads, I put a CDN edge in each region in front of the existing stack, so a read is answered locally in single-digit milliseconds and only writes and edge misses cross. At a 95% edge hit rate that is about two percent writes plus five percent of reads, roughly four percent of all traffic, which is below the 95th percentile - so p95 falls to about 54 ms while the crossing survives only in p99. Origin traffic drops by more than eighty percent, so the same origin now runs at a few percent utilization and the total stays inside budget; buying origin capacity would have cost more and moved p95 not at all. The residual risks are personalization, which is uncacheable, and purge latency for corrections.",
      }),
      reflection: {
        question: "60% of your readers are 90 ms away and an edge in their region serves 95% of their reads. Why does p95 improve so sharply?",
        options: [
          "Because the origin is no longer saturated, so queueing disappears",
          "Because the share of requests that still cross the ocean falls below five percent, so the 95th percentile now lands on locally served requests",
          "Because the CDN compresses responses and reduces transfer time",
          "Because writes are routed to the nearest region as well",
        ],
        answer: 1,
        explanation:
          "Percentiles are about the shape of the distribution, not the mean. With about four percent of requests still crossing, the slow tail no longer reaches the 95th percentile, so p95 reflects the local path - though p99 still shows the crossing, which is exactly where you should expect to find it.",
      },
    }),
  ],
};
