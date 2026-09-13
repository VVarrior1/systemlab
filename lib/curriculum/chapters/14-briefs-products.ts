import {
  allKinds,
  brief,
  chain,
  chapterTitles,
  clarification,
  defense,
  duplicates,
  estimate,
  graph,
  healthy,
  budget,
  node,
  objective,
  readingsFor,
  rejected,
  rubric,
  staleReads,
  workload,
  type ChapterFile,
} from "../shared";

/**
 * Chapter 12 continued - Design briefs, product systems (v2.2, spec section 14 item 6).
 * Four more Expert blank-canvas briefs: collaborative editing, a leaderboard, a rate-limiting
 * service, and ad-click aggregation. Same contract as `12-briefs.ts`: the prompt is deliberately
 * under-specified, the workload only makes sense once the relevant clarifications are asked, the
 * learner starts from a traffic-only canvas (`blankCanvas: true`), and grading is objectives plus
 * runnability - the reference below is never shown.
 *
 * v2.2 adds two stages between the build and the defense, which these briefs drive:
 * `techFocus` lists the node kinds the learner must name a concrete technology for, and
 * `dataModelPrompt` names the entities, keys and query patterns they must write down.
 *
 * Every reference was measured on the three assessment seeds [lesson seed, 123, 2026]; the
 * objectives sit roughly 25-45% above the worst measured value so a remix still has room.
 */

/** Every blank-canvas brief starts here: traffic and nothing else. */
const blankCanvasStarter = chain([node("traffic", "traffic", 0)]);

// ------------------------------------------------------------------ collaborative-editing
const editingReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Edit API", capacity: 360, replicas: 3 }),
    node("database", "db", 3, {
      label: "Document store",
      capacity: 440,
      replicas: 3,
      dbMode: "leader-follower",
      replicationLagMs: 200,
      consistency: "read-your-writes",
    }),
    node("queue", "queue", 3, { label: "Fan-out queue", maxQueue: 4000 }, 1),
    node("server", "worker", 4, { label: "Fan-out worker", role: "worker", capacity: 280, replicas: 3 }, 1),
    node("database", "presence", 5, { label: "Collaborator store", capacity: 250, dbMode: "sharded", shards: 3 }, 1),
  ],
  [
    ["traffic", "balancer"],
    ["balancer", "api"],
    ["api", "db"],
    ["api", "queue"],
    ["queue", "worker"],
    ["worker", "presence"],
  ],
);

