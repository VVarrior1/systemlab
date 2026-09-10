import type { Reading } from "../types";

/**
 * Verified deep-dive readings for the interview-toolkit (written) lessons and the
 * design-brief (Expert) lessons. Every URL below was fetched and confirmed to load
 * (no 404, no login/paywall) and to match its claimed content before being added here.
 * See the task report for the full verified/rejected URL log.
 */
export const readings: Record<string, Reading[]> = {
  "framing-and-requirements": [
    {
      title: "Service Level Objectives",
      url: "https://sre.google/sre-book/service-level-objectives/",
      source: "Google SRE Book",
      why: "Shows how to turn a vague 'make it reliable' ask into the concrete SLIs and numeric targets an interviewer expects you to pin down while scoping requirements.",
      minutes: 20,
    },
    {
      title: "AWS Well-Architected Framework",
      url: "https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html",
      source: "AWS Documentation",
      why: "Gives a repeatable checklist of the questions (reliability, scale, cost, security trade-offs) that separates a well-framed design from a guess.",
      minutes: 15,
    },
    {
      title: "The Tail at Scale",
      url: "https://research.google/pubs/the-tail-at-scale/",
      source: "Google Research (Dean & Barroso)",
      why: "Demonstrates why 'requirements' must include latency percentiles, not just averages, before you start drawing boxes.",
      minutes: 25,
    },
  ],

  "numbers-everyone-should-know": [
    {
      title: "Latency Numbers Every Programmer Should Know (interactive)",
      url: "https://colin-scott.github.io/personal_website/research/interactive_latency.html",
      source: "Colin Scott (interactive visualization)",
      why: "Lets you feel the multi-order-of-magnitude gaps between memory, SSD, disk, and network round-trips that the gym's latency quiz drills on.",
      minutes: 10,
    },
    {
      title: "Latency Numbers Every Programmer Should Know",
      url: "https://gist.github.com/jboner/2841832",
      source: "GitHub Gist (after Dean & Norvig)",
      why: "The canonical flat reference table to memorize before estimating p95/p99 budgets by hand.",
      minutes: 5,
    },
  ],

  "api-design-and-idempotency": [
    {
      title: "Idempotent requests",
      url: "https://docs.stripe.com/api/idempotent_requests",
      source: "Stripe API Docs",
      why: "Shows the concrete mechanics (idempotency-key header, stored first response, retry-safety) you should propose when a client might resend a mutating call.",
      minutes: 8,
    },
    {
      title: "Idempotency keys",
      url: "https://stripe.com/blog/idempotency",
      source: "Stripe Engineering Blog",
      why: "Explains the reasoning behind idempotency keys plus retries with jittered backoff, the pairing you're expected to justify in an API-design answer.",
      minutes: 12,
    },
    {
      title: "API Design Guide",
      url: "https://docs.cloud.google.com/apis/design",
      source: "Google Cloud Documentation",
      why: "A production style guide for resource naming, standard CRUD methods, and error conventions you can cite when defending an endpoint's shape.",
      minutes: 30,
    },
  ],

  "storage-engines-and-indexing": [
    {
      title: "Indexes",
      url: "https://www.postgresql.org/docs/current/indexes.html",
      source: "PostgreSQL Documentation",
      why: "Covers the B-tree, GIN, and BRIN index types and when each earns its write-amplification cost, the trade-off this lesson tests.",
      minutes: 25,
    },
    {
      title: "Use The Index, Luke",
      url: "https://use-the-index-luke.com/",
      source: "Markus Winand",
      why: "Explains how a B-tree index actually speeds up a WHERE/JOIN/ORDER BY from first principles, the mental model behind 'add an index' as an answer.",
      minutes: 30,
    },
    {
      title: "RocksDB Overview",
      url: "https://github.com/facebook/rocksdb/wiki/RocksDB-Overview",
      source: "RocksDB Wiki (Meta)",
      why: "Lays out the memtable/SST/compaction anatomy of an LSM-tree, the write-optimized alternative to a B-tree index you should be able to name and contrast.",
      minutes: 15,
    },
  ],

  "observability-and-slos": [
    {
      title: "Service Level Objectives",
      url: "https://sre.google/sre-book/service-level-objectives/",
      source: "Google SRE Book",
      why: "Defines SLI/SLO/SLA and error budgets, the vocabulary this lesson's defense questions expect you to use precisely.",
      minutes: 20,
    },
    {
      title: "Monitoring Distributed Systems",
      url: "https://sre.google/sre-book/monitoring-distributed-systems/",
      source: "Google SRE Book",
      why: "Introduces the four golden signals (latency, traffic, errors, saturation) as the minimum dashboard for any service you design.",
      minutes: 20,
    },
    {
      title: "Storage",
      url: "https://prometheus.io/docs/prometheus/latest/storage/",
      source: "Prometheus Documentation",
      why: "Shows what actually happens under an SLO dashboard: how a time-series backend blocks, compresses, and retains the samples your alerts read.",
      minutes: 12,
    },
  ],

  "url-shortener": [
    {
      title: "Snowflake (unique ID generator)",
      url: "https://github.com/twitter-archive/snowflake/tree/snowflake-2010",
      source: "Twitter (archived)",
      why: "The reference design for generating short, roughly-sortable unique IDs without a single coordinating counter, the core problem a shortener's key-generation step has to solve.",
      minutes: 10,
    },
    {
      title: "INCR",
      url: "https://redis.io/docs/latest/commands/incr/",
      source: "Redis Documentation",
      why: "Shows the simpler alternative to Snowflake — an atomic counter you encode to base62 — plus the race conditions to avoid when several app servers mint codes at once.",
      minutes: 8,
    },
    {
      title: "Default Cache Behavior",
      url: "https://developers.cloudflare.com/cache/concepts/default-cache-behavior/",
      source: "Cloudflare Documentation",
      why: "Explains how a redirect response gets cached at the edge, the reason a shortener's read path can be nearly all cache hits despite huge read:write skew.",
      minutes: 10,
    },
  ],

  "news-feed": [
    {
      title: "FollowFeed: LinkedIn's Feed Made Faster and Smarter",
      url: "https://www.linkedin.com/blog/engineering/feed/followfeed-linkedin-s-feed-made-faster-and-smarter",
      source: "LinkedIn Engineering",
      why: "Walks through the fanout-on-write vs. fanout-on-read trade-off head-on, with the real storage-size numbers LinkedIn measured for each, the central design decision in this brief.",
      minutes: 15,
    },
    {
      title: "TAO: Facebook's Distributed Data Store for the Social Graph",
      url: "https://research.facebook.com/publications/tao-facebooks-distributed-data-store-for-the-social-graph/",
      source: "USENIX ATC 2013 (Meta Research)",
      why: "Shows how the 'who do I follow, what did they post' graph underneath a feed is served at read-heavy scale, the data layer a fanout strategy sits on top of.",
      minutes: 25,
    },
    {
      title: "Redis sorted sets",
      url: "https://redis.io/docs/latest/develop/data-types/sorted-sets/",
      source: "Redis Documentation",
      why: "The concrete data structure (score = timestamp or rank) many fanout-on-write feeds use per-user to store and page through a materialized timeline cheaply.",
      minutes: 12,
    },
  ],

  "ticket-sale": [
    {
      title: "Waiting Room",
      url: "https://developers.cloudflare.com/waiting-room/",
      source: "Cloudflare Documentation",
      why: "The standard fix for a flash-crowd ticket drop: queue excess arrivals at the edge instead of letting them all hit checkout at once.",
      minutes: 10,
    },
    {
      title: "How to do distributed locking",
      url: "https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html",
      source: "Martin Kleppmann",
      why: "Explains why a naive Redis lock can still let two buyers win the same seat, and what a correctness-critical reservation step needs instead (fencing tokens).",
      minutes: 15,
    },
    {
      title: "Idempotent requests",
      url: "https://docs.stripe.com/api/idempotent_requests",
      source: "Stripe API Docs",
      why: "A client retrying a timed-out purchase must not double-charge or double-book a seat; this is the pattern that guarantees a retry is safe.",
      minutes: 8,
    },
  ],

  "chat-and-notifications": [
    {
      title: "How Discord Stores Trillions of Messages",
      url: "https://discord.com/blog/how-discord-stores-billions-of-messages",
      source: "Discord Engineering",
      why: "Shows a real partition key (channel_id, time_bucket) chosen specifically to keep a chat history table's hot partitions bounded at huge write volume.",
      minutes: 15,
    },
    {
      title: "How Real-Time Messaging Works at Slack",
      url: "https://slack.engineering/real-time-messaging/",
      source: "Slack Engineering",
      why: "Describes the gateway/channel-server split and consistent hashing that routes a message to every open WebSocket subscribed to it, the fanout problem this brief is built on.",
      minutes: 15,
    },
    {
      title: "Redis Streams",
      url: "https://redis.io/docs/latest/develop/data-types/streams/",
      source: "Redis Documentation",
      why: "Gives a concrete building block (consumer groups, XREADGROUP/XACK) for a durable, at-least-once notification queue behind a chat service.",
      minutes: 12,
    },
  ],

  "metrics-ingestion": [
    {
      title: "M3: Uber's Open Source, Large-scale Metrics Platform",
      url: "https://www.uber.com/blog/m3/",
      source: "Uber Engineering",
      why: "Describes what breaks a metrics pipeline at scale (500M points/sec, resharding, cross-DC queries) and why Uber built a purpose-made ingestion and storage tier for it.",
      minutes: 15,
    },
    {
      title: "Storage",
      url: "https://prometheus.io/docs/prometheus/latest/storage/",
      source: "Prometheus Documentation",
      why: "Shows the actual write path a metrics-ingestion service needs: a write-ahead log, 2-hour blocks, and remote-write for durability beyond one node.",
      minutes: 12,
    },
    {
      title: "INCR",
      url: "https://redis.io/docs/latest/commands/incr/",
      source: "Redis Documentation",
      why: "Its rate-limiter pattern is the same atomic-counter-with-expiry building block an ingestion service uses to pre-aggregate a metric before it ever hits long-term storage.",
      minutes: 8,
    },
  ],
};
