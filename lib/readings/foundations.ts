import type { Reading } from "../types";

export const readings: Record<string, Reading[]> = {
  "first-request": [
    {
      title: "Latency Numbers Every Programmer Should Know",
      url: "https://colin-scott.github.io/personal_website/research/interactive_latency.html",
      source: "Interactive reference",
      why: "Gives you the raw magnitudes (memory vs disk vs network round trip) that make up the single request you just traced end to end.",
      minutes: 5,
    },
    {
      title: "How browsers work",
      url: "https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work",
      source: "MDN Web Docs",
      why: "Walks through DNS, TCP/TLS handshakes, and response parsing, the exact sequence of round trips hiding inside \"one request\" before your server even starts working.",
      minutes: 10,
    },
    {
      title: "Service Level Objectives",
      url: "https://sre.google/sre-book/service-level-objectives/",
      source: "Google SRE book, ch. 4",
      why: "Explains why you measure a request's latency as a distribution (percentiles) rather than a single number, the habit this lesson is meant to start.",
      minutes: 15,
    },
  ],

  "find-the-bottleneck": [
    {
      title: "The Utilization, Saturation, and Errors (USE) Method",
      url: "http://www.brendangregg.com/usemethod.html",
      source: "Brendan Gregg",
      why: "Gives the exact checklist (utilization, saturation, errors per resource) for finding which node in your architecture is the actual constraint before you spend money widening it.",
      minutes: 10,
    },
    {
      title: "Monitoring Distributed Systems",
      url: "https://sre.google/sre-book/monitoring-distributed-systems/",
      source: "Google SRE book, ch. 6",
      why: "Introduces the four golden signals (latency, traffic, errors, saturation), the metrics you'd instrument to see a bottleneck forming instead of guessing at it.",
      minutes: 15,
    },
  ],

  "share-the-load": [
    {
      title: "Load Balancing at the Frontend",
      url: "https://sre.google/sre-book/load-balancing-frontend/",
      source: "Google SRE book, ch. 19",
      why: "Covers how traffic gets distributed before it ever reaches a single server, the layer above the round-robin/least-connections choice this lesson exercises.",
      minutes: 15,
    },
    {
      title: "Load Balancing in the Datacenter",
      url: "https://sre.google/sre-book/load-balancing-datacenter/",
      source: "Google SRE book, ch. 20",
      why: "Explains why naive round robin underperforms when servers or requests are non-uniform, and what least-loaded balancing buys you instead.",
      minutes: 15,
    },
    {
      title: "HTTP Load Balancing",
      url: "https://nginx.org/en/docs/http/load_balancing.html",
      source: "nginx docs",
      why: "Shows the concrete algorithms (round robin, least connections, weighted) as real config, so you can map the lesson's abstract balancer to a tool you'd actually deploy.",
      minutes: 8,
    },
  ],

  "littles-law": [
    {
      title: "Little's Law",
      url: "https://en.wikipedia.org/wiki/Little%27s_law",
      source: "Wikipedia",
      why: "States the L = λW relationship precisely and explains why it holds regardless of arrival or service distribution, the identity this lesson asks you to predict with before measuring.",
      minutes: 8,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE book, ch. 22",
      why: "Shows Little's Law's dark side in practice: queued work in flight (L) keeps growing when arrival rate exceeds service rate, which is exactly how cascading overload starts.",
      minutes: 15,
    },
  ],

  "make-reads-cheaper": [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "AWS Builders' Library",
      why: "Explains when caching a read path actually helps (reusable, eventually-consistent data) and the operational risks you take on in exchange for lower read cost.",
      minutes: 20,
    },
    {
      title: "Scaling Memcache at Facebook",
      url: "https://research.facebook.com/publications/scaling-memcache-at-facebook/",
      source: "USENIX NSDI 2013 paper",
      why: "Shows a read-heavy system pushed to real scale by fronting the database with a cache, the same lever this lesson has you pull, at the size where the tradeoffs get serious.",
      minutes: 25,
    },
  ],

  "survive-the-spike": [
    {
      title: "Handling Overload",
      url: "https://sre.google/sre-book/handling-overload/",
      source: "Google SRE book, ch. 21",
      why: "Lays out what a well-provisioned backend should do when demand exceeds capacity (degrade, shed, throttle) rather than simply falling over, the goal of surviving a spike.",
      minutes: 15,
    },
    {
      title: "What is Amazon EC2 Auto Scaling?",
      url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html",
      source: "AWS docs",
      why: "Shows the real mechanism (min/max/desired capacity plus scaling policies) for the \"add capacity to meet the spike\" side of the tradeoff this lesson makes you weigh against shedding.",
      minutes: 10,
    },
  ],

  "spend-your-budget": [
    {
      title: "Embracing Risk",
      url: "https://sre.google/sre-book/embracing-risk/",
      source: "Google SRE book, ch. 3",
      why: "Introduces the error budget itself: reliability past your target is a cost, not a virtue, which is the framing this lesson wants you to apply to your own spend.",
      minutes: 15,
    },
    {
      title: "Service Level Objectives",
      url: "https://sre.google/sre-book/service-level-objectives/",
      source: "Google SRE book, ch. 4",
      why: "Shows how to pick the SLI/SLO that turns \"how much should I spend\" into a measurable target instead of a guess.",
      minutes: 15,
    },
  ],

  "the-tail-at-scale": [
    {
      title: "The Tail at Scale",
      url: "https://research.google/pubs/the-tail-at-scale/",
      source: "Dean & Barroso, Communications of the ACM (2013)",
      why: "The source of the phenomenon this lesson simulates: fanning out to many services means your overall latency is dominated by the slowest one, and the paper gives the techniques to tame it.",
      minutes: 20,
    },
    {
      title: "Exponential Backoff and Jitter",
      url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
      source: "AWS Architecture blog (Marc Brooker)",
      why: "Explains why naive retries synchronize and worsen tail latency, and how jittered backoff (one of this lesson's fixes) actually spreads the load out.",
      minutes: 10,
    },
    {
      title: "Latency Numbers Every Programmer Should Know",
      url: "https://colin-scott.github.io/personal_website/research/interactive_latency.html",
      source: "Interactive reference",
      why: "Gives the per-hop latency variance building blocks that, once combined across a parallel fan-out, produce the amplified p99 this lesson has you observe.",
      minutes: 5,
    },
  ],

  "flash-crowd": [
    {
      title: "Handling Overload",
      url: "https://sre.google/sre-book/handling-overload/",
      source: "Google SRE book, ch. 21",
      why: "Describes the exact choice a flash crowd forces: scale ahead of the burst or shed the excess deliberately, and how to keep accepted traffic healthy either way.",
      minutes: 15,
    },
    {
      title: "What is Amazon EC2 Auto Scaling?",
      url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html",
      source: "AWS docs",
      why: "Shows why capacity that reacts to demand still has a ramp-up lag, the reason a 6x burst that arrives in seconds outruns autoscaling and forces shedding.",
      minutes: 10,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE book, ch. 22",
      why: "Explains how an unshed burst turns into a cascading failure through retries and queue buildup, the failure mode a flash crowd risks if you only ever add capacity.",
      minutes: 15,
    },
  ],

  "jobs-in-the-queue": [
    {
      title: "Introduction to Kafka",
      url: "https://kafka.apache.org/intro",
      source: "Apache Kafka docs",
      why: "Explains why decoupling producers from consumers through a durable log lets each side scale and fail independently, the core idea behind putting jobs in a queue.",
      minutes: 12,
    },
    {
      title: "Work Queues",
      url: "https://www.rabbitmq.com/tutorials/tutorial-two-python.html",
      source: "RabbitMQ tutorials",
      why: "Shows round-robin dispatch and acknowledgment concretely: how multiple workers pull from one queue and what happens if a worker dies mid-job.",
      minutes: 12,
    },
  ],

  "drain-the-backlog": [
    {
      title: "Amazon SQS visibility timeout",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      source: "AWS docs",
      why: "Explains in-flight message limits and retry-via-timeout, the mechanics of why a backlog can stall even with idle workers if visibility timeouts are set wrong.",
      minutes: 10,
    },
    {
      title: "Work Queues",
      url: "https://www.rabbitmq.com/tutorials/tutorial-two-python.html",
      source: "RabbitMQ tutorials",
      why: "Shows fair dispatch (prefetch count) as the lever for draining a backlog faster without starving some workers while others sit idle.",
      minutes: 12,
    },
    {
      title: "Little's Law",
      url: "https://en.wikipedia.org/wiki/Little%27s_law",
      source: "Wikipedia",
      why: "Gives the relationship between backlog size, arrival rate, and drain time you need to estimate how long a given worker count takes to clear a queue.",
      minutes: 8,
    },
  ],

  "when-caches-cannot-help": [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      source: "AWS Builders' Library",
      why: "Names the cases where caching stops helping or actively hurts: non-reusable data, thundering herd on expiry, and services that become secretly dependent on their cache.",
      minutes: 20,
    },
    {
      title: "Scaling Memcache at Facebook",
      url: "https://research.facebook.com/publications/scaling-memcache-at-facebook/",
      source: "USENIX NSDI 2013 paper",
      why: "Documents write-heavy and consistency problems (stale data, invalidation races) that a cache in front of the database cannot solve on its own, exactly where this lesson's write-heavy workload defeats caching.",
      minutes: 25,
    },
  ],

  "bounded-queues": [
    {
      title: "Circuit breaking",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
      source: "Envoy proxy docs",
      why: "Shows pending-request and connection limits as real, configurable backpressure: what a bounded queue rejects and why that protects the requests it does accept.",
      minutes: 10,
    },
    {
      title: "Amazon SQS visibility timeout",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      source: "AWS docs",
      why: "Shows a concrete bound (in-flight message limit) and the OverLimit rejection it causes, the same shed-vs-accept tradeoff this lesson makes you tune with maxQueue.",
      minutes: 10,
    },
    {
      title: "Handling Overload",
      url: "https://sre.google/sre-book/handling-overload/",
      source: "Google SRE book, ch. 21",
      why: "Explains why rejecting requests fast at a bound keeps the requests you do accept fast, instead of letting an unbounded queue drag everyone's latency down together.",
      minutes: 15,
    },
  ],
};
