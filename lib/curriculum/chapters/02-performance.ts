import { budget, chain, chapterTitles, defense, estimate, graph, healthy, lesson, node, p99, queueDepth, rejected, rubric, tweak, workload, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- 5. make-reads-cheaper

const readHeavyStarter = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 600, latency: 15 }),
  node("database", "db", 2, { label: "Catalog database", capacity: 120, latency: 25 }),
]);

const cachedCatalog = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "api", 1, { label: "API server", capacity: 600, latency: 15 }),
    node("cache", "cache", 2, { label: "Catalog cache", cacheHitRate: 0.8 }),
    node("database", "db", 3, { label: "Catalog database", capacity: 200, latency: 25 }),
  ],
  [
    ["traffic", "api"],
    ["api", "cache"],
    ["cache", "db"],
  ],
);

const makeReadsCheaper = lesson({
  id: "make-reads-cheaper",
  chapter: chapterTitles[1],
  title: "Make reads cheaper",
  subtitle: "Keep repeated reads away from storage.",
  difficulty: "Intermediate",
  minutes: 12,
  concept: "Cache hits and misses",
  brief:
    "Your product catalog receives 400 requests per second and 95% of them are reads of the same few thousand items. The API server has room to spare while the database is rated at 120 requests per second and is being asked to serve all 400. Buying database capacity is the most expensive thing in the price list. Find the cheaper shape.",
  learning: [
    "A cache in front of storage splits the read path in two. A hit is answered by the cache and never reaches the database: it costs a couple of milliseconds instead of tens, and, more importantly, it costs the database nothing at all. A miss pays both hops — the cache lookup and then the database read — so a cache always makes the miss path slightly slower. That is the trade: you accept a small penalty on a minority of requests to remove the majority from your most expensive component. This is the cache-aside pattern, the default shape of almost every read-heavy service in production.",
    "The number that matters is not the hit rate, it is the traffic that still reaches storage. Every write goes to the database no matter what, and so does every read that misses. So the database load is writes plus (reads times miss rate), and that sum is what you size the database against. At 400 requests per second with 95% reads and an 80% hit rate, that is 20 writes plus 76 misses, about 96 per second: less than a quarter of the original load. Sizing the database against total traffic instead of post-cache traffic is the single most common overspend in a read-heavy design.",
    "Caching buys throughput at the price of freshness and of a new failure mode. Data served from a cache can be stale, so a cache is only appropriate where the product can tolerate reading a value that was correct a moment ago. And the database must survive the cache being gone: a restart, an eviction storm or a deploy empties it, and for a few seconds every read becomes a miss and the full 400 requests per second land on a database sized for 96. Production teams handle that with warm-up, request coalescing and enough database headroom to survive a cold start, which later lessons in this chapter and the next make you build. The model here idealizes the hit rate as a fixed probability; real hit rates emerge from the key distribution and the cache size, which is what the caching chapter takes apart.",
  ],
  hints: [
    "Run the baseline first and compare the database's utilization with the API server's. Only one of them is the constraint.",
    "Work out the traffic that still reaches storage after a cache: every write, plus the reads that miss. That number, not the arrival rate, is what you size the database against.",
    "Insert a cache between the application and the database, and keep the database connection so that misses and writes still have somewhere to go.",
  ],
  objectives: [...healthy(380, 90), budget(20)],
  architecture: readHeavyStarter,
  reference: cachedCatalog,
  workload: workload({ requestRate: 400, readRatio: 0.95, seed: 21 }),
  allowedKinds: ["server", "database", "cache", "load-balancer"],
  estimation: estimate("dbLoad", "p95", "cost"),
  defense: defense({
    followUps: [
      "Traffic grows tenfold overnight to 4,000 requests per second. What breaks first with your design, and what is the next change you make?",
      "The cache restarts cold at peak. Walk me through the next thirty seconds: what does the database see, what do users see, and what would you have built to survive it?",
      "The product team now needs a user to see their own edit immediately after saving it. Does your design still work? What changes?",
    ],
    rubric: rubric([
      ["bottleneck", "Names the database as the bottleneck with its measured utilization, and notes the API had headroom", 25],
      ["arith", "Computes the post-cache database load as writes plus read misses, and sizes the database against that number", 30],
      ["alt", "States a rejected alternative (a bigger database) and why it loses on cost, referencing the nonlinear price of database capacity", 25],
      ["risk", "Identifies a remaining failure mode: cold cache, hot keys, staleness, or the cache becoming a hard dependency", 20],
    ]),
    modelAnswer:
      "The database was the bottleneck: rated at 120 requests per second and receiving all 400, so it sat pinned at 100% with a growing queue while the API server idled at about 67%. Because 95% of the traffic is reads of a small, repeatedly requested catalog, the cheap fix is a cache between the API and the database. With an 80% hit rate the database now sees writes plus read misses: 20 writes plus 0.95 times 400 times 0.2, about 76 misses, so roughly 96 requests per second. I sized the database at 200 per second, which leaves it under half utilized and absorbs a shift toward writes. The alternative was scaling the database to about 450 per second; database capacity is priced with an exponent above one, so that costs roughly three times what the cache plus a modest database costs, and it still leaves every read paying full storage latency. The risk I am accepting is the cold-start case: an empty cache sends the full 400 per second at a database sized for 96, so a real deployment needs coalescing and warm-up.",
  }),
  reflection: {
    question: "Traffic is 400 requests per second at 95% reads. You improve the cache hit rate from 80% to 90%. What happens to the load on the database?",
    options: [
      "It halves, from about 96 to about 48 requests per second",
      "It falls from about 96 to about 58 requests per second, because the 20 writes per second are unaffected by the cache",
      "It falls by 10%, in proportion to the hit-rate improvement",
      "It stays the same, because reads were already being served by the cache",
    ],
    answer: 1,
    explanation:
      "Writes always reach storage. Misses fall from 76 to 38 per second, but the 20 writes per second do not move, so the total goes from 96 to 58 rather than halving. As hit rates climb, the write path becomes the floor on database load, which is why write-heavy systems get so little from caching.",
  },
});

