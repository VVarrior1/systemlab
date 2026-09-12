import {
  allKinds,
  brief,
  chain,
  chapterTitles,
  clarification,
  defense,
  estimate,
  graph,
  healthy,
  budget,
  node,
  objective,
  rejected,
  rubric,
  workload,
  type ChapterFile,
} from "../shared";

/**
 * Chapter 12 - Design briefs. Expert, clarify-first missions: the prompt is deliberately
 * under-specified, and the workload only makes sense once the relevant questions are asked.
 * Since v2.1 every brief is a blank canvas (`blankCanvas: true`): the learner starts from a
 * traffic-only graph, the reference below is never shown, and grading is objectives plus
 * runnability only - any architecture that runs and clears the targets passes.
 * Each reference was measured on seeds [lesson seed, 123, 2026]; the objectives sit
 * roughly 25-40% above the worst measured value so a remix still has room.
 */

/** Every blank-canvas brief starts here: traffic and nothing else. */
const blankCanvasStarter = chain([node("traffic", "traffic", 0)]);

// ------------------------------------------------------------------ url-shortener
const shortenerReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Redirect API", capacity: 400, replicas: 3 }),
    node("cache", "cache", 3, { label: "Link cache", cacheModel: "keyed", cacheEntries: 6000 }),
    node("database", "db", 4, { label: "Link store", capacity: 200, dbMode: "leader-follower", replicas: 3 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ------------------------------------------------------------------ news-feed
const feedReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1),
    node("server", "api", 2, { label: "Feed API", capacity: 400, replicas: 3 }),
    node("cache", "cache", 3, { label: "Timeline cache", cacheModel: "keyed", cacheEntries: 12000 }),
    node("database", "db", 4, { label: "Timeline store", capacity: 200, dbMode: "sharded", shards: 4 }),
  ],
  [["traffic", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ------------------------------------------------------------------ ticket-sale
const ticketReference = graph(
  [
    node("traffic", "traffic", 0),
    node("rate-limiter", "limiter", 1, { label: "Entry limiter", limit: 600, burst: 400 }),
    node("load-balancer", "balancer", 2),
    node("server", "api", 3, { label: "Checkout API", capacity: 500, replicas: 3, maxQueue: 120 }),
    node("cache", "cache", 4, { label: "Inventory cache", cacheModel: "keyed", cacheEntries: 500, coalesce: true, ttlMs: 500 }),
    node("database", "db", 5, { label: "Inventory DB", capacity: 300 }),
  ],
  [["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "api"], ["api", "cache"], ["cache", "db"]],
);

// ------------------------------------------------------------------ chat-and-notifications
const chatReference = graph(
  [
    node("traffic", "traffic", 0),
    node("load-balancer", "balancer", 1, { region: "us-east" }),
    node("server", "intake", 2, { label: "Message intake", capacity: 400, replicas: 2, region: "us-east" }),
    node("queue", "queue", 3, { label: "Delivery queue", maxQueue: 1500, region: "us-east" }),
    node("server", "worker", 4, { label: "Delivery worker", role: "worker", capacity: 300, replicas: 3, region: "us-east" }),
    node("database", "db", 5, { label: "Message store", capacity: 250, dbMode: "sharded", shards: 3, region: "us-east" }),
  ],
  [["traffic", "balancer"], ["balancer", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "db"]],
);

// ------------------------------------------------------------------ metrics-ingestion
const metricsReference = graph(
  [
    node("traffic", "traffic", 0),
    node("rate-limiter", "limiter", 1, { label: "Ingest limiter", limit: 1100, burst: 500 }),
    node("load-balancer", "balancer", 2),
    node("server", "ingest", 3, { label: "Ingest API", capacity: 500, replicas: 3 }),
    node("database", "db", 4, { label: "Series store", capacity: 300, dbMode: "sharded", shards: 10 }),
  ],
  [["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "ingest"], ["ingest", "db"]],
);

export const chapter: ChapterFile = {
  title: chapterTitles[11],
  lessons: [
    brief({
      id: "url-shortener",
      chapter: chapterTitles[11],
      title: "Design a URL shortener",
      subtitle: "Extreme read skew, a tiny write path, and a hard cost ceiling.",
      difficulty: "Expert",
      minutes: 25,
      concept: "Read-heavy design",
      brief:
        "A growth team wants short links for its campaigns. The whole prompt you are given is: 'people paste a long URL, we hand back a short one, and clicking it should be instant even when a campaign goes viral - and please keep it cheap.' Nobody has told you how much traffic there is, how it is spread across links, what 'instant' means, or whether an edited link may take a moment to propagate. Ask before you build. The canvas is empty - there is no starter design and no required shape, so any architecture that runs and clears the targets is a pass, and you will be asked to defend the one you chose.",
      learning: [
        "A shortener is the purest read-heavy system in the catalogue: creating a link is a single small write, and every click afterwards is a key lookup that must return a redirect. Once you know the ratio is around a hundred to one, the shape of the answer is fixed before you draw anything - the write path can live on one modest primary for years, and essentially all of the engineering goes into keeping repeated reads away from storage. The interview signal is whether you establish that ratio first and let it dictate the components, rather than reaching for a cache because caches are familiar.",
        "Skew is the second thing to establish, because it decides whether a cache is worth anything. If clicks were spread uniformly over every link ever created, a cache holding a fraction of the key space would mostly miss and you would be paying for nothing. Real campaign traffic is extremely concentrated: a few thousand live links carry almost all clicks, so a keyed cache sized to comfortably hold that working set converts nearly every read into a hit. State the working set, size the cache to exceed it, and you can predict the hit rate instead of guessing at a dial.",
        "Now do the arithmetic that sizes storage. Database load after a cache is writes plus read misses, and nothing else. At a few hundred redirects per second with a working set that fits in cache, the misses are the cold tail and the freshly created links; the primary sees a small fraction of front-door traffic. That number, not the front-door rate, is what you provision the database for - and because database capacity is the most expensive thing on the price list, getting it right is what keeps the design inside the budget the team asked for.",
        "Spread the read path rather than growing one machine. A load balancer over several application replicas is cheap, linear and survives losing a replica, whereas a single larger server is a single failure domain and eventually hits a ceiling. On the storage side, a leader with followers lets reads fan out while writes stay on one leader - which is fine here precisely because writes are rare. Say out loud what that costs you: a follower read can be stale for the replication lag, which this product's requirements happen to tolerate.",
        "The parts the simulator cannot show still belong in your answer. Key generation is the classic follow-up: a base62 encoding of an atomic counter is simple and dense but needs one coordinator, while a Snowflake-style identifier gives every node an independent, roughly time-sortable id at the cost of longer codes. Custom aliases need a uniqueness check on the write path and an abuse policy. And analytics - counting every click - quietly turns a read into a write, which is the single most common way a shortener's cost model gets destroyed.",
        "What this model idealizes: redirects here terminate at your own cache, whereas a real shortener would let the browser and a CDN cache the redirect response itself, moving a large share of traffic off your infrastructure entirely. The simulation also ignores the size of the link table, the cost of storing click events, and the moderation and abuse workload that any public shortener acquires within days of launching. Treat the measured numbers as the shape of the answer, and name those three omissions when you defend it.",
      ],
      hints: [
        "The canvas is empty, so start from the request itself: draw the smallest path that can answer a redirect, run it, and read the utilization column to see what pins first.",
        "Work out how much traffic actually has to reach storage once repeated redirects are served from memory - the writes plus the reads that miss.",
        "Spread the front door across replicas behind a balancer and keep the storage tier sized for the miss traffic rather than the front-door rate; any shape that clears the targets counts.",
      ],
      objectives: [...healthy(760, 90), budget(65)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: shortenerReference,
      workload: workload({ requestRate: 800, readRatio: 0.99, duration: 30, seed: 11, keySpace: 5000, keySkew: 0.85 }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      remixable: true,
      clarifications: [
        clarification(
          "What is the read-to-write ratio, and what peak request rate should I design for?",
          "About a hundred redirects for every link created. Design for eight hundred requests per second at peak, and assume that ratio holds at peak.",
        ),
        clarification(
          "How concentrated is click traffic across links?",
          "Extremely. A few thousand live campaign links take almost every click; the historical tail is nearly idle but must still resolve.",
        ),
        clarification(
          "What latency target should a redirect meet, and at which percentile?",
          "Under a tenth of a second at p95, measured at the edge of our infrastructure. A redirect sits in front of every campaign landing page.",
        ),
        clarification(
          "Is it acceptable for an edited or newly created link to take a moment to propagate?",
          "Yes. A few seconds of staleness after an edit is fine. Deletions are rare and may be handled by a manual purge.",
        ),
        clarification(
          "What is the infrastructure budget?",
          "This must stay a small line item - under about sixty-five credits. If it costs more than the campaign tooling itself, the project is dead.",
        ),
        clarification(
          "Which language and web framework should the service be written in?",
          "Whatever the team already uses. It has no bearing on the architecture you are being asked for.",
          false,
        ),
        clarification(
          "How many engineers will maintain this?",
          "Two, part-time. Interesting for operational simplicity, but it does not change the capacity math.",
          false,
        ),
        clarification(
          "Does the dashboard need to match our brand colours?",
          "Yes, eventually. That is a front-end ticket and out of scope for this design.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your shortener. State the requirements you established through your clarifying questions, show the arithmetic that took you from the front-door request rate to the traffic that actually reaches storage, justify each component against a specific requirement, and name two alternatives you rejected with the reason each one loses here.",
        followUps: [
          "The growth team adds click analytics: every redirect now records an event. What does that do to your write path, and how do you keep it from destroying the cost model you just defended?",
          "A single campaign link goes viral and takes 60% of all traffic. Which component feels it first, what does your design do, and what would you add if it were not enough?",
          "Marketing wants custom aliases that users choose themselves. Walk through what that adds to the write path and which of your consistency assumptions it breaks.",
        ],
        rubric: rubric([
          ["framing", "States the requirements extracted from clarification - read/write ratio, skew, latency percentile, staleness tolerance, budget - before describing components", 25],
          ["arith", "Computes the traffic reaching storage as writes plus read misses and sizes the database from that number, not the front-door rate", 25],
          ["tradeoff", "Names a rejected alternative (a bigger single database, or a probabilistic hit-rate dial) and why it loses on cost or predictability", 25],
          ["risk", "Identifies a remaining failure mode - cold cache, hot key, replication lag, analytics writes - and how it would be detected", 25],
        ]),
        modelAnswer:
          "The clarifications set the design: eight hundred requests per second at peak, ninety-nine percent redirects, a working set of a few thousand hot links, a p95 under a tenth of a second, a few seconds of staleness tolerated, and a hard budget. That ratio means writes are eight per second - one modest primary forever - so the whole problem is keeping repeated reads off storage. I put a keyed cache in front of the link store sized well above the hot working set, so the database sees writes plus the cold-tail misses, a small fraction of the front door. The front door is a balancer over three application replicas, which is linear, cheap and survives losing one. Storage is a leader with followers: writes go to the leader, misses fan out over followers, and the staleness that costs us is inside the tolerance we were given. I rejected a single larger database - database capacity is the most expensive item and it stays one failure domain - and a fixed hit-rate dial, because hit rate here is an outcome of working set versus cache size. Remaining risks: a cold cache after a restart, one viral link, and analytics turning reads into writes.",
      }),
      reflection: {
        question: "The clarifying answers say clicks are concentrated on a few thousand live links. Why does that single fact change the design more than the request rate does?",
        options: [
          "It makes the cache's hit rate predictable, which turns database load into an arithmetic result rather than a guess",
          "It means the request rate can be ignored, since hot keys are served from memory regardless of volume",
          "It forces sharding, because concentrated keys always create a hot shard",
          "It removes the need for replicas, since a single cache node can absorb any concentrated read load",
        ],
        answer: 0,
        explanation:
          "Skew plus a cache size gives you a hit rate you can predict, and hit rate is what converts front-door traffic into database load - the number that sizes the most expensive component. Volume still matters for the application tier. Sharding is not implied, because concentration is exactly what a cache absorbs, and the cache itself is still a single failure domain that replicas and headroom protect against.",
      },
    }),

    brief({
      id: "news-feed",
      chapter: chapterTitles[11],
      title: "Design a news feed",
      subtitle: "Fan-out on write or on read, and a timeline that has to load instantly.",
      difficulty: "Expert",
      minutes: 30,
      concept: "Fan-out strategy",
      brief:
        "A social product asks you to design its home feed: 'when someone opens the app they should see a fresh timeline of posts from the people they follow, immediately, and it has to work when a celebrity posts.' You are not told how many people post versus scroll, how fresh 'fresh' has to be, how wide the follow graph gets, or what the latency target is. Every one of those answers moves the design. You start from an empty canvas: nothing is placed for you, no shape is prescribed, and anything that runs and meets the targets passes - so the components you place are your argument.",
      learning: [
        "The central decision is where the join between 'who I follow' and 'what they posted' happens. Fan-out on write materialises a timeline per user at post time: a write costs one insert per follower, and a read is a single cheap range scan over a precomputed list. Fan-out on read stores posts once and merges the followed authors' posts at request time: writes are trivial and reads are expensive. With a read-dominated feed the first is almost always right, because you are paying once per post to make millions of reads cheap - but you have to know the ratio before you can say that.",
        "The hybrid is the answer interviewers are listening for. Fan-out on write breaks precisely when one author has millions of followers: a single post becomes millions of inserts and the write path stalls for everyone. So you fan out on write for ordinary accounts and leave a small set of very-high-follower accounts to be merged in at read time, giving each reader one cheap precomputed list plus a handful of celebrity lookups. Say the threshold is a tuned number, and that you would measure the distribution of follower counts before choosing it.",
        "Whatever the strategy, the read path in front of storage looks the same, and that is what this simulation builds. Recent timelines are read far more often than they change, so a keyed cache holding the hot slice of timelines absorbs most reads, and the storage tier only sees writes plus misses. Size the cache against the active-user working set rather than the total user count - the tail of dormant accounts costs you nothing to miss on, because nobody is asking for them.",
        "Timeline storage is naturally partitioned by user, which is what makes it scale. Hash-sharding on the timeline owner spreads both the fan-out writes and the reads evenly across shards, and each shard holds an independent slice of the working set. Range-sharding by identifier or by time would put all of today's activity on one shard, which is the standard way to manufacture a hot partition. Name the shard key out loud and say what it makes cheap and what it makes expensive: per-user reads become one shard, but any query across users becomes a fan-out.",
        "Freshness is a requirement, not an absolute. A feed that is a few seconds behind is indistinguishable from live to a scrolling user, and that tolerance is what lets you cache timelines, read from followers, and do fan-out asynchronously through a queue. If the product instead demands that you always see your own post at the top the instant you publish, that is read-your-writes on one specific path, and it is far cheaper to special-case the author's own view than to make the whole feed strongly consistent.",
        "Ranking is the part that will be dropped on you at minute thirty. Treat it as a scoring function applied over a larger candidate set than you display: fetch a few hundred candidates from the precomputed timeline plus the celebrity merge, score them, return the top slice. That framing keeps ranking out of the storage design and turns it into a latency budget line, which is exactly what you want when the interviewer asks how personalisation changes your architecture.",
        "What this model idealizes: the simulation exercises the read path, not the fan-out write amplification - a real fan-out on write turns one post into thousands of inserts, and that asymmetry is the whole reason the hybrid exists. It also ignores timeline storage growth, deletions and unfollows rewriting materialised lists, and media, which belongs in object storage behind a CDN and never touches this path. Name those three when you defend the design.",
      ],
      hints: [
        "Nothing is placed for you, so build the simplest path that can serve a timeline and measure it; which component saturates and which has room tells you what kind of problem this is.",
        "Decide where the join happens before you place components, then work out how much read traffic survives a cache holding the active working set.",
        "Partition the timeline store by its owner so reads and writes spread evenly, keep the front door replicated behind a balancer, and let the targets rather than a prescribed shape decide when you are done.",
      ],
      objectives: [...healthy(665, 95), budget(65)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: feedReference,
      workload: workload({ requestRate: 700, readRatio: 0.9, duration: 30, seed: 12, keySpace: 20000, keySkew: 0.75 }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      remixable: true,
      clarifications: [
        clarification(
          "What is the ratio of feed reads to posts, and what peak rate should I design for?",
          "About nine reads for every write, at roughly seven hundred requests per second at peak. Most people scroll far more than they post.",
        ),
        clarification(
          "How fresh does a timeline have to be?",
          "A few seconds behind is fine for other people's posts. Users do expect to see their own post immediately after publishing it.",
        ),
        clarification(
          "What does the follower distribution look like?",
          "A long tail: almost everyone has a few hundred followers, and a few hundred accounts have millions. Assume the extreme tail exists and must not stall posting.",
        ),
        clarification(
          "What is the latency target for opening the app?",
          "The first screen should render in about a tenth of a second at p95 for the feed call itself; anything slower and engagement drops measurably.",
        ),
        clarification(
          "How much timeline history has to be retrievable?",
          "The first few hundred entries per user is what the app actually pages through. Anything deeper can be regenerated on demand.",
        ),
        clarification(
          "Should the feed be ranked by relevance or reverse chronological?",
          "Ranked eventually, but treat ranking as a scoring function over the candidates you fetch. It does not change the storage design.",
        ),
        clarification(
          "Which mobile framework will the client use?",
          "Native on both platforms. Not relevant to the backend design.",
          false,
        ),
        clarification(
          "How large is the team that will own this service?",
          "Around eight engineers. It affects how much operational complexity we can carry, not the capacity math.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your feed design. State the requirements your clarifying questions established, say where you put the join between followers and posts and why, show the arithmetic from front-door read rate to storage load, and name the two alternatives you rejected and what each would cost you here.",
        followUps: [
          "An account with fifty million followers posts. Trace what happens in your design in the next ten seconds, and say what you would change if the write path stalled.",
          "Product now requires that a user always sees their own post at the top of their feed the instant it is published. Which consistency guarantee is that, and where do you apply it without making the whole feed expensive?",
          "The feed becomes ranked rather than chronological, and ranking needs three hundred candidates per request instead of fifty. Which number in your estimate moves, and by how much?",
        ],
        rubric: rubric([
          ["framing", "States the read/write ratio, freshness tolerance, follower distribution and latency target extracted from clarification before choosing a strategy", 25],
          ["strategy", "Chooses fan-out on write, on read, or a hybrid and justifies it explicitly from the measured ratio and the follower tail", 30],
          ["arith", "Derives storage load from the read rate, the cache working set and the resulting miss traffic, and sizes partitions from it", 20],
          ["tradeoff", "Names the rejected alternative and the failure mode the chosen design still has, with how it would be detected", 25],
        ]),
        modelAnswer:
          "The clarifications gave me nine reads per write at seven hundred requests per second, a few seconds of freshness tolerance, a long-tailed follower distribution, and a p95 target around a tenth of a second. Nine to one and a tolerant freshness budget point at fan-out on write: pay once per post to materialise each follower's timeline, so a read is one range scan over a precomputed list. I special-case the extreme tail - accounts with enormous follower counts are merged at read time instead, which keeps a celebrity post from turning into millions of synchronous inserts. In front of storage I put a keyed cache sized to the active-user working set, so the store sees writes plus cold misses rather than the full read rate, and I hash-shard the timeline store by owner so both reads and fan-out writes spread evenly. The front door is a balancer over three replicas. I rejected pure fan-out on read, which makes every timeline a scatter-gather at exactly the moment users are most impatient, and range sharding, which would pile today's activity onto one shard. The residual risks are a cold cache after deploy and unfollows rewriting materialised timelines.",
      }),
      reflection: {
        question: "Why does a pure fan-out-on-write design break specifically for accounts with millions of followers?",
        options: [
          "One post becomes millions of timeline inserts, so a single write stalls the write path for everyone",
          "Their followers read more often, so the cache hit rate collapses for those timelines",
          "Their posts are larger, so the timeline store runs out of space faster than planned",
          "Their followers are spread across shards, so each post requires a distributed transaction",
        ],
        answer: 0,
        explanation:
          "Fan-out on write trades write amplification for cheap reads, and the amplification factor is exactly the follower count. At a few hundred followers that is fine; at tens of millions it is one post turning into tens of millions of inserts, which saturates the write path and delays everyone else's posts. That is why the standard answer is a hybrid: ordinary accounts fan out on write, extreme accounts are merged at read time.",
      },
    }),

    brief({
      id: "ticket-sale",
      chapter: chapterTitles[11],
      title: "Design a ticket sale",
      subtitle: "A flash crowd, one hot item, and a rule that you must never oversell.",
      difficulty: "Expert",
      minutes: 30,
      concept: "Flash crowds & admission control",
      brief:
        "A venue sells tickets for a single show and the sale opens at a fixed minute. The brief you are handed is one sentence: 'everyone arrives at once, nobody should get an error page, and we must never sell the same seat twice.' Nothing in that tells you how many people arrive, how far above normal that is, how long the surge lasts, or whether turning some buyers away politely is acceptable. Those answers decide whether you build for the peak or shed it. The canvas is empty, so there is no design to adjust: build whatever you can defend, and any architecture that runs and clears the targets passes.",
      learning: [
        "A flash crowd is not a big steady load; it is a short, enormous multiple of one. Establish two numbers before anything else: the peak factor and the duration. A six-fold surge lasting a couple of seconds is a fundamentally different engineering problem from a six-fold surge lasting an hour, because the first can be absorbed by a queue or shed at the door while the second has to be provisioned for. Ask for both, and say which one you are designing against - candidates who only ask 'how much traffic' get a number that is useless without its shape.",
        "Once you know the surge is brief, the real question is admission control: do you build capacity for the peak, or admit what you can serve and turn the rest away quickly? Provisioning for a six-fold peak means paying for six times the machines every minute of every day for a spike that lasts seconds - which is exactly what a cost ceiling is there to prevent. The alternative is a token-bucket rate limiter at the front door sized near what the system can genuinely serve, with a burst allowance that absorbs the first instant of the stampede.",
        "This is where rejection stops being a failure and becomes a product decision. A request rejected in a millisecond by a limiter costs almost nothing, leaves no queue behind, and can be turned into a waiting-room page with a position and an estimate. A request accepted into a system that cannot serve it occupies capacity, times out after several seconds, and often gets retried - turning one impatient user into three. The named production pattern is a waiting room in front of checkout; the metric that proves it is working is that accepted requests keep their latency while rejected rate rises.",
        "Everyone wants the same handful of items, so key skew is extreme and a cache behaves very differently than it does under spread load. A keyed cache with a short TTL serves the availability reads that dominate the surge, and request coalescing matters more than cache size: without it, the instant an entry expires, thousands of concurrent misses for the same key all hit storage at once. With coalescing, one request fetches and the rest join it. That single flag is the difference between a warm cache and a stampede that takes the database down.",
        "Correctness lives on the write path and the simulator will not check it for you, so say it explicitly. Never overselling means the seat decrement must be atomic and conditional - a conditional update or a row lock in a transaction, so two buyers cannot both succeed on the last seat. Reservations should be short-lived holds with an expiry rather than permanent claims, so abandoned checkouts return inventory. And every purchase call needs an idempotency key, because a buyer who times out will hit the button again and must not end up with two tickets.",
        "Fairness is the follow-up that separates senior answers. A pure rate limiter is first-come-first-served at millisecond resolution, which in practice rewards whoever has the fastest network and the best bots. Real sales use a queue that admits people in arrival order, per-account limits on quantity, and bot mitigation at the edge. Say which of those you would build first and why - and note that a fair queue is itself a system with capacity limits that has to be designed, not a checkbox.",
        "What this model idealizes: the simulation gives you the traffic shape, the shedding behaviour and the latency of accepted requests, but not the correctness of the seat decrement, the waiting-room user experience, or payment providers who have their own rate limits and timeouts. It also treats every rejected request as one lost user, whereas real buyers refresh. Assume retries make your effective peak worse than the number you were given, and design the limiter with that in mind.",
      ],
      hints: [
        "The canvas is empty, so sketch a checkout path you can measure and watch the timeline rather than the summary: find the moment the surge arrives and see how long the damage lasts after it passes.",
        "Compare what the surge demands with what your budget lets you provision, then decide whether the answer is capacity or admission control.",
        "Put something at the front door that can turn traffic away instantly, and give the hot-key read path a way to collapse concurrent misses into one fetch; any design that clears the targets passes.",
      ],
      objectives: [
        objective("p95", "lte", 110),
        objective("throughput", "gte", 330),
        objective("errorRate", "lte", 0.01),
        rejected(0.26),
        budget(55),
      ],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: ticketReference,
      workload: workload({ requestRate: 350, readRatio: 0.8, duration: 30, seed: 13, pattern: "flash", keySpace: 200, keySkew: 0.9 }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      clarifications: [
        clarification(
          "How big is the surge relative to normal traffic, and how long does it last?",
          "Roughly six times the baseline, for a couple of seconds after the sale opens. Baseline through the rest of the sale is a few hundred requests per second.",
        ),
        clarification(
          "What is the mix of availability checks to actual purchase attempts?",
          "About four reads for every write. Most of the surge is people refreshing the seat map, not completing a purchase.",
        ),
        clarification(
          "Is it acceptable to turn some buyers away, or must every request be served?",
          "Turning people away is acceptable if it is instant and honest - a waiting-room page. What is not acceptable is a slow page that times out.",
        ),
        clarification(
          "Can we oversell and reconcile afterwards?",
          "Absolutely not. Selling the same seat twice is a legal and reputational problem. The seat count must never go negative.",
        ),
        clarification(
          "What latency should an accepted request meet?",
          "Around a tenth of a second at p95 for the people we do admit. Speed for admitted buyers matters more than admitting everyone.",
        ),
        clarification(
          "What is the infrastructure budget for the sale?",
          "Modest - under about fifty-five credits. We cannot run peak-sized capacity all year for a spike that lasts seconds.",
        ),
        clarification(
          "Should the seat map be rendered server-side or in the browser?",
          "Client-side. That is a front-end decision and does not affect the capacity design.",
          false,
        ),
        clarification(
          "Which payment provider will we integrate with?",
          "Undecided. Assume a standard provider with a synchronous API; it does not change the architecture you are being asked for.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your ticket-sale design. State the peak factor, duration and tolerance for rejection that your clarifying questions established, explain why you chose admission control or capacity, show the arithmetic for what the surge demands versus what you provisioned, and describe exactly how you guarantee a seat is never sold twice.",
        followUps: [
          "Rejected buyers refresh the page every two seconds. What does that do to your effective peak, and which parameter of your limiter do you change?",
          "Two buyers hit the last seat within the same millisecond. Walk through your write path and name the mechanism that makes exactly one of them win.",
          "The promoter says rejecting anyone is unacceptable and asks you to make everyone wait instead. Describe the design that satisfies them and what it now costs you.",
        ],
        rubric: rubric([
          ["framing", "States the peak factor, surge duration, read/write mix and rejection tolerance from clarification before choosing an approach", 25],
          ["tradeoff", "Argues admission control against provisioning for the peak using the cost ceiling, and quantifies what each would cost", 30],
          ["correctness", "Specifies an atomic conditional decrement or lock plus idempotent purchase calls so a seat cannot be sold twice", 25],
          ["risk", "Names a residual risk - retries inflating the peak, fairness and bots, a cold cache at the drop - and how it would be detected", 20],
        ]),
        modelAnswer:
          "Clarification established a six-fold surge lasting a couple of seconds over a baseline of a few hundred requests per second, four reads per write, an explicit tolerance for instant rejection, an absolute ban on overselling, and a modest budget. Provisioning for the peak means paying six times over all year for a spike measured in seconds, which the budget forbids, so the answer is admission control: a token-bucket limiter at the front door set near what the stack can genuinely serve, with a burst allowance that absorbs the first instant. Behind it, a balanced pool of application replicas with a bounded queue so nothing accepted sits waiting for seconds, and a keyed cache with a short TTL and request coalescing for the seat-availability reads, which all target the same few keys - without coalescing every expiry becomes a stampede on one row. Correctness lives on the write path: the seat decrement is a conditional update inside a transaction, so exactly one of two concurrent buyers wins, holds expire so abandoned carts return inventory, and every purchase carries an idempotency key so a retried timeout does not double-book. Residual risks: rejected buyers refreshing, and fairness against bots.",
      }),
      reflection: {
        question: "During the drop, a fifth of arriving requests are rejected instantly by the limiter while accepted requests stay fast. How should you read that result?",
        options: [
          "As the design working: shedding early keeps admitted buyers fast, but rejected rate must be reported as a first-class signal, not hidden",
          "As a failure: any rejection means the system is under-provisioned and capacity should be increased until rejection reaches zero",
          "As a neutral outcome: rejected requests never entered the system, so they are not part of its reliability picture",
          "As a monitoring bug: rejections should be counted as server errors so they appear in the error rate",
        ],
        answer: 0,
        explanation:
          "Shedding is the deliberate choice the cost ceiling forces, and it works precisely because a rejection is cheap and leaves no queue behind. But it flatters every dashboard - rejected requests leave the latency population and are not faults - so rejected rate has to sit next to latency and errors as its own signal. Driving rejection to zero means buying peak capacity you use for seconds a year, and relabelling rejections as errors would destroy your ability to tell a deliberate shed from a broken dependency.",
      },
    }),

    brief({
      id: "chat-and-notifications",
      chapter: chapterTitles[11],
      title: "Design chat and notifications",
      subtitle: "A write-heavy pipeline, a bounded backlog, and users on two continents.",
      difficulty: "Expert",
      minutes: 30,
      concept: "Asynchronous delivery",
      brief:
        "A team messaging product needs to accept messages and deliver them to recipients, including people who are offline and will collect them later. The prompt is: 'sending should feel instant, nothing should ever be lost, and it has to work for our European customers too.' You are not told the send rate, the read/write mix, where the users are, what ordering guarantee is required, or how long undelivered messages must survive. Ask first. Nothing is placed on the canvas for you and no particular topology is required - any design that runs and meets the targets is a pass, so the pipeline you draw is the answer you are defending.",
      learning: [
        "Chat inverts the usual ratio: most traffic is writes. Sending a message is a durable write plus a fan-out to recipients, and reading history is comparatively rare because clients hold what they already received. That single fact removes the cache from the centre of the design - there is little repeated read traffic to absorb - and puts the write path and its durability guarantees in the spotlight instead. Establish the ratio in clarification, then say out loud that this is a write-heavy system and that the expensive component will therefore be storage, not the read tier.",
        "Split the request into the part the sender waits for and the part they do not. Accepting a message means validating it, writing it durably and handing it to a queue; delivery, fan-out, push notifications and badge counts happen behind that boundary. The sender's latency is then the intake path only, which is short and predictable, while the slow and failure-prone work is retried by workers without anyone watching a spinner. This is the standard producer-queue-consumer shape, and the sentence to say is that acknowledgement happens after the durable write, not after delivery.",
        "A queue is a shock absorber, not storage, and an unbounded one is a way to fail slowly. If workers fall behind, an unbounded backlog grows until every message in it is older than anyone's patience and the whole batch times out together. Bounding the queue makes the failure explicit and immediate: beyond the bound, intake rejects and you can tell the sender honestly. Size the bound from how long you are willing for a message to wait multiplied by the drain rate - that is Little's law again - and provision workers so the steady state sits comfortably below it.",
        "Worker capacity is the number to derive, not guess. Each worker replica processes at some rate, and you need the pool's aggregate to exceed the arrival rate with real headroom, because arrivals are bursty and a pool at ninety percent utilization has a queue that grows on every fluctuation. Two to three times headroom on the worker tier is the production norm; the storage tier behind it needs the same treatment, partitioned so the write volume spreads rather than piling onto one primary.",
        "Ordering is the guarantee people assume and rarely specify. Global ordering across a whole system is expensive and almost never required; per-conversation ordering is what users actually perceive, and it is cheap if you partition by conversation so every message for one channel is handled by one lane in sequence. Say that explicitly, because it also fixes your partition key: hashing on conversation gives you ordering, locality and even spread at once. Discord's choice of a channel-and-time partition key is the canonical example to cite.",
        "Offline delivery is a storage question wearing a delivery costume. A recipient who is disconnected needs their messages durably stored with a per-recipient cursor so they can resume from where they stopped, and the retention answer decides how much you keep and for how long. At-least-once delivery is the practical guarantee, which means recipients will occasionally see a duplicate - so give every message a stable identifier and let clients deduplicate. Promising exactly-once end-to-end is the answer that gets interrogated.",
        "Geography is a latency budget, not a redesign. When a large minority of users sit on another continent, every request they make pays a cross-region round trip - often the largest single term in their latency, larger than all your service time combined. You can either accept it and set an SLO that admits it, or place regional intake close to users and replicate asynchronously, which costs you cross-region consistency work. Decide deliberately and state the number: a design that quotes one p95 for both continents is a design that has not measured the far one.",
        "What this model idealizes: real chat runs over persistent connections, so there is a whole connection-management tier - gateways holding millions of sockets, presence, and consistent hashing to route a message to the right gateway - that this request-response simulation does not represent. Push notification providers, encryption, and read receipts multiplying the write volume are also absent. Name them, and be clear that what you are sizing here is the intake, queue, worker and storage pipeline behind that socket layer.",
      ],
      hints: [
        "Start from the read/write mix rather than from components - nothing is on the canvas yet: it tells you which tier will be expensive and rules out the one you would reach for by reflex.",
        "Separate what the sender waits for from what can happen behind an acknowledgement, and check what the intake path alone costs.",
        "Size the worker pool from the arrival rate with real headroom, bound the backlog so failure is immediate rather than slow, and spread storage by conversation; the targets, not a prescribed shape, decide whether it passes.",
      ],
      objectives: [...healthy(475, 230), budget(75)],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: chatReference,
      workload: workload({
        requestRate: 500,
        readRatio: 0.25,
        duration: 30,
        seed: 14,
        keySpace: 20000,
        regions: [
          { name: "us-east", share: 0.6 },
          { name: "eu-west", share: 0.4 },
        ],
        crossRegionLatencyMs: 90,
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      remixable: true,
      clarifications: [
        clarification(
          "What is the message rate at peak, and what is the read-to-write mix?",
          "About five hundred requests per second at peak, and it is write-dominated - roughly three sends for every history fetch. Clients cache what they have already received.",
        ),
        clarification(
          "Where are the users?",
          "Around sixty percent in North America and forty percent in Europe, and the European share is growing. Our infrastructure is currently all in one US region.",
        ),
        clarification(
          "What ordering guarantee do we need?",
          "Messages within one conversation must appear in the order they were sent. Ordering across different conversations does not matter.",
        ),
        clarification(
          "What happens to messages for a recipient who is offline?",
          "They must be stored durably and delivered when the client reconnects, with no loss. A rare duplicate is acceptable if clients can deduplicate.",
        ),
        clarification(
          "What latency should a send feel like?",
          "The sender's acknowledgement should come back in a couple of hundred milliseconds at p95, including for European users. Delivery to the recipient can take a little longer.",
        ),
        clarification(
          "How long must message history be retained?",
          "Indefinitely for compliance, but only the recent window is served interactively. Older history can be moved to colder storage.",
        ),
        clarification(
          "Should we support emoji reactions and threaded replies at launch?",
          "Reactions yes, threads later. Both are product features layered on the same message pipeline.",
          false,
        ),
        clarification(
          "Which client framework should we standardise on?",
          "Not decided, and not something this design depends on.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your chat design. State the send rate, read/write mix, region split, ordering guarantee and retention requirement your clarifying questions established, explain what the sender waits for and what happens behind the acknowledgement, show how you sized the worker pool and the backlog bound, and name the ordering and delivery guarantees you are promising.",
        followUps: [
          "Your workers fall behind for thirty seconds during a deploy. Walk through what your bounded backlog does, what the sender sees, and how you would decide the bound in the first place.",
          "A European user reports that sending feels sluggish while US users are happy. Which term in the latency budget explains it, and what are the two ways to fix it with their costs?",
          "The product adds read receipts, so every message read produces a write. What does that do to your write volume and which component do you resize first?",
        ],
        rubric: rubric([
          ["framing", "States the write-dominated mix, region split, ordering guarantee and retention window from clarification before placing components", 25],
          ["async", "Separates the synchronous intake path from asynchronous delivery and says where the acknowledgement happens relative to the durable write", 25],
          ["arith", "Sizes the worker pool and storage partitions from the arrival rate with explicit headroom, and derives the backlog bound from a wait tolerance", 25],
          ["tradeoff", "Names the ordering and delivery guarantees chosen, the alternative rejected, and the residual risk with how it would be detected", 25],
        ]),
        modelAnswer:
          "Clarification gave me five hundred requests per second at peak, write-dominated at roughly three sends per history fetch, a sixty-forty split between North America and Europe on a single US region, per-conversation ordering, durable offline delivery with tolerated duplicates, and indefinite retention with only a recent window served interactively. Because it is write-heavy there is no repeated read traffic for a cache to absorb, so the money goes into the write path. Intake is a balanced pair of replicas that validates, writes durably and enqueues; the sender is acknowledged there, so their latency is the intake path only. Delivery, fan-out and pushes run in a worker pool sized at roughly twice the arrival rate so a burst does not build a queue, with a bounded backlog derived from how long I will let a message wait times the drain rate - beyond it intake rejects honestly instead of failing slowly. Storage is partitioned by conversation, which gives per-conversation ordering, locality and even spread at once. European users pay one cross-region round trip, which dominates their p95; I accept it against the stated target rather than build regional writes, and I would revisit that as the European share grows.",
      }),
      reflection: {
        question: "Why is an unbounded delivery queue a worse failure mode than a bounded one when workers fall behind?",
        options: [
          "The backlog grows until every message in it is already too old to be useful, so the whole batch fails together with no early warning",
          "Unbounded queues consume more memory per message, so the queue process is killed first",
          "Bounded queues deliver messages faster, because a smaller queue has lower per-message overhead",
          "An unbounded queue reorders messages once it exceeds its allocated segment size",
        ],
        answer: 0,
        explanation:
          "An unbounded queue converts an overload into a latency problem that stays invisible until every queued item has aged past its deadline, at which point they time out together and you have both lost the work and burned the capacity. A bound makes the same overload immediate and legible: intake rejects, the sender is told, and the backlog stays inside a wait time you chose. Memory, per-message overhead and ordering are not the point - the point is when you find out.",
      },
    }),

    brief({
      id: "metrics-ingestion",
      chapter: chapterTitles[11],
      title: "Design metrics ingestion",
      subtitle: "Write-heavy ingest that grows through the day, and a storage tier that browns out.",
      difficulty: "Expert",
      minutes: 35,
      concept: "Write-heavy ingest & backpressure",
      brief:
        "The platform team wants a service that accepts metric samples from every host and container in the fleet and stores them for dashboards and alerts. All you are told is: 'the fleet is growing, we cannot lose the alerting signal, and last time the storage layer got slow it took the whole pipeline with it.' Nobody has said how many samples per second, how the load varies through the day, or whether dropping some samples is preferable to falling over. The canvas is empty: there is no starter pipeline and no required shape, and any architecture that runs and clears the targets passes.",
      learning: [
        "Metrics ingestion is the most write-heavy system most engineers ever build: samples arrive constantly, reads are a comparatively small trickle from dashboards and alert evaluations, and the ratio can reach a hundred writes per read. That inverts every reflex from a product service - there is no hot read set for a cache to absorb, so the cache you would reach for by habit does nothing here. The expensive, hard-to-scale component is the storage tier, and the whole design is about spreading writes across it and controlling what happens when it slows down.",
        "Sharding is the primary lever, and the shard key is the design decision. Hashing on the series identity - the metric name plus its label set - spreads writes evenly and keeps all samples for one series together, which is what range queries need. Sharding by time instead concentrates every write in the fleet onto whichever shard owns the current window, manufacturing a hot partition by construction. Derive the shard count from the write rate divided by a per-shard capacity you are willing to defend, then add headroom, because a metrics pipeline's load grows with the fleet it is watching.",
        "Load here is not steady, and pretending it is will size the system wrong. A fleet that scales up through the working day pushes an ingest rate that climbs with it, so the peak is not a brief spike but a sustained ramp to something well above the daily mean. Provisioning for the peak means the whole system idles for most of the day, which is why admission control belongs at the front: a rate limiter set near what the pipeline can genuinely absorb, so the top of the ramp is shed deliberately instead of quietly turning into unbounded backlog.",
        "Then there is the brownout, which is the failure this system actually has to survive. Storage does not usually die cleanly; it gets several times slower for a while - a compaction storm, a noisy neighbour, a degraded disk. Every request in flight now takes longer, work piles up behind it, and a pipeline with no protection converts a slow dependency into an outage that outlasts the brownout itself. The two protections to name are enough per-shard headroom that a multiple-times slowdown still leaves effective capacity above the arrival rate, and a front-door limiter that keeps the accepted load inside that budget.",
        "Be deliberate about what you protect. Not all metrics matter equally: alerting series must survive, while a high-cardinality debugging metric can be dropped without anyone noticing until Monday. Real pipelines encode that as priority classes with separate budgets, and it is the answer to 'what do you shed?' - not 'a random fifth of everything'. Cardinality control belongs in the same conversation, because an unbounded label like a user ID or a raw URL multiplies series count and is the single most common way a metrics system's cost explodes.",
        "Pre-aggregation is the lever that changes the arithmetic rather than the architecture. An agent that computes a per-minute summary on the host sends one sample where it would have sent sixty, cutting ingest volume by an order of magnitude and losing only sub-minute resolution that almost no dashboard reads. Downsampling on the storage side does the same for history: keep raw samples for days, minute rollups for weeks, hour rollups for a year. Say both out loud, because the strongest answer to a write-volume problem is often to write less.",
        "Late and out-of-order data is the follow-up you should expect. A host that was network-partitioned will send its buffered samples minutes later, so the ingest path needs a bounded acceptance window, and anything outside it is either dropped or written to a repair path. Say what the window is and what happens beyond it, because 'we accept everything forever' means every historical block stays open for rewriting, which is the thing that makes a time-series store expensive to operate.",
        "What this model idealizes: the simulation gives you write volume, shedding and the brownout, but not compaction, retention enforcement, cardinality explosions or the write-ahead log that makes ingestion durable across a restart. It also treats every sample as equal, whereas the real design's most important property is that alerting data has its own budget. Name those, and be explicit that the number you measured is the ingest tier's behaviour, not the storage engine's steady-state cost.",
      ],
      hints: [
        "Nothing is on the canvas, so build an ingest path you can measure, then watch what happens after the storage tier slows down rather than only during: the damage outlasts the event.",
        "Work out the per-shard arrival rate, then ask what is left of each shard's effective capacity while storage is running several times slower.",
        "Spread the writes wide enough that a slowdown still leaves headroom, and put something at the front door that caps what you admit as load climbs; any architecture that clears the targets passes.",
      ],
      objectives: [
        objective("p95", "lte", 340),
        objective("throughput", "gte", 780),
        objective("errorRate", "lte", 0.01),
        rejected(0.12),
        budget(170),
      ],
      architecture: blankCanvasStarter,
      blankCanvas: true,
      reference: metricsReference,
      workload: workload({
        requestRate: 900,
        readRatio: 0.1,
        duration: 30,
        seed: 15,
        pattern: "ramp",
        keySpace: 50000,
        keySkew: 0.5,
        failures: [{ kind: "slow-database", at: 0.5, duration: 5, factor: 3 }],
      }),
      allowedKinds: allKinds,
      estimation: estimate("dbLoad", "bottleneckCapacity", "cost"),
      clarifications: [
        clarification(
          "What sample rate should I design for, and how does it vary through the day?",
          "Around nine hundred requests per second as a daily mean, nine writes for every read, and it climbs steadily as the fleet scales up through the working day - the late-day peak is well above the mean.",
        ),
        clarification(
          "What is the read-to-write ratio?",
          "Overwhelmingly writes - roughly one read for every nine writes. Reads come from dashboards and alert evaluations, not from users.",
        ),
        clarification(
          "What happened last time storage got slow, and may we shed load to protect the pipeline?",
          "Storage ran several times slower for a few seconds and the whole ingest tier backed up and stayed broken long after. Yes - dropping some samples is far better than losing the alerting signal.",
        ),
        clarification(
          "What latency does an ingest write need to meet?",
          "It is machine-to-machine, so a few hundred milliseconds at p95 is fine. Agents buffer briefly; what they cannot tolerate is multi-second stalls.",
        ),
        clarification(
          "How long must samples be retained, and at what resolution?",
          "Raw samples for a few days, minute rollups for weeks, hour rollups for a year. Rollups are computed after ingest and are out of scope here.",
        ),
        clarification(
          "What is the budget for the ingest tier?",
          "It is internal infrastructure, so it has to be justifiable - keep it under about a hundred and seventy credits.",
        ),
        clarification(
          "Which dashboard product will read from this?",
          "The usual open-source one. It queries over an API and does not constrain the ingest design.",
          false,
        ),
        clarification(
          "How many engineers are on the platform team?",
          "Six. Relevant to how much we can operate, not to how the pipeline is sized.",
          false,
        ),
      ],
      defense: defense({
        prompt:
          "Defend your ingestion design. State the write rate, its shape through the day, the read/write ratio and the shedding tolerance your clarifying questions established, show how you derived the shard count and the per-shard headroom needed to survive a storage slowdown, justify what you put at the front door, and say which samples you would drop first and why.",
        followUps: [
          "Storage runs five times slower instead of three, and for a minute instead of a few seconds. Which of your numbers breaks first, and what does your design do rather than collapse?",
          "A team ships a metric labelled with a request ID, and the series count multiplies overnight. Which part of your design absorbs it, which part does not, and what would have caught it earlier?",
          "Agents that were network-partitioned reconnect and replay ten minutes of buffered samples at once. What does the front door do, and what have you promised about late data?",
        ],
        rubric: rubric([
          ["framing", "States the write rate, its daily shape, the read/write ratio and the explicit permission to shed before choosing components", 25],
          ["shards", "Derives shard count and per-shard headroom from the write rate and the brownout multiplier, rather than picking a number", 30],
          ["backpressure", "Justifies front-door admission control against provisioning for the peak, and says what shedding costs", 25],
          ["risk", "Names what is dropped first, the residual risk (cardinality, late data, rollups) and how it would be detected", 20],
        ]),
        modelAnswer:
          "Clarification gave me roughly nine hundred writes per second as a daily mean climbing well above that through the working day, nine writes per read, an explicit preference for shedding over collapse, a few hundred milliseconds of tolerance at p95, and a budget. There is no repeated read set, so no cache: the money goes into spreading writes. I hash-shard on series identity so writes spread evenly and each series stays contiguous for range queries, and I chose the shard count so that per-shard arrival sits near a third of per-shard capacity - because the failure I have to survive is storage running several times slower, and a threefold slowdown must still leave effective capacity above the arrival rate. At the front door a token-bucket limiter is set near what the pipeline genuinely absorbs, so the top of the daily ramp is shed in a millisecond instead of becoming backlog that outlives the event. I rejected provisioning for the ramp's peak, which idles most of the day and busts the budget. What I drop first is high-cardinality debug series, never alerting series, and the signals I would watch are rejected rate, per-shard utilization and series count.",
      }),
      reflection: {
        question: "Storage slows to a third of its normal speed for a few seconds. Why can that turn into an outage lasting far longer than the slowdown itself?",
        options: [
          "Arrivals keep coming while effective capacity has dropped below them, so a backlog builds that must be drained after the event before latency recovers",
          "The slowdown corrupts in-flight writes, so the pipeline must stop and replay them from the beginning",
          "Sharded stores rebalance automatically when one shard slows, and rebalancing is what causes the extended outage",
          "Client agents interpret slowness as failure and permanently stop sending, requiring a manual restart",
        ],
        answer: 0,
        explanation:
          "A brownout is an arithmetic problem: if effective capacity falls below the arrival rate, the excess accumulates for every second of the event and then has to be drained at whatever surplus capacity remains afterwards. That is why the recovery tail is longer than the event. The defences are per-shard headroom sized against the slowdown multiplier and a front door that caps what is admitted, so the backlog never gets a chance to build.",
      },
    }),
  ],
};
