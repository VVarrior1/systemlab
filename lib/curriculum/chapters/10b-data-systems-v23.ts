import { chapterTitles, conflicts, defense, egress, estimate, budget, graph, lesson, node, objective, queueDepth, rubric, workload, type ChapterFile } from "../shared";

/**
 * v2.3 additions to the Data systems chapter (same title as 10-data-systems.ts). Three simulations
 * over the v2.3 engine mechanics: object stores (transfer time, storage and egress billing),
 * partitioned streams (per-partition ordering and a slow-partition backlog), and leader election
 * under a network partition (heartbeat split-brain versus consensus). Every reference below was
 * measured on the three assessment seeds; objectives sit with headroom so a remix still fits.
 */

// ---------------------------------------------------------------- object-storage-and-egress

const objectStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "api", 1, { label: "Media API", capacity: 800 }),
    node("object-store", "store", 2, { label: "Object store", capacity: 400, replicas: 3, storedGb: 500 }),
  ],
  [["traffic", "api"], ["api", "store"]],
);
const objectReference = graph(
  [
    node("traffic", "traffic", 0),
    node("cdn", "edge", 1, { label: "CDN edge", capacity: 5000, cacheHitRate: 0.85 }),
    node("server", "api", 2, { label: "Media API", capacity: 800 }),
    node("object-store", "store", 3, { label: "Object store", capacity: 400, replicas: 3, storedGb: 500 }),
  ],
  [["traffic", "edge"], ["edge", "api"], ["api", "store"]],
);

// ---------------------------------------------------------------- partitioned-streams

const streamStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "producer", 1, { label: "Upload producer", capacity: 800 }),
    node("stream", "log", 2, { label: "Upload events", capacity: 20000, latency: 1, partitions: 2, consumerGroups: 1 }),
    node("server", "worker", 3, { label: "Indexer", role: "worker", capacity: 200, replicas: 2 }),
    node("database", "db", 4, { label: "Search index store", capacity: 800 }),
  ],
  [["traffic", "producer"], ["producer", "log"], ["log", "worker"], ["worker", "db"]],
);
const streamReference = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "producer", 1, { label: "Upload producer", capacity: 800 }),
    node("stream", "log", 2, { label: "Upload events", capacity: 20000, latency: 1, partitions: 8, consumerGroups: 1 }),
    node("server", "worker", 3, { label: "Indexer", role: "worker", capacity: 200, replicas: 8 }),
    node("database", "db", 4, { label: "Search index store", capacity: 800 }),
  ],
  [["traffic", "producer"], ["producer", "log"], ["log", "worker"], ["worker", "db"]],
);

// ---------------------------------------------------------------- split-brain

const splitStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Ledger API", capacity: 400, replicas: 3 }),
    node("database", "db", 3, { label: "Ledger store", capacity: 900, dbMode: "leader-follower", replicas: 3, election: "heartbeat", electionMs: 2000 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const splitReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Ledger API", capacity: 400, replicas: 3 }),
    node("database", "db", 3, { label: "Ledger store", capacity: 900, dbMode: "leader-follower", replicas: 3, election: "consensus", electionMs: 500 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);

export const chapter: ChapterFile = {
  title: chapterTitles[9],
  lessons: [
    lesson({
      id: "object-storage-and-egress",
      chapter: chapterTitles[9],
      title: "The bill is the bytes",
      subtitle: "A media API serves 2 MB objects straight from storage, and egress eats the budget.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Object storage & egress cost",
      brief:
        "A photo-and-video API takes 150 requests per second, and three in five of them read a roughly 2 MB object. Today the API calls the object store directly for every one of those reads. Under load the store's lanes are busy moving bytes, not just answering requests, latency is bad, and the bill is dominated by a line item nobody budgeted for. Put something in front of the object path that can serve most of those bytes without touching the store, and bring the design back under budget.",
      learning: [
        "An object store's lane is not just an answer machine, it is a pipe: serving a request means holding that lane for the object's own transfer time on top of whatever the store's baseline service time is. A 2 MB object does not move faster because you raised the store's configured capacity - the pipe still has to carry every one of those megabytes, at whatever bandwidth a lane actually has. Increasing 'capacity' shrinks the bookkeeping overhead per request; it does nothing to the physics of moving bytes. Past a certain payload size, the only lever that raises real throughput is more lanes: more replicas serving in parallel, or moving the work somewhere that never touches this store at all.",
        "A CDN edge is that somewhere. It sits in front of the origin, answers a cacheable read straight from its own cache without waiting on the origin's transfer-bound lane, and only calls through on a miss. This is the same cache-aside idea from earlier chapters applied to bytes instead of query results: the object store still exists as the source of truth, but the hot path for a popular photo or a recently uploaded clip is served by hardware that was built to move bytes fast and cheaply, not by the store that also has to accept every new upload. The production pattern is edge caching for static and semi-static assets - S3 plus CloudFront, R2 plus Cloudflare's own edge, GCS plus Cloud CDN - and it is close to universal for anything media-shaped.",
        "Egress is billed once, wherever the bytes leave the system, and it does not go away just because a CDN is in front of the store - the same GB of video reaches the same viewer either way. What a CDN buys you is not fewer billed bytes; it is fewer store replicas needed to hold the request rate, because the origin only has to serve the cache misses instead of every read. Do the arithmetic before touching a slider: multiply request rate by object share by payload size to get bytes per second, convert to GB per hour, and multiply by the egress rate - that number is close to fixed for a given workload, and it is usually the largest line on the bill once payloads stop being kilobytes of JSON and start being megabytes of media.",
        "Storage is billed differently again: every GB you keep costs something every hour, whether or not anyone reads it, because 'storedGb' is a level, not a rate. A design with no traffic at all still pays a storage bill. This is why real object stores offer storage classes and lifecycle rules - infrequent-access tiers, archival tiers - that trade retrieval latency for a cheaper level, and why 'we will just keep everything forever' is a cost decision, not a free one, even before anyone downloads a byte of it.",
        "What this model idealizes: every object the same size class transfers at the same fixed rate per lane, a CDN's own cache lookup costs no extra latency regardless of what it is serving, and cache hit rate is a dial rather than something that emerges from real request locality and TTLs. Real edges warm up, evict under memory pressure, and see hit rates that depend on the popularity distribution of the catalog, not a single configured number. The number to take away is the shape: bytes cost time at the node that has to move them, and bytes cost money exactly once, so the design question is which node moves them and how many of that node you need - not whether the bill can be avoided.",
      ],
      hints: [
        "Look at the object store's utilization and the request latency together, and check what fraction of that latency is happening at the store versus the network hop before it.",
        "Work out how much of the traffic is genuinely cacheable object reads, and compute how few requests would reach the origin store if most of those reads were answered somewhere closer to the client instead.",
        "Add a component that can serve a cached copy of an object without ever occupying an object store's lane, and place it ahead of the API on the object path.",
      ],
      objectives: [objective("p95", "lte", 350), objective("errorRate", "lte", 0.02), budget(82), egress(750)],
      architecture: objectStarter,
      reference: objectReference,
      workload: workload({ requestRate: 150, readRatio: 1, duration: 20, seed: 4201, objectShare: 0.6, payloadKb: 2048 }),
      allowedKinds: ["server", "cdn", "object-store"],
      estimation: estimate("cost", "p95"),
      defense: defense({
        followUps: [
          "Traffic 10x's overnight because a video went viral. What breaks first in your design, and what is the cheapest thing to change to survive it?",
          "The edge cache is flushed by an operator mistake at peak traffic. What happens to your origin, and how would you keep that from turning into an outage?",
          "The product now needs signed, expiring URLs for private videos instead of public objects. What does that do to your cache hit rate, and how would you get some of it back?",
          "How would you know, from a dashboard alone, that egress rather than compute is what is about to blow the monthly budget?",
        ],
        rubric: rubric([
          ["bottleneck", "Names the object store's transfer-bound lane as the throughput ceiling and gives the measured latency or utilization number that shows it", 25],
          ["mechanism", "Explains that a CDN edge answers cacheable reads without occupying the origin's lane, and distinguishes that from reducing billed egress", 25],
          ["arithmetic", "Computes egress from request rate, object share and payload size, and states why it stays roughly fixed regardless of where the object is served from", 25],
          ["limits", "Identifies what the design still cannot do: a cache miss still pays the full origin path, and storage cost never goes to zero while objects are kept", 25],
        ]),
        modelAnswer:
          "The baseline sends every read straight to the object store, and a 2 MB object holds a store lane for roughly 164 ms of transfer on top of its own service time, so at 150 requests per second with 60% object reads the store simply cannot keep enough lanes free without an unreasonable number of replicas - latency blows past budget and cost climbs with every replica added. I put a CDN edge in front of the API with a high cache hit rate, so the large majority of object reads never reach the store at all; the origin only has to serve misses, which is a small fraction of the original load, so a modest number of store replicas is enough to keep it healthy. Egress itself does not change - 150 requests per second times 60% times 2,048 KB is a fixed number of gigabytes per hour billed once wherever the bytes leave the system - what changes is that the store no longer needs the replica count to serve full traffic, which is where the cost savings actually come from. The residual risk is a cold or flushed cache: every request becomes a miss at once and the origin needs enough spare capacity to absorb that without cascading, which is a capacity margin I would size deliberately rather than assume away.",
      }),
      reflection: {
        question: "A team adds a CDN edge with a 90% cache hit rate in front of an object store, expecting their monthly egress bill to drop by roughly 90%. What actually happens to the bill?",
        options: [
          "Egress cost stays roughly the same, because the same bytes still reach the same clients whether the edge or the origin serves them",
          "Egress cost drops by about 90%, because the CDN absorbs nearly all the reads",
          "Egress cost disappears, because CDNs do not charge for bytes served from cache",
          "Egress cost roughly doubles, because now both the edge and the origin are billed for every request",
        ],
        answer: 0,
        explanation:
          "Egress is billed on bytes leaving the system to a client, and a cache hit at the edge still ships those bytes - it just ships them from a faster, cheaper-to-operate node instead of the origin. What a high hit rate saves is origin load and the replica count needed to serve it, which is a real and often larger saving, but it is a compute saving, not an egress saving. Conflating the two is how a team gets surprised when the CDN bill arrives looking a lot like the old one.",
      },
    }),

    lesson({
      id: "partitioned-streams",
      chapter: chapterTitles[9],
      title: "One slow lane, one backed-up lane",
      subtitle: "A stream with too few partitions turns one slow consumer into a p95 problem for everyone.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Partitioned streams & consumer sizing",
      brief:
        "An upload pipeline pushes 100 events per second through a two-partition stream into two indexer workers, one worker per partition, and on to a search index store. Partway through a run, whatever is consuming one partition slows to a crawl for several seconds - a slow disk, a bad deploy, does not matter which. That partition's messages back up behind it, and because there are only two partitions the whole system's tail latency follows it down. Give the stream enough partitions and enough workers that one slow lane cannot sink the p95 for everyone else.",
      learning: [
        "A stream is a partitioned log, not a work queue, and that distinction is the whole lesson. A message's key hashes to a partition, and inside a consumer group exactly one worker owns a given partition at a time - that ownership is what keeps a partition's messages in order, because a single owner processes them one at a time in arrival order. It also means a partition is a hard unit of parallelism: you cannot spread one partition's work across two workers without breaking the ordering guarantee that made you choose a stream in the first place, and a worker replica beyond the partition count simply sits idle.",
        "A slow consumer backs up only its own partition, not the stream. This is the mechanism worth internalizing: the other partitions have their own offsets and their own consumers, so a healthy partition keeps draining at full speed while a sick one queues up behind whatever is slowing it down. The system-wide symptom - the p95 you are graded on - blows out anyway, because a percentile does not care that the backlog lives in one lane; a fixed share of every window of requests is sitting in that lane's queue, and the tail statistic reports it faithfully. Watching only an aggregate 'consumer lag' metric hides exactly which partition is sick; watching per-partition lag is what tells you where to look.",
        "The fix is capacity in the dimension that actually failed: more partitions, so a given key's messages share the load across more independent lanes and a bad day for one lane's consumer punishes a smaller slice of traffic, and enough worker replicas that every partition actually has a dedicated consumer rather than several partitions queueing behind one busy worker. Doubling partitions without adding workers does nothing - it just changes which subset of keys shares a lane. The production pattern is to size partition count for your target parallelism up front, because repartitioning a live topic changes which worker owns which key and is disruptive to run, unlike adding stateless server replicas behind a load balancer.",
        "Consumer groups multiply this arithmetic rather than dividing it: every consumer group reads every message independently, so three consumer groups reading the same stream is three times the delivery work, not a three-way split of one delivery. That is a deliberate cost - it is how one upload event feeds a search indexer, an analytics pipeline and an audit log without any of them touching the others' offsets - but it means adding a second consumer group to a stream is a capacity decision on the stream itself, not a free multiplexing trick.",
        "What this model idealizes: a partition's consumer either is or is not slow, with no partial degradation, and rebalancing when a worker joins or leaves is instantaneous and free. Real consumer groups spend real seconds rebalancing when membership changes, during which a partition can sit briefly unowned, and a genuinely hot key can overload a single partition no matter how many partitions the topic has, because a partition is only as parallel as the number of distinct keys that hash into it. The number to take away is the shape: ordering is priced in partitions, and the price of too few of them is that one bad lane becomes everyone's tail latency.",
      ],
      hints: [
        "Look at where the backlog is actually sitting: check the per-partition wait times and the queue depth, not just the aggregate p95.",
        "Work out how many partitions and dedicated worker replicas you need so that a single slow consumer only ever affects one partition's share of the traffic, not the whole request rate.",
        "Raise the stream's partition count and add worker replicas so every partition has its own consumer, keeping the two numbers matched to each other.",
      ],
      objectives: [objective("p95", "lte", 100), objective("errorRate", "lte", 0.01), queueDepth(55)],
      architecture: streamStarter,
      reference: streamReference,
      workload: workload({
        requestRate: 100,
        readRatio: 0,
        duration: 20,
        seed: 5301,
        failures: [{ kind: "slow-partition", at: 0.3, duration: 6, factor: 20 }],
      }),
      allowedKinds: ["server", "stream", "database"],
      estimation: estimate("queueDepth", "throughput"),
      defense: defense({
        followUps: [
          "Traffic 10x's overnight. Does adding partitions alone fix your headroom, or do you need something else too? Explain the coupling.",
          "The consumer for one partition dies outright instead of merely slowing down. What does the stream do with its in-flight messages, and what does your worker need to handle correctly when they come back?",
          "The product now needs a second, independent pipeline to read the same upload events for analytics. What do you add, and what does it cost the stream?",
          "The on-call engineer gets paged at 3 a.m. for high p95. What single graph would tell them in ten seconds whether this is a partitioned-streams problem rather than something else?",
        ],
        rubric: rubric([
          ["mechanism", "States that a partition is owned by exactly one worker per consumer group and that this is what keeps it ordered and what limits its parallelism", 25],
          ["diagnosis", "Identifies that a slow consumer backs up only its own partition, and explains why that still moves the aggregate p95", 25],
          ["fix", "Sizes partitions and worker replicas together, explaining why raising one without the other does not help", 25],
          ["limits", "Names a remaining weak point: a single hot key overloading one partition, or rebalancing time when membership changes", 25],
        ]),
        modelAnswer:
          "With two partitions and two workers, one partition's consumer slowing to a twentieth of its speed for six seconds backs up that lane badly - messages queue up waiting for their single owning worker - and because a fixed share of all traffic hashes onto that partition, the system-wide p95 blows past the objective even though the other partition keeps draining normally and the error rate stays low. The fix is not more capacity in the abstract; it is more independent lanes. I raised the stream to eight partitions and matched it with eight worker replicas, so each partition's share of traffic is a smaller slice and each has its own dedicated consumer rather than sharing one across several partitions. When the same slow-partition event now hits one lane, it delays roughly an eighth of traffic instead of half, and the aggregate p95 stays inside budget. The remaining risk is a single very hot key: no partition count fixes a workload where one key gets a disproportionate share of traffic, because that key always hashes to the same lane, so I would watch per-partition throughput for skew as closely as I watch per-partition lag.",
      }),
      reflection: {
        question: "A stream's consumer for partition 3 slows to a crawl for ten seconds. What happens to partitions 0, 1 and 2 in the same consumer group?",
        options: [
          "Their consumers keep draining normally; only partition 3's messages back up",
          "All four partitions back up equally, because the stream throttles the whole topic when any consumer is slow",
          "The stream automatically reassigns partition 3's messages to another worker to keep throughput even",
          "The other partitions pause until partition 3 recovers, to preserve global ordering across the topic",
        ],
        answer: 0,
        explanation:
          "A partition is an independent FIFO lane with its own offset and its own consumer. A slow or dead consumer stalls only the partition it owns; the other partitions have their own workers and keep processing at full speed. What changes system-wide is a percentile statistic like p95, which reports the delay some fraction of all requests experienced - and if enough traffic hashes onto the sick partition, that is enough to blow the aggregate tail even though most of the system is healthy.",
      },
    }),

    lesson({
      id: "split-brain",
      chapter: chapterTitles[9],
      title: "Two leaders, one ledger",
      subtitle: "A network partition and heartbeat election elect a second leader that nobody asked for.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Leader election & split brain",
      brief:
        "A ledger API takes 200 requests per second, half of them writes, against a three-replica leader-follower database using heartbeat election. Four seconds into the run, a network partition splits one replica from the other two for a few seconds. The isolated replica cannot tell a dead leader from an unreachable one, so heartbeat election gives it a leader of its own - now two replicas are both accepting writes, and one side's writes are discarded the moment the network heals. Change how this database decides who is allowed to lead so that never happens again, without letting the error rate get out of hand.",
      learning: [
        "Heartbeat election answers one question - is the leader still sending heartbeats? - and a network partition makes that question unanswerable in the way that matters. The isolated replica stops hearing from the leader and, following its own rules, correctly concludes it should elect a new one. Nothing in that replica's local view distinguishes 'the leader died' from 'I can no longer reach the leader', and both look identical from inside a partition. The result is two replicas that each believe, with complete local justification, that they are the one true leader - and both keep accepting writes, because nothing on either side tells them otherwise.",
        "Split brain is expensive specifically because both leaders keep answering. The majority side looks completely healthy to its clients throughout; the minority side also looks healthy to its clients, right up until the partition heals. At that point one side's writes have to be thrown away - there is no way to merge two independently-advanced copies of a ledger without a conflict resolution policy, and the simplest and most common one is 'the minority loses', which is silent data loss from the point of view of whoever was talking to that side. This is why the metric that matters here is not just error rate; it is writes that were accepted and then discarded, which never shows up as an error to the client who made them.",
        "Consensus election refuses to answer the question heartbeats cannot answer. Instead of asking 'have I heard from the leader lately', a consensus protocol like Raft asks 'can I currently reach a majority of the replicas', and a leader must hold that majority to keep leading, must renew it continuously to keep leading, and a candidate must win it to start leading. In a partition, the minority side can count its own reachable replicas and see that it does not have a majority, so it refuses to elect anyone and refuses new writes rather than accepting them speculatively. Nothing is ever accepted twice, because at most one side can ever hold a majority at the same time - that is a property of majorities over a fixed replica count, not a property that needs to be separately verified.",
        "The trade consensus makes is visible, not hidden: the minority's clients get real, honest errors instead of writes that look successful and later vanish. That is why the error-rate objective on this mission has real teeth - a consensus design will show a higher error rate than a split-brain design's client-visible error rate during the same partition, because it is converting invisible data loss into visible, retriable failure. A shorter election timeout gets the majority side back to writing sooner and narrows that window, which is the one knob left to turn once the election strategy itself is fixed.",
        "What this model idealizes: only one clean network partition occurs, both sides can always tell how many replicas they can currently reach, and there is no such thing as a partial or flapping partition that repeatedly splits and heals. Real distributed systems add fencing tokens, leases and witness nodes precisely because reachability checks are noisier and slower than this model assumes, and a 'majority' becomes a genuinely hard question when the network is flaky rather than cleanly split. The number to take away is the shape: heartbeat election is a bet that unreachable means dead, and every partition is a chance for that bet to be wrong in exactly the way that produces two leaders.",
      ],
      hints: [
        "Check the events around the partition: look at which replica is treated as isolated and what each side of the split does with writes during that window.",
        "Work out what would have to be true for the isolated side to refuse to elect a new leader instead of electing one - what does it need to know that a heartbeat alone cannot tell it?",
        "Change the database's election strategy to the one that requires agreement from a majority of replicas before anyone is allowed to lead, and reconsider how quickly it should decide.",
      ],
      objectives: [conflicts(0), objective("errorRate", "lte", 0.06), objective("p95", "lte", 65)],
      architecture: splitStarter,
      reference: splitReference,
      workload: workload({
        requestRate: 200,
        readRatio: 0.5,
        duration: 20,
        seed: 6101,
        failures: [{ kind: "partition", at: 0.4, duration: 4 }],
      }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("p95", "throughput"),
      defense: defense({
        followUps: [
          "The partition lasts thirty seconds instead of a few. Does consensus election's error rate stay proportional, and what would you tell the on-call engineer to expect?",
          "The product now wants the isolated side to keep serving reads even though it cannot write. Does your election choice allow that, and what staleness does it imply?",
          "The on-call engineer gets paged at 3 a.m. for a spike in database errors. What one metric tells them this is a partition-and-election issue rather than an overload issue?",
          "How would you detect, from monitoring alone, that a split-brain incident happened last week even though nobody reported an outage at the time?",
        ],
        rubric: rubric([
          ["mechanism", "Explains why heartbeat election cannot distinguish an unreachable leader from a dead one, and why that produces two leaders during a partition", 25],
          ["evidence", "Cites the measured conflicting and discarded writes under heartbeat election and their absence under consensus", 25],
          ["tradeoff", "States the trade consensus makes explicitly: refused writes and a higher visible error rate in exchange for zero silent data loss", 25],
          ["headroom", "Justifies the election timeout choice and names what a longer or shorter one would cost", 25],
        ]),
        modelAnswer:
          "Under heartbeat election, the replica cut off by the partition cannot tell that the leader is merely unreachable rather than dead, so it elects its own leader after the timeout and both sides keep accepting writes for the rest of the partition; when the network heals, the minority's writes are discarded, which the measurements show as a large number of conflicting and lost writes even though the client-visible error rate stayed low - the isolated side looked healthy the whole time. I switched the database to consensus election, which requires a majority of replicas to agree before anyone leads. During the same partition, the minority side can count that it no longer has a majority and refuses new writes outright instead of accepting them speculatively, so conflicting and lost writes both go to zero. The cost is that those refused writes now show up as real errors to the minority's clients, so the error rate rises - that is the trade, made visible instead of hidden. I kept the election timeout short so the majority side recovers a leader quickly once the partition is confirmed, which limits how long that elevated error rate lasts without reintroducing the two-leader risk a longer, more heartbeat-like timeout would bring back.",
      }),
      reflection: {
        question: "A leader-follower database switches from heartbeat to consensus election. During a network partition, what is the most accurate description of the change?",
        options: [
          "Errors that used to be invisible (writes silently discarded later) become visible (writes refused immediately), and no write is ever accepted twice",
          "The database becomes fully available during the partition, since consensus is a strictly better algorithm than heartbeat",
          "The partitioned replica now waits for the network to heal before doing anything, avoiding both errors and lost writes",
          "Consensus prevents the partition itself from happening, so the failure never reaches the clients at all",
        ],
        answer: 0,
        explanation:
          "Consensus does not make a partition survivable for both sides - it makes the unsafe side refuse to pretend it is safe. The side that cannot reach a majority stops accepting writes and returns real errors instead of quietly taking writes it will later have to throw away. That is a strictly more honest failure mode, not a disappearance of the failure: total write capacity during the partition goes down, which is exactly why the error rate rises even as data safety improves.",
      },
    }),
  ],
};
