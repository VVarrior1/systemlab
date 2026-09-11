import { chain, chapterTitles, defense, estimate, graph, healthy, lesson, node, queueDepth, rubric, tweak, workload, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- 1. first-request

const baselineStack = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 200, latency: 15 }),
  node("database", "db", 2, { label: "Orders database", capacity: 150, latency: 25 }),
]);

const firstRequest = lesson({
  id: "first-request",
  chapter: chapterTitles[0],
  title: "The first request",
  subtitle: "Follow one request from traffic to storage and back.",
  difficulty: "Beginner",
  minutes: 8,
  concept: "Latency budget",
  brief:
    "An internal orders tool takes 60 requests per second, 90% of them reads. One application server talks to one database, and nothing is on fire. This run is the baseline every later lesson compares against, so before you press Run, commit to a number for p95 latency and for successful throughput and then find out how close you were.",
  learning: [
    "A request's latency is the sum of what happens on every hop it touches. Each component contributes two different things: a fixed latency (the network round trip, the protocol overhead, the disk seek the model rolls into one number) and a service time, the time the component is actually busy with this request. Service time is 1000 / capacity milliseconds, so a database rated at 150 requests per second spends about 6.7 ms of work on each one. Add the two together for every hop and you have the floor of your latency budget: nothing you do to the code makes a request faster than the sum of the hops it has to make.",
    "Latency is a distribution, not a number. The engine draws each service time from a lognormal centred on the mean, so most requests land near p50 and a few land far to the right. That is what real systems look like: a garbage collection pause, a cold page cache, an unlucky disk. Reporting the average hides those requests entirely, which is why every SLO you will ever write is stated at a percentile — p95, p99, sometimes p99.9 — and why the gap between p50 and p95 is the thing worth watching. When the gap widens without the average moving, something is queueing.",
    "Throughput and latency are separate questions and you must estimate both. Throughput asks how many requests finished successfully inside the traffic window; latency asks how long each of them took. A system can have a beautiful p95 and drop a third of its traffic, and a system can complete everything while taking two seconds per request. In an interview, quoting one without the other is the most common way to sound imprecise. The model idealizes plenty here: no TLS handshake, no DNS, no connection pool limits, no payload size. Real first requests pay all of those, which is why measured latency in production is almost always higher than a back-of-envelope sum.",
  ],
  hints: [
    "Read the numbers on each component before you run anything: every hop on the path contributes its own configured latency to every request.",
    "Add a component's service time to its latency. Service time is the reciprocal of its capacity, so a component with plenty of headroom contributes far less than its fixed latency does.",
    "After the run, compare p50 with p95 in the results. The distance between them is the tail, and it comes from the spread of service times, not from the average.",
  ],
  objectives: healthy(57, 90),
  architecture: baselineStack,
  reference: baselineStack,
  workload: workload({ requestRate: 60, readRatio: 0.9, seed: 11 }),
  allowedKinds: ["server", "database", "load-balancer", "cache"],
  estimation: estimate("p95", "throughput"),
  defense: defense({
    followUps: [
      "The database team tells you its latency will double next quarter after a storage migration. What happens to p50, to p95, and to throughput, and which of the three do you argue about in the review?",
      "Your product manager wants p95 under 30 ms. Given this architecture, is that achievable at all? What would have to change, and what would you refuse to promise?",
      "How would you know in production that your p95 had regressed, without a user complaining first?",
    ],
    rubric: rubric([
      ["budget", "Breaks the measured latency into per-hop contributions (each component's latency plus its service time) rather than quoting one total", 30],
      ["percentile", "Explains why p95 is reported instead of the average, and what the p50-to-p95 gap represents", 25],
      ["throughput", "States throughput separately from latency and notes that the system is far from its capacity limit", 20],
      ["idealization", "Names at least one real-world cost the model leaves out (TLS, DNS, connection pools, payload size, cold caches)", 15],
      ["detect", "Says how they would observe this in production (percentile dashboards, golden signals, alerting on symptoms)", 10],
    ]),
    modelAnswer:
      "The path is traffic to API to database, and every request pays all of it. The API contributes 15 ms of fixed latency plus about 5 ms of service time at a capacity of 200 per second; the database contributes 25 ms plus about 6.7 ms at a capacity of 150. That is roughly 52 ms of unavoidable work, and the measured p50 sits close to it because at 60 requests per second neither component is near saturation, so almost nothing waits in a queue. p95 lands near 58 ms, and that six-millisecond gap is the lognormal spread of service times rather than queueing: at this load there is no backlog to wait behind. Throughput is a separate claim — about 60 completions per second, matching arrivals, because we finish everything we accept. I would not promise p95 under 30 ms on this shape: the fixed latencies alone exceed it, so the fix would have to remove a hop, not speed one up. In production I would alert on p95 and error rate, not on the average.",
  }),
  reflection: {
    question: "The database's configured latency doubles from 25 ms to 50 ms while traffic stays at 60 requests per second. What happens?",
    options: [
      "p50 and p95 both rise by roughly 25 ms, and throughput is unchanged",
      "Throughput halves, because the database can now serve only half as many requests",
      "p95 rises but p50 stays flat, because latency only affects the tail",
      "Nothing measurable changes until the database reaches its capacity",
    ],
    answer: 0,
    explanation:
      "Configured latency is time added to every request after the lane is released; it does not occupy the component, so it does not reduce capacity or throughput. Every percentile shifts up by the same amount. Capacity, not latency, is what limits how many requests per second a component can serve.",
  },
});

