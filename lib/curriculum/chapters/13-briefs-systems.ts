import {
  allKinds,
  brief,
  chain,
  chapterTitles,
  clarification,
  defense,
  deadLetters,
  estimate,
  graph,
  healthy,
  budget,
  lostWrites,
  node,
  objective,
  rejected,
  rubric,
  workload,
  type ChapterFile,
} from "../shared";

/**
 * Chapter 12 continued (v2.2) - four more Expert design briefs, all blank canvas.
 * These four are the "systems" half of the brief set: money, geography, ingest and large objects.
 * Every brief adds the v2.2 stages - `techFocus` names the component kinds whose concrete
 * technology the learner must justify, and `dataModelPrompt` names the entities to model before
 * the defense starts.
 * Each reference below was measured on seeds [lesson seed, 123, 2026] with a probe run; the
 * objectives sit roughly 25-40% above (or below, for the "at least" ones) the worst measured
 * value, so a remix still has room and no objective passes by a hair.
 */

/** Every blank-canvas brief starts here: traffic and nothing else. */
const blankCanvasStarter = chain([node("traffic", "traffic", 0)]);

// ------------------------------------------------------------------ payments-ledger
// Measured: p95 ~74 ms, throughput ~239 req/s, errorRate 0, lostWrites 0, cost ~97.4 credits.
// The same pipeline on a leader-follower store loses 45-49 acknowledged writes when the leader dies.
const ledgerReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Payment API", capacity: 400, replicas: 3 }),
    node("queue", "journal", 3, { label: "Journal queue", maxQueue: 2000, ackMode: "at-least-once", visibilityTimeoutMs: 2000, maxDeliveries: 3 }),
    node("server", "poster", 4, { label: "Ledger poster", role: "worker", capacity: 250, replicas: 3, idempotent: true }),
    node("database", "db", 5, { label: "Ledger store", capacity: 300, dbMode: "quorum", replicas: 5, quorumWrite: 3, quorumRead: 2 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "journal"], ["journal", "poster"], ["poster", "db"]],
);

// ------------------------------------------------------------------ ride-matching
// Measured: p95 ~60 ms, throughput ~899 req/s, errorRate 0, cost ~103 credits.
const rideReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "lb-us", 1, { label: "US balancer", region: "us-west" }, -1),
    node("load-balancer", "lb-eu", 1, { label: "EU balancer", region: "eu-west" }, 1),
    node("server", "api-us", 2, { label: "US match API", capacity: 400, replicas: 3, region: "us-west" }, -1),
    node("server", "api-eu", 2, { label: "EU match API", capacity: 400, replicas: 2, region: "eu-west" }, 1),
    node("cache", "cache-us", 3, { label: "US cell cache", cacheModel: "keyed", cacheEntries: 4000, ttlMs: 1000, coalesce: true, region: "us-west" }, -1),
    node("cache", "cache-eu", 3, { label: "EU cell cache", cacheModel: "keyed", cacheEntries: 4000, ttlMs: 1000, coalesce: true, region: "eu-west" }, 1),
    node("database", "db-us", 4, { label: "US cell store", capacity: 200, dbMode: "sharded", shards: 4, region: "us-west" }, -1),
    node("database", "db-eu", 4, { label: "EU cell store", capacity: 200, dbMode: "sharded", shards: 3, region: "eu-west" }, 1),
  ],
  [
    ["traffic", "lb-us"], ["traffic", "lb-eu"], ["lb-us", "api-us"], ["lb-eu", "api-eu"],
    ["api-us", "cache-us"], ["api-eu", "cache-eu"], ["cache-us", "db-us"], ["cache-eu", "db-eu"],
  ],
);

