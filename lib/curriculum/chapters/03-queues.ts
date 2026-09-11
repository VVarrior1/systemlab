import { budget, chain, chapterTitles, graph, defense, estimate, healthy, lesson, node, objective, queueDepth, rejected, rubric, tweak, workload, type ChapterFile } from "../shared";

// ---------------------------------------------------------------- jobs in the queue

const uploadStarter = chain([
  node("traffic", "traffic", 0),
  node("server", "intake", 1, { label: "Upload API", capacity: 400, latency: 10 }),
  node("queue", "queue", 2, { label: "Thumbnail queue" }),
  node("server", "worker", 3, { label: "Thumbnail worker", role: "worker", capacity: 60, replicas: 1 }),
  node("database", "db", 4, { label: "Media store", capacity: 250 }),
]);

// ---------------------------------------------------------------- drain the backlog

const renderStarter = chain([
  node("traffic", "traffic", 0),
  node("server", "intake", 1, { label: "Ingest API", capacity: 600, latency: 8 }),
  node("queue", "queue", 2, { label: "Render queue" }),
  node("server", "worker", 3, { label: "Render worker", role: "worker", capacity: 60, replicas: 3 }),
  node("database", "db", 4, { label: "Asset store", capacity: 400 }),
]);

// ---------------------------------------------------------------- when caches cannot help

const ordersStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Orders API", capacity: 400, replicas: 2 }),
    node("cache", "cache", 3, { label: "Order cache", cacheHitRate: 0.9 }),
    node("database", "db", 4, { label: "Orders database", capacity: 200 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ---------------------------------------------------------------- bounded queues

const webhookStarter = chain([
  node("traffic", "traffic", 0),
  node("server", "intake", 1, { label: "Webhook intake", capacity: 800, latency: 5 }),
  node("queue", "queue", 2, { label: "Delivery queue" }),
  node("server", "worker", 3, { label: "Delivery worker", role: "worker", capacity: 70, replicas: 3 }),
  node("database", "db", 4, { label: "Delivery log", capacity: 500 }),
]);

export const chapter: ChapterFile = {
  title: chapterTitles[2],
  lessons: [
    lesson({
      id: "jobs-in-the-queue",
      chapter: chapterTitles[2],
      title: "Jobs in the queue",
      subtitle: "Size a worker pool against the rate work arrives.",
      difficulty: "Intermediate",
      minutes: 12,
      concept: "Producer and consumer rates",
      brief:
        "Your photo service accepts 100 uploads per second and every upload becomes a thumbnail job. The upload API answers immediately and drops the job on a queue, where a single worker renders about 60 jobs per second before writing to the media store. The queue grows all run and callers give up waiting.",
      learning: [
        "A queue does not create capacity; it stores the difference between what arrives and what is consumed. While the arrival rate exceeds the consumption rate the backlog grows linearly, and every job's wait grows with it, so a queue that is 'working' looks exactly like a queue that is failing until you plot its depth. The only stable states are consumption above arrivals (an empty queue) and a bound that throws work away.",
        "Consumer throughput is lanes times per-lane rate. One worker replica is one lane: it renders one job at a time at roughly 1,000 / capacity milliseconds per job. Doubling the replicas doubles the pool's jobs per second exactly as doubling each worker's speed would, so the sizing question is always the product, and the safety question is how much of that product you have spare. Production teams keep consumers at half to two-thirds of their peak arrival rate for the same reason web tiers do: service times are variable, and a pool at ninety percent utilization already has a visible queue.",
        "Wait time follows from Little's law. With the pool utilized at rho, the mean number waiting is proportional to rho / (1 - rho): at half load the queue is a job or two, at ninety percent it is nine times longer, and the p95 tail is worse still because service times here are lognormal, not constant. That is why the fix for a slow queue is almost never a bigger queue - it is a faster consumer, and the numbers you should quote in an interview are arrival rate, per-lane service rate, lane count, and resulting utilization.",
        "The model idealizes a few things worth naming out loud. Jobs are independent and identically distributed, workers never crash mid-job, there is no per-job retry or visibility timeout, and the caller waits synchronously for the job to finish so the queue's delay shows up in the request latency. Real pipelines decouple further - the client gets a job id and polls - which moves the pain from latency to freshness, not out of the system.",
      ],
      hints: [
        "Run the baseline and read the worker's utilization and the queue's depth together: one is pinned, the other only grows.",
        "Compute the pool's job rate as lanes times per-lane rate, then compare it with the arrival rate. Aim for the arrival rate to be a comfortable fraction of the pool's rate, not equal to it.",
        "Add lanes to the worker pool until its rate clears the arrival rate with headroom, then re-check the store behind it.",
      ],
      objectives: [...healthy(95, 120), queueDepth(30)],
      architecture: uploadStarter,
      reference: tweak(uploadStarter, { worker: { replicas: 3 } }),
      workload: workload({ requestRate: 100, readRatio: 0, duration: 30, seed: 41 }),
      allowedKinds: ["server", "queue", "database", "load-balancer", "cache"],
      estimation: estimate("bottleneckCapacity", "queueDepth", "p95"),
      defense: defense({
        followUps: [
          "Uploads triple overnight for a product launch. What is the first number you check, and what do you change?",
          "A worker crashes halfway through a job. What happens to that job in this design, and what would you add in production?",
          "How would you know from your dashboards that the pipeline is falling behind before customers tell you?",
        ],
        rubric: rubric([
          ["bottleneck", "Names the worker pool as the bottleneck and quotes its utilization and the queue depth from the baseline run", 25],
          ["arith", "Computes consumer throughput as lanes times per-lane rate and compares it with the arrival rate", 30],
          ["headroom", "Justifies the chosen headroom rather than sizing the pool exactly to the arrival rate", 20],
          ["alt", "States a rejected alternative (a larger queue, a faster store) and why it does not raise consumption", 15],
          ["risk", "Identifies a remaining failure mode: lost jobs on worker crash, poison messages, or duplicate delivery", 10],
        ]),
        modelAnswer:
          "The baseline shows the worker pinned at 100% utilization while the queue depth climbs all run and requests hit the five-second deadline: arrivals are 100 jobs per second and one lane renders about 60, so the backlog grows by roughly 40 jobs every second and the wait grows with it. The intake API and the media store are both nearly idle, so neither is the constraint. I added worker lanes: three replicas at 60 jobs per second each gives 180 jobs per second, putting the pool near 55% utilization, which leaves room for the lognormal service-time tail instead of sitting on the knee of the queueing curve. Queue depth then stays in single digits and p95 lands near 90 ms, dominated by the store's own latency rather than by waiting. I rejected a bigger queue - it buffers the same imbalance for longer - and a faster media store, which was idle. The design still loses in-flight jobs if a worker dies, so production would need acknowledgements and a visibility timeout.",
      }),
      reflection: {
        question: "The queue depth is growing steadily while the workers sit at 100% utilization. What does making the queue itself larger achieve?",
        options: [
          "It raises throughput, because more jobs can be in flight at once",
          "Nothing for throughput: it only lets the backlog and the wait grow further before work is dropped",
          "It lowers latency, because jobs spend less time waiting to be enqueued",
          "It protects the database by smoothing the write rate",
        ],
        answer: 1,
        explanation:
          "Throughput is set by the consumers, not by the buffer. While arrivals exceed the pool's job rate, a larger queue simply stores more waiting work, and every extra job in the queue is extra waiting time for the job behind it. The only real fixes are more consumption or less arriving work.",
      },
    }),

    lesson({
      id: "drain-the-backlog",
      chapter: chapterTitles[2],
      title: "Drain the backlog",
      subtitle: "Survive a burst by draining faster than it builds.",
      difficulty: "Intermediate",
      minutes: 14,
      concept: "Backlog build-up and drain rate",
      brief:
        "A video tool ingests 150 render jobs per second, and every hour a scheduled batch doubles that for about nine seconds. Three render workers keep up at 60 jobs per second each in the steady stretch, but during the burst the queue balloons to over a thousand jobs and requests keep timing out long after the burst has passed.",
      learning: [
        "A burst leaves a debt. While arrivals exceed the pool's rate, the backlog grows at (arrivals - consumption) jobs per second; when the burst ends, it shrinks at (consumption - arrivals) per second. A pool sized for the average takes far longer to clear the debt than the burst took to create it, which is why the latency damage outlives the traffic that caused it. The number to quote is the drain time: backlog divided by the surplus rate.",
        "Peak, not mean, sizes a consumer pool. Sizing three lanes at sixty jobs per second against a mean of 150 looks like twenty percent headroom, but against a peak of 300 it is a forty percent deficit, and the queue integrates that deficit for as long as the peak lasts. Capacity planning in production works from the peak-to-mean ratio for exactly this reason, and the same arithmetic decides how many consumers an autoscaler must have already started before the burst arrives - scaling that reacts after the queue grows is always late.",
        "Latency during a backlog is queue depth divided by service rate, so the tail is a direct readout of the debt. A thousand waiting jobs in front of a pool doing 180 per second is roughly five seconds of wait, which is exactly where the engine's request deadline kills them and turns a latency problem into an error-rate problem. Watching maxQueueDepth alongside p95 tells you whether you have a capacity problem or a variance problem.",
        "What the model leaves out: workers here start instantly and never warm up, the queue is durable and free, and the burst shape is known in advance. Real systems pay a start-up cost per consumer, have per-message retry, and often prefer to shed or defer low-value work during the burst instead of buying peak-shaped capacity that idles the rest of the hour.",
      ],
      hints: [
        "Watch the queue depth over the run, not just the final number: note where it starts growing and how long it takes to return to zero.",
        "Work out the surplus during the burst - the pool's job rate minus the burst arrival rate - and note that a negative surplus is what builds the backlog you then have to drain.",
        "Raise the pool's job rate until it exceeds the burst arrival rate, by making each lane faster or by adding lanes; the store behind it must keep up too.",
      ],
      objectives: [...healthy(180, 110), queueDepth(40)],
      architecture: renderStarter,
      reference: tweak(renderStarter, { worker: { capacity: 120 } }),
      workload: workload({ requestRate: 150, readRatio: 0, duration: 30, seed: 52, pattern: "spike" }),
      allowedKinds: ["server", "queue", "database", "load-balancer", "cache"],
      estimation: estimate("queueDepth", "p95", "throughput"),
      defense: defense({
        followUps: [
          "The burst lasts five minutes instead of nine seconds. Does your design still hold, and what breaks first?",
          "Finance halves your compute budget for this pipeline. What do you give up, and how do you keep the SLO honest?",
          "Your autoscaler adds workers ninety seconds after the queue starts growing. What does the p95 look like during that window?",
        ],
        rubric: rubric([
          ["bottleneck", "Identifies the worker pool as the constraint during the burst and quotes the peak queue depth from the baseline", 25],
          ["arith", "Computes the backlog as deficit times burst duration and the drain time as backlog divided by the surplus rate", 30],
          ["peak", "Sizes the pool against the peak arrival rate rather than the mean, and says why", 20],
          ["alt", "States a rejected alternative (a larger queue, autoscaling after the fact, a bigger store) and why it loses", 15],
          ["risk", "Names what still hurts: burst duration, cold consumers, or the cost of peak-shaped capacity", 10],
        ]),
        modelAnswer:
          "In the baseline the pool renders 180 jobs per second while the burst delivers 300, so it falls behind by 120 per second for about nine seconds - a backlog near 1,100 jobs, which matches the measured peak queue depth. At 180 jobs per second that debt needs six more seconds to clear, and a request waiting behind it exceeds the five-second deadline, which is why the error rate rises after the burst rather than during it. I made each lane faster instead of adding a fourth: three lanes at 120 jobs per second is 360 per second, above the 300 peak, so the queue never accumulates and p95 settles around 70 ms with peak depth in single digits. The store stays under half utilization, so it is not the constraint. I rejected a larger queue, which buffers the same deficit for longer, and reactive autoscaling, which starts consumers only after the queue has already grown. The remaining risk is a longer burst or an unforeseen peak: I would alert on queue depth and drain time, not on CPU.",
      }),
      reflection: {
        question: "A burst leaves 900 jobs queued. Your pool consumes 300 jobs per second and arrivals have returned to 200 per second. Roughly how long until the queue is empty?",
        options: ["About three seconds", "About nine seconds", "About four and a half seconds", "It never drains, because arrivals are still non-zero"],
        answer: 1,
        explanation:
          "The queue drains at the surplus rate, not the full service rate: 300 consumed minus 200 arriving leaves 100 jobs per second of surplus, so 900 queued jobs need about nine seconds. Reading the drain rate as the whole 300 per second is the classic error, and it makes recovery look three times faster than it is.",
      },
    }),

    lesson({
      id: "when-caches-cannot-help",
      chapter: chapterTitles[2],
      title: "When caches cannot help",
      subtitle: "A write-heavy workload has to be absorbed by storage.",
      difficulty: "Intermediate",
      minutes: 13,
      concept: "Read/write mix and cache leverage",
      brief:
        "An order-ingestion service takes 300 requests per second and only 15% of them are reads. There is already a cache in front of the database with a 90% hit rate, yet the database is pinned at 100% utilization, more than a third of requests fail, and raising the hit rate changes nothing at all.",
      learning: [
        "A cache removes read misses and nothing else. Every write goes through to storage to be durable, so the load a cache can possibly remove is bounded by the read share of your traffic. With reads at fifteen percent of a workload, a perfect cache removes at most fifteen percent of the database's work - and the difference between a good cache and a perfect one here is well under one percent of total load. That upper bound, not the hit rate, is the number to compute first.",
        "The general rule: database load equals writes plus reads times (1 - hit rate). Read-heavy systems make that second term dominate, which is why caching is the standard answer for a catalog or a feed; write-heavy systems make the first term dominate, and the first term is incompressible without changing the storage design. Once you see writes dominating, the honest options are more write capacity, cheaper writes (batching, an append-only store), or fewer writes (coalescing, sampling, or shedding low-value events).",
        "Write capacity is also the most expensive thing on the menu. The cost curve here is superlinear for databases and gently sublinear for caches, which mirrors reality: an extra replica of an in-memory cache is cheap, while a database tier that sustains twice the write throughput costs considerably more than twice as much. That is exactly why interviewers push on the read/write ratio early - it decides whether the cheap lever is even available.",
        "The model idealizes writes as uniform, independent, and equally expensive; it has no batching, no group commit, no write amplification from indexes or compaction, and no queue in front of storage to absorb bursts. Real write paths get relief from all of those, and pay for it in complexity and in read-after-write semantics, which the later chapters make you reason about explicitly.",
      ],
      hints: [
        "Compare the request mix in the workload panel with where the load actually lands: check what share of the database's traffic the cache could ever remove.",
        "Compute the database load as writes plus the reads that miss, then size storage against that number with headroom rather than against the request rate.",
        "Spend the budget on the component that is actually saturated, and check the cost curve before you buy: storage capacity is the most expensive thing you can scale here.",
      ],
      objectives: [...healthy(285, 80), budget(40)],
      architecture: ordersStarter,
      reference: tweak(ordersStarter, { db: { capacity: 450 } }),
      workload: workload({ requestRate: 300, readRatio: 0.15, duration: 30, seed: 63 }),
      allowedKinds: ["server", "load-balancer", "cache", "database", "queue"],
      estimation: estimate("dbLoad", "cost", "p95"),
      defense: defense({
        followUps: [
          "The product team says orders will grow ten times in a year. What is your storage plan, and at what point does a single database stop working?",
          "Someone proposes putting a queue between the API and the database so writes are absorbed during peaks. What does that fix, and what does it not fix?",
          "The read share rises to eighty percent after a reporting feature ships. Which part of your design changes?",
        ],
        rubric: rubric([
          ["bottleneck", "Names the database as the saturated component and quotes its utilization and error rate from the baseline", 25],
          ["arith", "Computes database load as writes plus read misses and shows that the cache can remove at most the read share", 30],
          ["alt", "States why raising the hit rate or adding cache capacity does not move the bottleneck", 20],
          ["cost", "Justifies the chosen storage capacity against the budget and notes that write capacity prices superlinearly", 15],
          ["risk", "Names what a bigger database does not solve: burst absorption, growth beyond one node, or write amplification", 10],
        ]),
        modelAnswer:
          "The workload is 85% writes, so of 300 requests per second about 255 are writes that must reach storage, plus roughly five read misses from the 45 reads at a 90% hit rate - about 260 requests per second against a database rated for 200. It is pinned at 100%, its queue is over a thousand deep, and nearly forty percent of requests hit the deadline. Raising the hit rate to 99% removes about four requests per second, which is noise; the cache's whole addressable share of this workload is the fifteen percent of traffic that is reads. So I bought write capacity: 450 requests per second puts the database near 58% utilization, p95 drops to about 52 ms, errors go to zero, and the total lands inside the budget because I sized it to measured load and headroom rather than doubling blindly. I rejected a larger cache (it addresses a term that is already small) and a queue in front of storage, which smooths bursts but does not raise sustained write throughput. Beyond roughly ten times this rate a single node stops being credible and the answer becomes sharding by order id.",
      }),
      reflection: {
        question: "Reads are 15% of traffic and the cache hits 90% of them. Which change removes the most database load?",
        options: [
          "Raising the cache hit rate from 90% to 99%",
          "Doubling the cache's capacity so more keys fit",
          "Nothing on the read path: 85% of the load is writes, which must reach storage regardless",
          "Adding a second cache in front of the first",
        ],
        answer: 2,
        explanation:
          "Reads contribute 45 requests per second and the cache already absorbs about 40 of them; the entire remaining prize is roughly five requests per second. The 255 writes per second cannot be cached away - they are the reason the database is saturated, and only write capacity, cheaper writes, or fewer writes will move that number.",
      },
    }),

    lesson({
      id: "bounded-queues",
      chapter: chapterTitles[2],
      title: "Bounded queues",
      subtitle: "Shed the overflow so accepted work stays fast.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Backpressure and load shedding",
      brief:
        "A webhook delivery pipeline takes 180 events per second and doubles during customer batch jobs. Three delivery workers handle about 210 events per second, the queue is unbounded, and during every burst the backlog grows past a thousand events so that even the events accepted after the burst wait seconds and time out. The compute budget is fixed.",
      learning: [
        "An unbounded queue converts an overload into a latency failure for everyone, including the requests that arrive after the overload is over. Because every waiting job adds to the wait of the job behind it, a deficit that lasts a few seconds punishes traffic for far longer, and once the wait exceeds the client's deadline the work is done and then thrown away - capacity spent producing nothing. Bounding the queue changes the failure mode from 'everyone is slow and some fail late' to 'most are fast and some are refused immediately'.",
        "A bound is a latency contract. The wait in front of a pool is roughly queue depth divided by the pool's service rate, so choosing a maximum depth is choosing a maximum wait: a bound of about a quarter of the pool's per-second rate promises a quarter of a second of queueing, whatever the arrival rate does. This is the same reasoning behind Envoy's pending-request limits and SQS in-flight caps, and it is why load shedding is presented in the SRE literature as a latency control rather than as an error budget expense.",
        "Rejections are not errors. A refused request is a deliberate, cheap answer the client can retry or route elsewhere; a timeout is an expensive non-answer after the system has already spent capacity on it. The engine counts them separately for that reason, and a good design states its shed rate as an explicit target next to its latency target. In production the same split appears in your SLOs: a 429 or 503 with a Retry-After is a contract, a five-second hang is a breach.",
        "The model idealizes shedding as instantaneous and free, applied uniformly to whatever arrives when the bound is reached. Real systems shed with priority - by tenant, by cost, or by value - and pair the bound with client backoff so that refused work does not immediately return and turn a shed into a retry storm. Without that pairing, a bound alone can amplify the very burst it was supposed to contain.",
      ],
      hints: [
        "Look at what the peak queue depth implies for waiting time: divide it by the pool's service rate and compare with the deadline the caller has.",
        "Decide the wait you are willing to promise first, then convert it into a maximum queue depth using the pool's service rate; that is your bound.",
        "Bound the queue so overflow is refused on arrival instead of buffered, and check the budget before you reach for more workers.",
      ],
      objectives: [
        objective("p95", "lte", 260),
        objective("throughput", "gte", 165),
        objective("errorRate", "lte", 0.01),
        rejected(0.3),
        budget(41),
      ],
      architecture: webhookStarter,
      reference: tweak(webhookStarter, { queue: { maxQueue: 25 } }),
      workload: workload({ requestRate: 180, readRatio: 0, duration: 30, seed: 74, pattern: "spike" }),
      allowedKinds: ["server", "queue", "database", "load-balancer", "rate-limiter", "cache"],
      estimation: estimate("queueDepth", "p95", "throughput"),
      defense: defense({
        followUps: [
          "Every refused webhook is retried by the sender after one second. What happens to your shed rate, and what do you change?",
          "One customer generates the whole burst. How would you keep their overflow from being refused on everybody else's behalf?",
          "Your budget is unfrozen. Would you now buy enough workers to accept every event, and how would you justify it?",
        ],
        rubric: rubric([
          ["bottleneck", "Explains that the unbounded queue, not the worker speed, is what turns a short burst into run-long timeouts", 25],
          ["arith", "Derives the queue bound from a target wait times the pool's service rate, and states the resulting shed rate", 30],
          ["shed", "Argues that a fast rejection is preferable to a late timeout and treats rejections and errors as different outcomes", 20],
          ["alt", "States a rejected alternative (more workers, a bigger queue, a client-side timeout) and why it loses under the budget", 15],
          ["risk", "Names a remaining risk: retry amplification, unfair shedding across tenants, or the lost events themselves", 10],
        ]),
        modelAnswer:
          "The pool consumes about 210 events per second and the burst delivers 360, so the queue grows by roughly 150 per second and peaks near 1,300 events - about six seconds of waiting in front of a pool that fast, which is past the caller's deadline, so about eleven percent of the run's events are burned as timeouts after we have already paid to queue them. Rather than buy capacity I bounded the queue: a depth of 25 in front of 210 events per second promises about 120 ms of queueing, and the measured p95 lands near 190 ms including the store write. Overflow during the burst is refused immediately - roughly nineteen percent of events, all inside the burst window - and the error rate drops to zero because nothing waits long enough to time out. I rejected adding workers, which the frozen budget forbids and which only moves the overload threshold, and a bigger queue, which buys longer waits. The real risk is senders retrying refused events at once; I would pair the bound with Retry-After and per-tenant limits.",
      }),
      reflection: {
        question: "Under a sustained overload, what is the practical difference between an unbounded queue and one bounded at a quarter-second of work?",
        options: [
          "The bounded queue completes fewer events overall, because rejections reduce throughput",
          "Roughly the same events complete, but with the bound they complete quickly and the overflow is refused instead of timing out",
          "The bounded queue is only safer if the workers are also faster",
          "There is no difference: both eventually reject the same work",
        ],
        answer: 1,
        explanation:
          "Completed work is set by the consumers either way. The bound decides what happens to the excess: buffered until it exceeds the deadline and thrown away after consuming capacity, or refused on arrival so the accepted work keeps a predictable wait. Throughput barely moves; the latency distribution and the failure mode change completely.",
      },
    }),
  ],
};