// ---------------------------------------------------------------- 2. find-the-bottleneck

const saturatedApi = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 180, latency: 15 }),
  node("database", "db", 2, { label: "Catalog database", capacity: 600, latency: 20 }),
]);

const findTheBottleneck = lesson({
  id: "find-the-bottleneck",
  chapter: chapterTitles[0],
  title: "Find the bottleneck",
  subtitle: "One component is holding the whole system back. Prove which.",
  difficulty: "Beginner",
  minutes: 10,
  concept: "Utilization and saturation",
  brief:
    "The catalog service used to be quick and is now timing out. Traffic has grown to 300 requests per second, 90% reads. The team is arguing: one half wants a bigger database, the other half blames the network. Both components are on the canvas with their real numbers. Find the constraint from the measurements, then size it properly instead of guessing.",
  learning: [
    "A bottleneck is the component whose utilization reaches 100% first. Utilization is arrival rate divided by service rate: a server rated at 180 requests per second that receives 300 is being asked to run at 167% of what it can do, which is not a slow system, it is an impossible one. The queue in front of it grows without bound for as long as the overload lasts, latency climbs until requests hit their deadline, and everything downstream looks healthy because it never receives the traffic that is stuck upstream. That last part is the trap: the database's dashboard is green precisely because the API is broken.",
    "Utilization alone is not enough, which is why Brendan Gregg's USE method pairs it with saturation and errors. Utilization tells you how busy a resource is; saturation (queue depth, wait time) tells you how much work is piled up behind it; errors tell you what is already failing. A component at 85% utilization with an empty queue is fine. A component at 85% utilization with a growing queue is not fine, it is minutes away from being the outage. Read utilization, queue depth and error counts together, per component, and the bottleneck identifies itself without a debate.",
    "Sizing is arithmetic, not vibes. Take the arrival rate the component actually sees, then divide by the utilization you are willing to run at. Industry practice is roughly 2 to 3 times headroom over steady-state demand for a component that must absorb bursts and lose a replica without falling over; running a single-lane service above 70 or 80% utilization means the queueing delay, which grows as one over one minus utilization, starts dominating your latency budget long before you reach 100%. Real deployments add more constraints the model ignores: connection pools, thread counts, memory per request, and the fact that you cannot buy a fractional server.",
  ],
  hints: [
    "Open the per-component metrics after a run and read utilization for every node, not just the one you suspect. The constraint is the component pinned at the top of the scale.",
    "Cross-check utilization against queue depth and errors. A busy component with no backlog is fine; a busy component with a growing backlog is the one hurting you.",
    "Size the constrained component from the traffic it actually receives divided by the utilization you are willing to run at, then leave headroom for bursts rather than aiming for a hair under saturation.",
  ],
  objectives: healthy(285, 80),
  architecture: saturatedApi,
  reference: tweak(saturatedApi, { api: { capacity: 520 } }),
  workload: workload({ requestRate: 300, readRatio: 0.9, seed: 12 }),
  allowedKinds: ["server", "database", "load-balancer"],
  estimation: estimate("bottleneckCapacity", "p95"),
  defense: defense({
    followUps: [
      "Traffic grows tenfold overnight to 3,000 requests per second. What breaks first now, and what is the second thing to break?",
      "Your finance lead asks why you did not simply double the database instead. Give the argument in one paragraph, with numbers.",
      "You are on call and get paged for rising latency. What single graph do you open first, and what would tell you it is a bottleneck rather than a dependency failure?",
    ],
    rubric: rubric([
      ["bottleneck", "Names the API server as the constraint and cites its measured utilization or queue depth, not a hunch", 30],
      ["arith", "Computes the capacity needed from arrival rate divided by a target utilization, and states the headroom chosen", 25],
      ["alt", "Explains why scaling the database was the wrong move, using its measured utilization", 20],
      ["queueing", "Explains why latency degrades before utilization reaches 100%, rather than only at saturation", 15],
      ["detect", "Describes the signals they would watch in production to catch this earlier (saturation, queue depth, per-component utilization)", 10],
    ]),
    modelAnswer:
      "The API server was the bottleneck. It is rated at 180 requests per second and receives all 300, so it was asked to run at about 167% of capacity: the queue in front of it grew for the whole run, latency ran into the request deadline, and errors followed. The database looked healthy at roughly 300 of its 600 per second, about 50% utilization, precisely because the API never handed it more. Scaling the database would have bought nothing and cost the most expensive credits in the catalog. I raised the API to 520 per second, which puts arrivals at about 58% utilization: enough that queueing delay stays small, and enough headroom to absorb a burst or lose part of the fleet. I deliberately did not size it at 310, a hair over demand, because queueing delay scales as one over one minus utilization and would have eaten the latency budget. The remaining risk is that this is one lane: a single replica has no failure headroom, so the next change is a balancer and a second replica.",
  }),
  reflection: {
    question: "A colleague proposes sizing the API at exactly 310 requests per second, just above the measured 300. Why is that a bad idea?",
    options: [
      "It would not work at all, because a component cannot serve traffic equal to its rated capacity",
      "Queueing delay grows sharply as utilization approaches 100%, so latency would be poor even though nothing is technically overloaded",
      "The database would then become the bottleneck and fail instead",
      "It costs more than sizing it generously, because of the nonlinear pricing curve",
    ],
    answer: 1,
    explanation:
      "At 97% utilization the component still keeps up on average, but every arrival that lands during a slow service time waits behind it, and waiting time grows as one over one minus utilization. Sizing to just above demand leaves no room for the variance that is always present, so p95 suffers long before you see errors.",
  },
});