// ---------------------------------------------------------------- 6. survive-the-spike

const spikeStarter = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "Checkout API", capacity: 320, latency: 12 }),
  node("database", "db", 2, { label: "Orders database", capacity: 320, latency: 25 }),
]);

const surviveTheSpike = lesson({
  id: "survive-the-spike",
  chapter: chapterTitles[1],
  title: "Survive the spike",
  subtitle: "Steady state is not the number you plan for.",
  difficulty: "Intermediate",
  minutes: 12,
  concept: "Headroom",
  brief:
    "Checkout runs at a comfortable 250 requests per second most of the day, and both components are sized just above that. Every evening a marketing email doubles the traffic for about ten seconds. The dashboards look fine at the daily average and the support queue says otherwise. Size this system for the peak it actually sees, not the average it reports.",
  learning: [
    "Capacity plans are written against peak load, not average load, and the ratio between them is a property of the product rather than of the system. A consumer app has a daily peak two or three times its average; a marketing send, a match kickoff or a market open can be far spikier. Sizing to the average means the system is in overload for exactly the minutes that matter most commercially, and it is the minutes that matter most that end up in the incident review. The first question in any capacity conversation is 'what is the peak-to-average ratio, and how confident are we in it'.",
    "Overload does not degrade gracefully on its own; it compounds. While arrivals exceed service rate the backlog grows, and every request in that backlog is waiting behind all the ones ahead of it, so latency grows too. When the spike ends the queue does not disappear instantly: the system has to work off the backlog at its normal rate, so the latency damage outlasts the traffic that caused it. That is why the peak queue depth during a burst is a better early-warning metric than the average latency across the window, which averages the disaster away.",
    "The conventional target is 2 to 3 times headroom over steady-state demand, which sounds wasteful until you count what it buys: absorbing the daily peak, tolerating the loss of a replica, and giving an autoscaler time to react. Autoscaling does not remove the need for headroom, it changes its shape: instances take tens of seconds to boot and warm up, so the headroom you keep is what carries you until the new capacity arrives. This model idealizes that away entirely — capacity here is instantaneous and static, so the lesson is about sizing rather than about scaling policy. It also ignores the cost side, which the next lesson makes you confront.",
  ],
  hints: [
    "Look at the traffic chart rather than the summary: find the multiple between the plateau and the burst, and plan against the burst.",
    "Check the queue-depth series over time instead of the average latency. The damage is concentrated in a window that the whole-run average hides.",
    "Size every component on the path against peak arrivals with room left over, then confirm no component's utilization approaches saturation during the burst.",
  ],
  objectives: [...healthy(300, 80), queueDepth(15)],
  architecture: spikeStarter,
  reference: tweak(spikeStarter, { api: { capacity: 700 }, db: { capacity: 700 } }),
  workload: workload({ requestRate: 250, readRatio: 0.9, pattern: "spike", seed: 22 }),
  allowedKinds: ["server", "database", "cache", "load-balancer"],
  estimation: estimate("bottleneckCapacity", "queueDepth", "p95"),
  defense: defense({
    followUps: [
      "Finance rejects the bill for this headroom and asks you to halve it. What do you change, and what do you tell them you are giving up?",
      "The spike is now 6 times the baseline instead of twice, and it arrives in two seconds. Does more capacity still work? What else would you reach for?",
      "How would you detect in production that you are about to run out of headroom, before the spike arrives rather than during it?",
    ],
    rubric: rubric([
      ["peak", "Plans against the measured peak rate rather than the average, and states the peak-to-average ratio", 25],
      ["arith", "Computes the capacity needed at peak with an explicit target utilization or headroom multiple", 25],
      ["queue", "Explains why the backlog and its latency damage outlast the spike itself", 20],
      ["alt", "Names a rejected alternative (caching, shedding, autoscaling) and the conditions under which it would win", 20],
      ["detect", "Describes how they would see this coming in production: peak utilization, queue depth, saturation alerts", 10],
    ]),
    modelAnswer:
      "Both components were sized at 320 requests per second against a 250 baseline, which is fine until the evening send doubles arrivals to 500 for ten seconds. During that window arrivals exceed service rate on both hops, so the backlog grows for the whole spike and takes several more seconds to drain afterwards, which is why the latency damage is wider than the traffic bump. I sized both components at 700 per second: that is about 71% utilization at the 500 peak and about 36% at baseline, so queueing stays small during the burst and there is still room to lose capacity. Peak queue depth is the metric I would watch, not average latency, because a thirty-second average buries a ten-second incident. I rejected sizing to 520, just above peak, because queueing delay explodes as utilization approaches one. If the spike were six times baseline rather than twice, capacity alone stops being the answer and I would add shedding: a bounded queue or a rate limiter that keeps accepted traffic fast.",
  }),
  reflection: {
    question: "During a ten-second spike, a component is asked to serve 500 requests per second against a capacity of 320. What best describes the latency damage?",
    options: [
      "Latency rises for ten seconds and returns to normal the instant the spike ends",
      "Latency rises during the spike and stays elevated afterwards while the accumulated backlog drains at the normal service rate",
      "Latency is unaffected until the queue overflows, then requests fail",
      "Latency rises by the ratio of arrival rate to capacity, about 56%, and no more",
    ],
    answer: 1,
    explanation:
      "During the overload the component falls behind by roughly 180 requests per second, so about 1,800 requests accumulate. When arrivals drop back to 250 the component still has that backlog to work through at its spare rate, so requests keep waiting behind it. The incident is longer than the spike that caused it.",
  },
});

