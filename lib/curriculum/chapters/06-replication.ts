import { budget, chapterTitles, defense, estimate, graph, healthy, lesson, node, readingsFor, rubric, staleReads, tweak, workload, written, type ChapterFile } from "../shared";

/** Traffic -> balancer -> API replicas -> one database. Every lesson in this chapter starts here. */
const stack = (api: Parameters<typeof node>[3], db: Parameters<typeof node>[3]) =>
  graph(
    [
      node("traffic", "traffic", 0),
      node("load-balancer", "balancer", 1),
      node("server", "api", 2, api),
      node("database", "db", 3, db),
    ],
    [
      ["traffic", "balancer"],
      ["balancer", "api"],
      ["api", "db"],
    ],
  );

// ---------------------------------------------------------------- read-replicas

const readReplicaStarter = stack({ capacity: 250, replicas: 4 }, { capacity: 150 });
const readReplicaReference = tweak(readReplicaStarter, { db: { dbMode: "leader-follower", replicas: 5, capacity: 200 } });

// ---------------------------------------------------------------- replication-lag

const lagStarter = stack({ capacity: 220, replicas: 3 }, { capacity: 220, replicas: 5, dbMode: "leader-follower", replicationLagMs: 400 });
const lagReference = tweak(lagStarter, { db: { consistency: "read-your-writes", capacity: 300 } });

// ---------------------------------------------------------------- leader-failover

const failoverStarter = stack({ capacity: 220, replicas: 3 }, { capacity: 400, replicas: 2, dbMode: "leader-follower", failoverMs: 3000 });
const failoverReference = tweak(failoverStarter, { db: { replicas: 4, capacity: 250, failoverMs: 800 } });