// ---------------------------------------------------------------- 3. share-the-load

const idleReplicas = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 220, latency: 12, replicas: 3 }),
  node("database", "db", 2, { label: "Catalog database", capacity: 600, latency: 20 }),
]);

const balancedStack = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { label: "Load balancer" }),
    node("server", "api", 2, { label: "API server", capacity: 220, latency: 12, replicas: 3 }),
    node("database", "db", 3, { label: "Catalog database", capacity: 600, latency: 20 }),
  ],
  [
    ["traffic", "balancer"],
    ["balancer", "api"],
    ["api", "db"],
  ],
);

const shareTheLoad = lesson({
  id: "share-the-load",
  chapter: chapterTitles[0],
  title: "Share the load",
  subtitle: "Three replicas are running. Only one of them is working.",
  difficulty: "Beginner",
  minutes: 10,
  concept: "Load balancing",
  brief:
    "Someone already paid for three API replicas, and the service is still drowning under 320 requests per second. The per-replica metrics tell the story: one replica is pinned, the other two are idle. Capacity you cannot route traffic to is capacity you do not have. Make all three replicas earn their keep.",
  learning: [
    "Replicas do not distribute traffic; something has to distribute traffic to replicas. In this model a direct connection from the traffic source to an application server reaches replica 1 only, which mirrors what happens in reality when a client resolves one address, or when a deployment scales out behind a service that nobody registered with the router. The fleet-wide utilization number looks comfortable while one machine is on fire, which is why per-replica metrics matter: an average across replicas is exactly the wrong summary when the distribution is the problem.",
    "A load balancer turns a set of replicas into one endpoint and picks a target per request. Round robin walks the list in order and is fine when replicas and requests are interchangeable. Least connections picks the replica with the fewest in-flight requests and is better when they are not: heterogeneous machines, long-tailed request costs, a replica that has just restarted with a cold cache. Google's SRE book makes the same point at datacenter scale — naive round robin degrades when request costs vary, because it keeps feeding a replica that is already behind.",
    "Balancing changes what capacity means. Three replicas of 220 requests per second are not a single 660-per-second component: each keeps its own queue, and a request routed to a busy replica waits there even if a neighbour is idle. That is why balancing algorithm and health checking matter more as the fleet grows, and why capacity planning is done per replica with headroom for losing one. The model idealizes the balancer itself: no connection draining, no sticky sessions, no slow-start after a deploy, and a balancer with effectively unlimited capacity of its own.",
  ],
  hints: [
    "Look at the per-replica breakdown for the application server rather than its overall utilization. Ask why the other lanes have processed nothing.",
    "Traffic that points straight at an application server only ever reaches its first replica. Work out what component sits between traffic and a fleet in every real deployment.",
    "Once traffic is spread, size each replica from the share of traffic it receives, not from the total, and confirm the per-replica utilizations end up close to each other.",
  ],
  objectives: healthy(305, 80),
  architecture: idleReplicas,
  reference: balancedStack,
  workload: workload({ requestRate: 320, readRatio: 0.9, seed: 13 }),
  allowedKinds: ["server", "database", "load-balancer"],
  requiredBalancedReplicas: 2,
  estimation: estimate("bottleneckCapacity", "p95"),
  defense: defense({
    followUps: [
      "One replica dies at peak. With your design, what does the load balancer do, how long does it take to notice, and what do users see in the meantime?",
      "Requests to this service are not uniform: 5% of them are ten times more expensive than the rest. Does your balancing choice still hold, and what would you change?",
      "The team wants to run the fleet at 90% utilization to save money. Make the argument for or against, with the failure case spelled out.",
    ],
    rubric: rubric([
      ["diagnosis", "Identifies from the per-replica metrics that only one replica was receiving traffic, rather than blaming total capacity", 30],
      ["mechanism", "Explains what the load balancer does and why replicas without a router in front of them are unreachable capacity", 25],
      ["arith", "Divides the traffic across replicas and states the resulting per-replica utilization", 20],
      ["alt", "Names a rejected alternative (scaling one replica up, adding more replicas) and why it loses", 15],
      ["risk", "Identifies a remaining risk: replica failure, uneven request cost, health-check detection delay, or sticky state", 10],
    ]),
    modelAnswer:
      "The fleet was three replicas of 220 requests per second, but traffic pointed straight at the server, so every request landed on replica 1. The per-replica view showed one lane saturated at 320 arrivals against 220 of capacity while the other two processed nothing, and total utilization averaged that away into a number that looked survivable. I put a load balancer between traffic and the fleet. Now each replica receives roughly 107 requests per second against 220 of capacity, about 49% utilization, and the p95 falls back to the sum of the hop latencies because nothing waits in a queue. I rejected scaling replica 1 to 400 per second: it costs more, and it leaves the other two replicas as expensive decoration with no failure headroom. Round robin is fine here because requests are interchangeable; if 5% of requests were ten times more expensive I would switch to least connections, since round robin keeps feeding a replica that is already behind. The remaining risk is detection delay when a replica dies.",
  }),
  reflection: {
    question: "With three balanced replicas of 220 requests per second each, one replica fails. Traffic stays at 320 requests per second. What is the immediate consequence?",
    options: [
      "Nothing, because 320 is below the fleet's remaining capacity of 440",
      "The two survivors each take about 160 requests per second, which fits, but there is now zero headroom for another failure or a spike",
      "The system fails completely, because the balancer cannot route around a dead replica",
      "Latency halves, because fewer replicas means fewer queues",
    ],
    answer: 1,
    explanation:
      "The survivors absorb the load — 160 each against 220 of capacity, about 73% utilization — so the service stays up but the queueing delay rises and the next failure has nowhere to go. This is why capacity planning is done as N+1 or N+2: enough replicas to lose one and still sit at a comfortable utilization.",
  },
});