// ---------------------------------------------------------------- 7. spend-your-budget

const overprovisioned = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 700, latency: 15 }),
  node("database", "db", 2, { label: "Profile database", capacity: 500, latency: 25 }),
]);

const budgetShape = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "api", 1, { label: "API server", capacity: 500, latency: 15 }),
    node("cache", "cache", 2, { label: "Profile cache", cacheHitRate: 0.8 }),
    node("database", "db", 3, { label: "Profile database", capacity: 180, latency: 25 }),
  ],
  [
    ["traffic", "api"],
    ["api", "cache"],
    ["cache", "db"],
  ],
);

const spendYourBudget = lesson({
  id: "spend-your-budget",
  chapter: chapterTitles[1],
  title: "Spend your budget",
  subtitle: "Same latency target, a third of the bill.",
  difficulty: "Intermediate",
  minutes: 14,
  concept: "Cost per unit of capacity",
  brief:
    "The profile service handles 350 requests per second at 92% reads and currently meets every latency target. It also costs more than the rest of the platform combined, because someone hit the problem with the most expensive component available. Keep the latency and error targets and get the bill under the cap. The price list is not linear.",
  learning: [
    "Capacity is not priced per unit across component types. In this model a server costs roughly in proportion to its capacity, while database capacity is priced with an exponent above one: doubling a database costs more than twice as much, because that is how storage really behaves once you leave the single-box regime and start paying for IOPS, replication and write amplification. Caches and load balancers are priced with exponents well below one, so they get cheap fast as you make them bigger. Those exponents are the whole design space: they mean the cheapest way to serve a read is almost never to make storage bigger.",
    "So the design question is not 'how much capacity do I need' but 'where do I buy it'. Removing load from an expensive component with a cheap one is almost always the better trade on a read-heavy path: a cache that absorbs 80% of reads lets you buy a database a quarter the size, and the cache itself costs less than the capacity it saved. The same logic drives real architecture decisions — CDNs in front of origins, read replicas instead of a bigger primary, queues that flatten a write burst so you can size for the mean instead of the peak.",
    "Cost is a first-class design objective, not an afterthought, and interviews reward the candidate who states it as a constraint and then justifies the spend. The discipline is to price each option before building it: what does it cost, what does it buy, and what is the cheapest thing that meets the requirement with acceptable risk. What this model leaves out is everything that makes real bills confusing — data volume, egress, licensing, the operational cost of one more component to run, and the fact that a cache adds a system your team has to reason about at 3 am. A design that is 20% cheaper and twice as hard to operate is not obviously a win.",
  ],
  hints: [
    "Open the cost breakdown after a run and rank the components by what each one contributes to the total. One line dominates.",
    "Compare what each component type charges for the same increase in capacity. The exponents differ by kind, so identical capacity is not identically priced.",
    "Reduce the traffic arriving at the expensive component instead of enlarging it, then re-size it against the load that actually remains.",
  ],
  objectives: [...healthy(330, 90), budget(18)],
  architecture: overprovisioned,
  reference: budgetShape,
  workload: workload({ requestRate: 350, readRatio: 0.92, seed: 23 }),
  allowedKinds: ["server", "database", "cache", "load-balancer"],
  estimation: estimate("cost", "dbLoad"),
  defense: defense({
    followUps: [
      "The workload shifts from 92% reads to 60% reads. Recalculate: does your design still fit the budget, and what do you change first?",
      "Your cache is now load-bearing for the budget. What is your plan for the hour it is unavailable, and how much of the saving does that plan give back?",
      "A colleague says the cheaper design has more moving parts and therefore more operational risk. Answer them.",
    ],
    rubric: rubric([
      ["breakdown", "Identifies from the cost breakdown which component dominated the bill, with numbers", 25],
      ["pricing", "Explains that database capacity is priced superlinearly while caches are priced sublinearly, and uses that to choose where to buy capacity", 30],
      ["arith", "Computes the post-cache database load and sizes the database against it rather than against total traffic", 25],
      ["alt", "Names a rejected alternative and prices it, rather than asserting it is worse", 10],
      ["risk", "Names the operational cost of the cheaper design: cache unavailability, staleness, one more component to run", 10],
    ]),
    modelAnswer:
      "The bill was dominated by one line: a database sized at 500 requests per second. Database capacity is priced with an exponent above one, so that single component cost about two thirds of the total while the server, priced roughly linearly, cost a third. The workload is 92% reads, so the cheap move is to stop sending reads to storage. With a cache at an 80% hit rate the database sees writes plus read misses: 28 writes plus about 64 misses, roughly 92 requests per second, so a database at 180 leaves it about half utilized with room for the mix to shift toward writes. I also trimmed the server from 700 to 500, still about 70% utilization at this traffic. The result meets the same p95 and error targets for roughly half the credits, because I bought the capacity from the cheapest curve instead of the most expensive one. If reads dropped to 60% the arithmetic inverts: writes would dominate, the cache would save far less, and I would be back to buying storage capacity or sharding it.",
  }),
  reflection: {
    question: "Database capacity is priced as a fixed cost plus a base rate times capacity raised to an exponent of about 1.35, while cache capacity uses an exponent of about 0.6. What does that imply?",
    options: [
      "Doubling the database costs about twice as much, and doubling the cache costs about half as much",
      "Doubling the database costs more than twice as much, while doubling the cache costs well under twice as much, so removing load from storage beats enlarging it",
      "Caches are always cheaper than databases at any capacity, so every design should have one",
      "The exponents only matter above a certain capacity threshold; below it both are linear",
    ],
    answer: 1,
    explanation:
      "An exponent above one means each extra unit of database capacity costs more than the last; an exponent below one means each extra unit of cache capacity costs less than the last. That is why offloading reads onto a cheap curve beats scaling up an expensive one — as long as the workload is actually cacheable.",
  },
});

