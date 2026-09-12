import type { Reading } from "../types";

// Deep-dive readings for the replication/consistency, partitioning, traffic-control,
// and multi-region lessons (spec §2, §6). Every URL below was fetched and verified
// during authoring; see the owning agent's report for the verification log.
export const readings: Record<string, Reading[]> = {
  "read-replicas": [
    {
      title: "High Availability, Load Balancing, and Replication",
      url: "https://www.postgresql.org/docs/current/high-availability.html",
      source: "PostgreSQL Documentation",
      why: "Lays out the standby/replica vocabulary (warm vs. hot standby, streaming vs. log-shipping) this lesson's leader-follower topology is built from.",
      minutes: 10,
    },
    {
      title: "26.4. Hot Standby",
      url: "https://www.postgresql.org/docs/current/hot-standby.html",
      source: "PostgreSQL Documentation",
      why: "Explains exactly what a follower can and can't do while serving reads, which is the mechanism behind routing reads off the leader to cut its load.",
      minutes: 8,
    },
    {
      title: "Replication with Amazon Aurora",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html",
      source: "AWS Documentation",
      why: "Shows a production replica fleet in practice: up to 15 read replicas spreading read load, and how they double as failover targets.",
      minutes: 7,
    },
  ],

  "replication-lag": [
    {
      title: "26.2. Log-Shipping Standby Servers (Streaming Replication)",
      url: "https://www.postgresql.org/docs/current/warm-standby.html",
      source: "PostgreSQL Documentation",
      why: "Defines replication lag precisely (WAL written on the primary vs. WAL applied on the standby) and the functions used to measure it.",
      minutes: 10,
    },
    {
      title: "Consistency Models: Read Your Writes",
      url: "https://jepsen.io/consistency/models/read-your-writes",
      source: "Jepsen",
      why: "Formally defines the read-your-writes guarantee a stale follower can violate, and why it's a per-session property, not a whole-system one.",
      minutes: 5,
    },
    {
      title: "Replication with Amazon Aurora",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html",
      source: "AWS Documentation",
      why: "Gives a concrete lag number (usually well under 100ms, growing under heavy write load) to calibrate what 'acceptable lag' looks like in a real system.",
      minutes: 6,
    },
  ],

  "leader-failover": [
    {
      title: "26.3. Failover",
      url: "https://www.postgresql.org/docs/current/warm-standby-failover.html",
      source: "PostgreSQL Documentation",
      why: "Walks through the actual failover mechanics (promotion, STONITH to avoid split-brain, rebuilding a new standby afterward) this lesson simulates.",
      minutes: 8,
    },
    {
      title: "Managing Critical State: Distributed Consensus for Reliability",
      url: "https://sre.google/sre-book/managing-critical-state/",
      source: "Google SRE Book",
      why: "Explains why leader election needs real consensus rather than ad hoc heartbeats, with case studies of split-brain incidents caused by cutting that corner.",
      minutes: 20,
    },
  ],

  "choosing-consistency": [
    {
      title: "Consistency Models",
      url: "https://jepsen.io/consistency",
      source: "Jepsen",
      why: "The map of the whole consistency-model landscape (models, phenomena, availability tradeoffs) this written lesson expects you to navigate.",
      minutes: 8,
    },
    {
      title: "Consistency Models: Linearizable",
      url: "https://jepsen.io/consistency/models/linearizable",
      source: "Jepsen",
      why: "Defines the strongest model precisely, and states outright why it can never be sticky- or totally-available during a partition — the crux of the CAP tradeoff.",
      minutes: 5,
    },
    {
      title: "CAP Twelve Years Later: How the \"Rules\" Have Changed",
      url: "https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/",
      source: "InfoQ (Eric Brewer)",
      why: "CAP's own author reframes the theorem as something to manage during partitions (detect, degrade, recover) rather than a permanent two-of-three choice.",
      minutes: 12,
    },
    {
      title: "Problems with CAP, and Yahoo's little known NoSQL system",
      url: "https://dbmsmusings.blogspot.com/2010/04/problems-with-cap-and-yahoos-little.html",
      source: "Daniel Abadi",
      why: "Introduces PACELC, the extension this lesson needs: even with no partition, every system still trades latency against consistency.",
      minutes: 10,
    },
  ],

  "shard-the-writes": [
    {
      title: "5.12. Table Partitioning",
      url: "https://www.postgresql.org/docs/current/ddl-partitioning.html",
      source: "PostgreSQL Documentation",
      why: "Concrete syntax and semantics for range, list, and hash partitioning — the same three strategies this lesson's shard key choice models.",
      minutes: 12,
    },
    {
      title: "Ranged Sharding",
      url: "https://www.mongodb.com/docs/manual/core/ranged-sharding/",
      source: "MongoDB Documentation",
      why: "Shows what makes a shard key good or bad (cardinality, frequency, monotonicity) before you ever hit an imbalance.",
      minutes: 6,
    },
    {
      title: "Hashed Sharding",
      url: "https://www.mongodb.com/docs/manual/core/hashed-sharding/",
      source: "MongoDB Documentation",
      why: "Contrasts hash-based sharding directly against range sharding, with the canonical monotonically-increasing-key example this lesson's write-scaling decision hinges on.",
      minutes: 6,
    },
  ],

  "hot-shard": [
    {
      title: "Hashed Sharding",
      url: "https://www.mongodb.com/docs/manual/core/hashed-sharding/",
      source: "MongoDB Documentation",
      why: "Spells out exactly how a monotonic range key funnels all writes onto one shard, which is the hot-shard failure mode this lesson reproduces and asks you to fix.",
      minutes: 6,
    },
    {
      title: "Ranged Sharding",
      url: "https://www.mongodb.com/docs/manual/core/ranged-sharding/",
      source: "MongoDB Documentation",
      why: "Explains why range sharding is still worth it despite hotspot risk: it keeps range queries targeted to one shard, the tradeoff a hash key gives up.",
      minutes: 6,
    },
    {
      title: "How Discord Stores Trillions of Messages",
      url: "https://discord.com/blog/how-discord-stores-trillions-of-messages",
      source: "Discord Engineering",
      why: "A real hot-shard postmortem: one busy channel overwhelms its partition while the rest of the cluster is idle, and how they routed around it.",
      minutes: 15,
    },
  ],

  "celebrity-problem": [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "AWS Builders' Library",
      why: "Names the exact scenario this lesson stages — hot-key/hot-partition throttling — as a reason to put a cache in front of a single overloaded shard.",
      minutes: 15,
    },
    {
      title: "How Discord Stores Trillions of Messages",
      url: "https://discord.com/blog/how-discord-stores-trillions-of-messages",
      source: "Discord Engineering",
      why: "Shows request coalescing in production: collapsing concurrent reads for the same ultra-hot key into one upstream call instead of one per request.",
      minutes: 15,
    },
    {
      title: "Hashed Sharding",
      url: "https://www.mongodb.com/docs/manual/core/hashed-sharding/",
      source: "MongoDB Documentation",
      why: "Makes the limit of sharding explicit: hashing spreads keys, not the traffic to one key — a single celebrity key always lands on one shard no matter the scheme.",
      minutes: 5,
    },
  ],

  "indexes-and-rebalancing": [
    {
      title: "Chapter 11. Indexes",
      url: "https://www.postgresql.org/docs/current/indexes.html",
      source: "PostgreSQL Documentation",
      why: "Covers the index types and tradeoffs (B-tree, hash, partial, covering) this written lesson expects you to reason about for query speed.",
      minutes: 15,
    },
    {
      title: "CREATE INDEX",
      url: "https://www.postgresql.org/docs/current/sql-createindex.html",
      source: "PostgreSQL Documentation",
      why: "Shows how to build an index without blocking writers (CONCURRENTLY) — the operational concern that makes adding an index to a live, sharded table risky.",
      minutes: 8,
    },
    {
      title: "Sharded Cluster Balancer",
      url: "https://www.mongodb.com/docs/manual/core/sharding-balancer-administration/",
      source: "MongoDB Documentation",
      why: "Explains how a live system rebalances data across shards after growth or a skewed key — migration thresholds, one-migration-per-shard-at-a-time, and scheduled balancing windows.",
      minutes: 10,
    },
  ],

  "rate-limit-the-api": [
    {
      title: "Scaling your API with rate limiters",
      url: "https://stripe.com/blog/rate-limiters",
      source: "Stripe Engineering",
      why: "Explains why an API needs rate limiting at all and how Stripe layers request-rate and concurrent-request limiters in front of the same endpoints this lesson protects.",
      minutes: 15,
    },
    {
      title: "Rate limiting rules",
      url: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
      source: "Cloudflare Documentation",
      why: "Shows rate limiting as a first-class piece of infrastructure — matched by expression, with a configurable action once the threshold is reached — rather than inline application code.",
      minutes: 8,
    },
    {
      title: "Rate Limiting",
      url: "https://redis.io/glossary/rate-limiting/",
      source: "Redis",
      why: "A worked implementation (INCR + EXPIRE) of per-key rate limiting, useful for seeing what the limiter node in this lesson's architecture is standing in for.",
      minutes: 8,
    },
  ],

  "burst-allowance": [
    {
      title: "Module ngx_http_limit_req_module",
      url: "https://nginx.org/en/docs/http/ngx_http_limit_req_module.html",
      source: "nginx Documentation",
      why: "Documents `burst` and `nodelay` directly: how many requests above the steady rate are let through immediately versus queued, which is this lesson's whole knob.",
      minutes: 8,
    },
    {
      title: "Scaling your API with rate limiters",
      url: "https://stripe.com/blog/rate-limiters",
      source: "Stripe Engineering",
      why: "Describes why Stripe added the ability to briefly burst above the steady cap for real-time spikes like flash sales — the exact motivation for a burst allowance.",
      minutes: 10,
    },
    {
      title: "Global rate limiting",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting",
      source: "Envoy Documentation",
      why: "Shows a local token bucket absorbing large bursts in front of a slower global limit, a two-tier pattern for handling burst without overloading the global limiter.",
      minutes: 8,
    },
  ],

  "backpressure-end-to-end": [
    {
      title: "Circuit breaking",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
      source: "Envoy Documentation",
      why: "States the design principle this lesson is built on — fail fast and apply backpressure downstream as soon as possible — and the concrete limits (connections, pending requests, retries) that enforce it.",
      minutes: 10,
    },
    {
      title: "What is Backoff For?",
      url: "https://brooker.co.za/blog/2022/08/11/backoff.html",
      source: "Marc Brooker",
      why: "Argues backoff only helps short-term and cannot substitute for shedding load under sustained overload — the failure mode this lesson's end-to-end chain is designed to expose.",
      minutes: 10,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE Book",
      why: "Shows how backpressure that isn't propagated end-to-end — a queue absorbing load instead of shedding it upstream — is exactly how local overload turns into a cascading outage.",
      minutes: 25,
    },
  ],

  "rate-limiting-algorithms": [
    {
      title: "Rate Limiting",
      url: "https://redis.io/glossary/rate-limiting/",
      source: "Redis",
      why: "Compares fixed-window, sliding-window, token-bucket, and leaky-bucket algorithms side by side, which is exactly the menu this written lesson asks you to choose from.",
      minutes: 10,
    },
    {
      title: "Module ngx_http_limit_req_module",
      url: "https://nginx.org/en/docs/http/ngx_http_limit_req_module.html",
      source: "nginx Documentation",
      why: "A production leaky-bucket implementation with the `burst` and `nodelay` parameters, showing how the abstract algorithm maps to a real, widely deployed limiter.",
      minutes: 8,
    },
    {
      title: "How we built rate limiting capable of scaling to millions of domains",
      url: "https://blog.cloudflare.com/counting-things-a-lot-of-different-things/",
      source: "Cloudflare Engineering",
      why: "Explains why Cloudflare chose a sliding-window counter over token bucket at their scale (two numbers per counter, cheap memcache ops) — a real algorithm-selection tradeoff.",
      minutes: 12,
    },
  ],

  "far-away-users": [
    {
      title: "Latency Numbers Every Programmer Should Know (interactive)",
      url: "https://colin-scott.github.io/personal_website/research/interactive_latency.html",
      source: "Colin Scott (after Peter Norvig / Jeff Dean)",
      why: "Puts a number on why distance hurts: same-datacenter round trip vs. cross-continent round trip, the gap this lesson's cross-region latency models.",
      minutes: 6,
    },
    {
      title: "26.4. Hot Standby",
      url: "https://www.postgresql.org/docs/current/hot-standby.html",
      source: "PostgreSQL Documentation",
      why: "Read replicas placed near remote users are one concrete way to shorten the round trip this lesson is about; this page covers what such a replica can serve on its own.",
      minutes: 8,
    },
    {
      title: "Cloudflare Load Balancing",
      url: "https://developers.cloudflare.com/load-balancing/",
      source: "Cloudflare Documentation",
      why: "Describes routing requests by a visitor's geography or measured endpoint latency — the geo-routing mechanism that gets far-away users to their nearest region.",
      minutes: 8,
    },
  ],

  "active-active": [
    {
      title: "Regional, dual-region, and multi-region configurations",
      url: "https://docs.cloud.google.com/spanner/docs/instance-configurations",
      source: "Google Cloud Documentation",
      why: "Contrasts a true multi-write-region setup against a single-leader one region-at-a-time, and is explicit about the tradeoff: higher availability and lower read latency for a small increase in write latency and cost.",
      minutes: 10,
    },
    {
      title: "Cloudflare Load Balancing",
      url: "https://developers.cloudflare.com/load-balancing/",
      source: "Cloudflare Documentation",
      why: "Covers the traffic-steering half of active-active: distributing requests across healthy endpoints in multiple regions and failing over automatically when one goes unhealthy.",
      minutes: 8,
    },
    {
      title: "Consistency Models: Linearizable",
      url: "https://jepsen.io/consistency/models/linearizable",
      source: "Jepsen",
      why: "Explains why accepting writes in two regions at once forces you off the strongest consistency model — the cost active-active pays that a single-leader system doesn't.",
      minutes: 5,
    },
  ],

  "region-outage": [
    {
      title: "Disaster recovery planning guide",
      url: "https://docs.cloud.google.com/architecture/dr-scenarios-planning-guide",
      source: "Google Cloud Documentation",
      why: "Introduces RTO and RPO, the two numbers that define how bad a regional outage is allowed to be for a given architecture — the yardstick this lesson grades against.",
      minutes: 15,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE Book",
      why: "Uses a real incident where traffic surging out of one region toward others nearly took down the whole service, showing how a regional failure can cascade if capacity isn't planned for it.",
      minutes: 25,
    },
    {
      title: "Cloudflare Load Balancing",
      url: "https://developers.cloudflare.com/load-balancing/",
      source: "Cloudflare Documentation",
      why: "Describes automatic failover to a healthy endpoint when one becomes unresponsive — the traffic-steering mechanism a region-outage response depends on.",
      minutes: 8,
    },
  ],
};