// ---------------------------------------------------------------- 4. littles-law

const nearSaturation = chain([
  node("traffic", "traffic", 0),
  node("server", "api", 1, { label: "API server", capacity: 900, latency: 10 }),
  node("database", "db", 2, { label: "Ledger database", capacity: 310, latency: 25 }),
]);

const littlesLaw = lesson({
  id: "littles-law",
  chapter: chapterTitles[0],
  title: "Little's law",
  subtitle: "Predict the queue before you measure it.",
  difficulty: "Beginner",
  minutes: 12,
  concept: "Queueing (L = lambda x W)",
  brief:
    "A ledger service takes a steady 300 requests per second. The application server has plenty of room; the database is rated at 310 requests per second and receives every one of those 300, which puts it just under saturation. Nothing is erroring yet, the throughput chart looks perfect, and the latency chart is already ugly. Predict how many requests are waiting at any moment, then measure, then fix it.",
  learning: [
    "Little's law says the number of items in a system equals the arrival rate times the time each item spends there: L = lambda x W. It is an identity, not a model, so it holds regardless of how arrivals or service times are distributed. If 300 requests per second arrive and each spends 60 ms inside, then on average 18 requests are in flight. Apply it to the queue alone and you get the backlog: arrival rate times waiting time. The power of the identity is that you can solve for whichever term you cannot measure — a queue depth you can see gives you the wait time you cannot, and vice versa.",
    "What the law does not give you is the wait time itself; that comes from utilization. For a single-lane component, waiting time grows roughly as utilization over one minus utilization, multiplied by the service time and a factor for how variable that service time is. The consequence is brutal and non-intuitive: going from 50% to 90% utilization does not double the wait, it multiplies it by roughly nine, and going from 90% to 95% doubles it again. That is why a component that is 'only' 90% busy already has a visibly bad p95 while its average still looks fine, and why capacity plans target utilization rather than raw headroom.",
    "In production this is the shape of a cascading failure. Arrival rate above service rate means the queue has no steady state at all: L grows for as long as the overload lasts, waiting time grows with it, and eventually every request in the queue has already been abandoned by the client by the time it is served, so the system burns all its capacity producing responses nobody wants. That is why bounded queues and load shedding exist, and why the SRE book treats a growing backlog as the leading indicator of an outage rather than an inconvenience. The model idealizes one thing worth naming: it queues requests but does not model the memory each queued request costs, which in reality is what actually kills the process.",
  ],
  hints: [
    "Estimate the queue before you run: multiply the arrival rate the component sees by the time you expect each request to spend waiting there.",
    "Get the waiting time from utilization, not from the service time alone. Ask how much of the latency budget is the component working versus requests waiting their turn.",
    "Fix it by changing the ratio of arrival rate to service rate at the constrained component, then re-derive the expected backlog and check the measured peak against it.",
  ],
  objectives: [...healthy(285, 55), queueDepth(6)],
  architecture: nearSaturation,
  reference: tweak(nearSaturation, { db: { capacity: 620 } }),
  workload: workload({ requestRate: 300, readRatio: 0.9, seed: 14 }),
  allowedKinds: ["server", "database", "load-balancer"],
  estimation: estimate("queueDepth", "p95"),
  defense: defense({
    followUps: [
      "Arrival rate rises 10% while capacity stays where you left it. Predict the change in queue depth and in p95, and say whether the relationship is linear.",
      "Instead of more database capacity, a colleague proposes a bounded queue that rejects overflow. Under what product requirement is that the better answer?",
      "At 3 am you are paged for this service. Which metric tells you the difference between 'slow dependency' and 'queue building up', and what do you do first?",
    ],
    rubric: rubric([
      ["law", "States Little's law correctly and applies it to this workload with real numbers (arrival rate times wait)", 30],
      ["utilization", "Explains that waiting time is driven by utilization and grows nonlinearly as it approaches one", 25],
      ["arith", "Computes the utilization before and after the change and ties it to the measured queue depth and p95", 25],
      ["alt", "States a rejected alternative (shedding, caching, a bounded queue) and the requirement under which it would win", 10],
      ["risk", "Names the failure mode of an unbounded queue: work that is served after the client has given up, memory growth, cascading failure", 10],
    ]),
    modelAnswer:
      "The database received all 300 requests per second against a capacity of 310, so it measured about 96% utilization. Its service time is only about 3 ms, but at that utilization the waiting term dominates: waiting scales as utilization over one minus utilization, so nearly every request that arrives during a slow service time queues behind it. The database's mean time per request came out around 35 ms against the 28 ms it should cost, so roughly 7 ms of pure waiting. Little's law turns that into a backlog: 300 per second times 7 ms is about two requests waiting on average, and the measured peak was in the teens because arrivals bunch. The same law applied to the whole system says 300 per second times a 44 ms median is about 13 requests in flight. I raised the database to 620 per second, which drops it to about 48% utilization: waiting collapses to well under a millisecond, p95 falls to the sum of the hop latencies, and the peak backlog drops to two. I rejected shedding because this is steady traffic we promised to serve, not an overload.",
  }),
  reflection: {
    question: "A component sits at 50% utilization and you double the traffic to it, taking it to 100% of its rated capacity. What happens to the average number of requests waiting?",
    options: [
      "It doubles, because queue depth is proportional to arrival rate",
      "It grows without bound: at 100% utilization there is no steady state, so the backlog keeps building for as long as the overload lasts",
      "It stays the same, because the component still serves every request eventually",
      "It rises by about 50%, in proportion to the increase in utilization",
    ],
    answer: 1,
    explanation:
      "Queueing delay scales as utilization over one minus utilization, so it diverges as utilization reaches one. At exactly 100% the queue has no equilibrium: every burst adds work that the component has no spare capacity to absorb, and Little's law turns that growing wait into a growing backlog until requests start hitting their deadline.",
  },
});

export const chapter: ChapterFile = {
  title: chapterTitles[0],
  lessons: [firstRequest, findTheBottleneck, shareTheLoad, littlesLaw],
};