// ------------------------------------------------------------------ log-search
// Measured: p95 ~103-105 ms, throughput ~831 req/s, errorRate 0, rejected ~2%, cost ~182 credits.
const logSearchReference = graph(
  [
    node("traffic", "traffic", 0),
    node("rate-limiter", "limiter", 1, { label: "Ingest limiter", limit: 820, burst: 400 }),
    node("load-balancer", "balancer", 2),
    node("server", "ingest", 3, { label: "Ingest API", capacity: 400, replicas: 3 }),
    node("queue", "queue", 4, { label: "Index queue", maxQueue: 3000 }),
    node("server", "indexer", 5, { label: "Indexer", role: "worker", capacity: 300, replicas: 4 }),
    node("database", "db", 6, { label: "Index store", capacity: 300, dbMode: "sharded", shards: 10 }),
  ],
  [["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "ingest"], ["ingest", "queue"], ["queue", "indexer"], ["indexer", "db"]],
);

// ------------------------------------------------------------------ video-upload-pipeline
// Measured: p95 ~79 ms, throughput ~747-750 req/s, errorRate 0, rejected ~6.2-6.5%,
// deadLetterRate 0, cost ~84.5 credits.
const videoReference = graph(
  [
    node("traffic", "traffic", 0),
    node("cdn", "edge", 1, { label: "Playback edge", cacheHitRate: 0.85 }),
    node("rate-limiter", "limiter", 2, { label: "Upload limiter", limit: 400, burst: 300 }),
    node("load-balancer", "balancer", 3),
    node("server", "intake", 4, { label: "Upload intake", capacity: 400, replicas: 3 }),
    node("queue", "queue", 5, { label: "Transcode queue", maxQueue: 2000, ackMode: "at-least-once", visibilityTimeoutMs: 2000, maxDeliveries: 3 }),
    node("server", "transcoder", 6, { label: "Transcoder", role: "worker", capacity: 200, replicas: 4, idempotent: true }),
    node("database", "db", 7, { label: "Asset store", capacity: 250, dbMode: "sharded", shards: 4 }),
  ],
  [["traffic", "edge"], ["edge", "limiter"], ["limiter", "balancer"], ["balancer", "intake"], ["intake", "queue"], ["queue", "transcoder"], ["transcoder", "db"]],
);

export const chapter: ChapterFile = {
  title: chapterTitles[11],
  lessons: [
    brief({
      id: "payments-ledger",
      chapter: chapterTitles[11],
      title: "Design a payments ledger",
      subtitle: "Small write volume, absolute durability, and retries that must not double-charge.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Strong consistency & exactly-once effects",
      brief:
        "A fintech team needs the service of record for money movement. The whole prompt is: 'every payment has to land in the books exactly once, the balance has to be right the moment we read it, and we cannot ever tell a customer their payment succeeded and then lose it.' Nobody has told you the transaction rate, the read/write mix, what 'right the moment we read it' means, how the client retries, or what happens when a storage replica dies mid-flight. Ask before you build. The canvas is empty - no starter design, no required shape - so any architecture that runs and clears the targets passes, and the one you draw is the one you will defend.",
      learning: [
        "A ledger is the rare system where volume is the easy part. A few hundred transactions per second is nothing for modern storage; what makes this hard is that every one of those writes is money, so the properties you normally trade away - durability of an acknowledged write, atomicity across two rows, an answer that is correct rather than eventually correct - are the requirements. Establish the rate early so you can say out loud that capacity is not the constraint, then spend the rest of the conversation on correctness. Candidates who size this like a feed have misread the problem.",
        "Double-entry is the data model, not an accounting nicety. Money is never edited in place: a transfer appends two immutable entries, a debit and a credit, that must land together or not at all, and an account's balance is the sum of its entries - usually materialised into a running balance row that is updated in the same transaction. That single decision gives you an audit trail for free, makes reconciliation a query rather than a forensic exercise, and means your invariant is checkable: the sum of every entry in a transfer is zero. Say the invariant, because it is what tells you whether a partial failure corrupted anything.",
        "Acknowledged durability is where storage topology stops being a preference. A leader with asynchronous followers acknowledges a write as soon as the leader has it; if the leader dies inside the replication window, those acknowledged writes were never anywhere else, and the customer was told yes about money that no longer exists. A quorum store instead requires a majority to accept the write before answering, so losing any single replica loses nothing that was acknowledged. That is the whole argument for paying for a majority-write store here, and it is why the objective on this mission counts lost writes rather than latency.",
        "Quorum arithmetic is worth doing in the open. With a majority write and a majority read over an odd number of replicas, read and write sets always overlap, so a read cannot miss an acknowledged write - the standard R + W > N condition. The cost is that every write occupies several replicas at once, so effective capacity is the replica count divided by the write quorum, and a slow replica drags the whole operation because you wait for the slowest member of the quorum. Size the store from the quorum-adjusted capacity, not the raw sum, and admit that this is why strong consistency is expensive.",
        "Retries are the second correctness problem, and they are guaranteed. A client that times out does not know whether the payment landed, so it will send it again; without protection, one intent becomes two ledger entries. The production answer is an idempotency key chosen by the client and stored with the result: the first request writes the key and the entries in one transaction, every retry finds the key and returns the original outcome. Say where the key is stored, how long it is retained, and what happens on a retry that arrives while the first is still in flight - that concurrent case is the one interviewers push on.",
        "Separating intake from posting is what lets you keep the acknowledgement honest without making the customer wait for everything downstream. The API validates, authorises and durably journals the intent, and a pool of idempotent posters applies entries to the ledger and drives settlement with the payment networks. At-least-once delivery plus an idempotent consumer gives you effectively-once side effects, which is the only achievable version of 'exactly once' across a network. The sentence to say is that the durable journal - not the settlement call - is what you acknowledged, and that anything past the journal is retried until it succeeds or is escalated to a human.",
        "What this model idealizes: the simulation shows you acknowledged-write loss, quorum capacity and queue behaviour, but not the transaction that makes two entries atomic, the reconciliation job that compares your books against the bank's, the currency rounding rules, or the regulatory retention that makes deleting an entry illegal. It also treats every payment as equal, whereas a real ledger has holds, reversals, chargebacks and multi-leg transfers that each add states to the model. Name those when you defend it, and be clear that what you measured is the write path's durability, not the correctness of the accounting itself.",
      ],
      hints: [
        "The canvas is empty, so start from one payment: draw the shortest path that can durably accept it, run it, and look at which objective fails rather than at which component is busy.",
        "One objective is not about speed at all - find the metric that counts acknowledged writes that vanished, then ask what has to be true of storage before an acknowledgement can be trusted.",
        "Make acceptance and posting two separate steps with something durable between them, and choose a storage mode where a majority has the write before the client hears yes; any design that clears the targets passes.",
      ],
      objectives: [...healthy(228, 100), lostWrites(0), budget(130)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: ledgerReference,
      workload: workload({
        requestRate: 240,
        readRatio: 0.35,
        duration: 30,
        seed: 16,
        keySpace: 20000,
        keySkew: 0.4,
        failures: [{ kind: "database", at: 0.5 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      remixable: true,
      techFocus: ["database", "queue", "server"],
      dataModelPrompt:
        "Model the ledger. Name the entities (account, transfer, journal entry, idempotency key, at minimum), give each a primary key and say what makes it unique, state the invariant that ties entries to a transfer, and list the query patterns you must serve: post a transfer, read a balance, replay a customer's statement, and look up a retry by its idempotency key. Say which entity grows fastest and what you would partition it by.",
      clarifications: [
        clarification(
          "What transaction rate should I design for, and what is the read-to-write mix?",
          "A few hundred requests per second at peak - call it two hundred and forty - and it is write-leaning: roughly two payments posted for every balance or statement read.",
        ),
        clarification(
          "What has to be true the instant a payment is acknowledged?",
          "It must be durable on more than one machine. If we return success and then lose the payment because a replica died, that is an incident with regulators, not a bug report.",
        ),
        clarification(
          "How fresh does a balance read have to be?",
          "It must reflect every payment we have acknowledged. A balance that is a few seconds behind is how customers get to spend the same money twice, so stale reads are not acceptable here.",
        ),
        clarification(
          "How do clients behave when a request times out?",
          "They retry, aggressively, and they always send the same client-generated idempotency key with the retry. Charging a customer twice is the worst outcome in the product.",
          ),
        clarification(
          "What is allowed to happen asynchronously after we acknowledge?",
          "Settlement with the card networks, fee calculation and notifications. Those can take seconds or minutes as long as they are never dropped, and a stuck one must be visible to an operator.",
        ),
        clarification(
          "What is the infrastructure budget?",
          "Money movement justifies real spend, but not unlimited - keep it under about a hundred and thirty credits. Anything more and finance wants a business case.",
        ),
        clarification(
          "Which cloud provider and region will this run in?",
          "Whichever our platform team standardises on. It has no bearing on the topology you are being asked to justify.",
          false,
        ),
        clarification(
          "Should the customer-facing receipt be an email or an in-app notification?",
          "Both, eventually. That is downstream of this service and does not change its design.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your ledger. State the rate, mix, durability and freshness requirements your clarifying questions established, show the arithmetic from the transaction rate to the capacity a majority-write store actually needs, name the concrete technology you chose for storage and for the journal and say why, walk through your data model and its invariant, and explain exactly how a retried payment cannot post twice.",
        followUps: [
          "The storage replica holding the leader role dies one millisecond after you acknowledged a payment. Walk through what your design does, and what a leader-with-asynchronous-followers store would have done instead.",
          "Two copies of the same payment arrive at two different API replicas at the same instant, both carrying the same idempotency key. Trace both requests and name the mechanism that makes exactly one set of entries exist.",
          "Compliance asks you to prove that the books balanced at every point last quarter. Which part of your data model makes that a query rather than an investigation, and what would you have to add if you had chosen mutable balance rows instead?",
        ],
        rubric: rubric([
          ["framing", "States the transaction rate, read/write mix, durability requirement and balance-freshness requirement from clarification, and says explicitly that capacity is not the constraint here", 18],
          ["durability", "Argues for a majority-write store over a leader with asynchronous followers using acknowledged-write loss, and does the quorum capacity arithmetic (replicas divided by the write quorum)", 22],
          ["tech", "Names a concrete technology for the ledger store, the journal and the API tier - and justifies each against a stated requirement (strong consistency, durable ordered delivery) rather than familiarity, including one option rejected by name", 20],
          ["dataModel", "Gives the double-entry model with keys: accounts, transfers, immutable journal entries and an idempotency-key record, states the zero-sum invariant, and names the partition key for the fastest-growing entity", 22],
          ["idempotence", "Explains idempotency keys plus at-least-once delivery to an idempotent poster, including the concurrent-retry case, and names a residual risk with how it would be detected", 18],
        ]),
        modelAnswer:
          "Clarification gave me about two hundred and forty requests per second, write-leaning at roughly two payments per read, acknowledged writes that must survive a replica death, balances that must reflect everything acknowledged, clients that retry with a stable idempotency key, and a budget around a hundred and thirty credits. Two hundred and forty per second is trivial volume, so I spend nothing on cleverness and everything on correctness. The ledger store is a majority-write, majority-read quorum store - five replicas, write quorum three, read quorum two - so read and write sets overlap and no acknowledged write can be lost when one replica dies; a leader with asynchronous followers acknowledges alone and loses everything inside the replication window, which my measurement shows as dozens of vanished payments. Because each write occupies three replicas, effective write capacity is the replica count divided by the write quorum, so I sized per-replica capacity from that rather than from the raw sum. The API validates and writes the intent to a durable at-least-once journal, acknowledges there, and idempotent posters apply the debit and credit entries and drive settlement. The data model is double-entry: accounts, transfers, immutable entries keyed by transfer, and an idempotency-key row written in the same transaction as the entries, so a retry finds the key and returns the original result. Residual risks: a poster stuck behind a settlement provider, and clock skew in statement ordering.",
      }),
      reflection: {
        question: "The same pipeline scores identically on latency and throughput whether storage is a leader with asynchronous followers or a majority-write quorum. What actually separates them here?",
        options: [
          "Only the quorum store guarantees that a write already acknowledged to the customer survives losing a replica; the leader can acknowledge alone and lose everything inside its replication window",
          "The quorum store is faster under failure, because reads no longer have to wait for the leader to be promoted",
          "The leader-follower store cannot serve balance reads at all, so it fails the freshness requirement by construction",
          "The quorum store is cheaper, because followers cost more than peers of equal capacity",
        ],
        answer: 0,
        explanation:
          "Both shapes serve the same traffic at the same speed - the difference only appears in the metric that counts acknowledged writes that no replica kept. A leader with asynchronous replication answers the client before any follower has the write, so a leader death inside the replication window destroys money that a customer was told had moved. A majority write means any surviving majority still holds it. Failover speed, read availability and price are all real considerations, but none of them is the reason this system pays for a quorum.",
      },
    }),

    brief({
      id: "ride-matching",
      chapter: chapterTitles[11],
      title: "Design ride matching",
      subtitle: "Geo-partitioned writes, a few violently hot cells, and matching that has to feel instant.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Geo-partitioning & hot cells",
      brief:
        "A mobility company wants the service that connects a rider tapping 'find me a car' to the drivers near them. The prompt you get is: 'drivers send their position constantly, riders ask who is nearby, and the answer has to come back before they lose patience - and it has to work in every city we launch in.' You have not been told the update rate, how requests are spread across the map, what 'nearby' means, how stale a driver position may be, or where the users are. Ask first. Nothing is placed on the canvas for you and no topology is prescribed, so any architecture that runs and clears the targets is a pass.",
      learning: [
        "Start by naming the two workloads, because they pull in opposite directions. Driver location updates are a firehose of small writes with no read of their own; rider searches are reads that have to scan a neighbourhood and come back fast. Those are different shapes, and the standard mistake is to design one system for the average of them. Establish the ratio in clarification - here it is read-leaning but with a heavy write floor that never stops, because drivers keep moving whether or not anyone is looking for them.",
        "Geography is your partition key, and choosing it well is the whole design. You cannot index a moving point with a B-tree on latitude and longitude and expect a radius query to be cheap, so real systems quantise the map into cells - a geohash prefix, an S2 cell, or Uber's H3 hexagons - and store supply keyed by cell. A 'who is near me' query then becomes a lookup of the rider's cell plus its ring of neighbours, which is a handful of key lookups instead of a scan. Say the cell size is a tuning parameter: too large and every query returns a city, too small and you touch dozens of cells per request.",
        "Cells are also what makes the load pathological, and you should predict it before you measure it. Demand is not spread evenly over a map - it concentrates on a stadium at kick-off, an airport terminal, a downtown block on a Friday night. Hashing on cell id spreads cells evenly across shards, but it cannot spread one cell, so the hottest cell lands on one shard and that shard sees a multiple of the average. The two mitigations to name are a short-lived cache in front of the hot cells, so repeated reads of the same neighbourhood do not each hit storage, and request coalescing so that concurrent misses for one cell collapse into a single fetch instead of a stampede.",
        "Freshness is a budget, not an absolute, and it is the lever that makes caching legal here. A driver position that is a second or two old is still a good answer - the car has moved a few metres and the matching engine is going to re-check availability at dispatch anyway. That tolerance is what lets you put a short time-to-live in front of the cell store and still be correct. State the number you were given, tie the time-to-live to it explicitly, and note the one place staleness is not acceptable: the moment of assignment, where two riders must not be given the same driver.",
        "Geography is also a latency term, and this is the brief where you should stop accepting a cross-ocean round trip. A rider and the drivers around them are, by definition, in the same place; there is no reason for that query to travel to another continent and back. Deploy a full stack per region - entry, matching service, cell cache, cell store - and let each region own the supply inside it. The global state that remains is small: identity, payments, trip history. The sentence to say is that this workload partitions naturally by geography, so a regional deployment is not a multi-region consistency problem, it is a locality win with almost no coordination cost.",
        "Matching itself is the part the canvas cannot draw, so describe it. Assignment has to be exclusive - a driver may be offered to one rider at a time - which is a short lock or a conditional update on the driver record, held for seconds, with a fallback when the driver does not answer. Batching improves the global outcome: collecting requests over a brief window and solving the assignment for a whole cell beats greedy nearest-first, at the cost of a little latency. Mention surge as a feedback loop on the same cell statistics you are already computing.",
        "What this model idealizes: the simulation gives you the read path, the hot-cell behaviour and the regional split, but not the persistent connections that carry driver telemetry, the spatial index itself, the assignment lock, or the trip state machine that starts once a match is made. It also treats every cell lookup as one request, whereas a real query touches a ring of neighbouring cells. Name those omissions and be explicit that what you sized is the supply-lookup tier, not the matching optimiser sitting on top of it.",
      ],
      hints: [
        "Nothing is placed for you, so draw the smallest path that can answer 'who is near me' and run it; the utilization column and the shard spread tell you which of the two workloads is really hurting.",
        "Ask where the requests come from before you place anything - if a large share of traffic starts far away, a round trip is the biggest single term in their latency, and it is not one you can optimise away with capacity.",
        "Partition storage by the quantised location rather than by driver, put something short-lived in front of it that collapses concurrent misses for the same neighbourhood, and give each population its own local stack; any design that clears the targets passes.",
      ],
      objectives: [...healthy(855, 85), budget(140)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: rideReference,
      workload: workload({
        requestRate: 900,
        readRatio: 0.7,
        duration: 30,
        seed: 17,
        keySpace: 3000,
        keySkew: 0.85,
        regions: [
          { name: "us-west", share: 0.6 },
          { name: "eu-west", share: 0.4 },
        ],
        crossRegionLatencyMs: 90,
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      remixable: true,
      techFocus: ["database", "cache", "server", "load-balancer"],
      dataModelPrompt:
        "Model the supply index. Name the entities (driver, driver location, cell, ride request, match, at minimum), give each a primary key, and state the cell identifier you are keying supply on and why it is the partition key. List the query patterns: write a driver's position, read the drivers in a cell and its neighbours, claim a driver exclusively, and read a rider's active match. Say what the time-to-live on a location is, which entity is hottest, and what a stadium at kick-off does to its key distribution.",
      clarifications: [
        clarification(
          "What request rate should I design for, and how does it split between driver updates and rider searches?",
          "About nine hundred requests per second at peak in our biggest markets, roughly seven reads for every three writes. Drivers publish their position on a timer whether anyone is searching or not.",
        ),
        clarification(
          "How is demand spread across the map?",
          "Very unevenly. A handful of areas - an airport, a stadium, one downtown grid - carry a large share of both supply and demand, and it moves by time of day. Assume a few thousand active cells with extreme concentration.",
        ),
        clarification(
          "How stale may a driver's position be when we return it?",
          "A second or so is fine; we re-verify availability at the moment of dispatch anyway. What is never acceptable is offering the same driver to two riders at once.",
        ),
        clarification(
          "Where are the users, and is one deployment enough?",
          "About sixty percent of peak traffic is on the US west coast and forty percent in Europe, and the European share is growing. Today everything runs in one US region and European riders complain about the wait.",
        ),
        clarification(
          "What latency target does a search have to meet?",
          "Under about a tenth of a second at p95 for the nearby-drivers call itself. Riders abandon the flow if the map sits empty.",
        ),
        clarification(
          "What is the infrastructure budget for this tier?",
          "Keep it under about a hundred and forty credits. It is one service inside a much larger platform, so it has to earn its slice.",
        ),
        clarification(
          "Which map provider will render the tiles in the app?",
          "The usual commercial one. Rendering is a client concern and does not constrain this design.",
          false,
        ),
        clarification(
          "Should driver payouts be daily or weekly?",
          "Weekly with an instant-cashout option. That is a different service entirely.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your matching design. State the rate, read/write split, demand concentration, staleness tolerance and geographic distribution your clarifying questions established, explain the key you partitioned supply on and what it makes cheap and expensive, name the concrete technologies you chose and why, present your data model, and say what happens when one cell carries a large share of all traffic.",
        followUps: [
          "A stadium empties and one cell takes a large share of every search in the city for ten minutes. Which component feels it first, what does your design do automatically, and what would you add if that were not enough?",
          "The company launches in a third continent next quarter. What exactly do you deploy, what stays global, and which piece of state is now the hardest to keep consistent?",
          "Two riders request a car in the same block in the same instant and the nearest driver is the same person. Walk through your write path and name the mechanism that stops both from being told yes.",
        ],
        rubric: rubric([
          ["framing", "States the request rate, read/write split, demand concentration, staleness tolerance and region split from clarification before placing components", 18],
          ["partition", "Chooses a quantised-location partition key, explains what it makes cheap (a neighbourhood lookup) and expensive (anything crossing cells), and identifies the hot-cell failure it cannot spread away", 22],
          ["tech", "Names a concrete technology for the cell store, the cell cache and the regional entry tier, justifies each against a stated requirement, and names one option considered and rejected with the reason", 20],
          ["dataModel", "Gives entities and primary keys for driver, location, cell and match, states the cell identifier as the partition key, and lists the query patterns including the exclusive claim", 20],
          ["risk", "Quantifies the cross-region round trip or the hot-cell multiple with a number, names the residual failure mode, and says how it would be detected in production", 20],
        ]),
        modelAnswer:
          "Clarification gave me about nine hundred requests per second at peak, seven reads per three writes, a few thousand active cells with extreme concentration, a staleness tolerance of about a second, a sixty-forty split between the US west coast and Europe, and a p95 target near a tenth of a second. I quantise the map into cells and key supply on the cell identifier, so a nearby-drivers query is a handful of key lookups over the rider's cell and its neighbours rather than a spatial scan, and I hash-shard the cell store on that key so cells spread evenly. Hashing spreads cells but cannot spread one cell, so in front of the store I put a keyed cache with a time-to-live tied to the staleness tolerance and request coalescing turned on, which collapses the concurrent misses a stadium generates into one fetch per cell. Because riders and the drivers near them are in the same place, I deploy a full stack per region - entry, matching API, cell cache, cell store - so neither population pays a cross-ocean round trip, which at ninety milliseconds each way would dominate their latency budget entirely; only identity, payments and trip history stay global. Exclusive assignment is a short conditional claim on the driver record with a timeout, so two riders cannot be offered the same car. Residual risks: cell size mis-tuning and a cold regional cache after a deploy.",
      }),
      reflection: {
        question: "Supply is hash-sharded on cell id, and a stadium empties into one cell. Why does adding shards not fix the resulting hot shard?",
        options: [
          "Hashing distributes cells, not the traffic inside one cell, so every request for that cell still lands on one shard no matter how many shards exist",
          "Hash sharding rebalances on write volume, so the hot cell keeps being moved and the migrations are what saturate the shard",
          "More shards increase the number of neighbour lookups per query, so the extra shards add more load than they remove",
          "The hot cell's keys collide with other keys under the hash function, and collisions grow with the shard count",
        ],
        answer: 0,
        explanation:
          "A partition key is only as fine-grained as its own values. Hashing guarantees that different cells land on different shards, which fixes an uneven map, but a single cell is one key: every request for it resolves to one shard however many you add. The mitigations are therefore in front of storage rather than inside it - a short-lived cache of that cell's answer, request coalescing so concurrent misses become one fetch, and if it persists, splitting the hot cell into finer sub-cells so it stops being a single key.",
      },
    }),

    brief({
      id: "log-search",
      chapter: chapterTitles[11],
      title: "Design log search",
      subtitle: "A write-heavy ingest pipeline, a sharded index, and a store that gets slow at the worst moment.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Ingest pipelines & brownout survival",
      brief:
        "Every service in the company ships its logs somewhere, and engineers need to search them when something breaks. All you are told is: 'ingest everything, make it searchable in near real time, and stop the whole thing falling over the way it did during the last incident - when the index got slow and we were blind for twenty minutes.' Nobody has said how many lines per second arrive, how many searches there are, how fresh a search result has to be, or whether dropping some log lines is preferable to losing the pipeline. The canvas is empty: there is no starter pipeline and no required shape, and any architecture that runs and clears the targets passes.",
      learning: [
        "Log search is two systems wearing one name, and the first thing to establish is how lopsided they are. Ingest is a relentless, write-only firehose whose rate is set by how many services you run, not by how many humans are working. Search is a small number of expensive, bursty queries issued by engineers - and, critically, issued precisely during an incident, which is the same moment ingest volume spikes because everything is logging errors. Ask for both numbers, then say the quiet part: the read path's worst hour is the write path's worst hour, so you cannot size them independently.",
        "Decouple acceptance from indexing, because indexing is the slow, failure-prone half. The intake tier should do almost nothing - authenticate, apply a little validation, and put the batch on a durable log - so it can absorb arrival spikes at a rate that has nothing to do with how fast the index can build. Indexers consume from that log at their own pace, and the queue between them is the shock absorber that turns a burst into a delay instead of an error. This is exactly the distributor-and-ingester split that Loki and every production logging stack uses; the phrase to say is that the queue decouples arrival rate from service rate.",
        "The queue must be bounded, and you should be able to derive the bound rather than guess it. An unbounded backlog converts an overload into a silent latency problem that ends with every queued batch aged past usefulness and failing together. The bound comes from Little's law run backwards: decide how far behind real time a search may legitimately be, multiply by the drain rate, and that is how many items you are willing to hold. Beyond it, intake rejects immediately and honestly, and your dashboard shows shedding rather than a slowly growing lie.",
        "Sharding the index is what makes search survivable, and the shard key is a real decision with a real trade-off. Hashing on a stream identity - service plus host, say - spreads writes perfectly evenly and keeps one stream's lines together, but a search across all services becomes a fan-out to every shard. Sharding by time instead makes retention and recent-window queries trivial while guaranteeing that every write in the fleet piles onto whichever shard owns the current hour, which is a hot partition by construction. Most production systems compromise: partition by time into indices, and shard within each by stream. Say which you chose and what query you made expensive.",
        "Then size the shards against the failure you actually have to survive, which is not a crash. Storage systems brown out: a compaction storm, a slow disk, a noisy neighbour, and service time multiplies for a while. If the arrival rate exceeds the degraded capacity for even a few seconds, a backlog accumulates that must be drained afterwards at whatever surplus remains, which is why the outage always outlasts the event. The design rule is to pick per-shard headroom from the slowdown multiplier you are designing against, so degraded capacity still clears the arrival rate - and to put a token-bucket limiter at the front door so nothing can push you past that budget.",
        "Be deliberate about what you shed, because not all log lines are equal. Error and audit streams are what the incident responder is searching for; a chatty debug logger on a batch job is not. Real pipelines encode this as per-tenant and per-stream rate limits with separate budgets, so a single team's runaway logger cannot consume the pipeline that everyone else's incident depends on. That is the answer to 'what do you drop?' - never 'a random slice of everything'. Cardinality belongs in the same conversation: a label containing a request id multiplies stream count and is the standard way a logging bill explodes overnight.",
        "What this model idealizes: the simulation shows you ingest throughput, shedding and brownout recovery, but not the inverted index itself, segment merging, the object storage tier that real systems use for cold data, or the query planner that turns a search into a fan-out with a deadline. It also treats a search as one request, when in production it is a scatter-gather over every shard with per-shard timeouts and partial results. Name those, and be clear that what you measured is the ingest tier's behaviour under stress rather than query performance.",
      ],
      hints: [
        "The canvas is empty, so build an ingest path you can measure, then watch the timeline after the storage tier slows rather than only during it - the damage outlives the event.",
        "Separate the thing that accepts a batch from the thing that indexes it, and put something durable and bounded between them so an arrival burst becomes a delay instead of an error.",
        "Work out what fraction of each partition's capacity survives while storage runs several times slower, spread the writes wide enough that the remainder still clears the arrival rate, and cap what you admit at the front door; any design that clears the targets passes.",
      ],
      objectives: [
        objective("p95", "lte", 160),
        objective("throughput", "gte", 780),
        objective("errorRate", "lte", 0.01),
        rejected(0.08),
        budget(250),
      ],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: logSearchReference,
      workload: workload({
        requestRate: 850,
        readRatio: 0.15,
        duration: 30,
        seed: 18,
        keySpace: 40000,
        keySkew: 0.5,
        failures: [{ kind: "slow-database", at: 0.5, duration: 5, factor: 3 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["database", "queue", "server", "rate-limiter"],
      dataModelPrompt:
        "Model the index. Name the entities (log line or event, stream or series, index segment, tenant, at minimum), give each a primary key, and state the shard key you chose for the index with what it makes cheap and what it makes a fan-out. List the query patterns: append a batch, search a time range within one stream, search a time range across all streams, and enforce retention. Say which label you would refuse to index and why cardinality is the thing that breaks this model.",
      clarifications: [
        clarification(
          "What ingest rate should I design for, and how many searches are there?",
          "Around eight hundred and fifty requests per second of ingest at steady state, and search is a trickle by comparison - roughly fifteen percent of the traffic, and it spikes exactly when an incident starts.",
        ),
        clarification(
          "How fresh does a search result have to be?",
          "Near real time - a few seconds behind is fine, a minute is not. Engineers are watching a deploy and need to see the errors it caused.",
        ),
        clarification(
          "What happened last time the index got slow, and may we drop data to protect the pipeline?",
          "It ran several times slower for a few seconds and the backlog took twenty minutes to clear, so we were blind long after it recovered. Yes - dropping some lines is far better than losing search during an incident.",
        ),
        clarification(
          "What latency does an ingest call have to meet?",
          "It is agent-to-service, so a couple of hundred milliseconds at p95 is fine. Agents buffer briefly; multi-second stalls make them drop data on their own.",
        ),
        clarification(
          "How is the log volume distributed across services?",
          "Thousands of distinct streams, and no single one dominates the way a hot key would - it is broad rather than concentrated. One team's runaway debug logger can still double the total overnight.",
        ),
        clarification(
          "What is the budget for this pipeline?",
          "It is internal tooling and the index is the expensive part, so keep the whole thing under about two hundred and fifty credits.",
        ),
        clarification(
          "Which query language should the search UI expose?",
          "Something close to what the team already knows. That is a product decision on top of whatever index you build.",
          false,
        ),
        clarification(
          "How long should we keep logs for, in the legal sense?",
          "Thirty days for most, a year for audit streams. Retention policy is being written separately and does not change the ingest sizing.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your log pipeline. State the ingest rate, search share, freshness requirement and shedding permission your clarifying questions established, show how you derived the partition count and the per-partition headroom needed to survive the slowdown, name the concrete technologies for the buffer and the index and justify them, present your data model and shard key, and say what you drop first.",
        followUps: [
          "The index runs five times slower for a full minute instead of three times slower for a few seconds. Which of your numbers breaks first, and what does your design do instead of collapsing?",
          "An engineer runs a search across every stream for a fourteen-day window during an incident. What does that query do to the tier you just sized, and how do you stop one query from hurting ingest?",
          "A team ships a log label containing a request id and the stream count multiplies overnight. Which part of your design absorbs it, which part does not, and what would have caught it on the first day?",
        ],
        rubric: rubric([
          ["framing", "States the ingest rate, search share, freshness target and explicit permission to shed from clarification before choosing components", 18],
          ["decouple", "Separates intake from indexing with a durable bounded buffer, and derives the bound from a freshness tolerance times the drain rate rather than picking a number", 20],
          ["headroom", "Derives the partition count and per-partition headroom from the arrival rate and the brownout multiplier, and explains why the backlog outlasts the event", 22],
          ["tech", "Names a concrete technology for the durable buffer, the index and the front-door limiter, justifies each against a stated requirement, and names one rejected alternative with the reason", 20],
          ["dataModel", "Gives entities and keys for streams, events and segments, states the shard key with the query it makes a fan-out, and identifies cardinality as the growth risk", 20],
        ]),
        modelAnswer:
          "Clarification established roughly eight hundred and fifty requests per second of ingest, search at about fifteen percent of traffic and bursting exactly during incidents, a few seconds of acceptable indexing delay, explicit permission to shed rather than fall over, and a budget near two hundred and fifty credits. I split acceptance from indexing: a thin intake tier behind a balancer validates and appends to a durable bounded buffer, and a pool of indexers consumes from it, so arrival rate is decoupled from index speed. The bound comes from the freshness tolerance multiplied by the drain rate - a few seconds of backlog, not an unbounded one - so an overload is visible immediately as shedding instead of as silently ageing data. The index is hash-sharded on stream identity, which spreads writes evenly and keeps a stream contiguous for a single-service search, at the cost of making an all-stream search a fan-out with per-shard timeouts and partial results. I sized the shards against the failure I actually have: a threefold slowdown, so per-shard arrival sits near a third of per-shard capacity and degraded capacity still exceeds arrivals, which is why the pipeline drains during the brownout instead of building a backlog that outlives it. A token-bucket limiter at the front door caps what can ever be admitted past that budget. What I drop first is high-volume debug streams under per-tenant limits, never error or audit streams, and the signals I watch are rejected rate, per-shard utilization and stream cardinality.",
      }),
      reflection: {
        question: "The index slows to a third of its normal speed for a few seconds, yet search stays broken for far longer. What is the mechanism?",
        options: [
          "Arrivals continue while degraded capacity sits below them, so a backlog accumulates that must be drained afterwards from whatever surplus capacity is left",
          "The slowdown corrupts open index segments, so every segment touched during the event has to be rebuilt from the buffer",
          "Search queries are queued behind ingest in the same pool, so the search tier stays saturated until the queue is manually cleared",
          "Agents interpret the slowdown as a failure and permanently stop shipping, so the gap persists until each agent is restarted",
        ],
        answer: 0,
        explanation:
          "A brownout is arithmetic. For every second that effective capacity sits below the arrival rate, the difference accumulates, and afterwards it can only be drained by whatever capacity is left over above the ongoing arrivals - so the recovery tail is longer than the event that caused it. The two defences follow directly: per-partition headroom sized from the slowdown multiplier you design against, so degraded capacity still clears arrivals, and a front-door limiter that prevents anything from pushing you past that budget in the first place.",
      },
    }),

    brief({
      id: "video-upload-pipeline",
      chapter: chapterTitles[11],
      title: "Design a video upload pipeline",
      subtitle: "Large objects, a transcoding fleet, a launch-day surge, and uploads that poison the queue.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Large objects & asynchronous pipelines",
      brief:
        "A creator platform wants uploads that work. The prompt is one line: 'a creator picks a file, it uploads, and a bit later it is watchable everywhere in every quality - and when a big campaign launches, thousands of people upload at the same minute.' Nothing in that tells you the file sizes, the upload rate, how long a creator will wait before the video is live, how many playbacks each upload eventually gets, or what should happen to a file that no encoder can process. Ask before you build. The canvas is empty - no starter design, no prescribed shape - and any architecture that runs and clears the targets is a pass.",
      learning: [
        "The first thing to get right is that the bytes should never touch your application servers. A multi-gigabyte upload streamed through an API replica occupies that replica for minutes, ties its lifetime to the creator's flaky connection, and makes every deploy an interrupted upload. The production pattern is a signed, direct, resumable upload to object storage: your service issues a short-lived credential, the client streams straight to storage, and your service learns the upload finished from a completion callback or a storage event. Say this early, because it changes what the request rate even means - your API handles small control-plane calls, not the payload.",
        "Everything after that is asynchronous by necessity. Transcoding one source into a ladder of renditions is minutes of CPU, not milliseconds of I/O, so the completion event goes onto a durable queue and a fleet of encoder workers consumes it. The creator is told 'processing', gets a thumbnail when the first rendition lands, and the video becomes watchable progressively. The contract to state plainly is that acceptance is acknowledged when the object and its metadata are durable, not when the encode finishes - anything else means a creator watching a spinner for ten minutes.",
        "Size the worker fleet from the job, not from the request rate, and expect the two numbers to look nothing alike. Each job occupies a worker for a long time, so what you need is total processing seconds per second of wall clock - arrival rate multiplied by service time - and enough parallel workers that the pool's aggregate exceeds it with real headroom. A pool near full utilization has a backlog that grows on every fluctuation, and here a growing backlog is directly visible to creators as minutes added to their publish time. Two to three times headroom is the production norm, and autoscaling the encoder pool on queue depth is the standard control loop.",
        "A launch surge is a queue-shaped problem, which is exactly what this architecture is good at. When uploads arrive at many times the baseline for a short window, the queue absorbs them and the fleet drains at its own rate: the cost is publish latency for the tail of that burst, not errors. But the intake tier still has to survive the front of the surge, and that is what a token-bucket limiter with a burst allowance is for - it protects the control plane instantly, and it turns 'the site fell over' into 'some creators were asked to retry in a moment'. Provisioning the encoder fleet for the peak would mean paying for idle machines every other minute of the year.",
        "Poison messages are the failure mode unique to this shape, and a brief that mentions them is testing whether you know about dead letters. Some fraction of uploads are corrupt, truncated, an unsupported codec, or simply large enough to trip a bug - and with at-least-once delivery, a job that crashes its worker becomes visible again and is redelivered to the next worker, which also crashes. Without a delivery limit, one bad file walks through your entire fleet, repeatedly, forever. The mechanism is a maximum delivery count after which the message is routed to a dead-letter queue, where it stops consuming capacity and starts being a support ticket. Say that the dead-letter rate is a first-class alert, because it is the earliest signal of a bad encoder release.",
        "At-least-once plus idempotent workers is the only honest delivery story, and it shapes your data model. A redelivery must not produce a second copy of a rendition or a second row of metadata, so key the output deterministically on the asset and the rendition - overwriting a rendition that is already there is a no-op rather than a duplicate. Combined with a visibility timeout longer than the worst realistic encode, that gives effectively-once side effects without pretending the network is reliable.",
        "Playback is the other half of the bill and the place where a CDN is not optional. One upload produces many renditions and is then watched thousands of times, so the read path is enormously larger than the write path and is also perfectly cacheable - immutable segment files under content-addressed URLs. Serving that from edge caches keeps origin traffic to cache fills and moves the expensive bytes to where the viewers are; without it, egress alone dwarfs every other line on the bill. What this model idealizes: it gives you the control plane, the queue, the encoder fleet and the edge hit rate, but not the bytes themselves - no storage growth, no per-rendition encode cost, no adaptive-bitrate manifest logic, and no content moderation, which in practice is another mandatory stage in the same pipeline.",
      ],
      hints: [
        "The canvas is empty, so ask what actually travels through your servers before you draw anything - if the payload never enters the request path, the tier you are sizing is much smaller than the brief implies.",
        "Put the slow work behind something durable and let the creator be acknowledged before it finishes, then look at what the timeline does during the surge rather than at the overall average.",
        "Give the delivery mechanism a limit on how many times one job may be retried before it is set aside, protect the front door with something that can shed instantly, and serve the read path from the edge; any design that clears the targets passes.",
      ],
      objectives: [
        objective("p95", "lte", 110),
        objective("throughput", "gte", 690),
        objective("errorRate", "lte", 0.01),
        rejected(0.12),
        deadLetters(0.01),
        budget(115),
      ],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: videoReference,
      workload: workload({
        requestRate: 600,
        readRatio: 0.75,
        duration: 30,
        seed: 19,
        pattern: "flash",
        keySpace: 5000,
        keySkew: 0.7,
        failures: [{ kind: "server", at: 0.45, duration: 4, target: "transcoder" }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["cdn", "queue", "server", "database", "rate-limiter"],
      dataModelPrompt:
        "Model the asset pipeline. Name the entities (upload session, asset, rendition, transcode job, dead-letter record, at minimum), give each a primary key, and state the deterministic key that makes a redelivered transcode job overwrite rather than duplicate a rendition. List the query patterns: start an upload, record a completion, claim the next job, mark a rendition ready, and fetch the playback manifest for an asset. Say which entity grows fastest, what you partition it by, and how a job reaches the dead-letter path.",
      clarifications: [
        clarification(
          "What upload rate should I design for, and what does the launch surge look like?",
          "A few hundred control-plane requests per second at baseline, and during a campaign launch it jumps to several times that for under a minute before falling back.",
        ),
        clarification(
          "How big are the files, and do they travel through our API?",
          "Hundreds of megabytes to a few gigabytes. They should absolutely not travel through the API - we want signed direct-to-storage uploads with resumption, and a completion event afterwards.",
        ),
        clarification(
          "How long may a creator wait before the video is watchable?",
          "Minutes is fine and expected, as long as they get an immediate acknowledgement and a visible progress state. What is not acceptable is the upload call itself hanging or failing.",
        ),
        clarification(
          "How many playbacks does an upload get, and how cacheable are they?",
          "Orders of magnitude more reads than writes - roughly three playback requests for every control-plane call in our mix - and the segments are immutable once published, so they are perfectly cacheable at the edge.",
        ),
        clarification(
          "What should happen to a file that cannot be processed?",
          "It must stop after a few attempts, be set aside somewhere we can inspect it, and raise an alert. Last time a single corrupt file cycled through the whole encoder fleet for hours.",
        ),
        clarification(
          "Is it acceptable to turn some uploads away during the surge?",
          "An instant, honest 'try again in a moment' is acceptable for a small share. A request that hangs and then fails after a timeout is not.",
        ),
        clarification(
          "Which codecs and rendition ladder should we produce?",
          "The standard set for web and mobile. The encoder team owns that list and it does not change the pipeline's shape.",
          false,
        ),
        clarification(
          "Should creators be able to edit the video title after publishing?",
          "Yes, that is a metadata update in the product. It has no bearing on the ingest and transcoding design.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your upload pipeline. State the upload rate, surge shape, file sizes, publish-latency tolerance and playback ratio your clarifying questions established, explain what the creator is acknowledged for and what happens behind it, show how you sized the encoder fleet, name the concrete technologies you chose, present your data model, and describe exactly what happens to a file no encoder can process.",
        followUps: [
          "A single corrupt upload crashes whichever worker picks it up. Trace that message through your queue and say precisely which setting stops it from touching every worker in the fleet.",
          "The campaign surge lasts ten minutes instead of one. Which of your numbers breaks first, what does a creator experience, and what do you scale?",
          "Finance says the bill is dominated by a single line item. Which one is it in your design, and what are the two changes you would make before adding capacity anywhere else?",
        ],
        rubric: rubric([
          ["framing", "States the upload rate, surge shape, file sizes, publish-latency tolerance and playback-to-upload ratio from clarification before placing components", 18],
          ["pipeline", "Keeps the payload out of the request path with signed direct-to-storage uploads, acknowledges on durable metadata rather than on encode completion, and sizes the encoder fleet from processing seconds per second with headroom", 22],
          ["poison", "Specifies at-least-once delivery with a maximum delivery count and a dead-letter destination, explains why an idempotent worker with a deterministic output key is required, and treats dead-letter rate as an alert", 20],
          ["tech", "Names a concrete technology for object storage, the job queue, the encoder fleet and the edge tier, justifies each against a stated requirement, and names one rejected alternative with the reason", 20],
          ["dataModel", "Gives entities and primary keys for upload session, asset, rendition and job, states the deterministic rendition key that makes redelivery idempotent, and identifies the fastest-growing entity and its partition key", 20],
        ]),
        modelAnswer:
          "Clarification gave me a few hundred control-plane requests per second with a surge of several times that for under a minute, files of hundreds of megabytes to a few gigabytes, minutes of acceptable publish latency with an immediate acknowledgement, roughly three playback requests per control-plane call against immutable segments, a requirement that unprocessable files be set aside after a few attempts, and tolerance for instant shedding. So the bytes never enter my request path: the intake service issues a short-lived signed credential, the client streams directly to object storage with resumption, and a completion event creates the asset metadata - that durable metadata write is what the creator is acknowledged on. The completion event goes onto an at-least-once queue, and an encoder fleet sized from arrival rate times encode duration, with roughly twofold headroom and autoscaling on queue depth, produces the rendition ladder. Redelivery is safe because each rendition is written under a deterministic key of asset and rendition, so a repeat is an overwrite rather than a duplicate, and the visibility timeout exceeds the worst realistic encode. A maximum delivery count routes a poison file to a dead-letter queue after a few attempts instead of letting it walk the fleet, and dead-letter rate is an alert because it is the first sign of a bad encoder release. A token-bucket limiter with a burst allowance protects the control plane through the front of the surge; the queue absorbs the rest as publish latency rather than errors. Playback is served from edge caches against immutable segments, which is what keeps origin egress - otherwise the largest line on the bill - down to cache fills.",
      }),
      reflection: {
        question: "With at-least-once delivery, one corrupt upload crashes every worker that picks it up. Which mechanism actually stops it, and why do the others not?",
        options: [
          "A maximum delivery count that routes the message to a dead-letter destination after a few attempts, because idempotency and a longer visibility timeout make redelivery safe but do not make it stop",
          "Making the worker idempotent, because a deduplicated job does no work and therefore cannot crash the worker again",
          "Raising the visibility timeout, because the message stays invisible long enough for the fleet to recover before it is retried",
          "Bounding the queue, because the poison message is rejected on arrival once the backlog it causes reaches the bound",
        ],
        answer: 0,
        explanation:
          "Idempotency stops a redelivery from producing duplicate output, and a visibility timeout stops a slow job from being redelivered while it is still running - both are necessary, and neither limits how many times a message that never succeeds comes back. Only a delivery counter with a dead-letter destination ends the cycle: after a few failed attempts the message leaves the working set, stops consuming encoder capacity, and becomes something a human can inspect. A queue bound sheds new arrivals, which does nothing about a message already inside.",
      },
    }),
  ],
};
