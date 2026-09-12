import { budget, chapterTitles, defense, estimate, graph, lesson, node, objective, rejected, rubric, tweak, workload, written, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- rate-limit-the-api

const limitStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 2),
    node("server", "api", 3, { label: "Public API", capacity: 150, replicas: 2 }),
    node("cache", "cache", 4, { cacheHitRate: 0.85 }),
    node("database", "db", 5, { label: "Catalog database", capacity: 150 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

const limitReference = graph(
  [...limitStarter.nodes, node("rate-limiter", "limiter", 1, { label: "Edge rate limiter", limit: 250, burst: 60 })],
  [["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- burst-allowance

const burstStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("rate-limiter", "limiter", 1, { label: "Edge rate limiter", limit: 320, burst: 320 }),
    node("load-balancer", "balancer", 2),
    node("server", "api", 3, { label: "Storefront API", capacity: 175, replicas: 2 }),
    node("cache", "cache", 4, { cacheHitRate: 0.9 }),
    node("database", "db", 5, { label: "Orders database", capacity: 260 }),
  ],
  [["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

const burstReference = tweak(burstStarter, { limiter: { limit: 340, burst: 3000 }, api: { capacity: 350, replicas: 2 } });

// ---------------------------------------------------------------- backpressure-end-to-end

const backpressureStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "intake", 2, { label: "Job intake", capacity: 500 }),
    node("queue", "queue", 3, { label: "Render queue" }),
    node("server", "worker", 4, { label: "Render worker", role: "worker", capacity: 80, replicas: 3 }),
    node("database", "db", 5, { label: "Asset store", capacity: 400 }),
  ],
  [["traffic", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);

const backpressureTuned = tweak(backpressureStarter, { queue: { maxQueue: 50 }, worker: { capacity: 90, replicas: 4 } });

const backpressureReference = graph(
  [...backpressureTuned.nodes, node("rate-limiter", "limiter", 1, { label: "Intake limiter", limit: 310, burst: 60 })],
  [["traffic", "limiter"], ["limiter", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);

// ---------------------------------------------------------------- lessons

export const chapter: ChapterFile = {
  title: chapterTitles[7],
  lessons: [
    lesson({
      id: "rate-limit-the-api",
      chapter: chapterTitles[7],
      title: "Rate limit the API",
      subtitle: "Shed the traffic you cannot serve, on purpose.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Load shedding & token buckets",
      remixable: false,
      brief:
        "Your public catalog API is sized for 300 requests per second across two replicas, and it is now taking 500. Roughly half of that is a handful of scrapers hammering the same endpoints with no backoff. Right now every caller — customer and scraper alike — waits behind the same queue, and p95 has passed four seconds. Finance will not approve a second pair of replicas: the budget is 18 credits.",
      learning: [
        "An overloaded queue is the worst possible way to fail. When arrivals exceed service capacity the queue grows without bound, so every request pays the accumulated backlog: latency climbs linearly with time until the client's deadline kills it. You do not get 300 fast requests and 200 slow ones — you get 500 slow ones and, once the five-second deadline bites, almost nothing useful. Shedding turns a system-wide brownout into a partial outage that the healthy fraction of callers never notices.",
        "A token bucket is the standard shape for shedding. Tokens accrue at a fixed rate (the `limit`) into a bucket that holds at most `burst` of them; an arriving request either takes a token or is rejected immediately. Rejection is cheap — no server thread, no database round trip — which is exactly why it protects the tier behind it. In the engine, and in production, a rejection counts as `rejectedRate` rather than `errorRate`: shedding is a decision you made, not a fault you suffered.",
        "Size the limit from measured capacity, not from wishful thinking. Two replicas at 150 requests per second is 300 in theory, but a queueing system run at 100% utilization has unbounded wait: the practical ceiling is somewhere around 80-85% of nominal, which is why real capacity plans carry 2-3x headroom over average load. Set the limit there and the accepted traffic sits at a utilization where the tail stays flat; set it at nominal capacity and you have simply moved the pile-up behind the limiter.",
        "Keep the burst small when the overload is sustained. The bucket starts full, so a large burst releases that many requests at once and hands the API a queue spike it did not need; with a steady flood, the tokens never refill above the drip rate anyway, so the burst buys nothing but a worse first second. Bursts earn their keep for spiky-but-legitimate traffic, which is the next lesson.",
        "What the model idealizes: one global bucket, and every caller treated alike. Real limiters are keyed — per API key, per IP, per tenant — so that one abusive client is throttled while everyone else is untouched, and they run distributed (Redis counters, or per-node buckets sized to a share of the global limit) with the drift that implies. They also tell the caller what happened: HTTP 429 with `Retry-After` and rate-limit headers, so a well-behaved client backs off instead of retrying into the wall.",
      ],
      hints: [
        "Run the baseline and read the API's utilization and queue depth. Ask yourself where the latency is actually accumulating.",
        "Work out the sustainable arrival rate: total replica capacity, discounted for the headroom a queue needs to stay short. That number, not the offered load, is what the system can promise.",
        "Put a token bucket in front of the balancer and set its refill rate to that sustainable number. Keep the bucket itself shallow — a deep bucket just dumps a crowd onto the API at the start.",
      ],
      objectives: [
        objective("p95", "lte", 95, "P95 latency of accepted requests at most 95 ms"),
        rejected(0.55),
        objective("errorRate", "lte", 0.01),
        budget(20),
      ],
      architecture: limitStarter,
      reference: limitReference,
      workload: workload({ requestRate: 500, readRatio: 0.9, duration: 30, seed: 801 }),
      allowedKinds: ["server", "load-balancer", "database", "cache", "rate-limiter"],
      estimation: estimate("bottleneckCapacity", "throughput", "p95"),
      defense: defense({
        followUps: [
          "Legitimate customers and scrapers are hitting the same limit, so paying customers are being dropped too. How do you fix that without raising the global limit?",
          "The scrapers respond to rejections by retrying immediately, three times each. What happens to your limiter and to the API, and what do you change?",
          "How would you know, from production telemetry alone, that the limit is set too low rather than too high?",
        ],
        rubric: rubric([
          ["bottleneck", "Names the API tier as the saturated component and cites its measured utilization and queue depth", 20],
          ["arith", "Derives the limit from replica capacity times a utilization target, not from the offered load", 30],
          ["shed", "Explains why rejecting early is better than queueing, and distinguishes rejections from errors", 25],
          ["alt", "States the rejected alternative (buy more replicas) and why the budget or the tail latency rules it out", 15],
          ["risk", "Identifies a remaining failure mode: per-tenant fairness, retry storms, or a limit set from stale capacity data", 10],
        ]),
        modelAnswer:
          "The API is the bottleneck: two replicas at 150 requests per second is 300 nominal, and it was being offered 500, so utilization pinned at 100% and the queue grew until the five-second deadline killed three quarters of the traffic. Queueing cannot fix an arrival rate above service rate; only shedding can. I sized the bucket from capacity, not demand: 300 nominal times roughly 83% utilization gives about 250 requests per second sustainable, so the limiter refills at 250 with a shallow burst of 60. That accepts 250 and rejects the other 250 — around 50% shed — while accepted p95 lands near 75 ms and unexpected errors go to zero. The cheap alternative, doubling to four replicas, does serve all 500 at similar latency but costs about 20 credits against an 18-credit cap, and it also pays the scrapers' bill. The real weakness is fairness: one global bucket throttles customers and scrapers identically, so the production version keys the bucket per API key and returns 429 with Retry-After.",
      }),
      reflection: {
        question: "Rejected requests are reported separately from errors. Why does that distinction matter when you read the results?",
        options: [
          "Rejections are cheaper to serve, so they are excluded from the cost model.",
          "Rejections are a deliberate policy decision, so they measure how much load you chose to refuse; errors measure work the system failed to do.",
          "Rejections are retried automatically by the engine, so counting them twice would inflate the error rate.",
          "Rejections only happen at rate limiters, so the split tells you which component is slowest.",
        ],
        answer: 1,
        explanation:
          "A rejection is the design working: the limiter refused work it knew it could not serve, quickly and cheaply. An error is the design failing: a request that was accepted, consumed capacity, and then timed out or blew up. Reporting them together would hide the whole point of shedding, because a healthy shedding system and a collapsing one would look identical.",
      },
    }),

    lesson({
      id: "burst-allowance",
      chapter: chapterTitles[7],
      title: "Size the burst",
      subtitle: "Absorb a real surge without punishing real customers.",
      difficulty: "Advanced",
      minutes: 14,
      concept: "Token bucket depth vs refill rate",
      brief:
        "Marketing sends a push notification every afternoon and the storefront doubles from 300 to 600 requests per second for about nine seconds. The limiter you inherited was tuned for the quiet hours, and yesterday it rejected nearly a fifth of the campaign traffic — real customers with real carts. The surge is legitimate, it is short, and the business wants it served.",
      learning: [
        "A token bucket has two independent knobs and they answer two different questions. The refill rate answers 'what arrival rate am I willing to sustain forever?' The bucket depth answers 'how large a surge above that rate am I willing to absorb before I start refusing?' Tuning only the refill rate gives you a limiter that is either permanently too tight or permanently too loose; the depth is what lets one policy serve both a quiet Tuesday and a push notification.",
        "The arithmetic for the depth is a rectangle. During a surge the bucket drains at (peak rate − refill rate) tokens per second for as long as the surge lasts, so a depth of at least that product covers the whole event. Nine seconds of 300 requests per second above the drip rate needs a couple of thousand tokens in the bucket. Get that right and rejections fall to zero; get it wrong by a factor of two and you shed the back half of every campaign.",
        "A deep bucket is a promise your capacity has to keep. The limiter admitting 600 requests per second does nothing for the customer unless the tier behind it can serve 600 requests per second. That is the trade the two knobs make explicit: a large burst allowance converts a rejection problem into a capacity problem, so it only works if you also raise the replica count or per-replica capacity to cover the peak with headroom. Absorbing a surge you cannot serve just moves the failure from the limiter to the queue.",
        "There is a second valid answer, and it is worth knowing why you might not pick it: raise the refill rate above the peak and leave the bucket shallow. That serves the campaign too, but it also permanently licenses any caller to sustain 600 requests per second, so an abusive client or a runaway retry loop gets the same allowance the campaign did. Keeping the refill rate near the sustainable average and paying for the surge out of a finite bucket is the policy that says 'a burst is fine, a flood is not'.",
        "What the model idealizes: one bucket, one tenant, and a surge whose shape you already know. Production limiters are per key and the shape is discovered from history — you set the depth from the p99 of measured burst volume, not from a guess. They also usually pair a small per-second bucket with a larger per-minute or per-hour quota, so a client can be bursty on a short timescale and still be bounded on a long one.",
      ],
      hints: [
        "Compare the rejected count second by second against the traffic curve. Notice exactly when the limiter starts refusing and when it stops.",
        "Work out the size of the surge as a volume, not a rate: the excess arrival rate multiplied by how long the excess lasts. That volume is what the bucket has to hold.",
        "Give the bucket a depth that covers the whole surge, then check that the tier behind the limiter can actually serve the peak rate you just admitted.",
      ],
      objectives: [
        rejected(0.05),
        objective("p95", "lte", 90),
        objective("throughput", "gte", 370),
        objective("errorRate", "lte", 0.01),
        budget(33),
      ],
      architecture: burstStarter,
      reference: burstReference,
      workload: workload({ requestRate: 300, readRatio: 0.9, duration: 30, seed: 802, pattern: "spike" }),
      allowedKinds: ["server", "load-balancer", "database", "cache", "rate-limiter"],
      estimation: estimate("bottleneckCapacity", "throughput", "p95"),
      defense: defense({
        followUps: [
          "Marketing changes the campaign so the surge lasts three minutes instead of nine seconds. Does your bucket still work, and what do you change if not?",
          "A single scraper discovers it can drain the whole bucket in one second. What did your design just give away, and how would you close it?",
          "Traffic grows 10x overnight and the surge scales with it. What breaks first — the limiter, the API, or the database?",
        ],
        rubric: rubric([
          ["arith", "Computes the surge as a volume: excess rate multiplied by surge duration, and sizes the bucket from it", 30],
          ["knobs", "Separates the refill rate (sustainable arrival rate) from the depth (absorbable surge) and says what each is for", 25],
          ["capacity", "Notes that admitting the peak requires capacity behind the limiter and quantifies the headroom", 20],
          ["alt", "States the alternative (raise the refill rate) and why a bucket with a shallow depth is a different policy", 15],
          ["risk", "Identifies a remaining failure mode: a longer surge, a single client draining the bucket, or no per-tenant isolation", 10],
        ]),
        modelAnswer:
          "The campaign is legitimate traffic, so the fix is to absorb it rather than shed it. The surge runs at 600 requests per second for about nine seconds against a sustainable 340, so the excess volume is roughly (600 − 340) x 9, about 2,300 requests; I set the bucket depth to 3,000 so the whole campaign fits with margin and rejections drop from 19% to zero. A deep bucket is only a promise if capacity can keep it, so I also raised the API from 175 to 350 per replica: 600 offered against 700 nominal is about 86% at the peak, which keeps p95 near 55 ms, and the cache holds database load to roughly 19% of accepted traffic so storage never becomes the constraint. The alternative — refill at 650 and keep the bucket shallow — passes the same objectives, but it permanently licenses every caller to sustain the peak rate. Keeping the refill near the average and paying for the surge from a finite bucket is the policy I want. The remaining risk is that one client can drain the bucket alone; production needs a per-key bucket.",
      }),
      reflection: {
        question: "You double the bucket depth but leave the refill rate and the API capacity alone. What happens during the next campaign?",
        options: [
          "Rejections fall and latency is unchanged, because the bucket absorbs the surge at no cost.",
          "Rejections fall but the accepted surge now queues at the API, so p95 rises — the bucket moved the bottleneck rather than removing it.",
          "Nothing changes, because the bucket depth only affects the first second of the run.",
          "Rejections rise, because a deeper bucket refills more slowly.",
        ],
        answer: 1,
        explanation:
          "The bucket controls admission, not service. Admitting more requests than the tier behind it can serve converts fast, cheap rejections into slow, expensive queueing — the same total pain, moved one hop downstream and made worse. The depth and the capacity have to be raised together.",
      },
    }),

    lesson({
      id: "backpressure-end-to-end",
      chapter: chapterTitles[7],
      title: "Backpressure end to end",
      subtitle: "Push the limit to the edge where rejecting is still cheap.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Bounded queues & backpressure",
      remixable: false,
      brief:
        "A video pipeline accepts render jobs over HTTP, drops them on a queue, and lets a worker pool grind through them. Marketing turned on a new export button and submissions jumped to 400 jobs per second against a pool that finishes about 240. The queue is unbounded, so nothing is ever refused: the backlog grows all afternoon and by mid-run two thirds of the jobs blow their deadline having already burned worker time.",
      learning: [
        "An unbounded queue is not a buffer, it is a delay line with no exit. A buffer absorbs a mismatch between arrival and service that is temporary; when the mismatch is permanent, the queue converts an obvious throughput problem into a silent latency problem and then, once the client deadline is reached, into a total failure. The tell is in the numbers: throughput sits pinned at the worker pool's real rate while queue depth and p95 climb in a straight line. Adding queue capacity never helps; it only lengthens the ramp.",
        "Backpressure means the pressure propagates. A bounded queue is the mechanism: once the backlog reaches its bound, arrivals are refused immediately instead of joining the line. That does two things. It caps the wait — a bound of B jobs in front of a pool that finishes S per second means nobody waits longer than roughly B/S — and it makes the overload visible at the front door, where the caller can be told to slow down, instead of at the deadline, where the work has already been paid for.",
        "Bound the queue and limit the intake, because they solve different halves. The bound protects latency for whatever is already in the system, but rejecting at the queue means every rejected job has already paid for a connection, an intake server slot, and a hop. A rate limiter at the edge refuses the same job before any of that, which is why real pipelines shed at the cheapest point that still knows enough to decide. The bounded queue then only has to catch the transients the limiter's averaging misses.",
        "Choose the bound from the latency you promised, not from memory available. Work backwards: if the SLO for an accepted job is 150 ms and the pool drains 340 jobs per second, the queue may hold about 50 jobs — anything more and an accepted job can miss its own SLO while sitting in a queue you built. A queue sized in gigabytes rather than seconds is the single most common way teams turn a fast system into a slow one.",
        "What the model idealizes: rejection here is instantaneous and free, and every job is worth the same. Real systems return 429 or 503 with a retry hint, and a client that ignores it can turn shedding into a retry storm that costs more than the original overload. Real pipelines also prioritize — a paid export outranks a free preview — and many prefer to shed the newest work (or the oldest, if freshness matters) rather than whatever happens to arrive when the bound is hit.",
      ],
      hints: [
        "Watch queue depth and p95 over the run rather than their averages. A line that climbs and never flattens tells you the arrival rate beats the service rate.",
        "Compute what the worker pool actually finishes per second, then decide how long an accepted job is allowed to wait. Those two numbers give you the size of the backlog you can afford to hold.",
        "Bound the queue to that backlog and put a limiter at the intake set to the pool's sustainable rate, so most of the excess is refused before it consumes anything.",
      ],
      objectives: [
        objective("p95", "lte", 120, "P95 latency of accepted jobs at most 120 ms"),
        rejected(0.3),
        objective("errorRate", "lte", 0.01),
        objective("maxQueueDepth", "lte", 55),
        budget(49),
      ],
      architecture: backpressureStarter,
      reference: backpressureReference,
      workload: workload({ requestRate: 400, readRatio: 0, duration: 30, seed: 803 }),
      allowedKinds: ["server", "queue", "database", "rate-limiter", "load-balancer", "cache"],
      estimation: estimate("throughput", "queueDepth", "p95"),
      defense: defense({
        followUps: [
          "The clients treat a rejection as a transient failure and retry immediately. Walk me through the next thirty seconds of your system.",
          "Product says paid exports must never be dropped while free previews may be. Where does that decision live in your design?",
          "The on-call engineer is paged at 3 am for this pipeline. Which metric fires the alert, and what does the runbook tell them to change?",
        ],
        rubric: rubric([
          ["diagnosis", "Identifies the unbounded queue as the reason latency, not throughput, was the visible symptom", 20],
          ["arith", "Derives the queue bound from the pool's drain rate and the accepted-job latency target", 30],
          ["placement", "Explains why the limiter belongs at the intake and the bound at the queue, and what each catches", 25],
          ["quant", "Quantifies the outcome: accepted rate, shed rate, and the resulting p95 and peak depth", 15],
          ["risk", "Names a remaining failure mode: retry storms, no per-class priority, or a bound that hides a real capacity shortfall", 10],
        ]),
        modelAnswer:
          "Throughput was already at the pool's ceiling — about 240 jobs per second against 400 arriving — so the extra 160 per second went into an unbounded queue and simply aged there until the deadline killed it, which is why the error rate was 67% while the workers were 100% busy. I made the overload explicit instead. The pool went to four replicas at 90, so it drains about 340 per second; at a 120 ms target for an accepted job the queue may hold roughly 0.12 x 340, call it 50 jobs, so I set maxQueue to 50. Then I put a token bucket at the intake refilling at 310 — just under the drain rate — with a shallow burst, so the roughly 22% of jobs we cannot serve are refused at the front door before they consume an intake slot. The result is p95 near 90 ms, peak depth around 30, and zero unexpected errors. Bigger workers alone would cost more than the 37-credit cap and would still leave the queue unbounded.",
      }),
      reflection: {
        question: "The team proposes keeping the queue unbounded but adding a fifth worker replica so the pool finishes 425 jobs per second. What is the strongest objection?",
        options: [
          "It costs more, and cost is the only objective that matters here.",
          "It works today but leaves no defence: the next time arrivals exceed the pool for any reason, the unbounded queue turns the overload back into a system-wide latency collapse.",
          "Adding replicas cannot increase the pool's drain rate, because the queue serializes jobs.",
          "A fifth replica would make the database the bottleneck, which is always worse than a slow worker pool.",
        ],
        answer: 1,
        explanation:
          "Sizing for today's peak is a capacity decision; bounding the queue is a safety decision, and you need both. Without a bound, any future mismatch — a traffic step, a slow dependency, a lost replica — silently reappears as unbounded latency. With one, the same event costs you a visible, measured slice of rejected work and leaves everything else fast.",
      },
    }),

    written({
      id: "rate-limiting-algorithms",
      chapter: chapterTitles[7],
      title: "Rate limiting algorithms",
      subtitle: "Buckets, windows, and the hard part: doing it across many nodes.",
      difficulty: "Advanced",
      minutes: 16,
      concept: "Limiter algorithms & fairness",
      brief:
        "You have used a token bucket twice now without asking what else was on the shelf. This lesson lays out the four algorithms interviewers expect you to compare, the accounting problem that appears the moment your limiter runs on more than one machine, and the fairness question that decides whether a limit protects your customers or punishes them.",
      learning: [
        "The token bucket is the default for a reason: it is two integers and a timestamp. Tokens accrue at a fixed rate up to a maximum depth; an arrival takes one or is refused. Refill rate sets the sustainable throughput, depth sets the largest surge you will absorb, and the state per key is small enough to keep in memory or in a single Redis hash. It admits bursts by design, which is usually what you want for human traffic, and its behaviour is easy to explain to the team that will be throttled by it.",
        "The leaky bucket is the token bucket's mirror image and answers a different requirement. Requests enter a queue and leave at a strictly constant rate; overflow is dropped. Where a token bucket smooths admission but lets a burst through intact, a leaky bucket smooths the output — downstream sees a flat, predictable rate no matter how lumpy the arrivals were. Use it when the thing you are protecting cannot absorb bursts at all, such as a legacy dependency, a payment gateway with a hard contractual rate, or an outbound email or SMS provider.",
        "The sliding window log is the exact answer and the expensive one. Store a timestamp for every accepted request per key, and on each arrival drop everything older than the window and count what is left. It is perfectly precise, it has no boundary artifacts, and its memory grows with the limit multiplied by the number of keys — a million keys at a thousand requests per minute is a billion timestamps. It is the right tool for low-limit, high-value decisions: expensive endpoints, login attempts, password resets, and anything you may need to justify to an auditor.",
        "The fixed window counter is the cheap answer with a known flaw. One counter per key per window, reset on the boundary — trivial to store and to reason about, but a caller who sends a full window's allowance just before the boundary and another immediately after gets double the intended rate across the seam. The sliding window counter is the usual compromise: keep the current and previous window's counts and interpolate by how far into the current window you are. It is within a few percent of the log's accuracy at two integers per key, which is why most production limiters land here or on a token bucket.",
        "Distributing a limiter is where the interesting failure modes live. A shared store — Redis with an atomic Lua script, or a dedicated limiter service — gives one true count at the cost of a network round trip on every request and a hard dependency you must have a fallback for. Local buckets sized to limit/N avoid that entirely but only behave if load balancing is even, and they under-admit whenever it is not. The common middle ground is a local bucket that leases capacity from a central authority in batches, plus an explicit decision about what happens when the authority is unreachable: fail open and protect availability, or fail closed and protect the backend.",
        "Fairness is the part candidates forget, and it is usually what the interviewer is probing for. A single global limit means the loudest caller decides who else gets served, so limits are keyed — per API key, per user, per tenant, per IP for unauthenticated traffic — and often layered, with a per-key bucket inside a global one that protects the fleet. Multi-tenant systems go further and reserve a floor for each tenant so a noisy neighbour cannot consume the shared pool, which is the same idea as weighted fair queueing in a network. Getting this wrong is how a limiter meant to stop abuse ends up throttling your largest customer.",
        "Finally, a limiter is a contract, so say so out loud. Return 429 with Retry-After and rate-limit headers describing the limit, what remains, and when it resets; distinguish 429 (you are over your quota) from 503 (we are overloaded), because clients should back off differently. Pair that with jittered exponential backoff on the client and a retry budget, or your shedding will simply be converted into a retry storm. And decide in advance which endpoints are exempt — health checks, payment callbacks, incident tooling — before an outage makes you decide in a hurry.",
      ],
      defense: defense({
        prompt:
          "You are designing rate limiting for a public API with 50,000 tenants, served by 40 stateless nodes behind a load balancer. Choose the algorithm and the accounting scheme, define the key, and say how the system behaves when your limiter's state store is unavailable.",
        followUps: [
          "Your largest tenant is 30% of total traffic and is now being throttled during their peak while smaller tenants sit idle. What in your design caused that, and what do you change?",
          "The store is down and you chose to fail open. Ten minutes later the origin database is saturated. What second line of defence should have been in place?",
          "An auditor asks you to prove that a specific account never exceeded five password-reset attempts per hour last Tuesday. Does your design answer that, and if not, what would?",
        ],
        rubric: rubric([
          ["algorithm", "Picks an algorithm and justifies it against at least one rejected alternative on memory, accuracy, or burst behaviour", 25],
          ["distribution", "Describes the accounting scheme across nodes (shared store, local shards, or leases) and its round-trip or accuracy cost", 25],
          ["key", "Defines the limit key and layers it (per tenant inside a global cap), with a stated fairness policy", 20],
          ["failure", "States an explicit fail-open or fail-closed choice and what backstop covers the other risk", 20],
          ["contract", "Mentions the client-facing contract: 429 versus 503, Retry-After or rate-limit headers, and backoff expectations", 10],
        ]),
        modelAnswer:
          "I would use a token bucket keyed per tenant, layered inside a global bucket per node that protects the fleet. Buckets are two integers and a timestamp, so 50,000 tenants is a few megabytes, and burst tolerance matches how human traffic actually arrives. For accounting across 40 nodes I would hold the per-tenant state in Redis behind an atomic Lua script, but have each node lease capacity in chunks of a few hundred tokens rather than call Redis per request: that turns a round trip per request into one per few hundred, at the cost of a bounded over-admission equal to the outstanding leases. If Redis is unreachable I fail open on the per-tenant limit and fall back to a strictly local bucket sized at the global limit divided by 40, so an outage in the limiter degrades fairness rather than availability, and the origin is still protected by that local ceiling plus bounded queues. Password resets are the exception: those go through a sliding window log, because the limit is small, the value is high, and I need an auditable record. Clients get 429 with Retry-After, and 503 is reserved for genuine overload.",
      }),
      reflection: {
        question: "A fixed window counter of 100 requests per minute is deployed. A client sends 100 requests at 11:59:59 and another 100 at 12:00:01. What has happened, and which algorithm fixes it most cheaply?",
        options: [
          "Nothing unusual: the client used two separate minutes of quota, which is the intended behaviour of every algorithm.",
          "The client achieved 200 requests in two seconds by straddling the window boundary; a sliding window counter fixes it with two integers per key.",
          "The client was throttled on the second batch, because fixed windows carry unused quota forward.",
          "The counter overflowed and reset, so a token bucket with a larger depth is required.",
        ],
        answer: 1,
        explanation:
          "The boundary artifact is the fixed window's known flaw: the limit holds within each window but not across the seam, so a caller can briefly sustain double the intended rate. A sliding window log removes it exactly but stores a timestamp per request; the sliding window counter keeps the current and previous counts and interpolates, landing within a few percent of exact for two integers per key.",
      },
    }),
  ],
};
