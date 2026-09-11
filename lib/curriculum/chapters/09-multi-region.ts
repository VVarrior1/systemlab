import { budget, chapterTitles, defense, estimate, graph, lesson, node, objective, rubric, tweak, workload, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- far-away-users

const farStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 2, { region: "us-east" }),
    node("server", "api", 3, { label: "Catalog API", capacity: 250, replicas: 2, region: "us-east" }),
    node("cache", "cache", 4, { cacheHitRate: 0.9, region: "us-east" }),
    node("database", "db", 5, { label: "Catalog database", capacity: 200, region: "us-east" }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

const farReference = graph(
  [
    ...farStarter.nodes,
    node("cdn", "edge-us", 1, { label: "US edge", region: "us-east", cacheHitRate: 0.95 }, -1),
    node("cdn", "edge-eu", 1, { label: "EU edge", region: "eu-west", cacheHitRate: 0.95 }, 1),
  ],
  [["traffic", "edge-us"], ["traffic", "edge-eu"], ["edge-us", "balancer"], ["edge-eu", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- active-active

const activeNodes = [
  node("traffic", "traffic", 0),
  node("load-balancer", "lb-us", 2, { label: "US balancer", region: "us-east" }, -1),
  node("load-balancer", "lb-eu", 2, { label: "EU balancer", region: "eu-west" }, 1),
  node("server", "app-us", 3, { label: "US app", capacity: 250, replicas: 2, region: "us-east" }, -1),
  node("server", "app-eu", 3, { label: "EU app", capacity: 250, replicas: 2, region: "eu-west" }, 1),
  node("cache", "cache-us", 4, { label: "US cache", cacheHitRate: 0.9, region: "us-east" }, -1),
  node("cache", "cache-eu", 4, { label: "EU cache", cacheHitRate: 0.9, region: "eu-west" }, 1),
  node("database", "db", 5, { label: "Primary database", capacity: 250, region: "us-east" }),
];
const activeCore: [string, string][] = [
  ["lb-us", "app-us"], ["lb-eu", "app-eu"],
  ["app-us", "cache-us"], ["app-eu", "cache-eu"],
  ["cache-us", "db"], ["cache-eu", "db"],
];

const activeStarter = graph(activeNodes, [["traffic", "lb-us"], ["traffic", "lb-eu"], ...activeCore]);

const activeReference = graph(
  [
    ...tweak(activeStarter, { "app-us": { capacity: 150 }, "app-eu": { capacity: 150 } }).nodes,
    node("cdn", "edge-us", 1, { label: "US edge", region: "us-east", cacheHitRate: 0.9 }, -1),
    node("cdn", "edge-eu", 1, { label: "EU edge", region: "eu-west", cacheHitRate: 0.9 }, 1),
  ],
  [["traffic", "edge-us"], ["traffic", "edge-eu"], ["edge-us", "lb-us"], ["edge-eu", "lb-eu"], ...activeCore],
);

// ---------------------------------------------------------------- region-outage

const outageStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "lb-us", 1, { label: "US balancer", region: "us-east" }, -1),
    node("load-balancer", "lb-eu", 1, { label: "EU balancer", region: "eu-west" }, 1),
    node("server", "app-us", 2, { label: "US app", capacity: 250, replicas: 2, region: "us-east" }, -1),
    node("server", "app-eu", 2, { label: "EU app", capacity: 150, replicas: 1, region: "eu-west" }, 1),
    node("cache", "cache-us", 3, { label: "US cache", cacheHitRate: 0.9, region: "us-east" }, -1),
    node("cache", "cache-eu", 3, { label: "EU cache", cacheHitRate: 0.9, region: "eu-west" }, 1),
    node("database", "db-us", 4, { label: "US database", capacity: 200, region: "us-east" }, -1),
    node("database", "db-eu", 4, { label: "EU database", capacity: 120, region: "eu-west" }, 1),
  ],
  [
    ["traffic", "lb-us"], ["traffic", "lb-eu"],
    ["lb-us", "app-us"], ["lb-eu", "app-eu"],
    ["app-us", "cache-us"], ["app-eu", "cache-eu"],
    ["cache-us", "db-us"], ["cache-eu", "db-eu"],
  ],
);

const outageReference = tweak(outageStarter, { "app-eu": { capacity: 250, replicas: 2 }, "db-eu": { capacity: 200 } });

// ---------------------------------------------------------------- lessons

export const chapter: ChapterFile = {
  title: chapterTitles[8],
  lessons: [
    lesson({
      id: "far-away-users",
      chapter: chapterTitles[8],
      title: "Far away users",
      subtitle: "Half your customers are an ocean away from your only stack.",
      difficulty: "Advanced",
      minutes: 14,
      concept: "Geography & edge delivery",
      brief:
        "The catalog runs entirely in us-east and it is comfortably fast — for the half of your traffic that is also in us-east. The other half is in eu-west, 100 ms of network away, and their p95 is three times worse than the American cohort's even though every server is nearly idle. Support tickets say the site feels broken; your dashboards say utilization is fine. Both are true.",
      learning: [
        "Distance is latency you cannot optimize away. Light in fibre covers roughly 200 km per millisecond, and real paths are neither straight nor congestion-free, so a transatlantic round trip lands around 70-100 ms and no amount of CPU changes that. When a design has one origin, every request from the far region pays that toll before the first byte of work is done, which is why the far cohort's p95 can be terrible while every utilization graph looks healthy.",
        "This is why percentiles must be read by cohort. A global p95 blends two populations with different physics; it will move when the mix moves and hide a problem that is total for half your users. In production this means slicing latency by region, and often by network — the fix you need is invisible in the aggregate. Here, the starter's p95 sits above the cross-region floor precisely because more than 5% of requests crossed the ocean, and it drops the moment that share falls below the percentile you are measuring.",
        "The only real fix is to answer the request closer to the user, and an edge cache is the cheapest way to do it. A CDN point of presence terminates the connection in the user's own region and serves cacheable responses from there; only the misses and the writes travel to the origin. The lever that decides how well this works is not the edge's capacity — it is the share of responses that are cacheable at all, which is a product decision about cache-control headers, TTLs, and how much per-user personalization is baked into the HTML rather than fetched by the client.",
        "Watch what the tail does as the hit rate moves, because it is not linear. Every request the edge cannot answer still pays the full crossing, so the fraction that crosses is (1 − cacheable share × hit rate). While that fraction is above 5%, your p95 sits on the far side of the ocean and improving the hit rate barely moves it; once it drops below 5%, p95 falls off a cliff to the local number. Tail metrics reward you only when the slow population becomes smaller than the percentile you report.",
        "What the model idealizes: the edge here is a single component that is treated as present in the caller's own region, with one hit rate and infinite fan-out, and writes simply pay the crossing. Real CDNs are hierarchies of POPs with their own misses, per-object TTLs, purge lag, and origin-shield tiers; and the honest remaining problem — writes, and any read that must be strongly consistent — still crosses. That is what the next lesson is about.",
      ],
      hints: [
        "Split the latency by where the request came from. Compare the near cohort with the far cohort before you change anything.",
        "Work out what fraction of requests still has to reach the origin, and compare that fraction with the percentile the objective is measured at. That comparison tells you how good the edge has to be.",
        "Terminate the request in the user's own region for everything that can be cached, and accept that writes and misses still make the crossing.",
      ],
      objectives: [
        objective("p95", "lte", 75),
        objective("throughput", "gte", 380),
        objective("errorRate", "lte", 0.01),
        budget(27),
      ],
      architecture: farStarter,
      reference: farReference,
      workload: workload({
        requestRate: 400,
        readRatio: 0.97,
        duration: 30,
        seed: 901,
        regions: [{ name: "us-east", share: 0.5 }, { name: "eu-west", share: 0.5 }],
        crossRegionLatencyMs: 100,
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache", "cdn"],
      estimation: estimate("p95", "cost"),
      defense: defense({
        followUps: [
          "The product team adds a personalized banner to every catalog page, so responses can no longer be shared between users. What happens to your p95, and what do you propose?",
          "The write share triples because the app now records a view event on every page load. Where does that land, and what would you change?",
          "How would you detect from production telemetry that the edge hit rate has quietly regressed, before customers tell you?",
        ],
        rubric: rubric([
          ["diagnosis", "Names geography, not capacity, as the cause and cites the near-versus-far latency split with numbers", 25],
          ["arith", "Computes the share of requests that still cross the ocean and relates it to the percentile being measured", 30],
          ["mechanism", "Explains that an edge terminates the request in the caller's region and that cacheability, not edge capacity, is the lever", 20],
          ["alt", "States a rejected alternative (bigger origin, more replicas) and why it cannot move a network-bound tail", 15],
          ["risk", "Names what still crosses — writes, misses, consistent reads — and a way to detect a hit-rate regression", 10],
        ]),
        modelAnswer:
          "Nothing was overloaded: the API sat around 80% and the database near 25%, yet the eu-west cohort was paying a 100 ms crossing on every single request. With half of traffic far away, 50% of requests were slow, so the global p95 was pinned above the cross-region floor at about 152 ms. Adding capacity cannot fix a network-bound tail, so I put an edge in each region in front of the balancer and pushed the cacheable share up to 95%. Reads are 97% of traffic, so the fraction that still crosses is 1 − 0.97 x 0.95, about 8% of the far cohort — roughly 4% of all requests, which is below the 5% the p95 reports, and that is exactly why p95 collapses from 152 ms to about 56 ms. Cost goes from 19 to 24 credits, inside the 27-credit cap, and the origin's utilization drops to single digits. What still crosses is every write and every miss, so the honest next step is a regional read path, not a better edge.",
      }),
      reflection: {
        question: "You raise the edge hit rate from 70% to 90% and p95 barely moves. What is the most likely explanation?",
        options: [
          "The edge is saturated, so the extra hits are queueing behind its capacity limit.",
          "More than 5% of requests still cross to the origin, so the 95th percentile is still drawn from the far-away population.",
          "Cache hits are not counted in the latency percentiles, so improving them cannot change p95.",
          "The origin got slower because it now receives only misses, which are more expensive than hits.",
        ],
        answer: 1,
        explanation:
          "A percentile only improves once the slow population shrinks below it. At a 90% hit rate on a workload that is half far-away and 97% reads, roughly 6-7% of the far cohort still crosses; while that stays above 5% of all traffic, p95 keeps reporting the transatlantic number. Push the crossing share under the percentile you report and the metric falls off a cliff.",
      },
    }),

    lesson({
      id: "active-active",
      chapter: chapterTitles[8],
      title: "Active-active, single leader",
      subtitle: "Serve reads where the user is; let the writes travel.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Regional stacks & write locality",
      brief:
        "You now run app servers in both us-east and eu-west, with geo routing sending each user to their own region, and each stack has its own cache. The database is still a single leader in us-east, because the product needs one authoritative copy of inventory. Traffic is 400 requests per second split evenly between the regions, 95% reads, and the European p95 is still about 150 ms. The servers are barely warm.",
      learning: [
        "Deploying servers in a region is not the same as serving requests there. The request only stays local if every hop it needs is local; the moment one dependency lives across the ocean, the whole request pays the crossing regardless of where the application replica ran. In the starter, an EU request reaches an EU app server in a couple of milliseconds and then makes a transatlantic call for its data, which is why the p95 is indistinguishable from having no EU stack at all.",
        "So the design question is not 'where do my servers run' but 'what fraction of requests can be completed without leaving the region'. Count it explicitly. With 95% reads, an edge hit rate of 90% and a regional cache hit rate of 90% behind it, the requests that must cross are the writes (5%) plus the reads that miss both layers (95% × 10% × 10%, about 1%) — roughly 6% of the far region, or 3% of all traffic. That is below the 5% the p95 reports, so the tail becomes a local number.",
        "Layering matters because each layer catches a different miss. The edge answers what is shareable between users and needs no application logic; the regional cache answers what is user- or query-specific but still repeatable, and it sits close enough to the app that a hit costs a couple of milliseconds. Behind both, the leader is doing what only a leader can do — accepting writes and serving the handful of reads that must be authoritative — which is also why its utilization falls to single digits and it can be provisioned smaller.",
        "Single-leader active-active is a deliberate consistency choice, not a compromise you failed to avoid. One leader gives you a total order for writes and no conflict resolution to design, at the price of a cross-region round trip on every write and a hard dependency on the leader's region. Multi-leader or leader-per-region removes that latency and introduces conflicts you must resolve — last-writer-wins, CRDTs, or application merge — which for inventory or payments is usually a worse trade than a slow write.",
        "What the model idealizes: routing here is perfect (each user reaches their own region's entry point), the caches never serve a value the leader has since changed within the window we measure, and the crossing is a fixed delay rather than a distribution with occasional multi-second tails. In production you also have to decide what happens to a European write when the transatlantic path is degraded but not down, and whether a read that just followed a write may be served from the regional cache at all — read-your-writes across regions is its own design problem.",
      ],
      hints: [
        "Trace one request from the far region step by step and note which hop leaves the region. The application server being local is not enough on its own.",
        "Write down the fraction of requests that can be answered without crossing: reads served at the edge, plus reads served by the regional cache, and count what is left over.",
        "Add a layer that terminates cacheable reads in the caller's own region, and once the origin stops seeing most of the traffic, take the savings out of the application tier.",
      ],
      objectives: [
        objective("p95", "lte", 80),
        objective("throughput", "gte", 380),
        objective("errorRate", "lte", 0.01),
        budget(39),
      ],
      architecture: activeStarter,
      reference: activeReference,
      workload: workload({
        requestRate: 400,
        readRatio: 0.95,
        duration: 30,
        seed: 902,
        regions: [{ name: "us-east", share: 0.5 }, { name: "eu-west", share: 0.5 }],
        crossRegionLatencyMs: 100,
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache", "cdn"],
      estimation: estimate("p95", "dbLoad", "cost"),
      defense: defense({
        followUps: [
          "The product now needs read-your-writes: a European user who updates their profile must see the change immediately. What breaks, and what do you do about it?",
          "Someone proposes a second leader in eu-west so writes are local too. Argue both sides and tell me what you would actually ship for an inventory system.",
          "The transatlantic link degrades to 400 ms without dropping. Which of your users notice, and what does your on-call see first?",
        ],
        rubric: rubric([
          ["locality", "Explains that a request is local only if every hop is local, and identifies the dependency hop as the crossing", 25],
          ["arith", "Computes the share of requests that still cross, layer by layer, and compares it with the reported percentile", 30],
          ["consistency", "Justifies keeping a single leader and names the conflict-resolution cost of the multi-leader alternative", 20],
          ["cost", "Notes that offloading the origin lets the application and database tiers shrink, with a number", 15],
          ["risk", "Names a remaining failure mode: cross-region read-your-writes, stale regional caches, or leader-region dependency", 10],
        ]),
        modelAnswer:
          "The EU stack was local for the application hop and remote for the one that mattered: every EU request called the us-east leader, so 50% of traffic paid 100 ms and the global p95 was about 152 ms. I added an edge in each region ahead of the balancer so cacheable reads terminate locally, leaving the regional cache to catch what the edge cannot share. Counting the crossings: writes are 5%, edge misses are 95% x 10%, and of those the regional cache misses 10%, so roughly 6% of EU traffic still crosses — about 3% of all requests, under the 5% that p95 reports, and p95 drops to about 57 ms. Because the origin now sees under a tenth of the load I cut each application tier from 250 to 150 per replica, which brings cost to about 33 credits, below both the cap and the starter. I kept one leader on purpose: inventory needs a single order for writes, and a second leader would buy local write latency at the price of conflict resolution I do not want to own.",
      }),
      reflection: {
        question: "Both regions now serve reads locally. A European user updates their shipping address and immediately reloads the page, still seeing the old one. What is the correct reading of this?",
        options: [
          "The edge and the regional cache are broken and should be bypassed for all authenticated traffic.",
          "It is the expected consequence of serving reads from a copy: the write went to the leader, and the local copies have not been invalidated or expired yet.",
          "The write was lost, because writes from the far region are not durable until the leader's region acknowledges them twice.",
          "The load balancer sent the read to the other region, where replication has not arrived.",
        ],
        answer: 1,
        explanation:
          "Serving reads from a local copy is exactly what bought the latency, and staleness is its price. The design answer is not to abandon the copies but to scope them: bypass or invalidate the cache for the small set of read-your-writes paths — the user's own profile after a write — and leave the shareable catalog reads at the edge where they belong.",
      },
    }),

    lesson({
      id: "region-outage",
      chapter: chapterTitles[8],
      title: "Lose a region",
      subtitle: "Failover is only real if the survivor can carry the load.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Regional failover & standby capacity",
      brief:
        "You run two independent regional stacks — balancer, app tier, cache and database in each — with traffic split evenly and geo routing in front. Halfway through the run us-east disappears for ten seconds: every replica of every component there goes dark at once. Routing does its job and sends the American half of the traffic to eu-west. The eu-west stack was sized for its own half.",
      learning: [
        "Failover has two halves and teams routinely build only one. The routing half — noticing the region is gone and sending traffic elsewhere — is the visible part, and it works here: the traffic source finds no live entry point in us-east and switches to eu-west within the same request. The capacity half is the part that decides whether failover is a blip or a second outage: the survivor is now receiving 100% of the traffic on a stack provisioned for 50%, and a queue fed at twice its service rate collapses in seconds.",
        "That is the N+1 argument, in the form regions take. If you run two regions and want to survive losing either, each must be able to carry the whole load, which means each runs at about half utilization in normal times — you are buying a full spare. Three regions is the cheaper shape for the same guarantee: each carries a third normally and half during a failure, so you only over-provision by 50% instead of 100%. This is why serious multi-region designs are usually three or more, and why 'active-passive' with a cold standby is a very different promise from active-active.",
        "Expect a small, unavoidable error spike at the moment of failure. Requests already in flight inside the dead region — being served, or waiting in a queue — have nowhere to go and fail. That population is roughly the arrival rate multiplied by the in-region latency, so a fast system loses less. It is why an error budget stated as a percentage over a window is a more useful SLO than 'zero errors': the design goal is that the failure costs a fraction of a second of traffic, not that it costs none.",
        "Latency degrades during the failover and that is the correct outcome. American requests are now crossing to eu-west, so they pay the cross-region delay on the way in; the p95 for the run rises even though nothing is overloaded. Deciding in advance which SLO you break during a regional failure — latency, not availability — is the substance of a disaster-recovery plan, along with the two numbers that go with it: how much data you can lose (RPO) and how long the degraded mode may last (RTO).",
        "What the model idealizes: routing is instantaneous and perfect, the two regional databases are independent so there is no failover of a leader and no replication to catch up, and the region returns whole with empty queues. Real regional failure is messier — DNS and connection pools take tens of seconds to move, a shared leader means a promotion with a real RPO, and coming back involves resynchronizing data and re-warming caches, which is often when the second incident happens.",
      ],
      hints: [
        "Run the baseline and watch the surviving region's utilization and queue depth from the moment the outage starts, not the averages over the whole run.",
        "Work out the load the survivor must absorb during the failure rather than in steady state, then size its application and storage tiers for that number with the usual headroom.",
        "Give the surviving region enough capacity to carry everyone, and accept that the redirected users pay a network crossing while the failure lasts.",
      ],
      objectives: [
        objective("p95", "lte", 170),
        objective("errorRate", "lte", 0.03),
        objective("throughput", "gte", 380),
        budget(44),
      ],
      architecture: outageStarter,
      reference: outageReference,
      workload: workload({
        requestRate: 400,
        readRatio: 0.9,
        duration: 30,
        seed: 903,
        regions: [{ name: "us-east", share: 0.5 }, { name: "eu-west", share: 0.5 }],
        crossRegionLatencyMs: 90,
        failures: [{ kind: "region", region: "us-east", at: 0.5, duration: 10 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache", "cdn", "rate-limiter"],
      estimation: estimate("bottleneckCapacity", "p95", "throughput"),
      defense: defense({
        followUps: [
          "Finance asks why you are paying for a stack that runs at half utilization all year. Make the case, and tell me what a three-region layout would change.",
          "The region comes back after ten seconds. Walk me through the next thirty seconds — what do you do about routing, caches and queues, and what could go wrong?",
          "Suppose the two regions shared one leader database in us-east instead of having their own. How does this incident play out differently?",
        ],
        rubric: rubric([
          ["capacity", "States that the survivor must carry the full load, with the number, and sizes its tiers accordingly", 30],
          ["diagnosis", "Reads the failure window rather than run averages, and names the saturated tier in the starter", 20],
          ["tradeoff", "Quantifies the standby cost of two regions and contrasts it with a three-region layout", 20],
          ["errors", "Explains the unavoidable in-flight error spike and expresses the goal as an error budget rather than zero", 15],
          ["risk", "Names a remaining risk: failback and cache re-warming, routing delay, or a shared leader's RPO", 15],
        ]),
        modelAnswer:
          "Routing already worked — the traffic source found no live entry point in us-east and moved everyone to eu-west — so the failure was purely a capacity one. During the outage the surviving stack sees the whole 400 requests per second instead of its usual 200, and the starter's EU tier was one replica at 150 with a 120-capacity database, so it ran at 100%, the queue grew past 1,900 and roughly 41% of requests died on the deadline. I sized eu-west for the failure case instead of the normal case: two replicas at 250 gives 500 nominal, about 80% at the failover peak, and the EU database went to 200, which the 90% cache hit rate keeps near a quarter utilized. That leaves p95 at about 120 ms — the redirected Americans pay the 90 ms crossing, which is the SLO I chose to break — with an error rate near 0.1% from in-flight requests only. The bill is a permanent 50% spare in each region; three regions would cut that over-provisioning to 50% instead of 100%.",
      }),
      reflection: {
        question: "During the outage the surviving region's error rate is near zero but its p95 nearly doubles. How should this be reported to the business?",
        options: [
          "As an outage, because any change in p95 during a failure means the failover did not work.",
          "As a successful failover with a planned latency degradation: availability was preserved and the redirected users pay a network crossing until the region returns.",
          "As a monitoring bug, since a healthy region cannot have a higher p95 than it did before the failure.",
          "As a capacity failure, because a correctly sized region shows no latency change at all during failover.",
        ],
        answer: 1,
        explanation:
          "Failover trades latency for availability on purpose. Half your users are now several thousand kilometres from the stack serving them, so their requests are slower by the speed of light and nothing in your control changes that. The design decision worth stating in advance is which SLO you are willing to break during a regional loss — and the honest answer is latency, not availability.",
      },
    }),
  ],
};
