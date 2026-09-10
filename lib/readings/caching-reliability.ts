import type { Reading } from "../types";

export const readings: Record<string, Reading[]> = {
  "hot-keys": [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "Amazon Builders' Library",
      why: "Explains hot-key throttling directly — why a single popular key can overload one cache shard even while the cluster's average load looks fine.",
      minutes: 14,
    },
    {
      title: "Best practices for designing and using partition keys effectively in DynamoDB",
      url: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html",
      source: "AWS Documentation",
      why: "Shows the mechanics of key skew from the storage side — how uneven access to a small set of keys creates a hot partition and what per-partition throughput limits mean for sizing.",
      minutes: 8,
    },
  ],
  "cold-start-and-stampede": [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "Amazon Builders' Library",
      why: "Describes the thundering-herd problem that follows a cache flush or mass expiry and how request coalescing fixes it.",
      minutes: 14,
    },
    {
      title: "proxy_cache_lock (ngx_http_proxy_module)",
      url: "https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_lock",
      source: "nginx documentation",
      why: "Shows a concrete, production mechanism for coalescing — only one request repopulates a missing cache entry while the rest wait, which is exactly the fix this lesson asks for.",
      minutes: 4,
    },
  ],
  "ttl-and-staleness": [
    {
      title: "HTTP caching",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching",
      source: "MDN Web Docs",
      why: "Defines freshness vs staleness and how max-age/TTL controls the tradeoff between hit rate and serving outdated data.",
      minutes: 12,
    },
    {
      title: "EXPIRE",
      url: "https://redis.io/docs/latest/commands/expire/",
      source: "Redis documentation",
      why: "Shows how TTLs are actually enforced (passive vs active expiry) so a shorter TTL's cost in hit rate is grounded in a real implementation, not just theory.",
      minutes: 6,
    },
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "Amazon Builders' Library",
      why: "Walks through soft vs hard TTL expiration strategies and the operational reasoning for picking a staleness budget.",
      minutes: 14,
    },
  ],
  "edge-caching": [
    {
      title: "Default cache behavior",
      url: "https://developers.cloudflare.com/cache/concepts/default-cache-behavior/",
      source: "Cloudflare documentation",
      why: "Explains how a CDN edge decides what and how long to cache, which is the exact mechanism this lesson's edge nodes model for remote readers.",
      minutes: 8,
    },
    {
      title: "HTTP caching",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching",
      source: "MDN Web Docs",
      why: "Grounds the CDN behavior in the underlying Cache-Control headers that origins use to tell edge nodes how long a response is good for.",
      minutes: 12,
    },
  ],
  "lose-a-server": [
    {
      title: "Health checking",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking",
      source: "Envoy documentation",
      why: "Shows how a load balancer actively probes upstream hosts and pulls a failed one out of rotation, the mechanism this lesson's health-check interval models.",
      minutes: 7,
    },
    {
      title: "Health checks for Application Load Balancer target groups",
      url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
      source: "AWS Documentation",
      why: "Gives concrete interval and threshold settings, making tangible how many seconds pass — and how many requests get dropped — before a dead server is actually removed.",
      minutes: 6,
    },
  ],
  "protect-the-database": [
    {
      title: "Chapter 26. High Availability, Load Balancing, and Replication",
      url: "https://www.postgresql.org/docs/current/high-availability.html",
      source: "PostgreSQL documentation",
      why: "Covers primary/standby replication and failover directly, the architecture this lesson asks you to build to protect the database.",
      minutes: 15,
    },
    {
      title: "Managing Critical State: Distributed Consensus for Reliability",
      url: "https://sre.google/sre-book/managing-critical-state/",
      source: "Google SRE Book",
      why: "Explains why naive 'promote the standby when the primary looks dead' failover is dangerous and what a sound leader-election scheme needs instead.",
      minutes: 18,
    },
  ],
  "detection-delay": [
    {
      title: "Outlier detection",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier",
      source: "Envoy documentation",
      why: "Shows how passive detection (ejecting hosts on consecutive errors) trades off against statistical detection over an interval, which is the detection-delay knob this lesson tunes.",
      minutes: 7,
    },
    {
      title: "Health checks for Application Load Balancer target groups",
      url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
      source: "AWS Documentation",
      why: "Makes the detection-delay math concrete: interval × unhealthy-threshold is literally how long traffic keeps flowing to a dead target before it's pulled.",
      minutes: 6,
    },
  ],
  "retry-storm": [
    {
      title: "Exponential Backoff And Jitter",
      url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
      source: "AWS Architecture Blog (Marc Brooker)",
      why: "Shows with measured data why plain exponential backoff still synchronizes retries into a storm, and why adding jitter is what actually spreads the load out.",
      minutes: 9,
    },
    {
      title: "Chapter 21: Handling Overload",
      url: "https://sre.google/sre-book/handling-overload/",
      source: "Google SRE Book",
      why: "Explains retry budgets and per-client retry ratios as the guardrail that stops a wave of retries from amplifying an outage into a bigger one.",
      minutes: 16,
    },
  ],
  "circuit-breaker": [
    {
      title: "CircuitBreaker",
      url: "https://martinfowler.com/bliki/CircuitBreaker.html",
      source: "martinfowler.com",
      why: "The canonical explanation of the closed/open/half-open state machine this lesson's circuitBreaker flag implements.",
      minutes: 8,
    },
    {
      title: "Circuit breaking",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
      source: "Envoy documentation",
      why: "Shows circuit breaking enforced as infrastructure-level limits rather than app code, reinforcing why failing fast protects the callee and not just the caller.",
      minutes: 6,
    },
  ],
  "cascading-failure": [
    {
      title: "Chapter 22 - Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE Book",
      why: "Directly names this lesson's failure mode: how one slow or overloaded dependency triggers positive feedback that takes down the rest of the system, and how to stop it.",
      minutes: 20,
    },
    {
      title: "The Tail at Scale",
      url: "https://research.google/pubs/the-tail-at-scale/",
      source: "Communications of the ACM (Dean & Barroso)",
      why: "Explains why a fan-out to several dependencies amplifies one slow one into a whole-request slowdown, the exact shape of this lesson's architecture.",
      minutes: 15,
    },
  ],
  "launch-day": [
    {
      title: "Preparing Shopify for Black Friday and Cyber Monday",
      url: "https://shopify.engineering/preparing-shopify-for-black-friday-cyber-monday",
      source: "Shopify Engineering",
      why: "A real capstone-style account of load-testing, fault injection, and freezes used to get a whole system ready for a single predictable traffic spike.",
      minutes: 10,
    },
    {
      title: "Chapter 21: Handling Overload",
      url: "https://sre.google/sre-book/handling-overload/",
      source: "Google SRE Book",
      why: "Ties together the capstone's pieces — throttling, load shedding, retry budgets — into one coherent policy for staying up when demand exceeds capacity.",
      minutes: 16,
    },
    {
      title: "The Tail at Scale",
      url: "https://research.google/pubs/the-tail-at-scale/",
      source: "Communications of the ACM (Dean & Barroso)",
      why: "Explains why a system that is merely 'up' on launch day can still feel broken if p99 latency blows out, motivating why the capstone checks tail latency, not just uptime.",
      minutes: 15,
    },
  ],
};
