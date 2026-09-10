import type { Architecture, Lesson, NodeKind, Objective, SystemNode, Workload } from "./types";

type LegacyLesson = Omit<Lesson, "kind" | "reference" | "estimation" | "defense" | "readings" | "remixable" | "difficulty"> & { difficulty: "Beginner" | "Intermediate" | "Advanced" };
function legacy(lesson: LegacyLesson): Lesson {
  return { ...lesson, kind: "sim", reference: lesson.architecture, estimation: [], defense: { prompt: "", followUps: [], rubric: [], modelAnswer: "" }, readings: [], remixable: false };
}
import { createSystemNode, defaultWorkload, nodeDefaults } from "./templates";

export const chapters = ["Foundations", "Performance", "Workloads & queues", "Reliability"];

const allKinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue"];

function node(kind: NodeKind, id: string, column: number, overrides: Partial<SystemNode> = {}): SystemNode {
  const base = createSystemNode(kind, id, { x: 40 + column * 280, y: 140 });
  const cost = overrides.capacity === undefined ? base.cost : base.cost * overrides.capacity / nodeDefaults[kind].capacity;
  return { ...base, cost, ...overrides };
}

function chain(nodes: SystemNode[]): Architecture {
  return {
    nodes,
    edges: nodes.slice(1).map((target, index) => ({ id: `${nodes[index].id}-${target.id}`, source: nodes[index].id, target: target.id })),
  };
}

function web(serverCapacity: number, databaseCapacity: number): Architecture {
  return chain([
    node("traffic", "traffic", 0),
    node("server", "server", 1, { label: "API server", capacity: serverCapacity }),
    node("database", "database", 2, { label: "Product database", capacity: databaseCapacity }),
  ]);
}

function cached(serverCapacity: number, databaseCapacity: number, cacheHitRate = 0.8): Architecture {
  return chain([
    node("traffic", "traffic", 0),
    node("server", "server", 1, { label: "Catalog API", capacity: serverCapacity }),
    node("cache", "cache", 2, { label: "Product cache", cacheHitRate }),
    node("database", "database", 3, { label: "Product database", capacity: databaseCapacity }),
  ]);
}

function jobs(workerCapacity: number, databaseCapacity: number): Architecture {
  return chain([
    node("traffic", "traffic", 0, { label: "Incoming jobs" }),
    node("server", "intake", 1, { label: "Job intake", capacity: 1000, latency: 5 }),
    node("queue", "queue", 2, { label: "Pending jobs" }),
    node("server", "worker", 3, { label: "Job worker", capacity: workerCapacity, latency: 10, role: "worker" }),
    node("database", "database", 4, { label: "Job results", capacity: databaseCapacity }),
  ]);
}

function workload(overrides: Partial<Workload> = {}): Workload {
  return { ...defaultWorkload, ...overrides };
}

function objective(metric: Objective["metric"], operator: Objective["operator"], target: number, label: string): Objective {
  return { id: metric, metric, operator, target, label };
}

const healthy = (throughput: number, latency = 180): Objective[] => [
  objective("p95", "lte", latency, `P95 latency at most ${latency} ms`),
  objective("throughput", "gte", throughput, `Throughput at least ${throughput} req/s`),
  objective("errorRate", "lte", 0.01, "Error rate at most 1%"),
];

