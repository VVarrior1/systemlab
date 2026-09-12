import type { Reading } from "../types";

/** Curated by the v2.1 readings agent. Every URL below was fetched and verified (no login/paywall, content matches). */
export const readings: Record<string, Reading[]> = {
  "at-least-once-delivery": [
    {
      title: "Amazon SQS visibility timeout",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      source: "AWS SQS docs",
      why: "Shows exactly why a slow or crashed consumer causes SQS to redeliver a message it already received.",
      minutes: 8,
    },
    {
      title: "Kafka delivery semantics",
      url: "https://docs.confluent.io/kafka/design/delivery-semantics.html",
      source: "Confluent (Kafka) docs",
      why: "Lays out at-most-once, at-least-once, and exactly-once as a spectrum of offset-commit timing tradeoffs.",
      minutes: 6,
    },
    {
      title: "Designing Data-Intensive Applications, Ch. 11: Stream Processing (message delivery guarantees)",
      url: "https://dataintensive.net/",
      source: "Kleppmann, DDIA",
      why: "Explains why at-least-once plus idempotent consumers is the practical way to approximate exactly-once.",
      minutes: 10,
    },
  ],
  "dead-letter-queue": [
    {
      title: "Using dead-letter queues in Amazon SQS",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html",
      source: "AWS SQS docs",
      why: "Defines maxReceiveCount and the redrive policy that moves a poison message out of the main queue.",
      minutes: 7,
    },
    {
      title: "Amazon SQS visibility timeout (interaction with DLQs)",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      source: "AWS SQS docs",
      why: "Connects repeated visibility-timeout expiry to the retry count that eventually triggers dead-lettering.",
      minutes: 5,
    },
  ],
  "quorum-reads-and-writes": [
    {
      title: "Dynamo: Amazon's Highly Available Key-value Store",
      url: "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf",
      source: "Amazon (SOSP 2007 paper)",
      why: "Original source for the N/R/W quorum parameters and the sloppy-quorum tradeoffs this lesson models.",
      minutes: 25,
    },
    {
      title: "Cassandra architecture: tunable consistency",
      url: "https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html",
      source: "Apache Cassandra docs",
      why: "Shows the R + W > N rule for avoiding stale reads in a real, currently-maintained quorum system.",
      minutes: 8,
    },
  ],
  "lost-writes-on-failover": [
    {
      title: "PostgreSQL: Synchronous Replication",
      url: "https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION",
      source: "PostgreSQL docs",
      why: "Explains how waiting for standby acknowledgment before commit is what actually prevents lost writes.",
      minutes: 8,
    },
    {
      title: "Jepsen: MongoDB 3.6.4",
      url: "https://jepsen.io/analyses/mongodb-3-6-4",
      source: "Jepsen analysis",
      why: "Documents acknowledged writes below majority concern getting rolled back after a real leader election.",
      minutes: 15,
    },
  ],
  "gray-failure": [
    {
      title: "Gray Failure: The Achilles' Heel of Cloud-Scale Systems",
      url: "https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/paper-1.pdf",
      source: "Microsoft Research (HotOS 2017)",
      why: "Coins gray failure and explains why partial, hard-to-observe degradation is worse than a clean crash.",
      minutes: 15,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE Book",
      why: "Walks through how one slow or flapping dependency can starve upstream servers and cascade outward.",
      minutes: 12,
    },
  ],
  "connection-pool-starvation": [
    {
      title: "About Pool Sizing",
      url: "https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing",
      source: "HikariCP wiki",
      why: "Argues a small saturated pool with a request queue behaves better than an oversized one under load.",
      minutes: 10,
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      source: "Google SRE Book",
      why: "Describes the same starvation mechanic at the fleet level: a slow backend exhausting caller resources.",
      minutes: 12,
    },
  ],
  "transactions-and-sagas": [
    {
      title: "Pattern: Saga",
      url: "https://microservices.io/patterns/data/saga.html",
      source: "microservices.io",
      why: "Defines the local-transactions-plus-compensating-actions structure this lesson's saga engine implements.",
      minutes: 10,
    },
    {
      title: "Sagas",
      url: "https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf",
      source: "Garcia-Molina & Salem (1987 paper)",
      why: "The original paper proposing sagas as a way to break long transactions into compensatable steps.",
      minutes: 20,
    },
  ],
  "stream-processing-and-search": [
    {
      title: "Kafka Streams (Confluent Platform docs)",
      url: "https://docs.confluent.io/platform/current/streams/index.html",
      source: "Confluent (Kafka) docs",
      why: "Overview of building continuous stream-processing applications directly on top of Kafka topics.",
      minutes: 8,
    },
    {
      title: "The Inverted Index",
      url: "https://www.elastic.co/guide/en/elasticsearch/guide/current/inverted-index.html",
      source: "Elasticsearch: The Definitive Guide",
      why: "Explains the term-to-document mapping that makes full-text search fast instead of scanning every row.",
      minutes: 7,
    },
  ],
};