// ------------------------------------------------------------------ leaderboard
const leaderboardReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Leaderboard API", capacity: 450, replicas: 3 }),
    node("cache", "cache", 3, { label: "Top-N cache", cacheModel: "keyed", cacheEntries: 4000, coalesce: true, ttlMs: 2000 }),
    node("database", "db", 4, { label: "Score store", capacity: 400, replicas: 3, dbMode: "leader-follower", replicationLagMs: 150 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ------------------------------------------------------------------ rate-limiter-service
const limiterReference = graph(
  [
    node("rate-limiter", "shed-us", 1, { label: "US overload shed", limit: 520, burst: 300, region: "us-east" }, -1),
    node("load-balancer", "lb-us", 2, { label: "US balancer", region: "us-east" }, -1),
    node("server", "api-us", 3, { label: "US decision API", capacity: 400, replicas: 2, region: "us-east" }, -1),
    node("cache", "counters-us", 4, { label: "US counter cache", cacheModel: "keyed", cacheEntries: 9000, region: "us-east" }, -1),
    node("database", "rules-us", 5, { label: "US policy store", capacity: 400, region: "us-east" }, -1),
    node("traffic", "traffic", 0),
    node("rate-limiter", "shed-eu", 1, { label: "EU overload shed", limit: 440, burst: 260, region: "eu-west" }, 1),
    node("load-balancer", "lb-eu", 2, { label: "EU balancer", region: "eu-west" }, 1),
    node("server", "api-eu", 3, { label: "EU decision API", capacity: 400, replicas: 2, region: "eu-west" }, 1),
    node("cache", "counters-eu", 4, { label: "EU counter cache", cacheModel: "keyed", cacheEntries: 9000, region: "eu-west" }, 1),
    node("database", "rules-eu", 5, { label: "EU policy store", capacity: 400, region: "eu-west" }, 1),
  ],
  [
    ["traffic", "shed-us"],
    ["shed-us", "lb-us"],
    ["lb-us", "api-us"],
    ["api-us", "counters-us"],
    ["counters-us", "rules-us"],
    ["traffic", "shed-eu"],
    ["shed-eu", "lb-eu"],
    ["lb-eu", "api-eu"],
    ["api-eu", "counters-eu"],
    ["counters-eu", "rules-eu"],
  ],
);

// ------------------------------------------------------------------ ad-click-aggregation
const clickReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "intake", 2, { label: "Click intake", capacity: 500, replicas: 3 }),
    node("queue", "queue", 3, { label: "Click stream", maxQueue: 6000, ackMode: "at-least-once", visibilityTimeoutMs: 300, maxDeliveries: 4 }),
    node("server", "worker", 4, { label: "Aggregation worker", role: "worker", capacity: 400, replicas: 4, idempotent: true }),
    node("database", "db", 5, { label: "Counter store", capacity: 400, dbMode: "sharded", shards: 8 }),
  ],
  [["traffic", "balancer"], ["balancer", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);

export const chapter: ChapterFile = {
  title: chapterTitles[11],
  lessons: [
    brief({
      id: "collaborative-editing",
      chapter: chapterTitles[11],
      title: "Design collaborative document editing",
      subtitle: "A flood of tiny writes, and every author must see their own keystroke.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Write-heavy collaboration",
      brief:
        "A productivity company wants multiple people editing the same document at once. The whole prompt is: 'it should feel like the other person is typing in the same window, nothing anyone types may ever be lost, and it must not feel laggy.' Nobody has told you how many edits a second, how many people share a document, whether a collaborator may see an edit a moment late, or what an author must see of their own work. The canvas is empty: no starter design, no prescribed shape, and any architecture that runs and clears the targets passes - so the pipeline you draw is the argument you will defend.",
      learning: [
        "Collaborative editing inverts the ratio every product engineer carries around. A document is opened once and then edited continuously, so the traffic is a stream of very small writes - a character, a cursor move, a formatting toggle - with comparatively few reads. That single established fact removes the cache from the centre of the design, because there is no repeated read traffic for it to absorb, and moves the money to the write path and its durability guarantees. Establish the ratio in clarification and say out loud that this is a write-heavy system before you place a single component.",
        "Split the request into what the author waits for and what they do not. Accepting an edit means validating it, assigning it a position in the document's order, and writing it durably; propagating it to everyone else in the session, updating presence, recomputing the document snapshot and sending notifications all happen behind that boundary. The author's latency is then the intake path alone, which is short and predictable, while fan-out to collaborators is queued work that can be retried without anyone watching a spinner. Acknowledge after the durable write, never after delivery.",
        "The consistency requirement here is unusually specific, and it is the interview signal. Collaborators may lag by a moment - nobody notices a hundred milliseconds in someone else's cursor - but an author must always see their own edit, immediately and in the right place. That is read-your-writes on exactly one path, and it is far cheaper than making the whole system strongly consistent: route a session's own reads to the copy that has certainly applied its writes, and let everything else read from a replica that may be a replication lag behind. Say which reads are pinned and what that costs the leader.",
        "Convergence is the part the simulator cannot show and the interviewer will ask about. Two people typing into the same paragraph produce conflicting operations, and the two industry answers are operational transformation, where the server rewrites incoming operations against the ones it has already applied, and CRDTs, where every operation carries enough identity that any order converges without a central arbiter. OT keeps the document small and the server smart; CRDTs keep the server dumb and let clients work offline, at the cost of metadata that grows with edit history. Name your choice and its cost - that is the answer being listened for.",
        "The write volume also decides where the data lives. Edits are append-only and partition naturally by document, so hashing on the document identifier gives you even spread, locality for the one query that matters, and a single ordering lane per document all at once. Range-partitioning by time would put every edit in the product onto one partition, which is how you manufacture a hot shard on purpose. Say the partition key out loud, and say what it makes expensive: anything that crosses documents becomes a fan-out.",
        "What this model idealizes: real collaborative editing runs over persistent connections, so there is a whole session tier - gateways holding one socket per participant, presence, and consistent hashing so every participant in one document lands on the same server - that a request-response simulation does not represent. Snapshotting and log compaction, offline reconciliation, and access control on every operation are also absent. Name those, and be clear that what you sized here is the intake, fan-out and storage pipeline behind that socket layer.",
      ],
      hints: [
        "Nothing is on the canvas, so start from the read/write mix rather than from components: it tells you which tier will be expensive and rules out the one you would reach for by reflex.",
        "Separate what the author waits for from what the other collaborators can receive a moment later, then work out how much traffic lands on the one component that must accept every edit.",
        "Give the write path a single ordered home per document, pin an author's own reads to the copy that certainly has their edit, and push fan-out behind a buffer; any shape that clears the targets counts.",
      ],
      objectives: [...healthy(460, 110), staleReads(0.02), budget(210)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: editingReference,
      workload: workload({ requestRate: 500, readRatio: 0.4, duration: 30, seed: 21, keySpace: 8000, keySkew: 0.7 }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["server", "database", "queue", "load-balancer"],
      dataModelPrompt:
        "Model the data: Document, Edit (the operation log), Session/Participant, and the Snapshot you materialise from the log. For each, give the primary key, the partition key, the query patterns the product actually issues (load a document, append an edit, list the participants of a session, resume from a cursor), and how each entity grows with edits per document and documents per tenant.",
      remixable: true,
      clarifications: [
        clarification(
          "What is the edit rate at peak, and what is the read-to-write mix?",
          "About five hundred requests per second at peak, and it is write-dominated: roughly three edits for every document load. Clients hold the document they already have open.",
        ),
        clarification(
          "How many people edit one document at the same time, and how many documents are live?",
          "Typically two to five, occasionally forty in a meeting. A few thousand documents are live at any moment out of a much larger archive, and the live ones take almost all the traffic.",
        ),
        clarification(
          "May a collaborator see someone else's edit a moment late?",
          "Yes - a fraction of a second is invisible to them. What is not acceptable is an author not seeing their own edit, or seeing it appear in the wrong place.",
        ),
        clarification(
          "What latency should typing feel like?",
          "The author's acknowledgement should come back inside a couple of hundred milliseconds at p95. Propagation to other participants can take a little longer than that.",
        ),
        clarification(
          "What must never be lost, and how long is edit history retained?",
          "No accepted edit may be lost - version history is a paid feature. Keep the full operation log indefinitely; only a recent window is served interactively, and older history is compacted into snapshots.",
        ),
        clarification(
          "What is the budget for this service?",
          "It is the core of a paid product, so there is real money available - but keep it under about two hundred and ten credits, or the unit economics stop working.",
        ),
        clarification(
          "Which rich-text editor component should the client use?",
          "The team already has one. It is a front-end decision and does not constrain the backend design.",
          false,
        ),
        clarification(
          "How many engineers will own this service?",
          "Five. Relevant to how much we can operate, not to how the pipeline is sized.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your collaborative editing design. State the edit rate, read/write mix, session size and consistency requirement your clarifying questions established, show the arithmetic from the front-door rate to the load on the component that must accept every edit, justify each technology you picked against a specific requirement, walk through your data model, and name two alternatives you rejected.",
        followUps: [
          "Two people type into the same paragraph at the same instant. Walk through how your design decides what the document ends up saying, and what your choice costs you in server complexity or stored metadata.",
          "A customer opens one document in a forty-person meeting and the fan-out for that document is forty times heavier than the average. Which component feels it first, and what do you change?",
          "The product adds offline editing: a client reconnects after an hour with a thousand buffered operations. What does your intake path do, and which of your consistency assumptions breaks?",
        ],
        rubric: rubric([
          ["framing", "States the write-dominated mix, session size, per-author consistency requirement and durability rule from clarification before placing components", 20],
          ["arith", "Computes the write rate landing on the ordered write path and sizes it with explicit headroom, rather than sizing from the front-door rate", 20],
          ["consistency", "Pins an author's own reads to a copy that has their edit while letting collaborators read a lagging replica, and says what that costs", 20],
          ["tech", "Justifies each chosen technology against a requirement - an ordered append-only log for edits, a replicated store for documents, a broker for fan-out - and names the alternative it beat", 20],
          ["datamodel", "Gives Document, Edit, Session and Snapshot entities with primary and partition keys, the real query patterns, and how each grows", 20],
        ]),
        modelAnswer:
          "Clarification gave me five hundred requests per second at peak, write-dominated at roughly three edits per document load, two to five collaborators per document with a forty-person tail, a few thousand live documents, an explicit tolerance for collaborators lagging a fraction of a second, an absolute requirement that an author sees their own edit, and no accepted edit ever lost. Write-dominated means no repeated read set, so no cache: three hundred writes a second land on the ordered write path, and I size that store near double what it needs, because the leader that orders a document's edits is one lane. The API is a balanced trio of replicas that validates, assigns a position and writes durably; acknowledgement happens there, so typing latency is the intake path only. Fan-out to other participants, presence and snapshots go behind a buffered queue into a worker pool sized above the arrival rate, writing to a store partitioned by document. Reads carrying a session's own recent writes are pinned to the leader; everything else reads a replica a replication lag behind, which the product explicitly tolerates. I rejected making every read strongly consistent - it doubles leader load for a guarantee only the author needs - and rejected synchronous fan-out, which puts every collaborator's network in the author's latency budget. For convergence I would use operational transformation on a per-document ordering lane and store the operation log append-only, keyed by document with a monotonic sequence, compacted into periodic snapshots.",
      }),
      reflection: {
        question: "The clarifications say collaborators may lag a fraction of a second but an author must always see their own edit. Why is that pair of answers cheaper than 'the document is always consistent for everyone'?",
        options: [
          "Because only the author's own reads have to be routed to a copy that certainly has the edit; everyone else can read a lagging replica, so the ordered write path carries far less read traffic",
          "Because it removes the need for any ordering at all, since each participant sees their own history",
          "Because eventual consistency makes writes faster, so the leader can accept more of them per second",
          "Because a cache can serve the author's own edits from memory without involving storage",
        ],
        answer: 0,
        explanation:
          "Read-your-writes is a per-session routing rule, not a system-wide guarantee: pin the small share of reads that follow a recent write by the same session to the copy that has it, and let the rest fan out over replicas. Making everything consistent would send all reads to the one ordered lane that already carries every write. Ordering is still required for convergence, eventual consistency does not change write throughput, and a cache in front of a write-heavy stream absorbs almost nothing.",
      },
    }),

    brief({
      id: "leaderboard",
      chapter: chapterTitles[11],
      title: "Design a game leaderboard",
      subtitle: "One key takes most of the reads, and it changes every time a match ends.",
      difficulty: "Expert",
      minutes: 30,
      concept: "Hot-key reads & coalescing",
      brief:
        "A mobile game wants a leaderboard. The prompt you are handed is: 'every player should see the global top of the table on the home screen, it should be up to date, and it must not fall over on tournament night.' You are not told how often players look at it versus how often scores change, how concentrated the reads are, how stale the table may be, or what happens when the cache in front of it is empty. Every one of those answers moves the design. The canvas is empty - nothing is placed for you and no shape is required, so any architecture that runs and clears the targets is a pass.",
      learning: [
        "A leaderboard is the extreme case of the hot-key problem. Almost nobody asks for rank four thousand; nearly every request is the same global top slice, rendered on a home screen that opens every time the app does. The read distribution is not merely skewed, it is concentrated on a handful of keys, and that changes what a cache is: not a statistical hit-rate dial, but a component that will serve one specific value to essentially the entire user base. Establish the concentration in clarification, because it is what makes the rest of the arithmetic possible.",
        "Writes are rare and bursty, and they arrive at a different rhythm from reads. Scores change when a match ends, not while people scroll, so the write rate is a small fraction of the read rate but it clusters - a tournament round finishes and thousands of results land inside a few seconds. That asymmetry is the whole design: an enormous, extremely concentrated read stream that a cache can flatten completely, sitting over a modest write stream that has to be ordered and durable.",
        "Freshness is a product decision, not a technical constant, and it is worth a short negotiation. A leaderboard that is a second or two behind is indistinguishable from live to a player, and that single concession lets you put a short time-to-live on the cached top slice and serve almost every request from memory. Demanding a strictly current table on every read would mean recomputing or re-reading a ranked structure on every home-screen open, which is the difference between one storage read per second and thousands.",
        "Now the failure this design actually has to survive: the stampede. When the cached top slice expires or the cache restarts cold, every in-flight request for that one key misses at the same instant and they all go to storage together. A key that was absorbing thousands of reads a second becomes thousands of simultaneous storage reads, which is enough to take down a database that was comfortable a millisecond earlier. The fix is request coalescing - the first miss fetches, everyone else waits on that single in-flight fetch - plus enough storage headroom that the one fetch that does happen is cheap. Name it, because 'add a cache' without it is the answer that fails at the drop.",
        "The ranked structure itself belongs in your answer. A sorted set - Redis ZSET, or the equivalent skip-list structure in any store - gives you rank and range queries in logarithmic time and updates in place when a score changes, which beats sorting a table on every read by an enormous margin. Say what it does not give you: a single sorted set is one key on one node, so a global board is inherently a hot key, and sharding by score band or by region turns a rank query into a merge across shards. Per-player rank in a huge board is the follow-up question, and the honest answers are approximate ranks from a histogram of score buckets, or an exact rank only for the neighbourhood around the player.",
        "What this model idealizes: the simulation exercises the read path and its stampede, not the sorted-set operations themselves, the anti-cheat pipeline that decides whether a score counts, or the time-windowed boards - daily, weekly, seasonal - that a real game runs alongside the all-time table and that multiply both the write volume and the number of hot keys. Name those, and be explicit that the number you measured is the read tier's behaviour, not the ranking structure's cost.",
      ],
      hints: [
        "The canvas is empty, so build the smallest path that can answer a top-of-table request, run it, and look at how few distinct keys the reads actually ask for.",
        "Work out how much traffic survives once the hot slice is held in memory, then ask what happens at the instant that memory is empty and every request for the same key misses together.",
        "Hold the hot slice in memory with a short expiry, make simultaneous misses on one key share a single fetch, and keep storage sized for that fetch rather than for the front door; any shape that clears the targets passes.",
      ],
      // The shared readings library covers the ranked structure; these two cover the other half of
      // the lesson (the hot-key stampede and an end-to-end leaderboard build). Remove the inline
      // list once `lib/readings/briefs-more.ts` carries at least two entries for this id.
      readings: [
        ...readingsFor("leaderboard"),
        {
          title: "Cache stampede",
          url: "https://en.wikipedia.org/wiki/Cache_stampede",
          source: "Wikipedia",
          why: "Names the failure this brief turns on and the mitigations: locking, external recomputation, probabilistic early expiration.",
          minutes: 6,
        },
        {
          title: "Build a real-time gaming leaderboard with Amazon ElastiCache for Redis",
          url: "https://aws.amazon.com/blogs/database/building-a-real-time-gaming-leaderboard-with-amazon-elasticache-for-redis/",
          source: "AWS database blog",
          why: "Walks an end-to-end leaderboard build and compares sorted sets against a relational ranking query.",
          minutes: 12,
        },
      ],
      objectives: [...healthy(840, 70), budget(130)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: leaderboardReference,
      workload: workload({
        requestRate: 900,
        readRatio: 0.95,
        duration: 30,
        seed: 22,
        keySpace: 2000,
        keySkew: 0.95,
        failures: [{ kind: "cache-flush", at: 0.5 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["cache", "database", "server", "load-balancer"],
      dataModelPrompt:
        "Model the data: Player, Score (one per player per board), Board (global, daily, seasonal, regional) and the materialised TopN slice you actually serve. Give the primary key for each, the ranked structure and its key, the query patterns (fetch the top slice, submit a score, fetch one player's rank and neighbourhood), and how each grows with players and with the number of boards.",
      remixable: true,
      clarifications: [
        clarification(
          "How often is the board read compared with how often scores change, and what peak rate should I design for?",
          "About nineteen reads for every score submission, at roughly nine hundred requests per second at peak. The board is on the home screen, so it is read every time the app opens.",
        ),
        clarification(
          "How concentrated are the reads across the board?",
          "Extremely. Almost every request is for the same global top slice; per-player rank lookups and regional boards are a small minority of traffic.",
        ),
        clarification(
          "How stale may the displayed table be?",
          "A second or two behind is fine - players cannot tell. What they do notice is the board not updating at all after a tournament round finishes.",
        ),
        clarification(
          "What has gone wrong before on tournament night?",
          "The cache was restarted during a deploy at peak and every request for the top slice missed at once. Storage was overwhelmed within a second and the home screen failed for everyone.",
        ),
        clarification(
          "What latency target does the home screen have?",
          "The board call should come back inside about a tenth of a second at p95. It blocks the first screen, so anything slower shows up in retention numbers.",
        ),
        clarification(
          "What is the infrastructure budget for this?",
          "It is one screen in a free-to-play game, so keep it under about a hundred and thirty credits.",
        ),
        clarification(
          "Should the leaderboard have an animated transition when ranks change?",
          "The designers would like one. It is a client concern and does not affect this design.",
          false,
        ),
        clarification(
          "Which cloud provider are we standardising on?",
          "Whichever the platform team has already chosen. The shape of the answer is the same either way.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your leaderboard. State the read/write ratio, the concentration of reads, the staleness the product accepts and the incident you were told about, show the arithmetic that turns front-door traffic into storage reads, justify the technology behind each component, present your data model including the ranked structure, and name two alternatives you rejected.",
        followUps: [
          "Your cache restarts cold at the exact moment a tournament ends. Walk through the first second, request by request, and say which mechanism keeps storage alive.",
          "The product now wants every player to see their own exact rank out of ten million players, on the same screen. What does that do to your design, and what would you offer instead if it is too expensive?",
          "Marketing adds daily, weekly and seasonal boards per region. Which of your components multiplies, which does not, and what is the new hot-key picture?",
        ],
        rubric: rubric([
          ["framing", "States the read/write ratio, the concentration on one key, the staleness tolerance and the cold-cache incident before describing components", 20],
          ["arith", "Computes storage reads as writes plus misses and shows how a short expiry on one hot key bounds the miss rate, rather than quoting a hit-rate percentage", 20],
          ["stampede", "Names request coalescing (or an equivalent single-flight mechanism) for simultaneous misses on one key and sizes storage for the surviving fetch", 20],
          ["tech", "Justifies each technology - a sorted set for ranking, an in-memory cache for the hot slice, a durable store for scores - against a requirement and names the alternative it beat", 20],
          ["datamodel", "Gives Player, Score, Board and TopN entities with keys, the ranked structure and its key, the three query patterns, and growth", 20],
        ]),
        modelAnswer:
          "Clarification established nine hundred requests per second at peak, nineteen reads per submission, reads concentrated almost entirely on one global top slice, a tolerance of a second or two of staleness, a hundred-millisecond target on the home screen, and a previous outage caused by a cold cache at peak. That makes the arithmetic easy: forty-five writes a second reach storage no matter what, and the reads only reach storage when the hot slice is absent. I hold the top slice in an in-memory cache with a short expiry, so a key that serves hundreds of reads a second costs storage one read per expiry window, and the whole read stream is served from memory. The defence against the incident I was told about is request coalescing: when the slice is missing, the first request fetches and every simultaneous request for that key waits on that single in-flight fetch instead of launching its own, so a cold cache costs storage one read per key rather than thousands. Behind the cache, scores live in a sorted set keyed by board, giving rank and range queries in logarithmic time and in-place updates when a match ends, with a leader taking the writes and followers absorbing the misses. I rejected recomputing the ranking on every read, which turns one storage read per second into thousands, and I rejected a bare cache with no coalescing, which is exactly the design that failed on tournament night.",
      }),
      reflection: {
        question: "The cache is restarted at peak and every request for the top slice misses in the same instant. Why does adding storage capacity fail to fix this, while coalescing does?",
        options: [
          "Because the misses are all for the same key, so one fetch can answer every waiting request; capacity sized for thousands of identical reads is money spent to do the same work repeatedly",
          "Because a cold cache always rejects requests until it is warm, so storage capacity is never reached",
          "Because storage capacity only helps writes, and this burst is made of reads",
          "Because the stampede is caused by the expiry timer rather than by the miss, so only a longer expiry can help",
        ],
        answer: 0,
        explanation:
          "A stampede on a hot key is thousands of copies of one question. Coalescing collapses them into a single in-flight fetch whose answer is shared, which is why it converts an unbounded burst into one read. Buying enough storage to serve the duplicate reads would work and would also be absurd, since you would be paying peak capacity to compute the same value thousands of times. Cold caches do not reject, and the expiry is only the trigger - a restart or an eviction does the same thing.",
      },
    }),

    brief({
      id: "rate-limiter-service",
      chapter: chapterTitles[11],
      title: "Design a rate-limiting service",
      subtitle: "Every other team's request path runs through you, on two continents.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Limiting as a product",
      brief:
        "The platform team wants to stop every service writing its own throttling code and asks you for a shared limiter other teams call before they serve a request. The prompt is: 'tell any caller in a millisecond whether this key is over its limit, never be the reason a request is slow, and do not let one abusive tenant hurt the others.' You are not told the decision rate, how many distinct keys there are, where the callers run, how accurate the counting has to be, or what should happen when the limiter itself is overloaded. The canvas is empty: no starter design, no prescribed shape, and anything that runs and clears the targets passes.",
      learning: [
        "This brief inverts the usual exercise: the rate limiter is not a component protecting your system, it is the system. That changes every requirement. A limiter sits in front of someone else's request path, so its latency is added to every request in the company, its availability ceiling is the availability of everything behind it, and its failure mode has to be decided in advance - fail open and admit everything during your outage, or fail closed and take the whole platform down with you. Say which one you chose and why before anything else.",
        "The counting mechanism is the first technical decision. A fixed window counter is one integer per key per window and is trivially cheap, but it admits twice the limit across a window boundary. A sliding window log is exact and stores a timestamp per request, which is unaffordable at platform scale. A sliding window counter interpolates between two fixed windows and is the usual production compromise. The token bucket is the one to name for burst-tolerant traffic: a key holds tokens that refill at the limit rate, so a caller can spend a short burst and then be shaped to the steady rate, which is what API products actually want.",
        "Where the counter lives decides the whole architecture. Counting per instance is fast and wrong - with a dozen limiter replicas, a key's real allowance is a dozen times its configured limit. Counting in a shared in-memory store is the standard answer: the counter is a single hot key, updated with an atomic increment or a small script so read-modify-write cannot race, with a short expiry so idle keys cost nothing. State that this is deliberately a memory-first design with a durable store only for the policies themselves, because a lost counter costs you one window of over-admission, whereas a lost policy costs you correctness.",
        "Geography is where naive distributed limiters break. If callers run on two continents and the counter lives in one of them, every decision pays a cross-region round trip - which is larger than the entire latency budget you were given. The production answer is per-region counters with each region enforcing a share of the global limit, accepting that the true global limit is approximate, and reconciling asynchronously. Say the number out loud: the accuracy you give up is bounded by the split, and the latency you buy back is the round trip you no longer pay.",
        "Then decide what happens when the limiter itself is over capacity, which is the question the prompt hides. You are a service with finite capacity like any other, so you need admission control of your own: shed the excess quickly rather than queueing it, because a slow decision is worse than no decision - the caller is blocked either way and you have added latency to a request that was going to be served. Per-tenant isolation belongs in the same breath: one abusive key must not consume the decision capacity that everyone else's keys need, which is what separate budgets or a fair queue gives you.",
        "What this model idealizes: the simulation gives you decision volume, regional placement, a counter store and deliberate shedding, but not the atomicity of the increment itself, the client-side library with its local pre-check and cached deny, or the policy distribution path that pushes new limits to every region. It also treats every decision as equal, whereas a real limiter classifies traffic and gives different tenants different budgets. Name those, and be clear that the numbers you measured are the decision tier's behaviour, not the counter store's internals.",
      ],
      hints: [
        "Nothing is on the canvas, so start from what a single decision must cost: build the shortest path that can answer one and measure how much of the budget each hop consumes.",
        "Work out where the counter for a key has to live so that every replica agrees, then ask what that placement costs a caller on the other continent.",
        "Keep the counting close to the callers, keep the durable store for policies rather than counters, and put something at your own front door that sheds instead of queueing when you are over capacity; any shape that clears the targets counts.",
      ],
      objectives: [
        objective("p95", "lte", 75),
        objective("throughput", "gte", 850),
        objective("errorRate", "lte", 0.01),
        rejected(0.06),
        budget(110),
      ],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: limiterReference,
      workload: workload({
        requestRate: 1000,
        readRatio: 0.8,
        duration: 30,
        seed: 23,
        keySpace: 3000,
        keySkew: 0.8,
        regions: [
          { name: "us-east", share: 0.55 },
          { name: "eu-west", share: 0.45 },
        ],
        crossRegionLatencyMs: 80,
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["cache", "server", "database", "rate-limiter", "load-balancer"],
      dataModelPrompt:
        "Model the data: Policy (a limit attached to a tenant, route or API key), Counter (the per-key state your algorithm needs - bucket level and last refill, or per-window counts), Tenant and the Decision audit record. Give the primary key and the storage tier for each, say which of them is durable and which may be lost, the query patterns (evaluate a key, load a policy, change a policy, report usage), and how key count grows with tenants and routes.",
      remixable: true,
      clarifications: [
        clarification(
          "How many decisions per second must this answer at peak, and what is the mix of checks to policy changes?",
          "Around a thousand decisions per second at peak, and the overwhelming majority are checks - roughly four checks for every state-changing operation such as a counter commit or a policy edit.",
        ),
        clarification(
          "Where do the calling services run?",
          "A little over half in our US region and the rest in Europe, and the European share is growing. Callers must not pay a transatlantic hop for a decision.",
        ),
        clarification(
          "How much latency may a decision add to the caller's request?",
          "It has to be negligible next to their own work - tens of milliseconds at p95, never more than a small fraction of their budget. We would rather you shed a decision than answer it slowly.",
        ),
        clarification(
          "How accurate does the counting have to be?",
          "Approximate is fine. Admitting slightly more than the configured limit for a moment is acceptable; blocking a legitimate caller because a counter was double-counted is not.",
        ),
        clarification(
          "What should happen when the limiter itself is over capacity?",
          "Shed the excess immediately and tell the caller. A decision that arrives late is worse than no decision, because the caller is blocked either way - and one noisy tenant must not eat everyone else's decision capacity.",
        ),
        clarification(
          "What is the budget for this service?",
          "It is shared infrastructure funded centrally, so keep it under about a hundred and ten credits and it will not be questioned.",
        ),
        clarification(
          "Should the client library be published for every language we use?",
          "Eventually, yes. That is a distribution question and does not change the service design.",
          false,
        ),
        clarification(
          "How many people are on the platform team?",
          "Eight. Useful for knowing what we can operate, not for sizing the decision path.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your rate-limiting service. State the decision rate, the region split, the latency budget, the accuracy tolerance and the overload policy your clarifying questions established, name the counting algorithm and where the counter lives, justify each technology, present your data model, and say what happens when your own service is down or over capacity.",
        followUps: [
          "Your counter store in one region becomes unavailable for thirty seconds. Do you fail open or fail closed, what does each choice do to the platform, and how would the caller find out?",
          "A single tenant sends a third of all decision traffic for one key. Which component feels it first, what protects the other tenants, and what would you add if it were not enough?",
          "Product wants the global limit to be exact across both regions. Explain what that costs in latency and availability, and what you would offer instead.",
        ],
        rubric: rubric([
          ["framing", "States the decision rate, region split, latency budget, accuracy tolerance and overload policy from clarification before placing components", 20],
          ["algorithm", "Names a concrete counting algorithm (token bucket or sliding window counter) and says what it over- or under-admits compared with the alternatives", 20],
          ["placement", "Puts the counter where every replica in a region agrees, keeps it out of the caller's cross-region path, and quantifies the accuracy given up", 20],
          ["tech", "Justifies each technology - an in-memory store with atomic increments for counters, a durable store for policies, an admission tier at its own front door - against a requirement", 20],
          ["datamodel", "Gives Policy, Counter, Tenant and Decision entities with keys and storage tiers, says which may be lost, and lists the query patterns and growth", 20],
        ]),
        modelAnswer:
          "Clarification gave me a thousand decisions per second at peak, four checks per state change, callers split roughly fifty-five to forty-five between the US and Europe, a latency budget of tens of milliseconds, explicit permission to be approximate, and an instruction to shed rather than answer slowly. So this is a memory-first service, deployed once per region, with nothing in a caller's path that crosses an ocean. Each region runs its own decision tier behind a balancer, backed by an in-memory counter store holding a token bucket per key - bucket level and last refill timestamp, updated with a single atomic operation so read-modify-write cannot race, with an expiry so idle keys cost nothing. Each region enforces its share of the global limit, which is why I asked whether approximate counting was acceptable: the accuracy I give up is bounded by that split, and what I buy is a decision that never pays a transatlantic hop. The durable store holds policies, not counters: a lost counter costs one window of over-admission, a lost policy costs correctness. At my own front door I put admission control that sheds excess in a millisecond rather than queueing it, because the caller is blocked either way and a slow decision is strictly worse than a fast rejection, and it keeps one noisy tenant from eating everyone else's decision capacity. I rejected per-instance counting, which multiplies every configured limit by the replica count, and I rejected a single global counter, which would put a cross-region round trip inside every decision.",
      }),
      reflection: {
        question: "Callers run on two continents and the product asks for one exact global limit. Why is per-region counting with a split limit usually the right answer?",
        options: [
          "Because an exact global counter puts a cross-region round trip inside every decision, which is larger than the entire latency budget, and the accuracy that buys is worth less than the latency it costs",
          "Because per-region counters are exact as long as each region's traffic is stable",
          "Because a global counter cannot be made durable, while regional counters can",
          "Because splitting the limit doubles the effective capacity of the service",
        ],
        answer: 0,
        explanation:
          "The trade is explicit: exactness requires every decision to consult one authority, and if that authority is on another continent the round trip alone exceeds the budget the callers were promised. Splitting the limit per region makes the global total approximate at the boundaries, which the product said it could tolerate, in exchange for a decision that stays local. Regional counters are not exact, durability is not the issue, and splitting a limit divides an allowance rather than adding capacity.",
      },
    }),

    brief({
      id: "ad-click-aggregation",
      chapter: chapterTitles[11],
      title: "Design ad click aggregation",
      subtitle: "A firehose of clicks, counted once, through a store that goes slow.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Stream ingest & idempotency",
      brief:
        "An advertising platform needs to count clicks. The prompt is: 'every click has to be counted, advertisers are billed from these numbers so we cannot count one twice, and the dashboard should be roughly live.' You are not told the click rate, how many campaigns the traffic spreads across, how fresh the dashboard must be, or what should happen when the counter store slows down - which the team mentions happened last quarter. The canvas is empty: there is no starter pipeline and no required shape, and any architecture that runs and clears the targets passes.",
      learning: [
        "Click aggregation is a stream problem wearing a web-service costume. Events arrive constantly and in enormous volume, reads are a small trickle from advertiser dashboards, and the ratio can reach twenty writes per read. That inverts every product reflex: there is no hot read set for a cache to absorb, so the cache you would place by habit does nothing, and the design is entirely about accepting writes, spreading them, and controlling what happens when the store behind them slows down.",
        "Split ingest from aggregation with a log in the middle. The click endpoint's only job is to accept the event, write it durably to a stream and return - it must be fast, because it sits in the redirect path of a real ad click. Everything downstream - deduplication, attribution, per-campaign counters, hourly rollups - is consumer work that reads the stream at its own pace. The log is what decouples the two rates, absorbs a burst, and lets you replay when a consumer has a bug, which is the property that makes this architecture standard rather than merely convenient.",
        "Delivery semantics are the crux, because money depends on them. At-most-once loses clicks when a consumer dies, which is revenue you cannot bill. At-least-once loses nothing and duplicates some, which is revenue you bill twice - and a duplicate charge is the failure mode that produces refunds and lawsuits rather than a dashboard discrepancy. So the answer is at-least-once delivery plus consumers that recognise work they have already done: derive a stable event identifier at the edge, record it in the same transaction as the counter update behind a unique constraint, and a redelivery of a key you have already committed returns success without touching the counter. Exactly-once delivery over a network does not exist; exactly-once effect does.",
        "The visibility timeout is where duplicates are manufactured, and it interacts with the failure this system has to survive. If the counter store runs several times slower, consumers that were finishing inside their lease now exceed it, the message becomes visible again, and a second consumer starts the same work - so a storage brownout produces a duplicate storm precisely when you are least able to reconcile it. Set the lease above the p99 of consumer processing including the slow case, and make the consumer idempotent so the duplicates that still happen are free.",
        "Then spread the writes. Per-campaign counters partition naturally by campaign identifier, so hashing on it distributes writes evenly and keeps a campaign's counters together for the range query a dashboard issues. Sharding by time instead puts every write in the platform onto the shard owning the current window, which manufactures a hot partition by construction. Derive the shard count from the write rate divided by a per-shard capacity you are willing to defend, then add headroom for the brownout multiplier: if the store can run half speed for a minute, the per-shard arrival rate has to stay below half of per-shard capacity or the backlog outlives the event.",
        "Pre-aggregation is the lever that changes the arithmetic rather than the architecture. Consumers that fold a second of clicks into one counter update per campaign turn a stream of individual increments into a much smaller stream of batched ones, which is how real pipelines survive volumes that no single counter could take. Tumbling windows with a watermark also give you a defensible answer for late events: accept them inside a bounded lateness window and correct the aggregate, drop or divert them beyond it. Say what the window is, because 'we accept everything forever' means every historical aggregate stays open for rewriting.",
        "What this model idealizes: the simulation gives you write volume, queue semantics, idempotency and the brownout, but not click fraud detection - which is a large share of a real system's work and the reason the raw log must be retained - nor the attribution join between clicks and impressions, the exactly-once sink protocols that real stream processors implement, or the columnar store the dashboards actually query. Name those, and be clear that what you sized here is the ingest and counting pipeline.",
      ],
      hints: [
        "The canvas is empty, so build an ingest path you can measure, then watch what happens after the store slows down rather than only during it: the damage outlasts the event.",
        "Decide what the click endpoint waits for and what it hands to something else, then work out the per-partition arrival rate against what a partition can still do while the store is degraded.",
        "Choose the delivery guarantee that cannot lose money, remove the cost of the one it does have at the consumer, and spread the counters wide enough that a slowdown still leaves headroom; any architecture that clears the targets passes.",
      ],
      objectives: [...healthy(930, 200), duplicates(0.01), budget(285)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: clickReference,
      workload: workload({
        requestRate: 1000,
        readRatio: 0.05,
        duration: 30,
        seed: 24,
        keySpace: 50000,
        keySkew: 0.6,
        failures: [{ kind: "slow-database", at: 0.5, duration: 6, factor: 3 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      techFocus: ["queue", "database", "server", "load-balancer"],
      dataModelPrompt:
        "Model the data: ClickEvent (the raw record, with the identifier you deduplicate on), Campaign, the per-campaign per-minute Aggregate the dashboard reads, and the DedupKey record itself. Give the primary key and partition key for each, say where the deduplication key is stored and for how long, list the query patterns (append an event, increment an aggregate, read a campaign's last day, replay a window), and say how each grows with clicks per second and retention.",
      remixable: true,
      clarifications: [
        clarification(
          "What click rate should I design for, and what is the read-to-write mix?",
          "About a thousand events per second at peak, and it is overwhelmingly writes - roughly twenty clicks recorded for every dashboard read. Reads come from advertisers, not consumers.",
        ),
        clarification(
          "How is traffic spread across campaigns?",
          "Across tens of thousands of active campaigns, moderately skewed: the biggest advertisers take a larger share but no single campaign dominates the platform.",
        ),
        clarification(
          "Is it worse to lose a click or to count one twice?",
          "Counting twice is far worse. Advertisers are billed from these numbers, so a double count is a refund and a credibility problem; a lost click is a rounding error we would rather avoid but can survive.",
        ),
        clarification(
          "How fresh does the advertiser dashboard have to be?",
          "Roughly live is enough - a minute behind is fine. Billing runs from the same aggregates at the end of the day, and that must be correct rather than fast.",
        ),
        clarification(
          "What happened last quarter when the store slowed down?",
          "The counter store ran at about half speed for a minute during a compaction. The pipeline backed up and stayed broken long after the store recovered, and we found duplicate counts afterwards.",
        ),
        clarification(
          "What is the budget for the ingest and counting tier?",
          "It is revenue infrastructure, so it can be funded properly - keep it under about two hundred and eighty-five credits.",
        ),
        clarification(
          "Which charting library will the advertiser dashboard use?",
          "Not decided. It reads an API and does not constrain this design.",
          false,
        ),
        clarification(
          "How many engineers will own the pipeline?",
          "Seven. Relevant to what we can operate, not to how the pipeline is sized.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your click pipeline. State the click rate, the read/write mix, the campaign spread, the loss-versus-duplication preference and the brownout you were told about, show how you derived the partition count and the headroom that survives a slowdown, name your delivery guarantee and the mechanism that makes its cost free, justify each technology, and present your data model.",
        followUps: [
          "The counter store runs at a third of its speed for five minutes instead of half speed for one. Which of your numbers breaks first, and what does your design do rather than collapse?",
          "A consumer crashes after incrementing the counter but before acknowledging the event. Walk through exactly what happens next and why the advertiser is not billed twice.",
          "Clicks from a network-partitioned edge arrive ten minutes late, after the minute they belong to has been billed. What does your pipeline do, and what have you promised advertisers about late data?",
        ],
        rubric: rubric([
          ["framing", "States the write-dominated ratio, the campaign spread, the explicit preference for losing over duplicating, and the brownout, before placing components", 20],
          ["semantics", "Chooses at-least-once delivery for the stated preference and names a concrete idempotency key enforced in the same transaction as the counter update, not a read-then-write check", 20],
          ["arith", "Derives the partition count and per-partition headroom from the write rate and the brownout multiplier rather than picking a number", 20],
          ["tech", "Justifies each technology - a durable partitioned log for the stream, a horizontally partitioned counter store, an aggregation consumer - against a requirement and names the alternative it beat", 20],
          ["datamodel", "Gives ClickEvent, Campaign, Aggregate and DedupKey with primary and partition keys, says where dedup keys live and for how long, and lists query patterns and growth", 20],
        ]),
        modelAnswer:
          "Clarification gave me a thousand events per second at peak, twenty writes per read, tens of thousands of campaigns with moderate skew, an explicit statement that double counting is far worse than losing a click, a minute of dashboard staleness tolerated, and a storage brownout at half speed for a minute that left both a backlog and duplicate counts. There is no repeated read set, so no cache: the money goes into the write path. Intake is a balanced trio of replicas whose only job is to stamp the event with a stable identifier, append it to a durable partitioned log and return, so the click redirect stays fast. Aggregation consumers read that log and increment per-campaign counters. Because a double count is the unacceptable failure, the queue is at-least-once - nothing is lost when a consumer dies - and the consumer is idempotent: it records the event identifier in the same transaction as the counter increment behind a unique constraint, so a redelivery of a key already committed returns success and does no work. I set the lease above the p99 of consumer processing including the degraded case, because a brownout that pushes processing past the lease is exactly what manufactures duplicates. Counters are hash-partitioned on campaign identifier so writes spread evenly and a campaign's series stays contiguous for the dashboard's range query, with the partition count chosen so per-partition arrival sits near half of per-partition capacity - which is what survives the half-speed brownout without building a backlog that outlives it. I rejected at-most-once, which loses billable clicks, and rejected time-based partitioning, which puts every write onto one partition by construction.",
      }),
      reflection: {
        question: "The counter store runs at half speed for a minute. Why does that produce duplicate counts as well as a backlog, and what makes the duplicates harmless?",
        options: [
          "Processing that used to finish inside the delivery lease now exceeds it, so messages become visible again and a second consumer repeats the work; an idempotency key committed with the counter update makes the repeat a no-op",
          "The store rejects writes while degraded, so consumers retry and each retry increments the counter again; only a longer lease can prevent it",
          "Duplicates come from the load balancer sending the same click to two intake replicas, which idempotent consumers cannot see",
          "Half-speed storage corrupts counters, so the pipeline must recount from the raw log after every brownout",
        ],
        answer: 0,
        explanation:
          "A visibility lease is a bet on how long processing takes, and a brownout invalidates the bet: work still in progress looks dead, the message is redelivered, and two consumers do the same increment. The fix is not a heroic lease value alone - it is a consumer that derives a stable key from the event and records it in the same transaction as the increment, so the second attempt is refused by a unique constraint rather than doubling the advertiser's bill.",
      },
    }),
  ],
};
