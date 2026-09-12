import {
  allKinds,
  budget,
  chapterTitles,
  defense,
  estimate,
  graph,
  healthy,
  lesson,
  node,
  objective,
  queueDepth,
  rejected,
  rubric,
  tweak,
  workload,
  type ChapterFile,
} from "../shared";

// ---------------------------------------------------------------- lose-a-server

const loseStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { healthCheckMs: 2000 }),
    node("server", "api", 2, { label: "Checkout API", capacity: 200, replicas: 2 }),
    node("database", "db", 3, { label: "Orders database", capacity: 500 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const loseReference = tweak(loseStarter, { balancer: { healthCheckMs: 250 }, api: { capacity: 250, replicas: 3 } });

// ---------------------------------------------------------------- protect-the-database

const protectStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { healthCheckMs: 500 }),
    node("server", "api", 2, { label: "Ledger API", capacity: 300, replicas: 2 }),
    node("database", "db", 3, { label: "Ledger database", capacity: 300, replicas: 1, dbMode: "leader-follower", replicationLagMs: 200, failoverMs: 3000 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const protectReference = tweak(protectStarter, { db: { capacity: 260, replicas: 4, failoverMs: 700 } });

// ---------------------------------------------------------------- detection-delay

const detectionStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { healthCheckMs: 8000 }),
    node("server", "api", 2, { label: "Search API", capacity: 200, replicas: 4 }),
    node("database", "db", 3, { label: "Index store", capacity: 800 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const detectionReference = tweak(detectionStarter, { balancer: { healthCheckMs: 300 } });

// ---------------------------------------------------------------- retry-storm

const retryStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Profile API", capacity: 300, replicas: 3, timeoutMs: 200, retries: 3, retryBackoffMs: 50 }),
    node("cache", "cache", 3, { label: "Profile cache", cacheHitRate: 0.85 }),
    node("database", "db", 4, { label: "Profile store", capacity: 150 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);
const retryReference = tweak(retryStarter, { api: { timeoutMs: 1200, retries: 1 }, db: { capacity: 500 } });

// ---------------------------------------------------------------- circuit-breaker

const breakerStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Payments API", capacity: 200, replicas: 3, timeoutMs: 120, retries: 2, retryBackoffMs: 30 }),
    node("database", "db", 3, { label: "Payments database", capacity: 700 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const breakerReference = tweak(breakerStarter, { api: { circuitBreaker: true } });

// ---------------------------------------------------------------- cascading-failure

const cascadeStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "gateway", 2, { label: "API gateway", capacity: 600, replicas: 2 }),
    node("server", "users", 3, { label: "User service", capacity: 500 }, -1),
    node("server", "catalog", 3, { label: "Catalog service", capacity: 500 }),
    node("server", "pricing", 3, { label: "Pricing service", capacity: 500 }, 1),
    node("database", "users-db", 4, { label: "Users store", capacity: 500 }, -1),
    node("database", "catalog-db", 4, { label: "Catalog store", capacity: 500 }),
    node("database", "pricing-db", 4, { label: "Pricing store", capacity: 500 }, 1),
  ],
  [
    ["traffic", "balancer"], ["balancer", "gateway"],
    ["gateway", "users"], ["gateway", "catalog"], ["gateway", "pricing"],
    ["users", "users-db"], ["catalog", "catalog-db"], ["pricing", "pricing-db"],
  ],
);
const cascadeReference = tweak(cascadeStarter, { pricing: { timeoutMs: 120, retries: 2, retryBackoffMs: 20, circuitBreaker: true } });

// ---------------------------------------------------------------- launch-day

const launchStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { healthCheckMs: 6000 }),
    node("server", "api", 2, { label: "Storefront API", capacity: 250, replicas: 2 }),
    node("cache", "cache", 3, { label: "Product cache", cacheHitRate: 0.6 }),
    node("database", "db", 4, { label: "Product database", capacity: 250 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);
const launchReference = tweak(launchStarter, {
  balancer: { healthCheckMs: 300 },
  api: { capacity: 300, replicas: 4 },
  cache: { cacheHitRate: 0.85 },
  db: { capacity: 400 },
});

export const chapter: ChapterFile = {
  title: chapterTitles[4],
  lessons: [
    lesson({
      id: "lose-a-server",
      chapter: chapterTitles[4],
      title: "Lose a server",
      subtitle: "Survive a replica dying without dropping the checkout.",
      difficulty: "Intermediate",
      minutes: 14,
      concept: "Redundancy and detection windows",
      brief:
        "Your checkout service runs two application replicas behind a load balancer and takes 300 requests per second all day. Halfway through this run one replica dies and never comes back. The balancer re-checks endpoint health every two seconds, so for a while it keeps sending a share of traffic to a machine that is already gone. Keep the checkout healthy through the failure.",
      learning: [
        "Redundancy is a capacity statement, not a checkbox. If N replicas are enough to carry peak traffic, then losing one leaves N-1 to carry the same peak. A pair sized to run at three quarters of its limit becomes a single replica at one and a half times its limit the moment one dies: the queue grows without bound, latency climbs until requests hit their deadline, and the outage looks like a latency problem rather than a hardware problem. This is why production capacity plans are written as N+1 or N+2 and why teams keep steady-state utilization near half of capacity rather than near the limit.",
        "The second half of the problem is detection. A load balancer does not know a machine is dead; it finds out at the next health check. Between the moment of death and the next probe, the balancer keeps offering that endpoint its normal share of traffic, and every one of those requests fails fast against a machine that is not answering. With R replicas and a check interval of I, an outage costs you roughly rate x I / R failed requests before routing corrects itself. Shrinking the interval shrinks the blast radius linearly.",
        "Real balancers add a second knob this model leaves out: an unhealthy threshold, the number of consecutive failed probes before an endpoint is ejected. AWS Application Load Balancers default to a 30-second interval with a threshold of 2, which is a detection window of a minute; Envoy deployments usually run active checks every few seconds and pair them with passive outlier detection that ejects a host after consecutive 5xx responses. The engine here models a single interval with instant, perfectly accurate probes, so it flatters aggressive settings: it charges you nothing for probe traffic and never flaps a healthy host out of rotation.",
        "The model also idealizes recovery. A replica that dies here dies cleanly and its in-flight work fails immediately. In production, a half-dead machine that accepts connections and answers slowly is far more damaging than one that is off, because health checks that only test 'does the port open' keep it in rotation. Health checks should exercise the same dependencies the request path uses, and should be cheap enough to run often.",
      ],
      hints: [
        "Run the baseline and watch the per-replica panel: note which replica stops processing at the failure and what the survivor's utilization does immediately afterwards.",
        "Size the application tier for the traffic it must carry after the loss, not before it: divide the request rate by the number of replicas that are still alive once one is gone, and give each replica room above that.",
        "Then shorten the balancer's health-check interval so the window in which traffic is still offered to a dead endpoint is a fraction of what it was.",
      ],
      objectives: [...healthy(285, 150), queueDepth(80)],
      architecture: loseStarter,
      reference: loseReference,
      workload: workload({ requestRate: 300, readRatio: 0.9, duration: 30, seed: 4201, failures: [{ kind: "server", at: 0.5 }] }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      requiredBalancedReplicas: 3,
      estimation: estimate("bottleneckCapacity", "p95", "throughput"),
      defense: defense({
        followUps: [
          "The failure happens during your traffic peak instead of at an average moment. Does your design still hold, and what is the first metric that moves?",
          "Your team asks you to cut the health-check interval by another factor of ten. What does that buy you and what does it cost?",
          "How would you know, at three in the morning, that this failure happened at all if the objectives were still met?",
        ],
        rubric: rubric([
          ["survivors", "Sizes the application tier from surviving capacity: states the traffic each remaining replica must carry after one is lost", 30],
          ["detection", "Explains the detection window as interval times share of traffic, and quantifies the failed requests it produces", 25],
          ["alt", "States a rejected alternative (one bigger replica, or capacity without a shorter interval) and why it loses", 20],
          ["risk", "Names a residual failure mode: a half-dead replica passing shallow health checks, correlated failure, or probe overhead", 15],
          ["detect", "Says how they would observe this in production: per-endpoint error rate, healthy-host count, or an ejection event", 10],
        ]),
        modelAnswer:
          "The baseline runs two replicas at 200 requests per second each against 300 offered, so each sits near 75% before anything breaks. When one dies the survivor is offered the full 300 against a limit of 200: 150% utilization, an unbounded queue, and requests that die on the five-second deadline. I sized the tier from the survivors instead: three replicas at 250 each is 750 total and 500 after the loss, which carries 300 at 60%. That is the N+1 rule with real headroom rather than a spare that only exists on paper. The second change is the detection window. At a two-second interval with two endpoints, the balancer keeps offering a dead one half of the traffic for up to two seconds, which is roughly 300 x 2 / 2 = 300 failed requests on top of the overload. At a quarter-second interval across three endpoints the same arithmetic gives at most 300 x 0.25 / 3 = 25, and measured it is under a dozen. I rejected one larger replica, because a single machine has no survivor at all, and I rejected extra capacity alone, because it does nothing about the requests already routed into a hole.",
      }),
      reflection: {
        question: "Two replicas each run at 70% utilization. One fails. What happens to the survivor?",
        options: [
          "It runs at 70% still, because utilization is a per-replica property",
          "It is offered 140% of what it can serve, so its queue grows until requests hit their deadline",
          "It runs at 100% and sheds the excess automatically",
          "The load balancer holds the excess traffic until the failed replica returns",
        ],
        answer: 1,
        explanation:
          "Utilization is offered work divided by capacity. Losing half the capacity while the offered work is unchanged doubles the ratio: 70% becomes 140%. Nothing sheds the excess unless you configure a bound or a limiter, so the queue grows and latency climbs until the request deadline starts failing requests.",
      },
    }),

    lesson({
      id: "protect-the-database",
      chapter: chapterTitles[4],
      title: "Protect the database",
      subtitle: "A read replica is not a write plan.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Leader failover",
      brief:
        "A ledger service takes 320 requests per second, 15% of them writes, against a leader-follower database that currently has exactly one instance: the leader. Four tenths of the way through the run that instance dies. The configured failover time is three seconds. Rebuild the storage tier so a dead leader is an inconvenience rather than an outage.",
      learning: [
        "In a leader-follower database every write goes to exactly one machine. Adding followers multiplies read capacity and gives you somewhere to fail over to, but it does not make writes highly available on its own: the moment the leader is gone, writes have nowhere to land until a new leader exists. This is why 'we have three replicas' is not an answer to 'what happens when the primary dies'. The answer is a promotion procedure and the time it takes.",
        "Failover time is the real availability number. During the promotion window every write fails, so the write error budget you burn is roughly write rate x failover seconds. At 15% writes on 320 requests per second, a three-second promotion costs about 145 failed writes; a 700-millisecond promotion costs about 34. Managed systems land in a wide range: Postgres with Patroni or RDS Multi-AZ typically promotes in tens of seconds, while consensus-backed stores with a pre-elected quorum can cut over in under a second. You buy shorter windows with faster failure detection and a standby that is already caught up, and you pay for them with the risk of promoting on a false alarm.",
        "There is also a capacity trap on the far side of the promotion. Before the failure, reads spread over every follower. Afterwards, one replica is dead and one of the survivors is busy being the new leader, so the remaining followers absorb all the reads. If you sized followers so that all of them together were barely enough, the promotion converts a storage failure into an overload. Size the follower pool for the post-failover shape, not the happy-path shape.",
        "This engine idealizes the hard parts on purpose. Promotion is instantaneous once the timer expires, a healthy follower is always caught up, and writes that were acknowledged but not yet replicated are simply not modelled. Real failover has to answer split-brain (two nodes both believing they are leader), lost unreplicated writes, and clients that cache a stale leader address. Read the consensus material before you claim a sub-second failover in an interview.",
      ],
      hints: [
        "Run the baseline and read the event log around the failure: notice which requests fail, and for how long, and separate reads from writes when you do.",
        "Work out the number of writes that land inside the promotion window: that is the write share of the traffic multiplied by the length of the window, and it is the error budget you are choosing to spend.",
        "Then size the follower pool for the state after promotion, when one replica is dead and one of the survivors has become the leader, and shorten the promotion window itself.",
      ],
      objectives: [...healthy(300, 160), budget(79)],
      architecture: protectStarter,
      reference: protectReference,
      workload: workload({ requestRate: 320, readRatio: 0.85, duration: 30, seed: 4202, failures: [{ kind: "database", at: 0.4 }] }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("dbLoad", "p95", "cost"),
      defense: defense({
        followUps: [
          "The product adds read-your-writes: a customer must see their own ledger entry immediately after posting it. What changes, and what does it cost the leader?",
          "Your promotion fires on a network blip while the old leader is still alive and accepting writes. What have you just done to the ledger, and how do you prevent it?",
          "Traffic grows ten times overnight. Which part of this design breaks first?",
        ],
        rubric: rubric([
          ["writes", "States that writes are single-homed on the leader and that followers do not make writes available", 25],
          ["arith", "Quantifies the outage as write rate multiplied by the promotion window, and reduces it deliberately", 30],
          ["postfailover", "Sizes the follower pool for the post-promotion state, where one replica is dead and one is the new leader", 25],
          ["alt", "States a rejected alternative (a single bigger database, or more followers without a shorter promotion) and why it loses", 10],
          ["risk", "Names a residual risk: split-brain, lost unreplicated writes, or stale leader addressing", 10],
        ]),
        modelAnswer:
          "The baseline has one instance in a leader-follower configuration, which means the leader is also the only replica. When it dies there is nothing to promote, so every read and every write fails for the remaining eighteen seconds of the run. I added followers and shortened the promotion window. With four replicas the leader takes the 48 writes per second and three followers share the 272 reads, about 91 each. After the failure one replica is gone and one survivor becomes the leader, so two followers carry all 272 reads, about 136 each: still comfortable at 260 capacity, which is why I sized from the post-promotion shape rather than the happy path. Shortening failover from three seconds to 700 milliseconds cuts the failed writes from roughly 48 x 3 = 145 to about 34, which is a tenth of a percent of the run. I rejected buying one much larger single-mode database: it is the most expensive capacity in the price list and it still has exactly one copy of the data.",
      }),
      reflection: {
        question: "A leader-follower database has three healthy followers. The leader dies. What is unavailable during the promotion window?",
        options: [
          "Nothing: the followers serve reads and writes",
          "Reads only, because followers are behind the leader",
          "Writes only, because they are single-homed on the leader until a new one is elected",
          "Everything, because the whole cluster restarts",
        ],
        answer: 2,
        explanation:
          "Followers can keep answering reads throughout, though possibly with stale data. Writes have exactly one destination, so they fail from the moment the leader dies until a follower is promoted. That window, multiplied by your write rate, is the outage you are budgeting for.",
      },
    }),

    lesson({
      id: "detection-delay",
      chapter: chapterTitles[4],
      title: "Detection delay",
      subtitle: "Failures cost what they cost until someone notices.",
      difficulty: "Intermediate",
      minutes: 12,
      concept: "Health-check intervals",
      brief:
        "A search service runs four replicas behind a load balancer and takes 420 requests per second. The capacity plan is sound: losing one replica still leaves plenty of room. The only problem is the balancer, which re-checks endpoint health every eight seconds. A replica dies a third of the way into the run. Bring the error rate inside the budget without buying a single extra machine.",
      learning: [
        "The failure in this lesson costs nothing in capacity: three of four replicas can carry the whole load. Every failed request comes from routing, not from overload. Between the instant a replica dies and the instant the balancer's next probe notices, the balancer keeps offering that endpoint its normal share of the traffic, and each of those requests fails against a machine that no longer answers. The cost is rate x interval / replicas, and none of it is visible in a utilization chart.",
        "That formula is the entire lesson, and it explains why detection intervals are measured in seconds rather than minutes in production. A load balancer that probes every 30 seconds with an unhealthy threshold of two is advertising a one-minute detection window; at a few thousand requests per second, that is tens of thousands of failed requests per incident. Halving the interval halves the bill, linearly, until you hit the floor set by the probe itself.",
        "There is a real cost on the other side, which this model does not charge you. Aggressive active checks are traffic: at a 100-millisecond interval, a fleet of a hundred balancers probing a hundred backends generates a hundred thousand requests per second of pure overhead. Aggressive checks also flap. A backend that is briefly slow because of a garbage-collection pause fails one probe, gets ejected, sheds its traffic onto its neighbours, and comes back a moment later, which is how a minor hiccup becomes an oscillation. Production systems buy back stability with a threshold of consecutive failures, with hysteresis on the way back in, and with passive outlier detection that ejects a host on real request errors rather than synthetic ones.",
        "The engine models an idealized probe: instantaneous, perfectly accurate, free, and applied to a binary alive flag. It therefore rewards the shortest interval you are willing to type, with no flapping and no probe load. Take the shape of the curve from this lesson, and take the floor from the reading: interval, threshold, and timeout together define the window, and the sane production range is a few hundred milliseconds to a few seconds.",
      ],
      hints: [
        "Run the baseline and compare the replica panel with the error timeline: the application tier is nowhere near its limit, so ask where the failures are actually being created.",
        "Estimate the failures as the request rate multiplied by the time the balancer keeps a dead endpoint in rotation, divided across the endpoints it is rotating over.",
        "Then change only the balancer's detection interval, and re-run to confirm the errors shrink in proportion.",
      ],
      objectives: [objective("errorRate", "lte", 0.01), objective("throughput", "gte", 400), objective("p95", "lte", 140)],
      architecture: detectionStarter,
      reference: detectionReference,
      workload: workload({ requestRate: 420, readRatio: 0.9, duration: 30, seed: 4203, failures: [{ kind: "server", at: 0.35 }] }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("throughput", "p95"),
      defense: defense({
        followUps: [
          "Someone proposes a 50-millisecond health-check interval across the whole fleet. Talk me through what that does to the backends and to stability.",
          "The replica does not die: it starts answering every request with a 500 after a bad deploy. Does your health check catch that, and how quickly?",
          "You cannot change the balancer at all. What else brings the error rate down during the detection window?",
        ],
        rubric: rubric([
          ["source", "Identifies routing to a dead endpoint, not overload, as the source of the errors, citing the utilization evidence", 30],
          ["arith", "Computes the detection cost as rate times interval divided by endpoints, and shows the reduction", 30],
          ["cost", "Names the real cost of aggressive checking: probe load, flapping, and the need for a consecutive-failure threshold", 25],
          ["alt", "States an alternative path (passive outlier detection, client retries, or a shorter unhealthy threshold) and its tradeoff", 15],
        ]),
        modelAnswer:
          "Nothing here is overloaded. Four replicas at 200 each carry 420 requests per second at just over half utilization, and three survivors still carry it at 70%. Every failed request is a request the balancer handed to a machine that had already died. With an eight-second interval the balancer can keep a quarter of the traffic pointed at that hole for most of an interval; here it is about seven seconds, roughly 420 x 7 / 4 = 735 requests, or six percent of a 12,600-request run, and the throughput target misses as well. Dropping the interval to 300 milliseconds gives at most 420 x 0.3 / 4 = about 32, and measured it is a handful: six hundredths of a percent. I changed nothing else, because adding capacity does not help a request that is being routed into a void. The tradeoff I would name in production is that this model gives me perfect, free probes. Real active checks cost backend traffic proportional to balancers times backends divided by interval, and an interval that short will eject a host on a single garbage-collection pause, so I would pair it with an unhealthy threshold of two or three consecutive failures and passive ejection on real errors.",
      }),
      reflection: {
        question: "A balancer probes eight backends every four seconds. One backend dies. Roughly what fraction of the run's requests fail, if the run is 40 seconds long?",
        options: [
          "About one in eight, because one of eight backends is dead",
          "About one in eighty: one eighth of the traffic, for up to four of the forty seconds",
          "None, because the balancer retries failed requests elsewhere",
          "All of them, because a dead backend fails the whole pool",
        ],
        answer: 1,
        explanation:
          "The dead backend only receives its share of the traffic, one eighth, and only until the next probe, at most four seconds out of forty. One eighth of one tenth is about 1.25% of requests. The size of the blast is the interval multiplied by the share, which is why interval is the knob that matters.",
      },
    }),

    lesson({
      id: "retry-storm",
      chapter: chapterTitles[4],
      title: "Retry storm",
      subtitle: "The client that tries harder makes the outage worse.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Timeouts, retries and amplification",
      brief:
        "A profile service takes 300 requests per second through a cache that absorbs most reads, so the store behind it normally sees about a quarter of the traffic. The API is configured with an impatient 200-millisecond dependency timeout and three retries. A third of the way into the run the store hits a six-second brownout and gets five times slower. Watch what the retry policy does to a slowdown, then fix it without buying your way out.",
      learning: [
        "A retry is a second copy of a request. When a dependency is failing because it is broken, retries cost you almost nothing extra; when it is failing because it is saturated, retries are the fastest way to make it worse. A timeout that fires while the dependency is merely slow abandons the call, but the work keeps running downstream and keeps consuming capacity: that is zombie work. The retry then adds a fresh copy on top of it. With three retries, one arriving request can turn into four concurrent units of work at the bottleneck, so a store that was at half utilization arrives at twice its limit through no change in real demand.",
        "The number to watch is amplification: dependency calls received divided by the requests its callers processed. At 1.0 nothing is duplicated. Above about 2 you are in a storm, and it is self-sustaining: the extra copies lengthen the queue, the longer queue trips more timeouts, and more timeouts create more copies. This is a positive feedback loop, and it is the reason outages keep going after the original trigger has passed.",
        "The fix has three parts, and you need all three. Set the timeout from the dependency's real latency distribution, not from a round number: a timeout below the dependency's own p99 converts normal tail latency into manufactured failures. Cap retries at one, with exponential backoff and full jitter so the copies do not arrive in a synchronized wave. And give the dependency enough headroom that a brownout of the size you expect does not push it past its limit in the first place. Production systems add a fourth part this engine does not model: a retry budget, where a client is allowed retries only up to a small percentage of its successful request volume, so a widespread failure cannot multiply load at all.",
        "This model idealizes a few things. The brownout is a clean multiplier on service time for a fixed window, retries are per dependency call rather than per user request, and there is no connection pool to exhaust. In production, retries also chew through file descriptors, thread pools and connection limits, and the first symptom is often a caller falling over rather than the callee.",
      ],
      hints: [
        "Run the baseline and read the amplification figure and the store's queue depth during the brownout, then compare the store's calls received against the requests the API processed.",
        "Work out how many copies of one request can exist at the store at once under the current policy, and multiply the store's normal load by that number to see what it is actually being asked to serve.",
        "Then set the timeout above the dependency's own tail latency rather than below it, cut the retry count to the smallest number that still helps, and give the store enough spare service capacity to absorb the brownout, staying inside the budget.",
      ],
      objectives: [...healthy(285, 200), queueDepth(140), budget(44)],
      architecture: retryStarter,
      reference: retryReference,
      workload: workload({
        requestRate: 300,
        readRatio: 0.9,
        duration: 30,
        seed: 4204,
        failures: [{ kind: "slow-database", at: 0.35, duration: 6, factor: 5 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("dbLoad", "p95", "cost"),
      defense: defense({
        followUps: [
          "The store's brownout lasts sixty seconds instead of six. Does your design still hold, and what is the first thing that gives?",
          "Every client of this API also retries three times, and you cannot change them. What do you do at your edge?",
          "How would you detect a retry storm in production before customers do? Name the specific signal.",
        ],
        rubric: rubric([
          ["amplification", "Names amplification with its measured value and explains it as timeout-driven duplicate work plus zombie work", 30],
          ["arith", "Computes the store's real load: base load multiplied by the number of concurrent copies one request can create", 25],
          ["policy", "Sets the timeout from the dependency's latency distribution and justifies the retry count and jitter", 20],
          ["alt", "States a rejected alternative (buying a much larger store, or removing retries entirely) and why it loses on cost or on transient faults", 15],
          ["detect", "Names an observable signal: calls-received versus requests-served ratio, retry counters, or backlog growth after recovery", 10],
        ]),
        modelAnswer:
          "The cache absorbs most reads, so the store normally sees the writes plus the misses: 30 plus 270 x 0.15, about 70 requests per second against 150 of capacity, or roughly half. The brownout multiplies service time by five, so effective capacity falls to about 30 and the store is at more than twice its limit. That is survivable for six seconds. What is not survivable is the retry policy: a 200-millisecond timeout fires long before a slowed call returns, and with three retries each arriving request can put four copies at the store while the abandoned copies keep running. Amplification climbs past two, the queue explodes, and requests die on the deadline. I raised the timeout well above the dependency's tail, cut retries to one with jittered backoff, and gave the store enough headroom that five times slower still leaves it under three quarters utilized. I rejected simply buying a much larger store: at this price curve database capacity is the most expensive thing on the canvas and it breaks the budget, and it would not stop the amplification next time.",
      }),
      reflection: {
        question: "A dependency slows down but does not fail. The caller has a timeout below the dependency's p99 and three retries. What is the immediate effect on the dependency?",
        options: [
          "It sees less load, because timed-out callers give up",
          "It sees the same load, because the retries replace the abandoned calls",
          "It sees several times its normal load, because abandoned work keeps running while retries add fresh copies",
          "Nothing changes until the timeout is longer than the dependency's p50",
        ],
        answer: 2,
        explanation:
          "Abandoning a call does not cancel the work downstream. The original request keeps occupying the dependency while the retry queues a new one behind it, so a slowdown becomes a multiplier on load. That is the feedback loop that turns a brownout into an outage.",
      },
    }),

    lesson({
      id: "circuit-breaker",
      chapter: chapterTitles[4],
      title: "Circuit breaker",
      subtitle: "Fail fast so the rest of the system stays alive.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Failing fast under a brownout",
      brief:
        "A payments API takes 200 requests per second with a peak in the middle of the run, and it already has a dependency timeout and a couple of retries. Late in the run the payments database enters a brownout and becomes ten times slower for four seconds. Every call now times out, the API keeps queueing new work behind calls it has already abandoned, and one request in sixteen fails outright across the whole run. Add the one mechanism that turns a slow dependency into a quick, honest failure.",
      learning: [
        "A timeout protects the individual request. It does not protect the system, because the caller happily starts another doomed call the moment the last one is abandoned. During a dependency brownout that means the caller keeps paying full latency for every request, keeps holding resources for the duration of every timeout, and keeps feeding zombie work to a dependency that is already underwater. The caller's own latency distribution collapses even though the caller is not the thing that broke.",
        "A circuit breaker is a state machine over recent dependency outcomes. Closed is normal. When the recent failure ratio crosses a threshold over a minimum sample, it opens: subsequent calls are not attempted at all and fail immediately, which is a rejection rather than an error, because you chose it. After a cool-down it goes half-open and lets a single probe through; success closes it, failure re-opens it. In this engine the breaker judges the last second of dependency calls and needs at least twenty of them with at least half failing, then opens for five seconds.",
        "Failing fast changes the arithmetic in three places. Requests that would have waited for a timeout return in milliseconds, so the caller's queues stay shallow and its latency for anything it can still serve stays normal. The dependency stops receiving new work, which is the only thing that lets an overloaded store drain and recover. And the failure becomes explicit and cheap to attribute, instead of a slow smear across every percentile. The price is that during the open window you are deliberately turning away work that might have succeeded, which is why breakers pair with fallbacks: a cached answer, a degraded response, or a queued retry for later.",
        "The model idealizes the granularity. Here the breaker is per calling server and covers all of its dependencies, so opening it sheds every request that server would have made. Real implementations key the breaker per dependency, per endpoint, and often per shard or per host, so that one bad backend does not take out unrelated calls. They also distinguish failure types: a breaker should open on timeouts and 5xx responses, not on a client's own 4xx. Bulkheads, which cap concurrent calls per dependency, are the complementary pattern and are frequently more useful than the breaker itself.",
      ],
      hints: [
        "Run the baseline and step through the samples during the brownout: watch the queue depth and the completed count, and note that the timeout is firing on almost every call.",
        "Separate the two costs of a doomed call: the resources it holds while it waits, and the fresh work it hands the struggling dependency. Ask which one a timeout alone actually removes.",
        "Then enable the mechanism on the API that stops attempting calls once a recent window of them has failed, so those requests are refused immediately instead of queued.",
      ],
      objectives: [
        objective("p95", "lte", 150),
        objective("errorRate", "lte", 0.01),
        rejected(0.2),
        objective("throughput", "gte", 215),
      ],
      architecture: breakerStarter,
      reference: breakerReference,
      workload: workload({
        requestRate: 200,
        readRatio: 0.9,
        duration: 50,
        pattern: "spike",
        seed: 4205,
        failures: [{ kind: "slow-database", at: 0.72, duration: 4, factor: 10 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("p95", "throughput"),
      defense: defense({
        followUps: [
          "The brownout lasts ten minutes instead of four seconds. Describe what your design does for the whole ten minutes, second by second at the boundaries.",
          "A customer complains that their payment was refused while the database was actually fine. How could your breaker have done that, and how do you reduce the chance?",
          "The breaker in this model covers every dependency of the server. Why is that wrong, and what would you build instead?",
        ],
        rubric: rubric([
          ["mechanism", "Describes the breaker as a closed/open/half-open state machine over a recent window of dependency outcomes", 25],
          ["arith", "Quantifies the tradeoff: the share of requests refused during the open window against the latency and error rate avoided", 30],
          ["protect", "Explains that failing fast protects the dependency as well as the caller, by letting an overloaded store drain", 20],
          ["alt", "States a rejected alternative (timeout alone, more retries, or more capacity) and why it does not stop the collapse", 15],
          ["risk", "Names a residual risk: false opens, coarse granularity, or the need for a fallback response", 10],
        ]),
        modelAnswer:
          "The baseline already has a timeout and two retries, and it still fails a request in sixteen, because a timeout only bounds one request. When the database goes ten times slower its effective capacity drops below the offered load, every call times out, and the API starts another one immediately: the queue grows, latency for everything goes to the deadline, and the store never gets a chance to drain. Enabling the breaker changes the shape of the failure. After roughly half a second of mostly-failing calls it opens, and for the next five seconds calls are refused in single-digit milliseconds instead of waiting out a timeout. The open window costs about five seconds of a fifty-second run, which lands near 8% of requests rejected, while the error rate falls from over 6% to under 0.7% and p95 for everything that is served stays at its healthy value of about 54 milliseconds. Those rejections are a deliberate choice, not a fault. I rejected adding capacity, because the brownout is a multiplier and no plausible size survives ten times, and I rejected more retries, which is the opposite of the fix. In production I would pair the breaker with a per-dependency key and a fallback so the refusal is a degraded answer rather than nothing.",
      }),
      reflection: {
        question: "Why does an open circuit help the dependency, not just the caller?",
        options: [
          "It does not: the breaker is purely a client-side latency optimization",
          "Because no new work arrives, so the dependency's backlog can drain and it can recover",
          "Because the breaker forwards the calls to a replica instead",
          "Because rejected calls are retried later at a lower priority automatically",
        ],
        answer: 1,
        explanation:
          "An overloaded dependency cannot recover while work keeps arriving faster than it can serve it. Refusing calls at the caller is the only thing in this design that removes load, which is why failing fast is a protection mechanism for the callee and not merely a latency trick for the caller.",
      },
    }),

    lesson({
      id: "cascading-failure",
      chapter: chapterTitles[4],
      title: "Cascading failure",
      subtitle: "One slow dependency in a fan-out takes down everything.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Isolating a failing dependency",
      brief:
        "An API gateway answers 150 requests per second, with a peak in the middle of the run, by calling three services in parallel: users, catalog and pricing. A request is only complete when all three have answered. Late in the run the pricing store enters a brownout and gets ten times slower. Nothing else is broken, and yet every request in the system stalls. Contain the damage to the part that is actually failing.",
      learning: [
        "A parallel fan-out finishes at the slowest branch. That makes fan-out width a tail-latency multiplier in normal operation, and it makes any single degraded branch an outage for the whole endpoint during a failure. Three healthy services and one sick one is not three quarters of a working product; it is a product where every single request waits for the sick one. This is the structural reason a microservice architecture can have a worse availability number than the monolith it replaced: availability multiplies across required dependencies.",
        "Without a bound on the branch, the sick service's queue absorbs everything. Requests sit until the end-to-end deadline, the gateway holds them all open, and the failure spreads outward to callers who had nothing to do with pricing. Adding a timeout on the pricing call converts an unbounded stall into a bounded one, which is a real improvement, but on its own it just changes stalls into a wall of manufactured errors while the pricing store still receives every call. Pairing the timeout with a circuit breaker on the failing branch removes the load as well: after a short window of failures the branch stops being called at all and requests resolve immediately.",
        "Once the branch is isolated, the design question is what a request should do without it. In this engine every dependency is required, so shedding the pricing call sheds the request, which is why the objective here caps the rejected share rather than demanding zero. Real systems get the extra option: mark the dependency optional and degrade, serve a stale price from cache, or queue the work and answer asynchronously. Deciding in advance which dependencies are required and which are optional is the design work; the breaker is only the enforcement.",
        "Two idealizations to keep in mind. The engine's breaker is per calling server and covers all of that server's dependencies, so placing it on the pricing service rather than on the gateway is what keeps the isolation narrow; a breaker on the gateway would shed users and catalog traffic as well. And a server lane here is only occupied while it computes, so waiting on a slow dependency does not exhaust a thread pool the way it would in production, where the caller usually falls over before the callee does.",
      ],
      hints: [
        "Run the baseline and compare the three services in the component panel: one of them has a queue that grows without bound while the other two stay idle, and every request is waiting for it.",
        "Reason about what a parallel fan-out returns when one branch never answers, and how long the gateway holds a request before the end-to-end deadline gives up on it.",
        "Then bound the failing branch at its own service: give it a dependency timeout and let it stop calling a dependency that has just failed a whole window of calls, so requests resolve immediately instead of stalling.",
      ],
      objectives: [
        objective("p95", "lte", 150),
        objective("errorRate", "lte", 0.01),
        rejected(0.2),
        objective("throughput", "gte", 160),
      ],
      architecture: cascadeStarter,
      reference: cascadeReference,
      workload: workload({
        requestRate: 150,
        readRatio: 0.9,
        duration: 50,
        pattern: "spike",
        seed: 4206,
        failures: [{ kind: "slow-database", at: 0.72, duration: 4, factor: 10, target: "pricing-db" }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("p95", "throughput"),
      defense: defense({
        followUps: [
          "Pricing is genuinely required: you cannot show a product without a price. Does that change your answer, and what do you build instead of shedding?",
          "You put the breaker on the gateway instead of on the pricing service. Walk me through what users and catalog traffic experience.",
          "The fan-out grows from three services to eight. What happens to your normal-day p99, before any failure at all?",
        ],
        rubric: rubric([
          ["fanout", "Explains that a parallel fan-out finishes at the slowest branch and that required dependencies multiply availability", 25],
          ["isolate", "Bounds the failing branch with a timeout and stops calling it, and explains why the timeout alone is not enough", 30],
          ["placement", "Justifies where the breaker is placed and what the blast radius of that placement is", 20],
          ["degrade", "Discusses required versus optional dependencies and what a degraded response would look like", 15],
          ["detect", "Names how they would detect this in production: per-dependency latency, saturation of one branch, or breaker state", 10],
        ]),
        modelAnswer:
          "Every request needs all three branches, so the endpoint's latency is the maximum of the three and its availability is the product of the three. When the pricing store goes ten times slower its effective capacity drops well below the 150 requests per second it is being offered, its queue grows without bound, and because the gateway waits for all branches, every request in the system stalls until the five-second deadline kills it. Users and catalog stay idle the whole time, which is the tell. I bounded the pricing branch at the pricing service: a timeout below the deadline stops the unbounded wait, and a circuit breaker stops the calls entirely once a window of them has failed, which both resolves requests in milliseconds and lets the pricing store drain. The open window refuses about five seconds of traffic, roughly 8% of requests, while the error rate stays under a percent and p95 for served requests falls from about a second to 67 milliseconds. I deliberately did not put the breaker on the gateway: that would shed users and catalog traffic too. The real production follow-up is to make pricing optional with a cached fallback so the refusal becomes a degraded answer.",
      }),
      reflection: {
        question: "A gateway calls four services in parallel, each independently available 99.9% of the time, and needs all four. What is the endpoint's availability?",
        options: [
          "99.9%, because the calls happen in parallel",
          "About 99.6%, because required dependencies multiply",
          "99.975%, because parallelism averages the failures",
          "100%, as long as the gateway has a timeout",
        ],
        answer: 1,
        explanation:
          "Required dependencies multiply: 0.999 to the fourth power is about 0.996, so the endpoint is roughly four times less available than any one of its dependencies. Parallelism helps latency, never availability. The only ways out are fewer required dependencies, or making some of them optional with a fallback.",
      },
    }),

    lesson({
      id: "launch-day",
      chapter: chapterTitles[4],
      title: "Launch day",
      subtitle: "A peak, a dead replica and a budget, all at once.",
      difficulty: "Advanced",
      minutes: 22,
      concept: "Designing for a known bad day",
      brief:
        "The storefront launches tomorrow. Traffic averages 400 requests per second and doubles for the middle third of the campaign window; 92% of it is reads of the same product pages. One application replica will die shortly after the peak and will not come back, and the load balancer currently notices dead endpoints every six seconds. Finance has capped the infrastructure budget. Ship a design that holds through all of it.",
      learning: [
        "A capstone is not a new mechanism, it is the interaction between mechanisms you already have. Three constraints bind here at once: a peak that doubles offered load, a replica loss that removes a share of capacity permanently, and a cost cap that forbids solving either one by brute force. Work them in that order. Size the application tier so that surviving replicas cover the peak, cut the traffic that reaches storage so the expensive component stays small, and only then tune the detection window that decides how many requests fall into the hole.",
        "The cost curve is what makes this a design exercise rather than an arithmetic one. Database capacity is priced superlinearly, so doubling the store's throughput costs far more than double, while cache capacity is priced sublinearly and application replicas are close to linear. That ordering tells you where to spend: a cache that raises the hit rate moves load off the most expensive component in the system, and every point of hit rate you gain is capacity you do not have to buy at the store. Compute the storage load explicitly before you size anything: writes always reach the store, and so does every read that misses.",
        "Peaks and failures interact. Capacity that is adequate at the average is not adequate at the peak, and capacity adequate at the peak is not adequate at the peak minus one replica. Decide which combination you are designing for and say so: a design that survives the peak and the failure simultaneously costs more than one that survives them separately, and on a real launch day you would rather over-provision for a few hours than explain a checkout outage. Production teams get this right with load tests at peak-plus-margin, game days that kill an instance while the test runs, and a freeze on deploys during the window.",
        "What this model leaves out is most of the operational work. There is no deploy in flight, no cold JIT or empty connection pool on the replacement replica, no third-party payment processor with its own limits, and no queue of asynchronous work backing up while the peak runs. Treat the objectives as a load test, not as a launch plan; the launch plan also needs a rollback path, an on-call rota, and a decision in advance about what you will shed if the peak is twice as big as you predicted.",
      ],
      hints: [
        "Run the baseline once and write down three separate numbers before touching anything: the application tier's utilization at the peak, the traffic reaching the store, and where the failures cluster in time.",
        "Compute the storage load from first principles as the writes plus the reads that miss the cache, then decide whether it is cheaper to raise the hit rate or to buy store capacity, given how the two are priced.",
        "Size the application tier from the replicas that survive the failure rather than from the ones you start with, then shorten the balancer's detection interval so the loss is a blip instead of a window.",
      ],
      objectives: [...healthy(460, 200), queueDepth(160), budget(45)],
      architecture: launchStarter,
      reference: launchReference,
      workload: workload({
        requestRate: 400,
        readRatio: 0.92,
        duration: 30,
        pattern: "spike",
        seed: 4207,
        failures: [{ kind: "server", at: 0.7 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      defense: defense({
        followUps: [
          "Marketing tells you the morning of launch that the peak will be four times the average, not two. What do you change, and what do you refuse to change?",
          "The cache restarts cold at the top of the peak. Walk me through the next thirty seconds at the store.",
          "The budget is cut by a third. Which component do you shrink first, and what risk are you accepting by doing it?",
        ],
        rubric: rubric([
          ["peak", "Sizes the application tier for the peak with the failed replica removed, and states the resulting utilization", 25],
          ["dbload", "Computes the load reaching the store as writes plus read misses, and uses hit rate rather than store capacity to reduce it", 25],
          ["cost", "Argues the spend explicitly against the price curve: where a credit buys the most capacity and where it buys the least", 20],
          ["detection", "Addresses the detection window and quantifies the requests it costs", 15],
          ["risk", "Names what the design still cannot survive: a cold cache, a larger peak, or a second correlated failure", 15],
        ]),
        modelAnswer:
          "I worked the three constraints in order. Peak offered load is 800 requests per second, and one replica dies, so the tier has to carry 800 on the survivors: four replicas at 300 gives 1,200 healthy and 900 after the loss, about two thirds utilized at the peak and comfortably under half afterwards. Second, the store. Writes are 8% of traffic, 32 per second at the average and 64 at the peak, and they always reach storage; misses are the rest. At the baseline hit rate of 60% the store sees roughly 32 + 368 x 0.4 = 179 per second, which at the peak is 358 and needs an expensive store. Raising the hit rate to 85% cuts it to about 87, and 174 at the peak, so a much smaller store carries it. That is the right trade because storage capacity is priced superlinearly while cache capacity is priced sublinearly, so the same credit buys far more relief at the cache. Third, the detection window: at six seconds the balancer feeds a dead endpoint for six seconds, several hundred failed requests; at a few hundred milliseconds it is a few dozen. Total spend lands under the cap. What it still cannot survive is a cold cache at the top of the peak.",
      }),
      reflection: {
        question: "Your design carries the peak with every replica healthy, and it carries the average with one replica dead. What have you actually verified?",
        options: [
          "That the design survives launch day, since both constraints are met",
          "Neither case individually, because the sim only reports averages",
          "Only that the two constraints hold separately; the binding case is the peak with a replica already dead",
          "That capacity is irrelevant as long as detection is fast",
        ],
        answer: 2,
        explanation:
          "Failures do not politely wait for quiet periods. The case that decides your capacity plan is the worst plausible combination, which here is peak traffic on the surviving replicas. Sizing for each constraint separately and assuming they do not overlap is how launch days go wrong.",
      },
    }),
  ],
};