export const chapter: ChapterFile = {
  title: chapterTitles[5],
  lessons: [
    lesson({
      id: "read-replicas",
      chapter: chapterTitles[5],
      title: "Serve reads from replicas",
      subtitle: "One writer, many readers.",
      difficulty: "Advanced",
      minutes: 14,
      concept: "Leader-follower replication",
      brief:
        "A product catalog serves 600 requests per second and 90% of them are reads of listings that barely change. The API tier has spare room, but the single database is pinned at 100% utilization, the queue in front of it is thousands of requests deep, and almost every request now times out. Caching is off the table for this exercise: the merchandising team needs every read to come from the database of record. Give the reads somewhere else to go without giving up a single place where writes are ordered.",
      learning: [
        "A leader-follower database has exactly one writable copy — the leader — and a set of followers that stream the leader's change log and apply it locally. Writes must go to the leader because that is where the ordering of updates is decided. Reads may go anywhere, because a follower holds the same rows a moment later. That asymmetry is the whole trick: read-heavy traffic is the part you can spread horizontally, and it is usually the overwhelming majority of a catalog, a profile service, or a feed.",
        "Size the tier from the split, not from the total. Reads divide across followers; writes do not divide at all. If reads are the large share of traffic, each follower carries the read rate divided by the number of followers, while the leader carries the entire write rate plus whatever replication work it does. A fleet that looks balanced on paper is often lopsided in practice: the leader sits nearly idle while the followers run hot, or the reverse when the write share creeps up. Check both numbers before you declare the tier healthy.",
        "Followers buy read throughput, not write throughput and not durability by themselves. Doubling the follower count does nothing for a write-bound system, and it does nothing for the write path's availability until you also have a promotion story. Production fleets keep 2-3× headroom per follower so that losing one does not push the survivors past their knee, and they treat replica count as a capacity dial that is cheap to turn — which is exactly why 'add a read replica' is the standard first answer to a read-saturated relational database.",
        "What this model idealizes: replication here is a latency offset, not a real log. There is no write-ahead log to ship, no apply lag that grows when the leader is busy, no risk of a follower falling so far behind that it is pulled from rotation, and no cost for the leader to fan its changes out. Real systems pay all of that, which is why replica counts in the teens (Aurora caps at fifteen) rather than the hundreds are the norm, and why lag monitoring is a first-class dashboard.",
      ],
      hints: [
        "Compare the API's utilization with the database's. One of them has room and the other does not, and the objectives will not move until the saturated one changes.",
        "Split the offered load into the part that must be ordered and the part that only has to be read. Divide the read part by the number of copies you plan to serve it from, and size one copy from that.",
        "Change the database's mode so it has a leader and followers, then add copies until the per-copy read load lands well under a single copy's capacity.",
      ],
      objectives: [...healthy(570, 110), budget(90)],
      architecture: readReplicaStarter,
      reference: readReplicaReference,
      workload: workload({ requestRate: 600, readRatio: 0.9, duration: 30, seed: 601 }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("dbLoad", "p95", "throughput"),
      defense: defense({
        followUps: [
          "The read share drops from ninety percent to sixty percent because a new write-heavy feature ships. Which component breaks first, and what do you change?",
          "A follower falls thirty seconds behind during a bulk import. How would you notice, and what should the read path do about it?",
          "You are asked to double the follower count again to cut latency. Explain why that will or will not help.",
        ],
        rubric: rubric([
          ["bottleneck", "Names the single database as the bottleneck and cites its measured utilization and queue depth from the baseline run", 20],
          ["arith", "Computes the split explicitly: total rate times the write share stays on the leader, total rate times the read share divides by the number of followers", 30],
          ["sizing", "States the per-follower load against per-follower capacity and quantifies the remaining headroom", 20],
          ["alt", "Names a rejected alternative (one larger database, or a cache) and says why it loses here", 15],
          ["risk", "Identifies a failure mode the design still has — stale follower reads, a write-bound leader, or replica loss — and how it would be detected", 15],
        ]),
        modelAnswer:
          "The baseline run pins the database at 100% utilization with a queue thousands deep while the API tier sits near 60%, so storage is the bottleneck and adding API replicas would change nothing. Of 600 requests per second, 10% — 60 per second — are writes that must be ordered on one leader, and 540 per second are reads that only need a consistent-enough copy. I switched the database to leader-follower with five copies: the leader takes the 60 writes per second, and the four followers take 540 divided by four, or 135 each. At 200 requests per second of capacity per copy that is 30% on the leader and about 68% on each follower, which leaves roughly 1.5× headroom and keeps p95 near 58 ms with no errors. I rejected one bigger database because it keeps a single failure domain and still puts reads and writes on the same lane, and I rejected a cache because the product requires reads of record. The design's remaining weakness is staleness: a follower read of a key written inside the replication window returns old data, which shows up here at just over one percent of requests.",
      }),
      reflection: {
        question: "You add four more followers to a leader-follower database. Which number is unchanged?",
        options: [
          "The read throughput the tier can sustain",
          "The rate at which writes can be committed",
          "The utilization of each individual follower",
          "The infrastructure cost of the database tier",
        ],
        answer: 1,
        explanation:
          "Followers only serve reads. Write commits are still serialized on the one leader, so the write ceiling is exactly where it was. Read throughput rises, per-follower utilization falls because the same reads spread wider, and cost rises with every copy. Scaling writes needs a different mechanism — partitioning, which is the next chapter.",
      },
    }),

    lesson({
      id: "replication-lag",
      chapter: chapterTitles[5],
      title: "Read your own writes",
      subtitle: "When a replica is a few hundred milliseconds behind.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Replication lag and session consistency",
      brief:
        "The same catalog now takes 400 requests per second with 30% writes, and merchandisers edit a small set of hot listings all day long. Followers trail the leader by roughly 400 ms. Support is filling up with the same complaint: an editor saves a price change, the page reloads, and the old price is still there — then it is right on the next refresh. The simulation counts these as stale reads. Keep the read fan-out you built, and make a user's own writes visible to that user immediately.",
      learning: [
        "Replication lag is the interval between a write committing on the leader and that write being visible on a follower. It is not a constant: it grows with write volume, with long-running queries on the follower, and with anything that stalls the apply process. During the lag window a follower is a correct snapshot of the recent past, which is fine for a stranger browsing a catalog and infuriating for the person who just pressed Save. The bug is not corruption; it is a guarantee nobody wrote down.",
        "Read-your-writes — sometimes called session consistency — is the weakest guarantee that fixes this complaint: within one session, any read after a write observes at least that write. Other sessions may still see stale data, and that is usually acceptable. Implementations route reads to the leader for a period after a write, or pin a session to the leader for keys it has touched, or carry a log position with the session and pick a follower that has caught up to it. This engine models the first shape: a read of a key written inside the lag window goes to the leader instead.",
        "The routing change moves load. Every read pulled back to the leader is read work the followers no longer absorb, so the leader's utilization rises by roughly the read rate multiplied by the fraction of reads that touch recently written keys. Skew makes that fraction much larger than it looks: when a handful of listings receive most of the edits and most of the views, a small share of the key space can drag a large share of the reads onto the leader. Measure the leader after the change, not before.",
        "The general rule is to pick the weakest guarantee that makes the product correct, then pay only for that. Full linearizability on every read would work here too, and would cost the entire read fan-out. Read-your-writes costs one slice of the reads. The cheapest option of all is a product change — show the editor an optimistic local copy of what they just saved — which is why 'do we actually need this to be consistent, or does it just need to look consistent to one person?' is a question worth asking before touching the database.",
        "What this model idealizes: the lag is a fixed number rather than a distribution that widens under load, followers never fall out of rotation, and a session is approximated by the key rather than by a real session token. Real systems also have to decide what happens after a failover, when the promoted follower may be missing writes the old leader had acknowledged — a hole this simulation does not model at all.",
      ],
      hints: [
        "Run the baseline and open the insight about stale reads. It tells you which class of request is being served old data.",
        "Work out which reads can possibly be stale: only reads of keys that were written within the replication window. Estimate that share from the write rate and the key skew before you change anything.",
        "There is a consistency setting on the database that routes exactly those reads to the leader. Change it, then re-measure the leader's utilization and give it whatever headroom it now needs.",
      ],
      objectives: [...healthy(380, 100), staleReads(0.02), budget(125)],
      architecture: lagStarter,
      reference: lagReference,
      workload: workload({ requestRate: 400, readRatio: 0.7, duration: 30, seed: 602, keySpace: 5000, keySkew: 0.7 }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("dbLoad", "p95"),
      defense: defense({
        followUps: [
          "Product now wants any user to see any other user's edit instantly, not just their own. What changes, and what does it cost?",
          "Replication lag triples during a nightly bulk import. What happens to the leader, and what would you have alerted on?",
          "How would you detect stale reads in production, where nothing labels a response as stale?",
        ],
        rubric: rubric([
          ["diagnosis", "Explains the stale read mechanically: a follower read of a key written inside the replication window, and cites the measured baseline rate", 25],
          ["guarantee", "Names read-your-writes (session consistency) as the guarantee being added and distinguishes it from strong consistency", 25],
          ["arith", "Quantifies the load the change moves onto the leader — the write rate plus the share of reads that touch recently written keys — and checks it against leader capacity", 25],
          ["alt", "States a rejected alternative (all reads to the leader, or lowering the lag) and why it loses on throughput or feasibility", 15],
          ["detect", "Says how staleness would be observed in production: lag metrics, session-tagged reads, or a client-side write-then-read probe", 10],
        ]),
        modelAnswer:
          "The baseline serves about 13% of all requests from a follower that had not yet applied a write to that key — those are the support tickets. The mechanism is simple: 120 writes per second land on the leader, key skew concentrates them on a small hot set, and any read of one of those keys inside the 400 ms replication window sees the pre-write row. I set consistency to read-your-writes, which routes reads of recently written keys to the leader and drops the measured stale rate to zero. That is not free: the leader now carries the 120 writes plus roughly a tenth of the 280 reads per second, so about 150 requests per second instead of 120, and I raised per-copy capacity to 300 so the leader sits near half utilization with room for a write-heavier day. I rejected sending all reads to the leader — that discards the entire read fan-out and puts 400 requests per second back on one lane — and I rejected simply asking for lower lag, because lag is an outcome of load, not a setting. The residual risk is cross-session staleness: another merchandiser can still see the old price for a few hundred milliseconds.",
      }),
      reflection: {
        question: "With read-your-writes enabled, which read is still allowed to return stale data?",
        options: [
          "A read by the user who just performed the write, on the key they wrote",
          "A read by a different user of a key that was just written by someone else",
          "Any read that arrives after the replication lag window has elapsed",
          "No read can be stale once read-your-writes is enabled",
        ],
        answer: 1,
        explanation:
          "Read-your-writes is a per-session guarantee. It promises that a session observes its own writes, and nothing more. A different user reading the same freshly written key can still be served by a lagging follower. Making that impossible requires a strictly stronger model — and a much larger share of reads routed to the leader.",
      },
    }),

    lesson({
      id: "leader-failover",
      chapter: chapterTitles[5],
      title: "Lose the leader",
      subtitle: "Replicas are not write availability.",
      difficulty: "Advanced",
      minutes: 15,
      concept: "Failover and promotion",
      brief:
        "The catalog runs on a leader with a single follower, and the runbook says a failover takes three seconds. Halfway through this run the leader's host dies. Two things go wrong at once: every write fails until a follower is promoted, and once the promotion happens there is no follower left to absorb the reads, so the surviving copy carries the entire 400 requests per second on its own. Make the tier ride out the loss of its leader inside the error budget.",
      learning: [
        "Losing a leader is two outages stitched together. The first is the promotion window: from the moment the leader stops answering until a replica has been elected, fenced and made writable, every write fails. Nothing about having replicas shortens that window by itself — it is set by how fast the system detects the death and how long it takes to agree on a successor. The second outage is capacity: the promoted replica leaves the read pool, so the survivors absorb its share on top of their own.",
        "Failover time is the product of a detection interval and a decision. Detection is heartbeats or lease expiry — short leases mean fast detection and a higher risk of demoting a leader that was only briefly slow. The decision should be a real consensus protocol (Raft, ZooKeeper, etcd) rather than an ad hoc heartbeat, because two nodes that both believe they are the leader will both accept writes, and split brain is far more expensive than a few extra seconds of downtime. Fencing the old leader — STONITH, or revoking its storage lease — is part of the cost.",
        "So the error budget for a leader loss is roughly the write rate multiplied by the promotion window, divided by the total requests in the period. Halving the promotion window halves the failed writes; the term you cannot remove is the writes that were in flight. That arithmetic is why production systems tune failover into the hundreds of milliseconds and why clients are expected to retry writes with idempotency keys rather than surface the error.",
        "Size the fleet for the post-failure world, not the steady state. A leader plus one follower looks like redundancy and behaves like a single point of capacity: after promotion the read pool is empty and one lane carries everything. A leader plus three followers loses one lane to promotion and still has two readers, which is the difference between a blip and a second, larger incident. The standard rule of thumb — N+2 for anything that must survive a failure while a node is already out for maintenance — applies here exactly.",
        "What this model idealizes: promotion is instantaneous once the timer expires, the new leader has every write the old one acknowledged, and clients notice the new leader immediately. Real failovers lose unreplicated writes under asynchronous replication, need connection pools and DNS or proxy layers to re-point, and can leave the cluster with a stale replica that must be rebuilt from a base backup before it can serve traffic again.",
      ],
      hints: [
        "Run the baseline and read the timeline. Two separate events hurt you: one during the promotion window and one for the rest of the run.",
        "Estimate the failed writes as the write rate multiplied by the promotion window, then compare that with the error budget in the objectives. Do the same arithmetic for the read load one surviving copy would have to carry.",
        "Shorten the promotion window on the database, and add enough copies that losing one still leaves more than one copy serving reads.",
      ],
      objectives: [...healthy(380, 100), budget(80)],
      architecture: failoverStarter,
      reference: failoverReference,
      workload: workload({ requestRate: 400, readRatio: 0.85, duration: 40, seed: 603, failures: [{ kind: "database", at: 0.5 }] }),
      allowedKinds: ["server", "load-balancer", "database"],
      estimation: estimate("p95", "throughput"),
      defense: defense({
        followUps: [
          "You cut the promotion window by another factor of four. What new failure mode have you bought, and how would you tell it apart from a real leader death?",
          "The leader dies during the nightly peak rather than at average load. Redo the arithmetic and say what breaks.",
          "A client retries every failed write three times during the promotion window. What happens the instant the new leader comes up?",
        ],
        rubric: rubric([
          ["window", "Explains that writes fail for the whole promotion window and quantifies the failed writes as write rate times that window", 25],
          ["capacity", "Points out that promotion removes a reader, and computes the read load the surviving copies must carry afterwards", 25],
          ["change", "States both changes made — a shorter promotion window and more copies — and ties each to a measured number", 20],
          ["alt", "Rejects an alternative (one very large replica, or relying on client retries alone) with a reason", 15],
          ["risk", "Names the residual risk: unreplicated writes lost at promotion, split brain, or a retry surge when the new leader opens", 15],
        ]),
        modelAnswer:
          "The baseline fails on two fronts. With a three-second promotion window and 60 writes per second, about 180 writes fail outright, which is roughly one percent of the run on its own. Worse, the tier had one leader and one follower, so promoting the follower left zero readers: the single survivor then carried all 400 requests per second at 400 capacity, ran above 90% utilization, and pushed p95 from under 60 ms to more than 130 ms for the second half of the run. I made two changes. I cut the promotion window to 800 ms, which drops the failed writes to roughly 48 — about 0.3% of the run and comfortably inside the one percent error budget. And I went to four copies at 250 capacity each: after the leader dies and one follower is promoted, two followers still split the 340 reads per second, about 170 each, or 68% utilization, so p95 stays near 57 ms. I rejected relying on client retries alone, because they hide the outage rather than shorten it and they arrive as a thundering herd the moment the new leader opens. The residual risk is writes acknowledged by the old leader but never replicated.",
      }),
      reflection: {
        question: "A tier runs one leader and one follower. The leader dies and the follower is promoted. What is the state of the tier immediately afterwards?",
        options: [
          "Fully redundant again, because the promoted node accepts both reads and writes",
          "Read capacity is unchanged, but write capacity is halved",
          "A single copy carrying all reads and all writes, with no redundancy left",
          "Writes continue to fail until the dead node is repaired",
        ],
        answer: 2,
        explanation:
          "Promotion converts your only follower into the leader. Writes resume, but the read pool is now empty, so the one surviving node absorbs the entire workload with no spare to lose. This is why a leader plus one follower is a redundancy story on paper and a capacity cliff in practice.",
      },
    }),

    written({
      id: "choosing-consistency",
      // The PACELC entry in lib/readings ships an http:// URL; the curriculum test requires https and
      // the origin serves it. Normalising here keeps the fix inside this chapter's ownership, and it
      // becomes a no-op the moment the readings library is corrected.
      readings: readingsFor("choosing-consistency").map((reading) => ({ ...reading, url: reading.url.replace(/^http:\/\//, "https://") })),
      chapter: chapterTitles[5],
      title: "Choosing a consistency model",
      subtitle: "Linearizable, causal, eventual — and what each one costs.",
      difficulty: "Advanced",
      minutes: 20,
      concept: "CAP, PACELC and consistency models",
      brief:
        "You have now watched a replica serve a stale price and watched a leader loss fail every write for three seconds. Both are consistency decisions wearing an operational costume. This lesson gives you the vocabulary an interviewer expects when you say a system is 'eventually consistent', and a method for choosing the weakest model that still makes the product correct — because every step up the ladder is paid for in latency, availability during partitions, or both.",
      learning: [
        "Linearizability is the strongest single-object model: every operation appears to take effect at one instant between its invocation and its response, and once a read returns a value, no later read returns an older one. It is what people usually mean by 'strong consistency', and it is what makes a distributed system feel like one machine. The price is coordination on the critical path — a quorum round trip, a lease check, or a route to the leader — on every operation, including reads. Compare-and-set, distributed locks, leader election and uniqueness constraints all need it; almost nothing else does.",
        "Sequential consistency relaxes linearizability by dropping real time: all operations appear in some single total order that every process agrees on, and each process's own operations appear in program order, but that order need not match wall-clock order. Causal consistency relaxes it further: only operations related by happens-before must be ordered, and concurrent operations may be seen in different orders by different observers. Causal is the sweet spot for social products — a reply never appears before the comment it answers — and it is achievable without coordination, using vector clocks or dependency tracking.",
        "Eventual consistency promises only that if writes stop, replicas converge. It says nothing about how long, about what you read in the meantime, or about whether you can read your own writes. In practice teams bolt session guarantees on top: read-your-writes, monotonic reads (never go backwards in time), monotonic writes, and writes-follow-reads. These are cheap, they are per-session rather than global, and they resolve the overwhelming majority of user-visible 'the site is broken' complaints without paying for a total order.",
        "CAP says that when the network partitions, a system must choose between remaining available and remaining linearizable. It is narrower than folklore suggests: it applies only during a partition, and 'availability' means every non-failing node answers, which is a stricter bar than an SLO. Brewer's own retrospective reframes it as a design loop — detect the partition, enter an explicit degraded mode, then recover and reconcile — which is far more useful than picking two letters. The interesting engineering is in the degraded mode: which operations do you refuse, which do you accept and reconcile later, and how do you tell the user?",
        "PACELC is the extension that matters day to day: if there is a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. Most systems are never partitioned and are always making the else-branch trade. A quorum read across three availability zones costs a round trip; a leader read costs a redirect; a follower read costs staleness. Classifying a store as PC/EC (Spanner), PA/EL (Dynamo, Cassandra with low quorums) or PC/EL (a leader-follower relational database with follower reads) says far more about how it will feel in production than CAP alone.",
        "Pick per operation, not per system. In a payments product the ledger entry and the idempotency key need linearizability — double-spend and duplicate charge are unrecoverable — while the transaction list, the merchant's dashboard and the monthly statement are happily eventual. In a social feed, posting and reading your own timeline want read-your-writes, comment threads want causal ordering, and follower counts can be minutes stale. The design conversation an interviewer is listening for is exactly this decomposition: name the few operations that need coordination, isolate them, and let everything else run cheap.",
        "Two practical consequences follow. First, strong consistency is not the safe default — it is a latency and availability bill you pay on every request, and it hides real bugs behind an assumption that the database will save you. Second, weak consistency is not a licence to ignore anomalies: you owe the product a definition of what a user may observe, written down, tested, and visible in the client. 'Eventually consistent' with no stated session guarantees and no bounded staleness is not a design, it is an absence of one.",
      ],
      defense: {
        prompt:
          "You are designing a ride-hailing product. Choose a consistency model for each of these operations and justify each choice: (1) assigning a driver to a ride request, (2) showing the rider the driver's location on the map, (3) charging the rider's card at the end of the trip, (4) the driver's lifetime earnings total. Then say what each choice costs you during a network partition between two data centers.",
        followUps: [
          "Your surge-pricing service reads a counter that is eventually consistent. Give a concrete sequence of events where that produces a user-visible bug, and the weakest guarantee that prevents it.",
          "A staff engineer proposes making the whole system linearizable 'so we never have to think about this again'. Give the two strongest arguments against, with numbers.",
          "Classify your design in PACELC terms and defend the else-branch choice at ninety-nine point nine percent uptime, when there is no partition at all.",
          "During a partition, your driver-assignment service cannot reach the coordination store. Describe the degraded mode you would ship, and how you reconcile afterwards.",
        ],
        rubric: rubric([
          ["models", "Names and correctly distinguishes at least three models — linearizable, causal or sequential, and eventual — rather than using 'strong' and 'weak' as a binary", 20],
          ["percall", "Assigns a different model to different operations in the same product and justifies each from the product requirement, not from habit", 25],
          ["cap", "States CAP accurately as a partition-time choice and does not claim a system 'gives up P'", 15],
          ["pacelc", "Uses the else-branch: names the latency-versus-consistency trade that applies when there is no partition, with a concrete cost", 20],
          ["session", "Mentions session guarantees (read-your-writes, monotonic reads) as the cheap fix for the common user-visible anomaly", 10],
          ["degraded", "Describes an explicit degraded mode and a reconciliation path rather than assuming the partition never happens", 10],
        ]),
        modelAnswer:
          "Driver assignment needs linearizability: it is a compare-and-set on a scarce resource, and two data centers each assigning the same driver is unrecoverable. I would route it through a single consensus-backed coordinator per city and accept the round trip. Driver location on the map is eventual with monotonic reads — a rider must never see the car jump backwards, but a second of staleness is invisible. The card charge needs linearizability on the idempotency key only: the ledger write is a uniqueness constraint, while the receipt and history it produces can be eventual. Lifetime earnings is eventual, recomputed from the ledger, and can lag minutes. In PACELC terms the assignment path is PC/EC — during a partition the minority side refuses new assignments rather than double-booking, and even with no partition it pays a quorum round trip of a few milliseconds. Everything else is PA/EL: it stays available on both sides of a partition and reads the nearest replica. The degraded mode for assignment is an explicit one: the minority region shows riders a 'no drivers available' state, which is a truthful and reconcilable answer, rather than assigning from stale state and reconciling a double-booked driver afterwards.",
      },
      reflection: {
        question: "A team says their system 'gives up partition tolerance to get consistency and availability'. What is wrong with that statement?",
        options: [
          "Nothing — CA systems are a valid third choice under CAP",
          "Partitions are a property of the network, not a choice; a system that cannot tolerate them simply fails when one occurs",
          "It is wrong only for systems that span more than one data center",
          "Consistency and availability are the same property, so the sentence is redundant",
        ],
        answer: 1,
        explanation:
          "You do not choose whether the network partitions; you only choose what your system does when it does. A so-called CA system is one that has decided to become unavailable — or to silently violate consistency — the moment a partition occurs. The useful framing is Brewer's: detect the partition, enter an explicit degraded mode, then recover and reconcile.",
      },
    }),
  ],
};