const legacyLessons: LegacyLesson[] = [
  {
    id: "first-request", number: 1, chapter: chapters[0], title: "Your first request", subtitle: "Follow a request from browser to database.", difficulty: "Beginner", minutes: 8,
    concept: "Latency & throughput",
    brief: "A small store serves 100 requests every second. Follow one request through its API and database, then establish a healthy baseline before changing the design.",
    learning: [
      "Latency is the time a request takes from arrival to completion. Throughput counts how many requests finish each second.",
      "P95 is the latency at or below which 95% of successful requests finish. The slowest 5% can take longer.",
      "Each component adds processing and transit time. Waiting for a busy component adds queueing time on top.",
    ],
    hints: ["The starting system has enough capacity. Run it once and inspect a completed request.", "Compare the API and database steps in the trace. Their processing and transit times contribute to total latency.", "A fast average can hide slow requests. Check P95 together with the error rate."],
    objectives: healthy(95, 150), architecture: web(200, 150), workload: workload(), allowedKinds: ["server", "database"],
    reflection: { question: "A service reports P95 latency of 80 ms. What does this mean?", options: ["Every request finishes within 80 ms.", "95% of successful requests finish within 80 ms.", "The service completes 95 requests every 80 ms."], answer: 1, explanation: "P95 describes a latency percentile, not a maximum or a request rate. Check errors separately because this simulator reports latency for successful requests." },
  },
  {
    id: "find-the-bottleneck", number: 2, chapter: chapters[0], title: "Find the bottleneck", subtitle: "Discover why requests start waiting.", difficulty: "Beginner", minutes: 10,
    concept: "Capacity & saturation",
    brief: "Traffic has grown to 220 requests per second, but the API can process only 100. Diagnose the queue and give the constrained component enough capacity to keep up.",
    learning: ["A component's capacity is its processing limit per replica, measured in requests per second.", "When arrivals exceed service capacity, waiting requests accumulate and some eventually time out.", "Increasing capacity elsewhere does not remove the narrowest point on the request path."],
    hints: ["Run the baseline and compare utilization and queue depth for the two components.", "The database can already handle 400 requests per second. Focus on the API server.", "Give the API roughly 300 requests per second of capacity, then rerun the same workload."],
    objectives: healthy(210), architecture: web(100, 400), workload: workload({ requestRate: 220 }), allowedKinds: ["server", "database"],
    reflection: { question: "Why did increasing the database's capacity leave the API queue unchanged?", options: ["Only caches can reduce queueing.", "The simulator ignores database capacity.", "The API remained the component limiting the request path."], answer: 2, explanation: "The API still receives work faster than it can process it. Unused capacity downstream cannot process requests that are waiting upstream." },
  },
  {
    id: "share-the-load", number: 3, chapter: chapters[0], title: "Share the load", subtitle: "Route requests to each application replica.", difficulty: "Beginner", minutes: 12,
    concept: "Load balancing & replicas",
    brief: "Spread 360 requests per second across at least two application replicas behind a load balancer. The starter has just one 200-request-per-second replica. Add replicas to that server or connect a second server through the balancer. Extra replicas alone cannot distribute incoming traffic.",
    learning: ["In this model, a direct connection to an application server addresses only its first replica. Additional replicas stay idle unless a load balancer routes requests to them.", "A load balancer selects healthy application replica endpoints in round-robin order. With both replicas receiving traffic, two 200-req/s replicas provide about 400 req/s of processing capacity.", "Routing and capacity are separate requirements. The replicas still share a database, so downstream capacity must be checked too. Real deployments may use a proxy, service networking, or client-side balancing; none is implicit in this graph."],
    hints: ["The load balancer has ample capacity, but its only application replica can process just 200 req/s.", "Keep the load balancer and increase the server's replica count to two, or connect a second server from the load balancer to the database.", "Compare the same two-replica design with traffic connected directly to the server: only the first replica receives requests, so the 200-req/s bottleneck returns."],
    objectives: healthy(340),
    architecture: chain([node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2), node("database", "database", 3, { capacity: 600 })]),
    workload: workload({ requestRate: 360 }), allowedKinds: ["server", "load-balancer", "database"], requiredBalancedReplicas: 2,
    reflection: { question: "Why do two 200-req/s application replicas still bottleneck at about 200 req/s when traffic connects directly to the server in this model?", options: ["The direct connection addresses only the first replica; the second needs an explicit traffic-routing mechanism.", "Adding a replica halves the capacity of each server.", "A database automatically prevents application replicas from receiving traffic."], answer: 0, explanation: "Provisioning another replica creates capacity, but it does not route requests there. An explicit load balancer in this model distributes requests across both healthy replicas. Storage capacity must still support their combined output." },
  },
  {
    id: "make-reads-cheaper", number: 4, chapter: chapters[1], title: "Make reads cheaper", subtitle: "Keep repeated reads away from storage.", difficulty: "Intermediate", minutes: 12,
    concept: "Cache hits & misses",
    brief: "Your catalog receives 400 requests per second, and 95% are reads. The API has room to spare, while the database can serve only 120. Add a cache so repeated reads can finish before reaching storage.",
    learning: ["A cache hit finishes at the cache. A cache miss continues to the next component.", "In this model, the configured hit rate applies only to reads; every write continues to the database.", "Expected database traffic is total traffic multiplied by one minus the read fraction times the cache hit rate."],
    hints: ["Insert a cache between the API and database, replacing their direct connection.", "At a 95% read ratio and an 80% hit rate, about 24% of traffic still reaches the database: roughly 96 requests per second.", "Keep the cache's downstream database connection so misses and writes have somewhere to go."],
    objectives: healthy(380), architecture: web(600, 120), workload: workload({ requestRate: 400, readRatio: 0.95 }), allowedKinds: ["server", "database", "cache"],
    reflection: { question: "With 1,000 req/s, 90% reads, and an 80% cache hit rate, about how much traffic reaches the database?", options: ["100 req/s", "200 req/s", "280 req/s"], answer: 2, explanation: "Of 900 reads, 180 miss the cache. All 100 writes continue to storage, for about 280 database requests per second." },
  },
  {
    id: "survive-the-spike", number: 5, chapter: chapters[1], title: "Survive the spike", subtitle: "Design for the busy moment, not the average.", difficulty: "Intermediate", minutes: 12,
    concept: "Burst traffic & headroom",
    brief: "A product launch doubles catalog traffic from 220 to 440 requests per second during the middle of the run. A load balancer routes traffic to the API, and a cache protects storage. The API's single 300-request-per-second replica is too small for the peak.",
    learning: ["A system can be healthy at its average request rate and overloaded during a short peak.", "Queueing created during a spike can keep latency elevated even after arrivals return to normal.", "Headroom is spare capacity that incoming requests can actually reach. The load balancer distributes requests across application replicas; this lab does not add or remove replicas automatically during a run."],
    hints: ["Run the spike and locate the interval where latency rises.", "The workload doubles from 35% to 65% of the run. Plan for 440 req/s at the API.", "Keep the load balancer and use two 300-req/s API replicas for 600 req/s of routed capacity. Alternatively, increase a single replica's capacity above the peak. Check storage demand too."],
    objectives: [...healthy(270, 200), objective("maxQueueDepth", "lte", 40, "Peak queue depth at most 40")],
    architecture: chain([node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2, { label: "Catalog API", capacity: 300 }), node("cache", "cache", 3, { label: "Product cache", cacheHitRate: 0.9 }), node("database", "database", 4, { label: "Product database", capacity: 200 })]),
    workload: workload({ requestRate: 220, readRatio: 0.95, pattern: "spike" }), allowedKinds: ["server", "load-balancer", "database", "cache"],
    reflection: { question: "Why can latency stay high just after traffic drops back to normal?", options: ["Previously queued requests still need to be processed.", "A cache stops working after every traffic spike.", "The database forgets its capacity."], answer: 0, explanation: "A lower arrival rate stops adding work as quickly, but it does not erase the existing backlog. Spare processing capacity is needed to drain it." },
  },
  {
    id: "spend-your-budget", number: 6, chapter: chapters[1], title: "Spend your budget", subtitle: "Meet the target with fewer infrastructure credits.", difficulty: "Intermediate", minutes: 15,
    concept: "Cost & right-sizing",
    brief: "The catalog handles 320 requests per second, mostly reads. Its oversized API and database cost 25 credits. Bring that cost to 13 credits or less while preserving responsiveness and successful throughput.",
    learning: ["Credits are a teaching model, not provider prices. More capacity increases a component's cost, and replicas multiply it, even when traffic cannot reach them.", "A cache can replace expensive repeated database work with a smaller amount of cheaper work.", "Right-sizing means measuring required capacity, making a change, and checking performance again."],
    hints: ["First run the baseline. It meets the performance target but exceeds the budget.", "At 95% reads and an 80% hit rate, a cache sends about 77 req/s to storage.", "Try a 400-req/s API, a 150-req/s database, and one default cache. Their total cost is 12 credits."],
    objectives: [...healthy(304), objective("cost", "lte", 13, "Infrastructure cost at most 13 credits")],
    architecture: web(600, 600), workload: workload({ requestRate: 320, readRatio: 0.95 }), allowedKinds: ["server", "database", "cache"],
    reflection: { question: "Which change most directly explains the cheaper design?", options: ["The budget reduces incoming traffic.", "Cache hits reduce the database capacity required for the same traffic.", "A smaller database makes every operation faster."], answer: 1, explanation: "The cache removes repeated read work from the database. That lets you reduce provisioned storage capacity while continuing to serve the offered workload." },
  },
  {
    id: "jobs-in-the-queue", number: 7, chapter: chapters[2], title: "Jobs in the queue", subtitle: "Follow a job until its work is actually done.", difficulty: "Intermediate", minutes: 12,
    concept: "Queues & worker capacity",
    brief: "An image-processing pipeline accepts 160 jobs per second. Its queue is fast, but the worker completes only 80 jobs per second. Get jobs through the entire pipeline without an ever-growing backlog.",
    learning: ["A queue stores pending work. It does not supply the processing capacity needed to complete that work.", "The server after a queue acts as a worker. Its replicas pull jobs from one shared FIFO queue, so the queue provides the work-distribution mechanism. Application servers instead need an explicit load balancer to use multiple replicas.", "This lab measures end-to-end completion, including time waiting in the queue; accepting a job is not counted as finishing it. Queue durability, delivery guarantees, retries, and duplicate jobs are not modeled."],
    hints: ["Compare the queue's growing backlog with the worker's utilization.", "Raising queue capacity will not make the worker faster.", "Give the worker at least 240 jobs per second of capacity. Storage already supports 400."],
    objectives: [...healthy(150, 200), objective("maxQueueDepth", "lte", 30, "Peak queue depth at most 30")],
    architecture: jobs(80, 400), workload: workload({ requestRate: 160, readRatio: 0 }), allowedKinds: ["server", "queue", "database"],
    reflection: { question: "What does a queue contribute when jobs arrive faster than workers can finish them?", options: ["Unlimited processing capacity.", "Immediate completion of every job.", "A place for pending work to wait."], answer: 2, explanation: "A queue buffers work. Sustained arrival rates above worker capacity still create a growing backlog and eventual deadline failures in this model." },
  },
  {
    id: "drain-the-backlog", number: 8, chapter: chapters[2], title: "Drain the backlog", subtitle: "Give background work enough burst capacity.", difficulty: "Intermediate", minutes: 12,
    concept: "Backpressure & backlog",
    brief: "A notification pipeline normally receives 180 jobs per second and briefly peaks at 360. One 200-job-per-second worker cannot stay ahead of the burst. Keep waiting jobs below 50 and deliver them promptly.",
    learning: ["A queue absorbs timing differences between producers and workers, but a backlog is also unfinished work.", "Worker replicas pull different jobs from the shared queue, providing parallel processing without an HTTP load balancer. Downstream storage needs enough capacity for their combined output.", "Backpressure means controlling production or admission when consumers fall behind. This mission explores capacity and backlog with a fixed offered workload; it does not simulate a producer backpressure policy."],
    hints: ["Inspect the middle of the timeline, when the arrival rate doubles.", "Two worker replicas pulling from this queue provide about 400 jobs per second, above the 360-job peak.", "The results database already supports 600 operations per second. Verify the queue drains and end-to-end P95 improves."],
    objectives: [...healthy(220, 250), objective("maxQueueDepth", "lte", 50, "Peak queue depth at most 50")],
    architecture: jobs(200, 600), workload: workload({ requestRate: 180, readRatio: 0, pattern: "spike" }), allowedKinds: ["server", "queue", "database"],
    reflection: { question: "After a burst, which condition lets a backlog shrink?", options: ["Workers process jobs faster than new jobs arrive.", "The queue receives more jobs than workers finish.", "The queue is renamed."], answer: 0, explanation: "A backlog decreases only when the completion rate exceeds the arrival rate. The difference is the rate at which waiting work can drain." },
  },
  {
    id: "when-caches-cannot-help", number: 9, chapter: chapters[2], title: "When caches cannot help", subtitle: "Revisit a design when the workload changes.", difficulty: "Advanced", minutes: 12,
    concept: "Read/write workload mix",
    brief: "A former read-heavy catalog now processes inventory updates: 80% of its 300 requests per second are writes. Even a 95% read hit rate cannot protect the 150-req/s database. Restore performance for this new workload.",
    learning: ["The effectiveness of an architecture depends on the shape of its workload, including its read/write ratio.", "Writes bypass cache hits in this model. Raising the hit rate cannot remove write traffic from storage.", "With 20% reads and a 95% hit rate, roughly 81% of requests still reach the database. Increase provisioned database service capacity here; real read replicas do not automatically increase write throughput."],
    hints: ["At least 240 writes per second must reach the database, even with a perfect read hit rate.", "The API and cache have enough processing capacity. The database needs to handle about 243 req/s.", "Raise database capacity to around 350 req/s, then inspect both throughput and tail latency."],
    objectives: healthy(285), architecture: cached(600, 150, 0.95), workload: workload({ requestRate: 300, readRatio: 0.2 }), allowedKinds: ["server", "database", "cache"],
    reflection: { question: "Why does increasing the read hit rate from 95% to 100% provide little benefit here?", options: ["The cache is never used.", "Most traffic is writes, which still require database processing.", "A higher hit rate always slows the API."], answer: 1, explanation: "Only 20% of traffic is eligible for cache hits. Even eliminating all remaining read misses leaves 240 writes per second for storage." },
  },
  {
    id: "lose-a-server", number: 10, chapter: chapters[3], title: "Lose a server", subtitle: "Keep serving after application capacity disappears.", difficulty: "Advanced", minutes: 15,
    concept: "Redundancy & failover",
    brief: "At the halfway point, the first replica of the first application server fails. Keep 180 requests per second moving through the API and database with at most 1% errors. This lab assumes immediate health detection by the load balancer.",
    learning: ["Capacity that exists only before a failure does not establish resilience. Surviving capacity must still meet demand, and requests need a route to it.", "The load balancer routes new requests across healthy application replica endpoints. Direct traffic remains addressed to the first replica, so adding an unreachable standby does not provide failover.", "The first replica of the first enabled matching server fails for the rest of the run. Its in-flight processing and queued work can fail. Health detection is immediate in this model; real detection delays, retries, and recovery are not modeled."],
    hints: ["Run once and inspect the halfway point where the first replica fails.", "Keep the load balancer and give the application server two replicas, or add another application server connected from the load balancer to the database.", "Check the healthy capacity the load balancer can reach after the failure, not just total pre-failure capacity."],
    objectives: healthy(170, 200),
    architecture: chain([node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2, { capacity: 400 }), node("database", "database", 3, { capacity: 400 })]),
    workload: workload({ requestRate: 180, failure: "server" }), allowedKinds: ["server", "load-balancer", "database"],
    reflection: { question: "Two 100-req/s replicas handle a steady 180 req/s. Are they provisioned to survive one replica failing?", options: ["Yes, because there are two replicas.", "Yes, because a load balancer increases total processing capacity.", "No, the remaining 100-req/s replica cannot sustain 180 req/s."], answer: 2, explanation: "Redundancy requires sufficient remaining capacity. Two replicas can provide normal operation without providing enough capacity during a failure." },
  },
  {
    id: "protect-the-database", number: 11, chapter: chapters[3], title: "Protect the database", subtitle: "Remove a shared dependency's single point of failure.", difficulty: "Advanced", minutes: 15,
    concept: "Dependency availability",
    brief: "The application and cache are healthy, but one database service slot fails halfway through the run. Here, database replicas are an idealized managed pool that can automatically use surviving slots. Keep misses and writes successful while exploring that assumption, not a real database replication protocol.",
    learning: ["A cache can continue serving hits while its backing database is unavailable, but misses and writes still depend on storage.", "Each database replica in this model is an equivalent service slot for reads and writes behind an implicit managed endpoint. The pool sends waiting work to surviving slots, so provision enough surviving capacity for cache misses and writes.", "Real database replicas may be read-only, require leader election, or have replication lag. This lab models none of those behaviors, nor consistency or write coordination. Adding a real replica does not by itself guarantee write scaling or automatic failover."],
    hints: ["Observe which requests fail after the database service slot goes offline. Cache hits can still complete.", "For this idealized managed pool, set the database replica count to two so its built-in dispatcher has a surviving service slot.", "Verify that the remaining slot handles misses and writes without a new queue. This result relies on the model's immediate routing and equivalent-slot assumptions."],
    objectives: healthy(170, 200), architecture: cached(400, 200, 0.85), workload: workload({ requestRate: 180, readRatio: 0.9, failure: "database" }), allowedKinds: ["server", "database", "cache"],
    reflection: { question: "Why is a high cache hit rate insufficient to guarantee availability during a total database outage?", options: ["Misses and writes still need the database.", "Every cache hit must also query the database.", "Caching disables database failover."], answer: 0, explanation: "Cache hits avoid storage, but the remaining requests still need a healthy database. A high hit rate can reduce the scope of an outage without eliminating it." },
  },
  {
    id: "launch-day", number: 12, chapter: chapters[3], title: "Launch day", subtitle: "Balance cost, peak demand, and a real failure.", difficulty: "Advanced", minutes: 15,
    concept: "Capacity planning capstone",
    brief: "Your catalog launches at 400 requests per second, spikes to 800, and loses one application replica halfway through. Keep P95 under 180 ms, errors under 1%, and infrastructure at 30 credits or less.",
    learning: ["Requirements interact: caching changes database demand, application replicas need explicit load-balancer routing, and all provisioned replicas contribute to cost.", "Plan for the overlap between the traffic peak and failure, when routed surviving capacity is lowest relative to demand.", "This capstone evaluates capacity and a single failure with immediate health detection and idealized managed storage. It does not validate data consistency, real database failover, network behavior, or all production conditions."],
    hints: ["The failure overlaps the 800-req/s traffic spike. Two surviving 400-req/s replicas are a useful starting point.", "At 90% reads and an 80% hit rate, the database sees about 224 req/s during the peak.", "Try three 400-req/s application replicas and a 300-req/s database, retaining the existing cache and load balancer. The design costs 29 credits."],
    objectives: [...healthy(490), objective("cost", "lte", 30, "Infrastructure cost at most 30 credits"), objective("maxQueueDepth", "lte", 50, "Peak queue depth at most 50")],
    architecture: chain([node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2, { label: "Catalog API", capacity: 400 }), node("cache", "cache", 3, { label: "Product cache" }), node("database", "database", 4, { label: "Product database", capacity: 200 })]),
    workload: workload({ requestRate: 400, readRatio: 0.9, pattern: "spike", failure: "server" }), allowedKinds: allKinds,
    reflection: { question: "Which capacity estimate matters most for this launch?", options: ["Normal traffic divided by the total pre-failure replica count.", "Peak demand compared with the capacity that survives the failure.", "The cache hit rate without considering writes."], answer: 1, explanation: "The most demanding modeled interval combines the traffic spike and the missing application replica. Surviving application and database capacity must support that interval within the budget." },
  },
];

export const lessons: Lesson[] = legacyLessons.map(legacy);

export function getLesson(id: string): Lesson | undefined {
  return lessons.find((lesson) => lesson.id === id);
}