// ---------------------------------------------------------------- 8. the-tail-at-scale

const fanoutStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "gateway", 1, { label: "API gateway", capacity: 900, latency: 5 }),
    node("server", "users", 2, { label: "User service", capacity: 350, latency: 10 }, -1),
    node("server", "catalog", 2, { label: "Catalog service", capacity: 350, latency: 10 }, 0),
    node("server", "pricing", 2, { label: "Pricing service", capacity: 280, latency: 10, variance: "high" }, 1),
    node("database", "users-db", 3, { label: "Users store", capacity: 500, latency: 10 }, -1),
    node("database", "catalog-db", 3, { label: "Catalog store", capacity: 500, latency: 10 }, 0),
    node("database", "pricing-db", 3, { label: "Pricing store", capacity: 500, latency: 10 }, 1),
  ],
  [
    ["traffic", "gateway"],
    ["gateway", "users"],
    ["gateway", "catalog"],
    ["gateway", "pricing"],
    ["users", "users-db"],
    ["catalog", "catalog-db"],
    ["pricing", "pricing-db"],
  ],
);

const theTailAtScale = lesson({
  id: "the-tail-at-scale",
  chapter: chapterTitles[1],
  title: "The tail at scale",
  subtitle: "Every page waits for the slowest service it called.",
  difficulty: "Advanced",
  minutes: 15,
  concept: "Tail amplification in fan-out",
  brief:
    "The product page is assembled by a gateway that calls three services in parallel — users, catalog and pricing — and renders only when all three have answered. At 250 requests per second the median page is quick and p99 is close to three times the median, which is what users complain about. The pricing team points at their dashboard and insists their service is fine. They are almost right, which is the problem.",
  learning: [
    "When a request fans out to N services in parallel and needs all of them, its latency is the maximum of N draws, not the average. If each service is slow 1% of the time, the chance that a request escapes all three unscathed is 0.99 cubed, about 97%, so roughly 3% of requests are slow — three times the per-service rate. Dean and Barroso called this tail amplification: at a fan-out of a hundred, a one-in-a-hundred hiccup per dependency means essentially every request is slow. The uncomfortable corollary is that each team can be individually within its SLO while the page they compose is not, which is exactly the argument the pricing team is making.",
    "Two things drive a component's tail: how variable its service time is, and how close it is to saturation. Variance sets the spread of a single draw — the model's high-variance setting is a lognormal wide enough that the ninety-ninth percentile is several times the mean, which is what a service with an unpredictable code path, a garbage collector or an occasional cache miss actually looks like. Utilization then multiplies it, because a long service time makes every request behind it wait. Reducing variance, by making the slow path rare or the work uniform, shrinks the tail at its source in a way that adding capacity does not.",
    "When you cannot fix the dependency, you cap it — carefully. A timeout turns an unbounded tail into a bounded one: the caller gives up at a known point, retries once against a fresh draw, and the retry usually lands in the fast bulk of the distribution, which is the hedged-request idea from the same paper. But an abandoned call keeps running and keeps consuming the dependency's capacity, so every timeout that fires adds load rather than removing it. Set the timeout near the tail of a busy, high-variance dependency and you get the opposite of what you wanted: a few percent of calls time out, each retry doubles the work, utilization climbs, the tail gets longer, more calls time out, and the service falls over. Try it in this lesson and watch the error rate. The right ordering is to fix the distribution first and then set the timeout as a backstop, comfortably above the healthy p99, with jittered backoff and a retry budget. The model idealizes hedging as a plain timeout-and-retry: no request cancellation, no tied requests, no per-tenant budgets.",
  ],
  hints: [
    "Compare the gateway's percentiles with each service's own. Ask which service the slowest requests actually waited on, and look at the service-time spread rather than the mean.",
    "Reason about the probability that a request escapes every branch quickly. A request needs all of them to be fast, so per-branch tails compound instead of averaging out.",
    "You have two levers: make the offending dependency's service time less variable, and stop the caller from waiting on an unbounded tail by giving it a deadline and a single fresh attempt.",
  ],
  objectives: [...healthy(235, 55), p99(70)],
  architecture: fanoutStarter,
  reference: tweak(fanoutStarter, {
    pricing: { variance: "low" },
    gateway: { timeoutMs: 150, retries: 1, retryBackoffMs: 20 },
  }),
  workload: workload({ requestRate: 250, readRatio: 0.9, seed: 24 }),
  allowedKinds: ["server", "database", "cache", "load-balancer"],
  estimation: estimate("p95", "throughput"),
  defense: defense({
    followUps: [
      "The gateway now calls eight services instead of three, each with the same per-service tail. What happens to the fraction of slow page loads, and what do you change?",
      "Your timeout fires on 3% of calls and each one is retried. What does that do to the load on the dependency, and how would you keep it from becoming a retry storm during a brownout?",
      "The pricing team refuses to touch their service and points at their own p99, which is inside their SLO. Make the case to them with numbers.",
    ],
    rubric: rubric([
      ["amplify", "Explains tail amplification: the request waits for the maximum of the parallel calls, so per-branch tails compound with fan-out width", 30],
      ["diagnosis", "Identifies the high-variance dependency as the source, using the gateway's percentiles versus the per-service ones", 25],
      ["fix", "Justifies the levers used: reducing service-time variance (or the utilization that amplifies it), and setting the timeout as a backstop above the healthy tail rather than near it", 25],
      ["cost", "Notes that an abandoned call still consumes capacity, and that the timeout must sit above the healthy distribution's high percentile", 10],
      ["risk", "Names a remaining risk: retry amplification, wider fan-out, correlated slowness, or no retry budget", 10],
    ]),
    modelAnswer:
      "The gateway waits for all three services, so page latency is the maximum of three draws rather than their average. Users and catalog are well behaved. Pricing runs at about 89% utilization with a high service-time variance, so its own tail is several times its mean; because the page needs every branch, that tail lands in the page's tail. p50 stayed near 39 ms while p99 ran past 100 ms, which is why each team's dashboard looked acceptable and the page did not. I reduced the pricing service's service-time variance, which shrinks the tail at its source: at the same utilization, page p99 fell to about 38 ms, because a variable service time is also what makes the queue behind it long. Then I gave the gateway a 150 ms timeout with one jittered retry as a backstop, deliberately far above the healthy p99. I first tried a tight timeout against the high-variance service and it was much worse: an abandoned call keeps consuming capacity, so retries doubled the load and the service collapsed. Buying pricing more capacity also works, by moving it off the steep part of the queueing curve, but it costs more and leaves the variance in place.",
  }),
  reflection: {
    question: "Each of three parallel dependencies is slow on 2% of calls, independently. Roughly what fraction of fan-out requests are slow?",
    options: [
      "About 2%, because the calls run in parallel and overlap",
      "About 0.7%, since the slowness is divided across the three services",
      "About 6%, because the request is slow if any one of the three is slow",
      "About 0.0008%, the product of the three probabilities",
    ],
    answer: 2,
    explanation:
      "The request completes only when the last dependency answers, so it is slow if any branch is slow: one minus 0.98 cubed, about 5.9%. Parallelism removes the additive latency, not the tail. This is why widening a fan-out degrades p99 even when every dependency stays inside its own SLO.",
  },
});

