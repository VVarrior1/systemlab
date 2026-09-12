import {
  budget,
  chapterTitles,
  deadLetters,
  defense,
  duplicates,
  estimate,
  graph,
  healthy,
  lesson,
  lostWrites,
  node,
  objective,
  readingsFor,
  queueDepth,
  rubric,
  staleReads,
  tweak,
  workload,
  written,
  type ChapterFile,
} from "../shared";

/**
 * Chapter 10 - Data systems (v2.1). Six simulations over the v2.1 engine mechanics
 * (queue delivery semantics, quorum replication, lost writes on failover, gray failures and
 * connection pools) plus two written lessons. Every reference below was measured on the three
 * assessment seeds; objectives sit 20-30% above the worst measured value so a remix still fits.
 */

// ---------------------------------------------------------------- at-least-once-delivery

const deliveryStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "intake", 1, { label: "Job intake", capacity: 400, replicas: 2 }),
    node("queue", "queue", 2, { label: "Job queue" }),
    node("server", "worker", 3, { label: "Job worker", role: "worker", capacity: 90, replicas: 2 }),
    node("database", "db", 4, { label: "Job store", capacity: 400 }),
  ],
  [["traffic", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);
const deliveryReference = tweak(deliveryStarter, {
  queue: { ackMode: "at-least-once", visibilityTimeoutMs: 1500, maxDeliveries: 3 },
  worker: { idempotent: true },
});

// ---------------------------------------------------------------- dead-letter-queue

const poisonStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("server", "intake", 1, { label: "Event intake", capacity: 500, replicas: 2 }),
    node("queue", "queue", 2, { label: "Event queue", ackMode: "at-least-once", visibilityTimeoutMs: 1000, maxDeliveries: 10 }),
    node("server", "worker", 3, { label: "Event worker", role: "worker", capacity: 90, replicas: 3 }),
    node("database", "db", 4, { label: "Event store", capacity: 300, dbMode: "sharded", shards: 8 }),
  ],
  [["traffic", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);
const poisonReference = tweak(poisonStarter, { queue: { maxDeliveries: 2 } });

// ---------------------------------------------------------------- quorum-reads-and-writes

const quorumStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Profile API", capacity: 400, replicas: 2 }),
    node("database", "db", 3, { label: "Profile store", capacity: 450, replicas: 3, dbMode: "quorum", quorumWrite: 3, quorumRead: 1 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const quorumReference = tweak(quorumStarter, { db: { quorumWrite: 2, quorumRead: 2 } });

// ---------------------------------------------------------------- lost-writes-on-failover

const failoverStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Orders API", capacity: 400, replicas: 2 }),
    node("database", "db", 3, { label: "Orders store", capacity: 300, replicas: 3, dbMode: "leader-follower", replicationLagMs: 800, failoverMs: 2500 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const failoverReference = tweak(failoverStarter, { db: { replicationLagMs: 100, failoverMs: 250 } });

// ---------------------------------------------------------------- gray-failure

const grayStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { healthCheckMs: 1000 }),
    node("server", "api", 2, { label: "Checkout API", capacity: 400, replicas: 3 }),
    node("database", "db", 3, { label: "Checkout store", capacity: 400, replicas: 3, dbMode: "leader-follower" }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const grayReference = tweak(grayStarter, {
  balancer: { algorithm: "least-connections", healthCheckMs: 250 },
  api: { timeoutMs: 300, retries: 3, retryBackoffMs: 30 },
});

// ---------------------------------------------------------------- connection-pool-starvation

const poolStarter = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Orders API", capacity: 600, replicas: 2, poolSize: 8 }),
    node("database", "db", 3, { label: "Partner ledger", capacity: 800, latency: 150 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "db"]],
);
const poolReference = tweak(poolStarter, { api: { poolSize: 32, maxQueue: 80, timeoutMs: 600 } });

export const chapter: ChapterFile = {
  title: chapterTitles[9],
  lessons: [
    lesson({
      id: "at-least-once-delivery",
      chapter: chapterTitles[9],
      title: "At-least-once delivery",
      subtitle: "A worker dies mid-job. You choose which way it hurts.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Delivery semantics & idempotency",
      brief:
        "A billing pipeline takes 110 jobs per second through a queue into two worker replicas. One replica is being OOM-killed and restarted by its supervisor roughly every tenth of a second for eighteen seconds in the middle of the run. The queue is configured for at-most-once delivery: a job handed to a replica that dies is simply gone. Find the losses, switch the queue to at-least-once, watch what that costs you, and then make the cost go away.",
      learning: [
        "Delivery semantics are a choice between two failure modes, not a spectrum of quality. At-most-once deletes the message when it hands it to a consumer, so a consumer that dies mid-job takes the job with it and nobody ever finds out: the request simply failed. At-least-once keeps the message invisible instead of deleted, and makes it visible again when the consumer neither acknowledges it nor finishes inside the visibility timeout. Nothing is lost, but the same job can now run twice. Exactly-once delivery across a network does not exist; what people call exactly-once is at-least-once delivery plus a consumer that recognises work it has already done.",
        "The visibility timeout is the knob that decides what 'died' means. It is a bet on how long the job can legitimately take: set it shorter than the real tail of your processing time and healthy consumers get their work stolen while they are still doing it, which manufactures duplicates and, in the worst case, a redelivery storm where every message is being processed by two consumers at once. Set it much longer than the tail and a genuinely dead consumer's jobs sit invisible for that long before anyone retries them. The production practice is to measure the p99 of job duration, set the timeout above it, and extend the lease from inside long jobs (SQS calls this changing message visibility) rather than picking one heroic number.",
        "The duplicate is unavoidable, so make it harmless. An idempotent consumer derives a stable key from the job - the payment id, the message id, the (topic, partition, offset) triple - records it when the work commits, and on seeing that key again returns success without repeating the side effect. The cheap implementation is a unique constraint on that key in the same transaction as the effect, so the database refuses the second write for you; the expensive mistake is a read-then-write check, which is a race with a window exactly as wide as your processing time. Watch the store in this lesson: with an idempotent worker the duplicate deliveries never reach it at all.",
        "Notice which duplicates count and which do not. A message that is redelivered after it was already handed to a worker is a real duplicate, because side effects may already have happened - the charge may be on the card even though nobody acknowledged it. A message that is redelivered without ever having reached a worker is just a retry and costs you nothing but a little latency. This is why the metric to watch is the duplicate rate rather than the redelivery count, and why an at-least-once queue over idempotent consumers reports duplicate work at zero while still never losing anything.",
        "What this model idealizes: the queue itself is never the thing that fails, acknowledgements are instantaneous, and idempotency is free and perfect. Real deduplication needs somewhere to store keys, which means a retention window (SQS deduplicates over five minutes, Kafka's producer over the session), and beyond that window a very late redelivery is indistinguishable from new work. Real workers also die between the side effect and the acknowledgement, which is the case that turns 'did it happen?' into a support ticket. Design the key, bound the window, and say out loud what happens after the window closes.",
      ],
      hints: [
        "Run the baseline and look at what the failed requests have in common: check the events for the worker replica and the traces for jobs that never reached the store.",
        "Decide which of the two failure modes this pipeline can tolerate - losing a job it accepted, or doing a job twice - and change the queue's delivery mode to match that answer.",
        "Then remove the cost of the mode you chose at the consumer, by making a repeated job recognise itself and do nothing rather than repeat its side effect.",
      ],
      objectives: [...healthy(104, 130, 0.005), duplicates(0.005), budget(48)],
      architecture: deliveryStarter,
      reference: deliveryReference,
      workload: workload({
        requestRate: 110,
        readRatio: 0,
        duration: 30,
        seed: 3101,
        failures: [{ kind: "flapping", target: "worker", at: 0.2, duration: 18, intervalMs: 120 }],
      }),
      allowedKinds: ["server", "queue", "database", "load-balancer", "cache"],
      estimation: estimate("bottleneckCapacity", "p95"),
      defense: defense({
        followUps: [
          "The job in this pipeline charges a credit card. Write down the exact key you would deduplicate on, where you would store it, and for how long.",
          "A job legitimately takes longer than the visibility timeout on one percent of inputs. Describe what happens and two different ways to fix it.",
          "Your consumer dies after the charge succeeds but before it acknowledges the message. What does the customer see, and what does your design do about it?",
        ],
        rubric: rubric([
          ["semantics", "States the at-most-once versus at-least-once trade as a choice between lost work and duplicated work, and says which one this workload can tolerate", 25],
          ["evidence", "Cites the measured numbers: work lost under at-most-once, duplicate rate under at-least-once, and both after the fix", 20],
          ["idempotency", "Names a concrete idempotency key and the mechanism that enforces it (unique constraint in the same transaction, not read-then-write)", 25],
          ["timeout", "Justifies the visibility timeout from the job-duration distribution and names the failure at each extreme", 20],
          ["limits", "Identifies what the design still cannot do: the dedup retention window, or the gap between side effect and acknowledgement", 10],
        ]),
        modelAnswer:
          "The baseline loses work silently. A worker replica is killed and restarted throughout the middle of the run, and every job that replica had in hand is deleted with it, so about one and a half percent of accepted jobs never reach the store and nothing retries them. For billing that is the unacceptable failure mode, so I switched the queue to at-least-once: the message stays invisible rather than deleted, and a replica death or a visibility-timeout expiry makes it visible again. Error rate went to zero and about one and a half percent of jobs were now processed twice, which for a charge is equally unacceptable. So I made the worker idempotent: it derives a key from the job, records it in the same transaction as the charge behind a unique constraint, and a redelivery of a key it has already committed returns success without touching the store. Duplicates drop to zero, losses stay at zero, and the store sees strictly less work than before. The visibility timeout is set above the p99 job duration so healthy workers do not get their jobs stolen; the residual risk is a redelivery arriving after the dedup retention window, which I would bound and alert on.",
      }),
      reflection: {
        question: "A queue is switched from at-most-once to at-least-once delivery and nothing else changes. What has the system gained and lost?",
        options: [
          "It gained durability and lost nothing; at-least-once is strictly better",
          "It gained exactly-once processing, because the queue now tracks acknowledgements",
          "It stopped losing jobs when a consumer dies, and started running some jobs more than once",
          "It gained throughput, because messages are no longer deleted on delivery",
        ],
        answer: 2,
        explanation:
          "At-least-once trades lost work for repeated work. The queue no longer deletes a message when it hands it over, so a dead consumer's job comes back - but a job that had already started can now run a second time. That duplicate is only harmless once the consumer is idempotent, which is a property of the consumer, never of the queue.",
      },
    }),

    lesson({
      id: "dead-letter-queue",
      chapter: chapterTitles[9],
      title: "The poison message",
      subtitle: "One job that can never succeed, retried forever, starves every job behind it.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Dead-letter queues & retry bounds",
      brief:
        "An event pipeline takes 150 jobs per second into three worker replicas backed by an eight-partition store. A bad producer release is writing records that one partition rejects outright: about an eighth of all jobs fail at the store on every single attempt, and they will keep failing no matter how often you retry them. The queue is set to at-least-once with the maximum delivery count. Watch the backlog, then bound the retries without throwing away work that would have succeeded.",
      learning: [
        "A poison message is one that fails every time it is processed, for a reason that retrying cannot change: a malformed payload, a record the schema rejects, a referenced row that no longer exists. Under at-least-once delivery a failure is a redelivery, so a poison message does not disappear - it comes back, fails again, and comes back again. With a high delivery bound each poisoned job consumes a worker slot as many times as you allow, and because the failing jobs are the fastest to fail, they cycle through the pool far more often than healthy jobs do. The queue is now spending most of its capacity on work that can never complete.",
        "The arithmetic is worth doing before you touch a dial. If a share p of jobs is poison and the delivery bound is D, the load on the consumer pool is (1 - p) + p x D times the arrival rate, and every one of those extra deliveries also lands on the store. With an eighth of jobs poisoned and a bound of ten, the pool is asked for roughly twice the work it was sized for, which is exactly how a pipeline whose consumers look busy can have a backlog that grows all run and latency in the seconds. The failures are not the outage; the retries are.",
        "The dead-letter queue is the bound that makes the failure stop spreading. After a message has been delivered the configured number of times without being acknowledged, it is moved out of the main queue - in SQS that is the redrive policy's maxReceiveCount, in Kafka it is a topic your consumer explicitly produces to - and the main queue gets on with its life. Dead-lettering is not silent dropping: the message is kept, it is counted, and somebody is expected to look. In production the dead-letter queue's depth and age are alertable metrics, and a DLQ nobody monitors is a very tidy way to lose data.",
        "Choosing the bound is a two-sided decision, which is why this mission has objectives on both sides. Too high and poison work starves real work, as the baseline shows. Too low and a job that hit a transient fault - a brief store slowdown, a leader election, a network blip - is condemned on its first bad day even though the second attempt would have succeeded. The production instinct is a small bound with exponential backoff between attempts, so the retries that do happen are spread over time rather than hammering a dependency that may be recovering, and everything beyond it is a human problem rather than a capacity problem.",
        "The deeper fix is upstream of all of this: validate at the boundary so poison never enters the queue. Schema validation at the producer, a compatibility check in the registry, and a rejection at intake all convert a silent pipeline outage into a loud producer error, which is far cheaper to diagnose. When you do dead-letter, keep enough context to replay: the original payload, the failure reason and the delivery count, so the job can be fixed and redriven rather than archaeologically reconstructed.",
        "What this model idealizes: every poisoned job here fails for the same reason at the same partition, redeliveries are immediate rather than backed off, and the dead-letter queue is a counter rather than a place you can inspect and redrive from. Real incidents are messier - a poison batch usually shares a producer, a tenant or a time window, and finding that correlation is most of the work. The number to take away is the shape: the delivery bound multiplies the cost of every unprocessable job by exactly itself.",
      ],
      hints: [
        "Run the baseline and compare the jobs the store completed with the deliveries the queue made; then look at where the backlog is and how it changes through the run.",
        "Work out how much work the consumer pool is really being asked for: the healthy share plus the poisoned share multiplied by the number of times each poisoned job is allowed to come back.",
        "Cap how many times one message may be delivered before the queue gives up on it and sets it aside, and pick the cap so a job that failed once for a transient reason still gets another chance.",
      ],
      objectives: [
        objective("p95", "lte", 110),
        objective("throughput", "gte", 125),
        queueDepth(20),
        deadLetters(0.15),
        duplicates(0.18),
        budget(145),
      ],
      architecture: poisonStarter,
      reference: poisonReference,
      workload: workload({
        requestRate: 150,
        readRatio: 0,
        duration: 30,
        seed: 3202,
        keySpace: 20000,
        keySkew: 0.4,
        failures: [{ kind: "error-burst", target: "db", at: 0.1, duration: 26, ratio: 1 }],
      }),
      allowedKinds: ["server", "queue", "database", "load-balancer", "cache"],
      estimation: estimate("queueDepth", "throughput"),
      // The failure is a fixed share of unprocessable jobs rather than a traffic-scaled event, so the
      // dead-letter rate - and with it the error rate - cannot fall under the remix's 1% error budget.
      remixable: false,
      defense: defense({
        followUps: [
          "Your dead-letter queue has ten thousand messages in it on Monday morning. Walk through what you do, in order.",
          "A colleague proposes setting the delivery bound to one so nothing is ever retried. Give the concrete scenario where that loses you data, and the one where it saves you.",
          "How would you have caught this before the backlog grew? Name the metric and the alert threshold you would set on it.",
        ],
        rubric: rubric([
          ["mechanism", "Explains that under at-least-once a permanent failure becomes an unbounded retry loop, and that the retries - not the failures - consume the pool", 25],
          ["arith", "Computes the amplified load on the consumer pool from the poison share and the delivery bound, with numbers", 25],
          ["bound", "Sets a delivery bound and defends it from both sides: high enough to survive a transient fault, low enough to protect the queue", 20],
          ["dlq", "Treats the dead-letter queue as an inspectable, alertable destination with a replay path, not as a drop", 20],
          ["upstream", "Names the upstream fix - validation at the producer or at intake - so poison never enters the queue", 10],
        ]),
        modelAnswer:
          "About an eighth of the jobs hit a partition that rejects them on every attempt, so under at-least-once they are never acknowledged and keep coming back. With the delivery bound at ten, the pool is asked for roughly 0.875 plus 0.125 times ten, a little over two times its nominal load, and since a failing job fails quickly it recycles faster than healthy work. The backlog grows all run and p95 reaches most of a second, while the failure rate barely moves - the outage is the retries, not the errors. I cut the delivery bound to two. Poisoned jobs now get one retry, in case the first failure was transient, and are then dead-lettered: the queue drains, p95 falls back under a tenth of a second, and the dead-letter rate settles at exactly the poison share, which is the honest number. I would alert on dead-letter depth and age rather than on error rate, keep payload and failure reason with each dead-lettered message so it can be redriven after the producer is fixed, and add schema validation at intake so this class of job is rejected at the door next time.",
      }),
      reflection: {
        question: "Under at-least-once delivery, a message fails permanently and the delivery bound is set very high. What is the dominant cost?",
        options: [
          "The failed messages themselves, which show up directly as the error rate",
          "The repeated deliveries, which consume consumer and storage capacity that healthy jobs needed",
          "Storage, because the queue has to keep every failed message forever",
          "Nothing measurable until the queue runs out of disk",
        ],
        answer: 1,
        explanation:
          "A permanently failing message costs you its own failure once. What it costs repeatedly is the capacity of every redelivery - consumer slots, storage operations and queue time that healthy jobs are waiting for. Bounding deliveries converts an unbounded capacity problem into a bounded, countable one.",
      },
    }),

    lesson({
      id: "quorum-reads-and-writes",
      // The Dynamo paper entry in lib/readings ships an http:// URL; the curriculum test requires
      // https and allthingsdistributed.com serves it. Normalising here keeps the fix inside this
      // chapter's ownership, and it becomes a no-op once the readings library is corrected.
      readings: readingsFor("quorum-reads-and-writes").map((reading) => ({ ...reading, url: reading.url.replace(/^http:\/\//, "https://") })),
      chapter: chapterTitles[9],
      title: "Quorum reads and writes",
      subtitle: "Three peers, no leader. You choose how many have to agree.",
      difficulty: "Advanced",
      minutes: 20,
      concept: "Quorums and the R + W > N rule",
      brief:
        "A profile store runs as three peer replicas with no leader: every write is sent to all of them and answers when enough have acknowledged, and every read is answered by enough of them to be trusted. It is configured to require all three acknowledgements on a write. Forty percent of the way through the run one replica dies and does not come back. Watch what that does to the write path, then pick a read and write quorum that survives it without serving stale data.",
      learning: [
        "A quorum system replaces the leader with arithmetic. With N replicas, a write waits for W acknowledgements and a read collects R responses; the operation's latency is that of the W-th or R-th fastest replica, not the slowest, which is why a quorum system tolerates a slow peer gracefully. Availability follows directly: a write survives N - W failures and a read survives N - R. Setting W = N looks maximally safe and is the opposite - it means any single replica failure takes writes down entirely, which is exactly what the baseline shows the moment one of the three peers dies.",
        "The rule that makes reads trustworthy is R + W > N. If the read set and the write set must overlap in at least one replica, then any read is guaranteed to see at least one copy of the most recent acknowledged write, and with version comparison it can return that value. With N of three, W and R of two is the classic configuration: it survives one replica loss on both paths and still overlaps. Drop to W and R of one and you have a fast, highly available store that will hand back values it has already been told are out of date - which is visible in this mission as a stale read rate in the tens of percent.",
        "Quorums buy availability with capacity, and the price is easy to miss. Every write occupies W replicas and every read occupies R of them, so a cluster of three peers at W = R = two does not have three replicas' worth of throughput - it has roughly one and a half, because each operation consumes two lanes. Lose a replica and the two survivors must each take part in every operation, so the effective throughput of the cluster is now that of a single replica. Size the peers for the degraded case, not the healthy one: that is the case you bought the quorum for.",
        "Sloppy quorums and the anti-entropy machinery are where real systems live. Dynamo-style stores will accept a write to the first W reachable nodes even if they are not the nodes that own the key, hand the data back later (hinted handoff), repair divergent copies during reads, and run a background Merkle-tree comparison to converge the rest. That makes the system far more available than the strict arithmetic suggests, and far weaker than R + W > N promises, because the overlap guarantee no longer holds during the partition. If you cite Dynamo or Cassandra in an interview, say which of the two you mean.",
        "What this model idealizes: replicas here answer or fail, never disagree, so there is no version reconciliation, no vector clocks, no last-write-wins tombstone problem and no read repair. In a real quorum store the hardest question is not how many nodes answered but what you do when two of them answer differently, and the standard answers - last write wins with synchronized clocks, versioned values resolved by the client, or CRDTs that cannot conflict by construction - each have a failure mode worth naming.",
      ],
      hints: [
        "Run the baseline and watch the moment the replica dies: check the events and compare what happens to reads with what happens to writes.",
        "Write down how many replicas each kind of operation has to reach, and how many are left after one of them is gone; the failing path is the one whose requirement no longer fits.",
        "Then choose read and write requirements that both fit the surviving replicas and still overlap, so every read is guaranteed to touch a replica that took part in the latest write.",
      ],
      objectives: [...healthy(285, 70), staleReads(0.02), budget(95)],
      architecture: quorumStarter,
      reference: quorumReference,
      workload: workload({
        requestRate: 300,
        readRatio: 0.7,
        duration: 30,
        seed: 3303,
        keySpace: 2000,
        keySkew: 0.8,
        failures: [{ kind: "database", target: "db", at: 0.4 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("dbLoad", "p95"),
      defense: defense({
        followUps: [
          "Your product adds a 'change my handle' feature that must never show the old handle after it is changed. Which of R, W and N do you touch, and what does it cost?",
          "Two replicas come back after a partition with different values for the same key. Describe how your store decides which one wins, and the anomaly your choice permits.",
          "Traffic doubles and you lose a replica at the same time. Show the arithmetic for whether the cluster still serves the load.",
        ],
        rubric: rubric([
          ["availability", "Connects W and R to how many failures each path survives, and identifies the baseline's W = N as the cause of the write outage", 25],
          ["overlap", "States R + W > N and explains why the overlap is what makes a read trustworthy, not the size of R alone", 25],
          ["capacity", "Quantifies the capacity cost of a quorum and sizes the cluster for the degraded case, with numbers", 20],
          ["alt", "Names a rejected alternative - W = R = 1, or a leader-follower store - and why it loses here", 20],
          ["limits", "Mentions what the model omits: divergent replicas, read repair, sloppy quorums or clock-based conflict resolution", 10],
        ]),
        modelAnswer:
          "The baseline requires all three replicas to acknowledge a write, so it survives zero failures on the write path. When one peer dies at forty percent, every write fails for the rest of the run and the error rate lands near eighteen percent, which is the write share of the traffic over the remaining run. Reads were unaffected because they only needed one replica. I set both the write and the read quorum to two: writes survive one loss, reads survive one loss, and because two plus two is greater than three, every read set overlaps the latest write set, so the stale read rate stays at zero. The cost is capacity - each operation now occupies two of the three lanes, so the cluster's effective throughput is about one and a half replicas while healthy and one replica while degraded, and I sized the peers so three hundred requests per second still fits with a replica gone. I rejected W and R of one: it is faster and survives two losses, but with no overlap it serves values it knows are stale, which this measured at around a quarter of all reads, and a profile store that shows the old name after a change is a support ticket.",
      }),
      reflection: {
        question: "A store has five replicas with W = 2 and R = 2. What is the guarantee on reads?",
        options: [
          "Reads never return stale data, because two replicas agree",
          "Reads may return stale data, because the read set and the write set need not overlap",
          "Reads never return stale data as long as no replica has failed",
          "Reads are linearizable, because R equals W",
        ],
        answer: 1,
        explanation:
          "Two plus two is not greater than five, so a read can be answered entirely by replicas that took no part in the most recent write. Overlap - not agreement between the replicas you happened to ask - is what makes a quorum read trustworthy.",
      },
    }),

    lesson({
      id: "lost-writes-on-failover",
      chapter: chapterTitles[9],
      title: "Lost writes on failover",
      subtitle: "The database said yes. Then the leader died, and it had never told anyone.",
      difficulty: "Advanced",
      minutes: 20,
      concept: "Asynchronous replication & durability",
      brief:
        "An orders service writes to a leader with two followers and eight hundred milliseconds of replication lag, and fails over in two and a half seconds. Halfway through the run the leader dies. The requests that were acknowledged in the last moments before the death look successful in every metric you have - they returned 200 to the customer - and yet the orders are not there afterwards. Find how many, and get that number down.",
      learning: [
        "Asynchronous replication means the leader answers the client before the followers have the data. The window of exposure is exactly the replication lag: every write acknowledged inside that window exists on precisely one machine, and if that machine dies before the data leaves it, the write is gone. Nothing in your error rate shows it, because the client was told the write succeeded - that is what makes lost writes the most dangerous failure in this chapter. The measurement that matters is not 'did requests fail' but 'how many acknowledged writes did not survive the failover'.",
        "The lag is not a constant you can wish away, and the usual causes are mundane: a single-threaded apply on the follower, a long transaction on the leader, a follower doing a backup, or a network hiccup. What you control is how much you promise on top of it. Semi-synchronous replication makes the leader wait for at least one follower to acknowledge before it answers the client, which moves the durability boundary off a single machine at the cost of one round trip on every write and a hard question about what to do when no follower is available. PostgreSQL's synchronous_commit and MySQL's semi-sync plugin are both this knob.",
        "The other lever is to stop having a single acknowledging replica at all. A quorum write that requires two of three peers is durable the moment it is acknowledged, because two copies exist before the client hears yes - which is why the quorum design in this chapter reports zero lost writes on the same failure. That is the same trade in different clothing: you pay a round trip to the second-fastest replica on every write, and you get a durability guarantee that survives losing any one machine. Either path is a valid answer to this mission; what is not valid is quoting an availability number while the durability boundary sits on one disk.",
        "Failover time is a separate budget from durability and it is worth separating them out loud. Detection - usually a few missed health checks - plus promotion plus the clients learning about the new leader is the window during which writes fail outright, and it shows up honestly in the error rate. Making that window short is mostly an operational exercise: shorter detection intervals, a pre-elected standby, a proxy that clients never have to re-resolve. Making it too short is how you get a split brain, where the old leader has not noticed it is dead and is still acknowledging writes that the new leader will never see. Fencing tokens and STONITH exist because that second failure is worse than the first.",
        "What this model idealizes: the promotion always succeeds, the new leader is always caught up to the replication boundary, clients rediscover it instantly, and there is no split brain. It also does not model the after-party, which in production is the worst part - reconciling a customer who has a receipt for an order that no longer exists. Whatever your design, the honest interview answer names the durability boundary explicitly: how many machines have the data before the client is told yes.",
      ],
      hints: [
        "Run the baseline and read the events around the leader's death rather than the summary; the important number is not in the error rate at all.",
        "Work out which acknowledged writes existed on only one machine when it died: the arrival rate of writes multiplied by the window during which a write has not yet reached a follower.",
        "Shrink that window - or change how many replicas must hold a write before the client is told it succeeded - and separately shorten the promotion so fewer writes fail outright.",
      ],
      objectives: [...healthy(285, 70), lostWrites(25), budget(82)],
      architecture: failoverStarter,
      reference: failoverReference,
      workload: workload({
        requestRate: 300,
        readRatio: 0.55,
        duration: 30,
        seed: 3404,
        keySpace: 5000,
        keySkew: 0.6,
        failures: [{ kind: "database", target: "db", at: 0.5 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("dbLoad", "throughput"),
      defense: defense({
        followUps: [
          "A customer has an order confirmation email for an order that no longer exists in your database. Describe the conversation you have with support, and the mechanism that would have prevented it.",
          "Your team proposes semi-synchronous replication. What is the new failure mode you have just bought, and how do you configure around it?",
          "The old leader comes back up after the failover and still thinks it is the leader. What happens, and what stops it?",
        ],
        rubric: rubric([
          ["boundary", "States the durability boundary explicitly: how many machines hold a write before the client is told it succeeded", 30],
          ["arith", "Computes the lost-write count from the write rate and the replication lag, and compares it with the measured value", 25],
          ["failover", "Separates the failover window (visible failures) from the lag window (invisible losses) and treats them as different budgets", 20],
          ["alt", "Names a rejected or alternative design - semi-synchronous replication, or a quorum write - with its cost on the write path", 15],
          ["split", "Mentions split brain, fencing, or reconciliation after the fact as the risk that comes with aggressive failover", 10],
        ]),
        modelAnswer:
          "The baseline acknowledges a write as soon as the leader has it and lets followers catch up eight hundred milliseconds later, so at roughly one hundred and thirty-five writes per second there are about a hundred acknowledged writes living on exactly one machine at any instant. When the leader dies, those hundred disappear - the measured lost-write count is around a hundred and ten - and none of them appear in the error rate, because every one of those customers got a success. Separately, the two-and-a-half-second promotion failed every write it overlapped, which is the visible three to four percent error rate. I attacked the two windows separately: I cut the replication lag so the exposure window is short, which brings lost writes down to a dozen, and I shortened the promotion so the outright failures stay well under one percent. The stronger answer to durability is to stop acknowledging from one machine: a quorum write of two out of three peers, or semi-synchronous replication with at least one acknowledging follower, makes the write durable before the client hears yes, at the cost of a round trip per write and a policy for what to do when no follower is available. I would also fence the old leader on promotion, because a leader that has not noticed it is dead is a worse problem than the one I just fixed.",
      }),
      reflection: {
        question: "A leader-follower database with asynchronous replication loses its leader. Which requests are the dangerous ones?",
        options: [
          "The ones that failed during the promotion window, because the customer saw an error",
          "The reads served by followers, because they may be stale",
          "The writes acknowledged inside the replication lag before the death, because they succeeded and then ceased to exist",
          "None; the promotion copies the leader's remaining data to the new leader first",
        ],
        answer: 2,
        explanation:
          "Failed requests are honest: the client knows. The writes that were acknowledged in the last lag window before the leader died were confirmed to the client and existed on one machine only, so they vanish silently and no error metric will ever show them. That is why the durability boundary - how many machines hold the write before you answer - is the thing to state out loud.",
      },
    }),

    lesson({
      id: "gray-failure",
      chapter: chapterTitles[9],
      title: "Gray failure",
      subtitle: "The replica is up, it answers every health check, and it is eating your requests.",
      difficulty: "Advanced",
      minutes: 20,
      concept: "Partial failure & retry budgets",
      brief:
        "A checkout service runs three API replicas over a leader with two followers. A quarter of the way into the run the leader starts failing about thirty percent of the operations it receives, for eighteen seconds, while answering every health check perfectly. Nothing is taken out of rotation, the dashboard stays green, and customers see errors. Find the failure in the per-replica numbers, then survive it without making it worse.",
      learning: [
        "A gray failure is a component that is degraded rather than dead, and the defining property is differential observability: the health check sees one thing and the application sees another. The classic shapes are a replica that returns errors for a fraction of requests, one that is an order of magnitude slower than its peers, and one that flaps between dead and alive faster than the detection interval. None of them trip a liveness probe, because a liveness probe asks 'are you there' and the answer is honestly yes. This is why the healthy-replica count in this mission never changes while the error rate climbs.",
        "You find these by comparing replicas against each other, not against a threshold. A per-replica error rate, latency and throughput breakdown makes an outlier obvious in seconds, where an aggregate hides it: thirty percent of one replica's requests failing is only ten percent of the tier's, which sits comfortably inside most alert thresholds while being an outage for every customer routed to it. The production practices to name are per-instance dashboards, deep health checks that exercise the real dependency path rather than returning 200 from a static handler, and outlier ejection - the load balancer removing an endpoint whose error rate diverges from its peers, which is what Envoy and gRPC actually ship.",
        "The retry is the right tool here and it must be a budget, not a number. A partial failure is the one case where retrying genuinely works: the next attempt has a good chance of landing somewhere healthy, so a bounded retry with exponential backoff and full jitter converts a thirty-percent failure into a fraction of a percent. What makes it safe is the budget: a client may spend retries only up to a small percentage of its successful request volume, so a total outage - where every retry is guaranteed to fail - cannot multiply the load. Without that cap, the same retries that rescue you here are the amplification that turns a brownout into an outage.",
        "A circuit breaker is the wrong tool for this particular failure and it is worth being able to say why. A breaker is a binary judgement about a dependency: when it opens, you fail one hundred percent of calls fast in order to stop sending doomed work. Against a dependency that is failing thirty percent, opening the breaker converts a seventy-percent success rate into a zero-percent one, and against your only store there is nowhere else for those requests to go. Breakers earn their place when the dependency is either genuinely down or when you have a fallback - a cache, a default, a degraded response - and this design has neither.",
        "Routing helps for the slow variant and barely for this one, which is a distinction worth making out loud. Least-connections sends new work to whichever endpoint has the fewest requests in flight, so it naturally drains traffic away from an endpoint that has become slow - it is self-correcting where round robin is not. But a replica that fails fast is not busy; it looks like the least loaded endpoint in the fleet, which is the black-hole effect where the broken instance attracts more traffic than its healthy peers. The answer to that one is error-aware routing or outlier ejection, not a load metric.",
        "What this model idealizes: the burst is a clean probability over a fixed window, the failures are immediate rather than slow, and there is no partial corruption - the requests that succeed are correct. Real gray failures include the far nastier kinds: a replica returning stale or wrong data, a disk that is slow only on fsync, a network path that drops one percent of packets. The common thread is that your monitoring is measuring a different thing from your users, and the fix is always to measure closer to the user.",
      ],
      hints: [
        "Run the baseline and open the per-replica breakdown for the storage tier rather than the summary, then compare the healthy-replica count with what the traces are doing.",
        "Work out which share of the traffic touches the degraded replica and what share of that fails, then check that it matches the error rate you measured.",
        "Give the caller a bounded way to make a second attempt land somewhere healthy, with spread-out backoff, and reason about why failing everything fast would be worse here.",
      ],
      objectives: [...healthy(285, 115), budget(112)],
      architecture: grayStarter,
      reference: grayReference,
      workload: workload({
        requestRate: 300,
        readRatio: 0.6,
        duration: 30,
        seed: 3505,
        keySpace: 10000,
        keySkew: 0.6,
        failures: [{ kind: "error-burst", target: "db", at: 0.25, duration: 18, ratio: 0.3 }],
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("p95", "throughput"),
      defense: defense({
        followUps: [
          "Your health check is a GET on /healthz that returns 200 from a static handler. Rewrite it so this failure would have been caught, and say what new risk your version introduces.",
          "The same replica starts returning wrong data instead of errors. Which of your defences still works?",
          "Traffic is ten times higher and every client retries. Show what your retry policy does to the store during the same eighteen seconds.",
        ],
        rubric: rubric([
          ["observability", "Names differential observability: the health check and the application disagree, and the evidence is per-replica rather than aggregate", 25],
          ["evidence", "Uses the measured per-replica numbers to locate the degraded replica and predict the tier-level error rate from it", 20],
          ["retry", "Specifies a bounded retry with backoff and jitter, and frames the bound as a budget that protects against total failure", 25],
          ["breaker", "Explains why a circuit breaker is the wrong tool against a partial failure with no fallback, rather than adding it reflexively", 20],
          ["routing", "Distinguishes what least-connections fixes (slow endpoints) from what it does not (fast-failing endpoints), or names outlier ejection", 10],
        ]),
        modelAnswer:
          "The leader is failing about thirty percent of what it receives while its health checks keep passing, so the healthy-replica count stays at three all run and nothing is ejected. Writes all route to the leader, so with forty percent writes over eighteen of thirty seconds the tier-level error rate is about seven percent, which matches what I measured - and the per-replica breakdown is where it is obvious, because the aggregate looks like a mild wobble. I added a bounded retry with jittered exponential backoff at the API. Because the failure is probabilistic rather than total, a small number of attempts drops the residual failure rate below a quarter of a percent, at the cost of a heavier tail on the retried requests, which shows in p99 rather than p95. I deliberately did not add a circuit breaker: opening it against a dependency that is still succeeding seventy percent of the time, with no fallback behind it, converts a partial failure into a complete one. I did switch the balancer to least-connections, which protects the API tier against the slow variant of this failure, and I would add outlier ejection on error rate for the fast-failing variant, since a replica that fails quickly looks like the least busy endpoint and attracts traffic. The retry must be a budget, capped as a fraction of successful volume, so a total outage cannot turn it into amplification.",
      }),
      reflection: {
        question: "One replica fails thirty percent of its requests but answers every health check. Why does the load balancer keep sending it traffic?",
        options: [
          "Because the health check interval is too long",
          "Because a liveness check asks whether the process is reachable, not whether it is serving requests correctly",
          "Because round-robin routing ignores health entirely",
          "Because the failures are too few to cross the balancer's error threshold",
        ],
        answer: 1,
        explanation:
          "The replica is genuinely there and genuinely answering, so a liveness probe is telling the truth - it is just measuring a different thing from what your users experience. Catching this needs either a deep health check that exercises the real dependency path or outlier ejection that compares a replica's error rate with that of its peers.",
      },
    }),

    lesson({
      id: "connection-pool-starvation",
      chapter: chapterTitles[9],
      title: "Connection pool starvation",
      subtitle: "Your servers are idle, your dependency is fine, and everything is timing out.",
      difficulty: "Advanced",
      minutes: 18,
      concept: "Concurrency limits & Little's law",
      brief:
        "An orders API calls a partner ledger that takes about 150 milliseconds to answer - it is not overloaded, it is just far away and slow by nature. Each API replica holds a pool of eight connections to it, requests that cannot get a connection wait, and the end-to-end deadline is 1.2 seconds. At 240 requests per second almost nothing completes, while the API replicas sit at a fifth of their capacity and the ledger is barely warm. Explain the contradiction, then size the pool.",
      learning: [
        "A connection pool is a concurrency limit, and concurrency is governed by Little's law: the number of calls in flight equals the arrival rate multiplied by the time each call takes. A dependency that answers in 150 milliseconds under 240 requests per second needs about 36 calls in flight - not because it is busy, but because that is how many are simply in the air at any instant. Give the caller sixteen connections and it can never have more than sixteen in the air, so the effective throughput of the whole system is the pool size divided by the latency, whatever the rest of the hardware could do.",
        "This is why the symptom is so confusing in production. The server's CPU is idle, because waiting for a connection consumes no CPU. The dependency's utilization is low, because it is only being given a trickle of work. Every dashboard you would normally check says the system is healthy while the request queue grows without bound and requests die on the client deadline. The signal that identifies it is a pool metric - connections in use, wait time to acquire, acquisition timeouts - and if you take one operational habit from this lesson, make it exporting those three from every pool you own.",
        "Sizing is arithmetic plus headroom, and both bounds matter. The floor is the Little's law number for your peak rate and your dependency's realistic latency, not its median: size against the p95 of the call, because that is the state the pool is in when it matters. Then add headroom for the day the dependency gets slower, because pool demand scales linearly with its latency - a dependency that doubles its latency doubles the connections you need to serve the same traffic. The ceiling is the dependency: connections are not free on the far side, and the classic pool-sizing advice is that a pool far larger than the dependency can serve concurrently just moves the queue from your process into theirs, where you cannot see it.",
        "Unbounded waiting is the second half of the bug and it needs its own fix. A request that will never be served in time should not be allowed to hold a place in the wait list until the deadline kills it - it should be rejected immediately so the caller learns quickly and the queue stays short. That means a bounded acquisition queue and an acquisition timeout, so the failure mode under genuine overload is fast, cheap rejection rather than a system-wide stall. A timeout on the call itself does the same job downstream: it returns the connection to the pool instead of letting one slow call hold it indefinitely.",
        "The general shape here is a bulkhead. Every finite resource a caller holds while waiting for someone else - connections, threads, file descriptors, in-flight semaphore slots - is a place where a slow dependency can starve work that has nothing to do with it. Isolating them per dependency is what stops one slow partner from taking down the endpoints that never call that partner. This is Hystrix's original argument and it is still the right one: bound your concurrency per dependency, make exhaustion an explicit, fast, observable failure, and never let the bound be implicit.",
        "What this model idealizes: connections are free to create, never time out, and a waiting request costs nothing but its own latency. Real pools have connection establishment costs and TLS handshakes that make a cold pool slow exactly when traffic arrives, they have validation queries, and they interact with the dependency's own limit on concurrent connections. The arithmetic is the part that transfers: in-flight equals rate times latency, and the pool must be at least that, with headroom for the latency you have not seen yet.",
      ],
      hints: [
        "Run the baseline and put the API's utilization next to its error rate: the component that is failing is not the component that is busy, so find the resource requests are actually waiting for.",
        "Apply Little's law to the dependency call: multiply the arrival rate by how long each call takes to work out how many calls have to be in flight at once, then compare that with what one replica is allowed.",
        "Raise the ceiling to that number with headroom, then make the waiting bounded so a request that cannot be served promptly is turned away quickly instead of dying on the deadline.",
      ],
      objectives: [...healthy(228, 230), objective("rejectedRate", "lte", 0.02), budget(80)],
      architecture: poolStarter,
      reference: poolReference,
      workload: workload({
        requestRate: 240,
        readRatio: 0.8,
        duration: 30,
        seed: 3606,
        keySpace: 10000,
        keySkew: 0.6,
        deadlineMs: 1200,
      }),
      allowedKinds: ["server", "load-balancer", "database", "cache"],
      estimation: estimate("bottleneckCapacity", "p95"),
      defense: defense({
        followUps: [
          "The partner ledger's latency triples during their peak hour. What happens to your pool, and what have you already done about it?",
          "A colleague fixes this by removing the pool limit entirely. Give two concrete things that go wrong.",
          "Which metrics would have paged you before customers noticed, and what threshold would you set on each?",
        ],
        rubric: rubric([
          ["diagnosis", "Identifies the bottleneck as the caller's concurrency limit rather than either component's capacity, and explains why utilization looked fine", 25],
          ["littles", "Applies Little's law with numbers: in-flight calls equal arrival rate times dependency latency, sized against the tail not the median", 30],
          ["bounded", "Bounds the waiting - acquisition queue, acquisition timeout or call timeout - so overload fails fast instead of stalling", 20],
          ["headroom", "Provides headroom for a slower dependency and explains why pool demand scales with dependency latency", 15],
          ["observe", "Names the pool metrics that make this visible: in-use connections, acquisition wait time, acquisition timeouts", 10],
        ]),
        modelAnswer:
          "Nothing here is overloaded. The ledger answers in about a hundred and fifty milliseconds, so by Little's law two hundred and forty requests per second need roughly thirty-six calls in flight at all times. Two replicas with a pool of eight each allow sixteen, so the system's ceiling is sixteen divided by a hundred and fifty milliseconds, a little over a hundred requests per second, and everything above that queues for a connection until the one-point-two-second deadline kills it. That is why the API sits near a fifth of its capacity while almost every request fails: waiting for a connection burns no CPU on either side. I sized each replica's pool above the per-replica in-flight requirement with roughly seventy percent headroom, so a dependency that gets meaningfully slower still fits, and p95 settles at just over the ledger's own latency with no failures. I also bounded the wait list and put a timeout on the call, so that under genuine overload the excess is rejected in milliseconds rather than stalling, and one slow call returns its connection instead of holding it. I rejected removing the limit: an unbounded pool just moves the queue into the partner's process and takes away the only place I can see it, and it removes the bulkhead that stops this dependency from starving endpoints that never call it. In production I would alert on acquisition wait time and acquisition timeouts, not on CPU.",
      }),
      reflection: {
        question: "A server calls a dependency that takes 200 ms. Traffic is 100 requests per second. How many concurrent calls must the server support to keep up?",
        options: ["2", "20", "100", "500"],
        answer: 1,
        explanation:
          "Little's law: in-flight equals arrival rate times service time, so 100 per second times 0.2 seconds is 20 concurrent calls. Any concurrency limit below that - a connection pool, a thread pool, a semaphore - becomes the system's throughput ceiling no matter how idle the machines look.",
      },
    }),

    written({
      id: "transactions-and-sagas",
      chapter: chapterTitles[9],
      title: "Transactions and sagas",
      subtitle: "ACID, isolation levels, and what replaces them once you have more than one database.",
      difficulty: "Advanced",
      minutes: 25,
      concept: "Transactions, isolation and compensation",
      brief:
        "Every simulation in this chapter has treated a write as a single atomic event. Real systems write to several rows, several tables, and eventually several services, and the guarantees you get depend on choices most engineers never make explicitly. This lesson covers what a transaction actually promises, what the isolation levels below serializable let through, why two-phase commit is rare in practice, and how sagas, the outbox pattern and idempotency keys replace it once a single transaction is no longer available.",
      learning: [
        "ACID is four separate promises and only one of them is about concurrency. Atomicity means a group of writes either all happen or none do - it is about crash and abort behaviour, not about other transactions. Consistency, in the ACID sense, is the application's invariants and is mostly your job rather than the database's. Isolation is the one people mean: how much concurrent transactions can see of each other. Durability means the commit survives a crash, and it is exactly the property the failover lesson showed to be a lie when the durability boundary is one machine. Say which of the four you are relying on and you have already out-argued most of the room.",
        "Isolation levels are a menu of anomalies you agree to tolerate. Read committed, the default in most databases, prevents dirty reads but allows a value to change between two reads in the same transaction. Snapshot isolation, confusingly called repeatable read in PostgreSQL and MySQL, gives every transaction a consistent point-in-time view and eliminates most read anomalies, but allows write skew: two transactions each read the same state, each decide their write is safe, and together they violate an invariant neither could have broken alone. Serializable forbids all of it, at the cost of aborts under contention or of actual locking.",
        "Write skew is worth being able to describe from memory, because it is the anomaly that survives the level most teams are actually running. Two doctors are on call; each checks that at least one other doctor remains before removing themselves from the rota; under snapshot isolation both checks pass against the same snapshot and both succeed, leaving nobody on call. The fixes are to materialise the conflict so the database can see it - a lock on the rota row, SELECT FOR UPDATE, or a constraint - or to move to serializable. The general lesson: a read that a decision depends on is part of the transaction, and unless the database knows that, it cannot protect you.",
        "Two-phase commit extends atomicity across systems and is rarer than textbooks suggest for a specific reason. A coordinator asks every participant to prepare, each one durably promises it can commit and gives up its right to abort, and then the coordinator tells them all to commit. The prepared state is the problem: a participant that has promised must hold its locks until it hears back, so a coordinator that crashes at the wrong moment leaves rows locked in several systems until a human intervenes. It also makes availability multiplicative - every participant must be up for the transaction to complete - which is the opposite of what a microservice architecture is supposed to buy.",
        "A saga replaces one distributed transaction with a sequence of local ones, each with a compensating action that semantically undoes it. Book the flight, charge the card, reserve the seat; if the seat reservation fails, refund the card and cancel the flight. The critical word is semantically: you cannot un-charge a card, only refund it, and the customer sees both. Sagas are therefore eventually consistent and expose intermediate states, so the design work is deciding which steps may be observed half-done and which hide behind a pending status. Orchestrated sagas put the state machine in one service, which is easy to reason about and easy to make a bottleneck; choreographed sagas have each service react to events, which decouples deployment and hides the flow.",
        "The outbox pattern solves the gap between the database and the message broker, which is where most homegrown sagas break. Writing a row and publishing an event are two systems, so any crash between them leaves you with one and not the other: the order exists but nobody was told, or the event fired for an order that rolled back. The outbox writes the event into a table in the same local transaction as the business change, and a separate relay reads that table and publishes it. Publication becomes at-least-once, which lands you back at the first lesson of this chapter: consumers must be idempotent, and the key belongs in the event.",
        "Idempotency keys are how the same discipline reaches your API boundary. A client generates a key per logical operation and sends it with every retry; the server stores the key with the result of the first successful execution and returns that stored result on any repeat, rather than doing the work twice. It needs to be scoped to the caller, stored atomically with the effect, and retained long enough to cover realistic retry windows, including a user who refreshes twenty minutes later. Stripe's API is the canonical example to cite, and the reason to cite it is that the guarantee is defined by the server, not by hoping the network behaves.",
        "Put together, the practical rule is to keep the transaction small and local, and let everything that crosses a boundary be idempotent and retryable. Pick the isolation level you need for the invariant you actually have, materialise the conflicts the database cannot see, and reach for a saga only when a single transaction is genuinely unavailable - with compensations written before the happy path ships, because they are the part nobody tests. If you can restructure the problem so the money and the state live in one database, that is usually a better answer than any distributed protocol.",
      ],
      defense: {
        prompt:
          "Design the checkout flow for a marketplace where placing an order must reserve inventory in an inventory service, charge the customer through a payment provider, and create an order record in your own database. Say where transactions apply, what happens when each step fails, and which anomalies a customer may observe.",
        followUps: [
          "The payment succeeds but your order write fails. Walk through exactly what your system does over the next five minutes, and what the customer sees at each point.",
          "Your team proposes two-phase commit across the three systems. Give the two strongest arguments against and the one situation where you would accept it.",
          "Give a concrete write-skew scenario in this checkout flow, and the smallest change that prevents it.",
          "How do you make the whole flow safe when the client retries the checkout button three times in two seconds?",
        ],
        rubric: rubric([
          ["acid", "Distinguishes atomicity, isolation and durability rather than treating ACID as one property, and names the isolation level being assumed", 20],
          ["anomaly", "Describes a concrete anomaly the chosen isolation level permits - write skew, lost update, phantom - and how to prevent it", 20],
          ["2pc", "Explains two-phase commit's prepared-state and multiplicative-availability costs, rather than rejecting it by reflex", 15],
          ["saga", "Structures the flow as local transactions with compensations, and states that compensation is semantic rather than an undo", 25],
          ["outbox", "Identifies the dual-write problem between database and broker and solves it with an outbox or equivalent", 10],
          ["idempotency", "Specifies an idempotency key with its scope, storage and retention so retries are safe end to end", 10],
        ]),
        modelAnswer:
          "I would keep one local ACID transaction around the things that live in my database - the order row and an outbox event - and treat everything crossing a service boundary as a saga step with a compensation. The flow is: create the order in a pending state, reserve inventory, charge the payment provider, then mark the order confirmed. Inventory reservation is a conditional decrement under a unique constraint so two concurrent checkouts cannot both take the last unit; at read committed or snapshot isolation a read-then-write check would be a write skew waiting to happen, so the invariant has to be materialised as a constraint or a row lock rather than trusted to the read. If the charge fails I release the reservation; if the order write fails after a successful charge, the relay retries from the outbox and, failing that, the compensation issues a refund, which the customer sees as a charge and a refund rather than as nothing. Every outbound call carries an idempotency key derived from the order id, scoped to the caller and stored with its result, so the retries that at-least-once delivery guarantees do not double-charge anyone. I rejected two-phase commit: the prepared state holds locks in the inventory service until the coordinator resolves, and it makes checkout unavailable whenever any one participant is, which is the opposite of what splitting these services bought. The anomaly I am explicitly accepting is a visible pending window, which the UI shows honestly.",
      },
      reflection: {
        question: "A service writes a row to its database and then publishes an event to a broker. It crashes between the two. What has gone wrong, and what fixes it?",
        options: [
          "Nothing; the broker will detect the missing event and request it",
          "A dual-write problem: the two systems can disagree, and an outbox table written in the same transaction plus a relay fixes it",
          "An isolation problem, fixed by raising the isolation level to serializable",
          "A durability problem, fixed by synchronous replication of the database",
        ],
        answer: 1,
        explanation:
          "Two systems, two writes, no shared transaction: any crash between them leaves you with a state change nobody was told about, or an event for a change that rolled back. Writing the event into the same database transaction and relaying it asynchronously turns the dual write into one atomic local write plus an at-least-once publication - which is exactly why the consumers must be idempotent.",
      },
    }),

    written({
      id: "stream-processing-and-search",
      chapter: chapterTitles[9],
      title: "Streams and search",
      subtitle: "Logs versus queues, partitions and consumer groups, windows, and why search is its own system.",
      difficulty: "Advanced",
      minutes: 25,
      concept: "Log-based streaming and inverted indexes",
      brief:
        "The queue in this chapter deletes a message once it is acknowledged, which is the right model for work to be done and the wrong one for a record of what happened. This lesson covers the log-based alternative - partitions, offsets, consumer groups, replay - what exactly-once processing means when it is achievable, how windowing handles time that does not arrive in order, and why full-text search ends up in a separate system with an inverted index rather than a LIKE query on your primary store.",
      learning: [
        "A queue and a log solve different problems with similar vocabulary. A queue is a work distributor: a message goes to one consumer, is acknowledged, and disappears, and adding consumers adds throughput. A log is an ordered, replayable record: messages are appended, retained for a configured window, and every consumer group reads the whole thing at its own position. That difference is why Kafka can feed six independent teams from one topic and replay three days of history into a new service, and why an SQS queue cannot. Choose a queue when the message is a task, and a log when the message is a fact that more than one consumer may care about now or later.",
        "Partitions are the unit of both parallelism and ordering, and they are the same unit on purpose. A topic is split into partitions; each partition is an ordered sequence, and each partition is consumed by exactly one member of a consumer group at a time. Ordering is therefore guaranteed within a partition and never across the topic, so your partition key is a design decision, not a detail: key by conversation, user or account and you get per-entity ordering with even spread; key by something low-cardinality and you get a hot partition that one consumer must handle alone. Maximum useful parallelism equals the partition count, which is why it is awkward to change later.",
        "Offsets replace acknowledgements and they change the failure modes. A consumer periodically commits the position it has reached; if it dies, the group rebalances and another member resumes from the last committed offset. Commit after processing and a crash replays the last batch - at-least-once. Commit before processing and a crash skips it - at-most-once. The same choice as the queue lesson, expressed as when you move a number. Exactly-once processing exists inside a closed system: Kafka's transactional producer writes the output records and the offset commit atomically, so effect and position move together. It stops being exactly-once the moment the side effect leaves that system, which is why a consumer that calls a payment API is back to idempotency keys.",
        "Stream processing means computing over unbounded data, so every aggregate needs a window. Tumbling windows are fixed and non-overlapping and answer 'per minute'; hopping and sliding windows overlap to give smoother rolling metrics; session windows close after a gap in activity and are how you group a user's burst of behaviour. The hard part is not the shape but the clock: event time is when the thing happened and processing time is when you saw it, and they diverge whenever a producer is buffering, retrying or partitioned away. Aggregate by processing time and your per-minute counts move when your pipeline hiccups.",
        "Late data makes you state a policy rather than discover one. A watermark is the pipeline's assertion that it believes it has seen everything up to a given event time, which lets a window close and emit; anything arriving afterwards is late and needs a rule - drop it, emit a correction that downstream consumers must handle, or hold windows open for an allowed lateness that costs memory. There is no configuration that avoids the trade: waiting longer gives more complete results later. Say the number and the consequence out loud - 'we allow two minutes of lateness, later events go to a repair path' - and you have answered the question properly.",
        "Search is a separate system because the access pattern is inverted. A primary store maps a key to a document; a search engine maps every term to the list of documents that contain it, which is what makes a query over hundreds of millions of documents fast. That index is built at write time by an analysis chain - tokenise, lowercase, remove stop words, stem, sometimes synonym-expand - and the exact same chain must run over the query, which is why a mismatch between index-time and query-time analysis is the classic reason a document you can see is not returned. A LIKE query cannot use any of it; it scans.",
        "Keeping the index in sync is where the systems meet. The index is a derived view of the primary store, so it should be built from the log rather than dual-written: the same outbox or change-data-capture stream that feeds everything else feeds the indexer, which makes the index rebuildable from scratch by replaying - the property that turns a corrupted index from an incident into a chore. Accept that it is eventually consistent, usually by a second or two, and design the product around it: read the primary store after a write when the user expects to see their own change, and let everyone else read the index.",
        "The last thing to say in an interview is what search costs. Relevance scoring, faceting and highlighting are why the separate system earns its place, but an inverted index is memory-hungry, expensive to update in place, and sharded by document rather than by key - so a query fans out to every shard and merges, and the tail latency of the slowest shard is the latency of the query. That is the tail-at-scale problem from the performance chapter, and it is the reason real search tiers over-replicate shards, hedge requests and cap the candidate set before scoring.",
      ],
      defense: {
        prompt:
          "Design the pipeline behind a product analytics feature: clients emit events, a dashboard shows per-minute active users with at most a minute of delay, and support needs to search the raw events by user, text and time. Say what is a queue and what is a log, how you partition, which delivery guarantee each stage needs, and how the search index stays in sync.",
        followUps: [
          "A mobile client was offline and uploads an hour of buffered events at once. What do your windows do, and what does the dashboard show?",
          "Your consumer group is falling behind by twenty minutes. List the levers you have, in the order you would pull them, and what limits each one.",
          "Support says a document they can see in the primary store is missing from search. Give three plausible causes and how you would distinguish them.",
          "Explain to a sceptical engineer why you did not just add a full-text index to the primary database.",
        ],
        rubric: rubric([
          ["logvsqueue", "Distinguishes a replayable log with consumer groups from a work queue, and assigns each part of the pipeline to the right one", 20],
          ["partitioning", "Chooses a partition key deliberately and connects it to both ordering and parallelism, naming the hot-partition risk", 20],
          ["delivery", "States the delivery guarantee per stage and where idempotency or transactional offsets are required", 20],
          ["time", "Separates event time from processing time, uses windows and a watermark, and states an explicit late-data policy", 20],
          ["search", "Explains the inverted index and the analysis chain, and keeps it in sync from the log rather than by dual writes", 15],
          ["cost", "Names a cost or limit of the search tier: scatter-gather tail latency, index size, or eventual consistency", 5],
        ]),
        modelAnswer:
          "Client events go into a partitioned log rather than a queue, because the dashboard, the search indexer and the data warehouse all need the same events independently, and because replay is how I rebuild any of them. I partition by user id: it gives per-user ordering, spreads evenly, and matches how both the aggregation and the search index are keyed. Ingest is at-least-once with an event id, and every downstream consumer is idempotent, so a producer retry or a rebalance cannot double-count. The dashboard consumer aggregates per-minute active users in tumbling windows on event time, with a watermark that allows a couple of minutes of lateness; the offline client that uploads an hour of buffered events therefore lands mostly outside the watermark, and those events go to a repair path that restates older windows rather than silently inflating the current one - the dashboard shows a corrected figure for past minutes, not a spike now. Using Kafka's transactional producer, the aggregate write and the offset commit move together, which is genuine exactly-once because both sides are in the same system. The search index is a derived view built by another consumer group off the same log, so it is rebuildable by replay and never dual-written; it is eventually consistent by a second or two, which support tolerates. I did not put full-text search in the primary store because the access pattern is inverted - term to documents, not key to document - and the analysis chain, relevance scoring and faceting are the product. The cost I would name up front is scatter-gather: a query fans out to every shard, so the slowest shard sets the latency, and the search tier is sized and replicated for that tail.",
      },
      reflection: {
        question: "A team keeps their search index in sync by writing to the primary database and to the search engine in the same application function. What is the most important problem with this?",
        options: [
          "Search writes are slower than database writes, so latency suffers",
          "The two writes are not atomic, so a crash or a failed call leaves the index permanently diverged with no way to rebuild it from the write path",
          "The search engine cannot accept writes at the same rate as the database",
          "Nothing, as long as both writes are retried until they succeed",
        ],
        answer: 1,
        explanation:
          "This is the dual-write problem again. Any failure between the two leaves the index wrong, and because the index was built from a transient in-process call rather than from a durable log, there is nothing to replay to repair it. Deriving the index from the log - via an outbox or change data capture - makes it both consistent and rebuildable.",
      },
    }),
  ],
};