// ---------------------------------------------------------------- 9. flash-crowd

const flashStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "api", 1, { label: "Storefront API", capacity: 320, latency: 12 }),
    node("cache", "cache", 2, { label: "Product cache", cacheHitRate: 0.8 }),
    node("database", "db", 3, { label: "Product database", capacity: 300, latency: 20 }),
  ],
  [
    ["traffic", "api"],
    ["api", "cache"],
    ["cache", "db"],
  ],
);

const flashCrowd = lesson({
  id: "flash-crowd",
  chapter: chapterTitles[1],
  title: "Flash crowd",
  subtitle: "Six times the traffic for two seconds. You cannot buy your way out.",
  difficulty: "Advanced",
  minutes: 15,
  concept: "Load shedding versus over-provisioning",
  brief:
    "A storefront sits at 200 requests per second, 95% reads, until a post goes viral and traffic hits six times that for about two seconds. Right now the burst takes the site down for far longer than it lasts. There is a hard budget cap, and provisioning for the peak blows straight through it. Decide what you are going to say no to, and make everything you say yes to fast.",
  learning: [
    "A flash crowd is not a capacity problem you can solve with capacity. The burst arrives in seconds, autoscaling reacts in tens of seconds to minutes, and provisioning permanently for a peak you see for two seconds out of every thirty means paying for idle capacity for the other twenty-eight. So the honest options are: accept a degraded experience for everyone, or serve a subset of the traffic properly and refuse the rest quickly. Handling overload well, in the SRE sense, means choosing the second on purpose instead of discovering the first by accident.",
    "Shedding is the mechanism, and the crucial property is that it is cheap and immediate. A bounded queue rejects on arrival when the backlog is already at its limit: the rejected request costs almost nothing, and, more importantly, it never enters the queue that the accepted requests are waiting in. That is why a shedding system's accepted p95 stays flat while its rejection rate climbs — you are trading a clear, fast failure for a small number of users against a slow, ambiguous failure for all of them. A rate limiter does the same thing from the front door with a token bucket, and later lessons size one properly.",
    "Rejections and errors are different things and should be counted differently, in the simulator and in your monitoring. A rejection is a decision you made, returned fast, with a status the client can act on: back off, retry later, show a queue page. An error is the system failing to keep a promise it made by accepting the request. Conflating them is how teams end up with dashboards that cannot distinguish 'we are shedding as designed' from 'we are falling over'. Set the bound from what you can actually serve: queue bound divided by service rate is the worst wait an accepted request will see, so pick the bound from your latency target, not from a round number. The model idealizes the client side — no client retries hammering you after a rejection, which in reality is the thing that turns a flash crowd into a retry storm.",
  ],
  hints: [
    "Look at what happens in the seconds after the burst, not just during it. Ask why the damage lasts longer than the traffic did.",
    "Price the pure-capacity answer first: size every component for the peak, read the cost breakdown, and compare it with the cap. That tells you the lesson is not about capacity.",
    "Give the front door a bound on how much work it will hold, so overflow is refused on arrival instead of joining the queue. Choose the bound from the wait you are willing to give an accepted request.",
  ],
  objectives: [...healthy(195, 130), rejected(0.25), budget(21)],
  architecture: flashStarter,
  reference: tweak(flashStarter, {
    api: { capacity: 420, maxQueue: 30 },
    db: { capacity: 260 },
  }),
  workload: workload({ requestRate: 200, readRatio: 0.95, pattern: "flash", seed: 25 }),
  allowedKinds: ["server", "database", "cache", "load-balancer", "rate-limiter", "queue"],
  estimation: estimate("p95", "cost"),
  defense: defense({
    followUps: [
      "Every rejected client retries immediately, three times. What does your design do now, and what would you change to stay standing?",
      "The business says rejecting 20% of a viral moment is unacceptable. What would it actually cost to serve all of it, and what do you propose instead?",
      "How do you make sure your on-call can tell shedding from failing at 3 am? What do you emit, and what do you alert on?",
    ],
    rubric: rubric([
      ["diagnosis", "Explains why the unbounded design stays broken after the burst ends, in terms of backlog draining at the normal service rate", 25],
      ["shed", "Chooses shedding deliberately and explains why a rejected request is cheap and does not degrade accepted requests", 25],
      ["arith", "Sizes the bound or the limit from a latency target or a service rate, and estimates the resulting rejection rate", 25],
      ["cost", "Prices the over-provisioning alternative against the cap and rejects it with numbers", 15],
      ["risk", "Names a remaining risk: client retries, unfair shedding across tenants, or rejections being counted as errors", 10],
    ]),
    modelAnswer:
      "The burst is six times baseline for two seconds, about 2,400 extra requests against a front door that serves a few hundred per second. Unbounded, every one of them joins the queue, so requests wait behind a backlog that takes far longer than the burst to drain and most of them hit their deadline: the outage outlives the traffic. Provisioning for the peak means sizing the API near 1,300 per second plus a matching database, which prices out well above the cap for capacity that idles 93% of the time. So I shed. I raised the API modestly to 420 per second and gave it a queue bound of 30 requests, which is about 70 ms of work at that service rate — inside my latency target. During the burst the queue fills, the overflow is refused on arrival at almost no cost, and the roughly 19% of requests that are rejected never slow down the 81% that are accepted. Error rate stays near zero because a rejection is a decision, not a failure. The risk I am accepting is client retries, which is why the real system also needs a limiter and a retry-after.",
  }),
  reflection: {
    question: "During the burst your design rejects about 19% of requests. Why does the accepted traffic stay fast?",
    options: [
      "Because rejected requests are retried later, when the system is idle",
      "Because the queue bound caps how long an accepted request can wait, and rejected requests never join that queue",
      "Because rejecting requests frees database capacity that the accepted requests then use",
      "Because the rejected requests were the slow ones, so the average improves",
    ],
    answer: 1,
    explanation:
      "The bound is the guarantee: an accepted request waits behind at most the bounded backlog, so its worst-case wait is the bound divided by the service rate. Overflow is refused on arrival and never enters that queue, so it costs the accepted requests nothing. Shedding protects latency precisely because rejection is immediate.",
  },
});

export const chapter: ChapterFile = {
  title: chapterTitles[1],
  lessons: [makeReadsCheaper, surviveTheSpike, spendYourBudget, theTailAtScale, flashCrowd],
};
