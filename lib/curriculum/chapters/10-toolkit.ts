import { chapterTitles, defense, rubric, written, type ChapterFile } from "../shared";

/**
 * Chapter 10 - Interview toolkit. Five written lessons: no simulation, no objectives.
 * Each one teaches the frameworks, numbers and named patterns a candidate is expected to
 * produce on demand, and sets a concrete exercise as its defense prompt.
 */
export const chapter: ChapterFile = {
  title: chapterTitles[9],
  lessons: [
    written({
      id: "framing-and-requirements",
      chapter: chapterTitles[9],
      title: "Frame before you draw",
      subtitle: "Turn a vague prompt into a contract you can design against.",
      difficulty: "Intermediate",
      minutes: 14,
      concept: "Requirements & SLOs",
      brief:
        "Your interviewer says 'design a system where restaurants publish menus and diners search them', then goes quiet and starts a forty-five minute timer. The candidates who fail here start drawing boxes in the first minute. The candidates who pass spend eight minutes turning that sentence into a written contract: what the system must do, how fast, for how many people, and what they are deliberately not building.",
      learning: [
        "Functional requirements say what the system does; non-functional requirements say how well it must do it. 'A diner can search menus by dish name' is functional. 'The 99th percentile search returns in under 300 ms for 50,000 concurrent diners, and stale results up to sixty seconds old are acceptable' is non-functional. Interviews are won on the second list, because it is the one that decides your components: a latency target buys you a cache, a durability target buys you replication, a consistency target decides whether reads may touch a follower. Write both lists on the board and keep them visible; every later tradeoff argument points back at them.",
        "Only a few clarifying questions actually change a design. The high-value six are the read/write ratio, the peak-to-average traffic factor, the latency objective and at which percentile, the consistency requirement (can a reader see stale data, and for how long), the data retention and size, and the geographic mix of users. Each one flips a specific decision: a 100:1 read ratio makes a cache and read replicas obvious, a 10x peak factor makes autoscaling or shedding obvious, a 'must read your own write' answer removes follower reads. Questions about team size, language or deployment tooling are polite noise and burn your clock.",
        "Convert scale words into numbers immediately, out loud. Ten million daily active users each performing five searches is 50 million requests per day; divided by roughly 100,000 seconds in a day that is about 600 requests per second average. Apply a peak factor - most consumer traffic peaks at two to five times the daily mean, event-driven traffic much more - and you are designing for 1,500 to 3,000 requests per second. Do the same for storage: writes per day times bytes per record times replication factor times retention. Numbers stop the conversation being about opinions and let you say 'this needs four shards' with a reason behind it.",
        "An SLO is a number with a window attached: 99.9% of search requests succeed in under 300 ms, measured over a rolling twenty-eight days. That phrasing gives you three things at once. It names the indicator you will measure (the SLI), it sets the target, and it implies an error budget - 99.9% availability allows roughly forty-three minutes of failure per month, which is the currency you spend on deploys, migrations and risky experiments. Interviewers listen for whether you pick a percentile rather than an average, because averages hide exactly the tail that makes users leave.",
        "Say what you are not building, and say it early. 'Out of scope: payment processing, restaurant onboarding, image moderation, and the recommendation ranking model - assume ranking is a scoring function we call.' Non-goals are not a way to dodge work; they are how you buy time to go deep on the one or two things the interviewer actually wants to see. They also protect you later: when someone asks about fraud detection at minute forty, you can point at your own list and say you consciously deferred it, which reads as judgment rather than as a gap.",
        "Budget the clock the way a staff engineer budgets a design review. Roughly: five to eight minutes framing requirements and scale, five minutes on the API surface and data model, five minutes on back-of-envelope estimates, ten minutes on the high-level architecture, ten to twelve minutes on one deep dive the interviewer chooses, and a few minutes on failure modes and what you would measure. If you are still asking clarifying questions at minute fifteen you have lost the deep dive, which is where the signal actually lives. Announce the plan out loud - it makes the rest of the session collaborative.",
        "The requirements list is also your defense weapon. Every design decision should be traceable to a line on it: 'I am adding a cache because the read ratio is 100:1 and the SLO is 300 ms at p99'; 'I am accepting eventual consistency for search because the requirement allows sixty seconds of staleness'; 'I am not sharding yet because 600 writes per second fits one primary with headroom.' When the interviewer pushes back, you are arguing about a requirement, not about taste. That is the difference between a candidate who sounds senior and one who sounds like they memorised an architecture diagram.",
        "What this framing idealizes: it assumes the requirements you are given are stable and honest. Real products discover their read/write ratio only after launch, peak factors get set by a marketing campaign nobody told you about, and the latency target is usually invented on the spot by whoever is loudest. The discipline still pays, because writing the assumption down makes it falsifiable - you will notice the day traffic stops matching it. Treat every number you were told as a hypothesis with a monitor attached, and design the seams so the shape can change without a rewrite.",
      ],
      defense: defense({
        prompt:
          "Exercise. Your prompt is: 'Design a system that lets restaurants publish menus and diners search them.' Write the framing you would give in the first eight minutes: three functional requirements, three non-functional requirements each carrying a number, the five clarifying questions you would ask with one line on what each answer would change in your design, and two things you are explicitly ruling out of scope. Finish with the average and peak request rate you would design for and the arithmetic that got you there.",
        followUps: [
          "Your interviewer answers the latency question with 'as fast as possible'. What number do you write down instead, at which percentile, and how do you defend picking it yourself?",
          "Ten minutes in you learn that diners search by location and that 30% of all searches land in a ninety-minute dinner window. Which requirement changes, and which part of your intended design does that invalidate?",
          "The interviewer says the search index may be up to an hour stale. Which requirement did that relax, what component does it let you delete, and what new failure becomes invisible to your users?",
        ],
        rubric: rubric([
          ["split", "Separates functional from non-functional requirements and attaches a number and a percentile to the non-functional ones", 25],
          ["questions", "Asks clarifying questions from the high-value set and states, per question, which design decision the answer flips", 25],
          ["arith", "Derives average and peak request rate from a stated user count and per-user action rate, showing the peak factor", 25],
          ["scope", "Names explicit non-goals and ties at least one design choice back to a specific requirement line", 25],
        ]),
        modelAnswer:
          "Functional: a restaurant publishes and edits a menu; a diner searches dishes by name and cuisine; a diner opens a restaurant page. Non-functional: search returns in under 300 ms at p99; 99.9% availability over twenty-eight days; menu edits may take up to sixty seconds to appear in search. Clarifying questions: read/write ratio (a 100:1 ratio justifies a cache and read replicas), peak factor (decides autoscaling versus shedding), latency percentile (decides whether a cross-region hop is affordable), staleness tolerance (decides follower reads versus read-your-writes), and data size plus retention (decides one primary versus shards). Out of scope: payments and image moderation. Scale: two million diners times five searches per day is ten million requests per day, over roughly 100,000 seconds that is about 120 per second average; a dinner-hour peak factor of four gives roughly 500 per second, which one replicated read path with a cache handles comfortably, so I would not shard storage yet.",
      }),
      reflection: {
        question: "An interviewer tells you the product needs 'high availability'. What is the most useful thing to write on the board next?",
        options: [
          "A specific availability target with a measurement window, plus the error budget it implies",
          "A list of the redundant components you will add, since redundancy is what availability means",
          "A note to revisit availability after the high-level design is drawn",
          "The multi-region deployment topology, because that is the strongest form of availability",
        ],
        answer: 0,
        explanation:
          "'High availability' is not a requirement until it is a number over a window. 99.9% monthly gives you about forty-three minutes of budget and probably one region; 99.99% gives you four minutes and forces multi-region failover and automated recovery. Choosing components before choosing the target means you cannot say whether you have over-built or under-built, and you have no error budget to spend on releases.",
      },
    }),

    written({
      id: "numbers-everyone-should-know",
      chapter: chapterTitles[9],
      title: "Numbers everyone should know",
      subtitle: "The latency ladder, capacity rules of thumb, and estimates you can do in your head.",
      difficulty: "Intermediate",
      minutes: 15,
      concept: "Back-of-envelope estimation",
      brief:
        "Halfway through a design an interviewer asks how many servers you need, how much the data will cost to keep for a year, and whether a cross-region read fits the latency budget. There is no laptop, no calculator, and no partial credit for 'it depends'. What separates a strong candidate here is a small table of memorised numbers and the willingness to round hard and reason out loud.",
      learning: [
        "Memorise the latency ladder, because every architecture argument is really about which rungs a request touches. An L1 cache reference is about one nanosecond, a main-memory reference about 100 nanoseconds, a random SSD read tens of microseconds, a spinning-disk seek a few milliseconds, a round trip inside one datacentre about half a millisecond, and a round trip between continents 70 to 150 milliseconds. The gaps are orders of magnitude, not percentages. That is why moving a read from disk to memory can be a thousand-fold win and why one accidental cross-region hop can eat a 300 ms budget on its own.",
        "Carry rough capacity numbers for the components you will draw. A simple stateless service doing light work handles low thousands of requests per second per modern machine; anything doing JSON parsing, auth and a couple of dependency calls is more like several hundred to a couple of thousand. A single relational primary comfortably takes hundreds to low thousands of writes per second before you think about sharding, while an in-memory store like Redis handles a hundred thousand simple operations per second. These are deliberately fuzzy, and that is fine: you only need to be right to within a factor of two to decide whether a design needs one node or fifty.",
        "Request-rate math is always the same shape: daily active users times actions per user per day, divided by seconds in a day, then multiplied by a peak factor. Round 86,400 seconds to 100,000 and the division becomes trivial - one million requests per day is about ten per second, one billion per day is about ten thousand per second. Peak factors are two to five for consumer traffic with a daily rhythm, and ten or more for anything event-driven like a ticket drop. Always design capacity against the peak, then say out loud what you assumed, so the interviewer can correct the assumption rather than the arithmetic.",
        "Storage math is writes per day times bytes per record times retention days times replication factor. Keep a few sizes in your head: a UUID is 16 bytes, a timestamp 8, a short text post a few hundred bytes, a compressed metrics sample a handful of bytes, a phone photo one to three megabytes, a minute of 1080p video 50 to 100 megabytes. Then remember the unit ladder - a thousand kilobytes is a megabyte, a thousand megabytes a gigabyte, and so on - so ten million posts per day at 300 bytes is three gigabytes per day, about a terabyte a year, which is small enough that you should say so and move on.",
        "Bandwidth is request rate times payload size, and it is the number candidates forget. Ten thousand image reads per second at 200 KB each is two gigabytes per second, which is 16 gigabits - more than a single machine's network interface, so the answer must involve a CDN, not a bigger server. Doing this calculation early often kills a design before you have wasted ten minutes on it, and it is the natural place to introduce edge caching. The same arithmetic tells you what egress will cost, which is frequently the largest line on a real cloud bill.",
        "Little's law ties rate to latency: the number of requests in flight equals arrival rate times the time each one spends in the system. Five hundred requests per second each taking 200 ms means a hundred concurrent requests, which sizes your connection pool, your thread count and your queue. Run it backwards to catch nonsense: if a component can only hold fifty in flight and you are sending five hundred per second, average latency cannot exceed 100 ms without a growing backlog. This one relationship explains most queueing surprises, and it is the fastest sanity check available mid-interview.",
        "Round aggressively and say your rounding out loud. Powers of ten beat precision: call a year 30 million seconds, call a day 100,000, call 1,024 a thousand. The interviewer is grading whether you know that a number is in the hundreds rather than the millions, not whether you can do long division under stress. Say 'call it 500 per second, and I am rounding up because I would rather over-provision than melt' - that sentence shows both the estimate and the engineering judgement behind it, and it invites a correction instead of an interrogation.",
        "Practise until this is muscle memory, then keep practising, because estimation decays fast. This app ships a drill trainer at /gym with seeded exercises for exactly these skills: peak QPS from daily active users, storage per year, bandwidth from payload size, servers needed with headroom, cache sizing for a hot key subset, Little's law, shard counts from write rate, and a multiple-choice latency-ladder quiz. Ten minutes there before a real interview is worth more than another hour of reading architecture diagrams, because the numbers are what you will be asked to produce without warning.",
      ],
      defense: defense({
        prompt:
          "Exercise. A photo-sharing product has 20 million daily active users. Each opens the app three times a day and sees 30 photos per session; 2% of sessions upload one photo averaging 1.5 MB. Estimate, showing every step: average and peak read requests per second, average upload writes per second, egress bandwidth at peak, new storage per year including a replication factor you choose, and how many application servers you would provision. State every assumption and every rounding, and end with the one number you are least confident in and how you would check it.",
        followUps: [
          "Your bandwidth estimate came out larger than a single machine's network interface. Which component does that force into the design, and which of your other estimates does adding it change?",
          "The interviewer says your storage estimate is off by an order of magnitude. Walk through where an order of magnitude can hide in this calculation, and which term you would re-derive first.",
          "You sized servers from average load. What happens on the day the peak factor is ten instead of four, and what would you have measured beforehand to know?",
        ],
        rubric: rubric([
          ["chain", "Derives peak QPS from daily active users through a stated actions-per-day and peak factor, with the arithmetic visible", 25],
          ["bytes", "Computes bandwidth and yearly storage from payload size, retention and a stated replication factor", 25],
          ["capacity", "Turns request rate into a server count using a per-server throughput assumption plus explicit headroom", 25],
          ["judgement", "States assumptions and roundings out loud and names the least reliable number with a way to verify it", 25],
        ]),
        modelAnswer:
          "Reads: 20 million users times three sessions is 60 million sessions per day, times 30 photos is 1.8 billion photo reads per day. Divide by roughly 100,000 seconds: about 18,000 reads per second average. A peak factor of four gives roughly 72,000 per second. Uploads: 2% of 60 million sessions is 1.2 million per day, about 12 per second average and maybe 50 at peak - trivial for one primary, so no write sharding yet. Bandwidth at peak: 72,000 reads times 1.5 MB is far beyond any origin fleet, so photo bytes must be served from a CDN and object storage; only metadata hits my servers. Storage: 1.2 million uploads times 1.5 MB is 1.8 TB per day, about 650 TB per year, times three-way replication is roughly two petabytes. Servers: 72,000 metadata requests per second at 2,000 per server is 36 machines, provisioned at 50 for headroom. Least confident number: photos viewed per session, which I would check against real session analytics.",
      }),
      reflection: {
        question: "A read that currently hits an SSD is moved into an in-memory cache. Roughly what order of improvement should you claim for that single hop?",
        options: [
          "About two orders of magnitude, from tens of microseconds to hundreds of nanoseconds",
          "About 20-30%, since both are fast solid-state paths",
          "About four orders of magnitude, the same as replacing a disk seek with memory",
          "No latency improvement; the win is purely in throughput and cost",
        ],
        answer: 0,
        explanation:
          "A main-memory reference is around 100 nanoseconds and a random SSD read is tens of microseconds, so the hop itself improves by roughly a hundredfold. Disk seeks are milliseconds, which is where the four-orders-of-magnitude story comes from - claiming it for SSD overstates the win. And the improvement is real latency, not just throughput, which is exactly why caches move the p99 and not only the cost line.",
      },
    }),

    written({
      id: "api-design-and-idempotency",
      chapter: chapterTitles[9],
      title: "APIs that survive retries",
      subtitle: "Resources, pagination, versioning, and making a repeated call safe.",
      difficulty: "Intermediate",
      minutes: 14,
      concept: "API contracts & idempotency",
      brief:
        "A mobile client submits a payment, the response times out at the gateway, and the phone retries twice on a flaky train connection. Your API either charged the customer once or three times, and which one it did was decided months earlier by whoever designed the endpoint. Interviewers ask for an API sketch because it is the fastest way to find out whether you think about failure at the contract level or only at the diagram level.",
      learning: [
        "Pick a style and justify it in one sentence. REST over HTTP models nouns and uses the verb set the network already understands, which makes caching, proxies and retries behave predictably - the right default for public and cross-team APIs. RPC styles like gRPC model verbs directly, carry a typed schema and are cheaper on the wire, which suits chatty internal service-to-service calls. GraphQL lets a client fetch exactly the fields it wants in one round trip, which pays off for rich mobile screens and costs you query-complexity limits and cache difficulty. Interviewers care far less which you choose than whether you name the tradeoff you accepted.",
        "Model resources, not procedures. A collection endpoint and an item endpoint - /orders and /orders/{id} - with GET, POST, PATCH and DELETE will cover most of a design, and nesting should stop at one level so that /restaurants/{id}/menus stays readable while deeper hierarchies get flattened into query parameters. Use plural nouns, keep identifiers opaque, and return the created resource with its identifier on POST. The payoff is that the semantics of each verb are already agreed: GET and PUT and DELETE are idempotent by definition, POST is not, and every caching layer between you and the client already knows that.",
        "Offset pagination is the trap. LIMIT 20 OFFSET 100000 makes the database walk and discard a hundred thousand rows, and if an item is inserted between two page fetches the client silently sees a duplicate or misses a row. Cursor pagination - also called keyset or seek pagination - passes an opaque cursor encoding the last sort key seen, so the query becomes a range scan on an index and stays constant-cost at any depth. Return the cursor and a boolean for more pages rather than a total count, since counting is often the most expensive part of the request. Say the words 'stable sort key' out loud; that is what makes the cursor correct.",
        "Version so that you can change your mind. Additive changes - a new optional field, a new endpoint - do not need a version at all if clients are built to ignore unknown fields, and that tolerance is worth stating as a rule in the contract. Breaking changes need an explicit version, either as a path prefix like /v2 or as a media-type or header negotiation; the path is uglier and far easier to route, log and debug. Whichever you pick, the design that matters is the deprecation process: publish a sunset date, measure traffic per version so you know who is still on the old one, and never break a version silently.",
        "Idempotency is the property that making the same call twice has the same effect as making it once. GET, PUT and DELETE get it for free from their semantics. POST does not, so for anything that moves money or books a seat, the client generates a unique idempotency key - a UUID per logical operation, not per attempt - and sends it in a header. The server stores the key with the outcome: on a repeat it returns the original stored response instead of executing again. Store a fingerprint of the request body alongside the key and reject a reused key that carries different parameters, otherwise the mechanism becomes a way to corrupt data rather than protect it.",
        "The implementation details are where the follow-ups land. Write the key and the in-progress marker in the same transaction as the effect, so a crash between charging and recording cannot lose the record; a second call arriving while the first is still running should wait or return a conflict rather than proceeding. Keep keys for at least as long as clients might retry - twenty-four hours is a common choice - and expire them after that so the table stays bounded. Scope keys per API caller so two tenants cannot collide. Named pattern to cite: this is exactly how Stripe's idempotent requests work.",
        "Retries only become safe when the client behaves too. Retry with exponential backoff and full jitter, never in a tight loop, and cap the total attempts with a retry budget so a struggling dependency does not get a synchronised stampede from every client at once. Retry only idempotent operations or ones carrying an idempotency key, and only on the status codes that indicate a transient condition. Always pair a retry with a timeout - a retry without a timeout is just a slower failure - and surface Retry-After on 429 and 503 so a well-behaved client knows exactly how long to wait.",
        "What this idealizes: the contract assumes clients read your documentation and that a key really is unique per operation. In practice mobile clients regenerate keys after a reinstall, third-party integrators hardcode page sizes, and someone will eventually retry a non-idempotent endpoint by hand. Design defensively - validate, bound page sizes, rate limit per key, and return errors specific enough to debug from a log line. And remember that an idempotency key protects one service's own effect; end-to-end exactly-once across several services still needs each hop to be independently safe.",
      ],
      defense: defense({
        prompt:
          "Exercise. Design the public API for a feature where a user reserves a seat on a specific bus departure and pays for it. Write the endpoints with verbs and paths, the request and response shape for the reservation call, how a client pages through the departures list, how you version the API, and precisely how a client retrying a timed-out reservation avoids double-booking and double-charging. Include what the server stores, when it stores it, and what it returns on the second and third attempt.",
        followUps: [
          "The client's network drops after the server has charged the card but before the response is written. Walk through what the retry sees, step by step, and name the exact moment your design becomes safe.",
          "A partner integrator reuses one idempotency key for every request they ever send. What does your API do, and what would you have to add to detect this before it corrupts a booking?",
          "Product now wants clients to page through departures sorted by price rather than departure time. What breaks in your pagination scheme, and what do you change?",
        ],
        rubric: rubric([
          ["shape", "Presents resource-oriented endpoints with correct verb semantics and a concrete request/response body", 25],
          ["idempotency", "Specifies client-generated idempotency keys, server-side storage of the outcome, and the replayed response on retry", 30],
          ["retry", "Pairs retries with timeouts, exponential backoff with jitter, and a bounded attempt budget", 20],
          ["paging", "Chooses cursor pagination over offset and explains the stable sort key and the cost difference", 25],
        ]),
        modelAnswer:
          "GET /v1/departures?route=42&cursor=...&limit=50 returns departures plus an opaque cursor encoding the last (departure_time, id) pair, so paging is an index range scan and inserts cannot shift a page. POST /v1/reservations creates a booking; the body carries departure_id, seat, and payment token, and the client sends Idempotency-Key: a UUID generated once per logical booking and reused across attempts. The server writes the key, a fingerprint of the body, and an in-progress marker in the same transaction that reserves the seat, then records the response against the key. A retry with the same key returns the stored response verbatim; a retry arriving while the first is still running gets 409 rather than a second charge; a reused key with a different body gets 422. Keys are scoped per API client and expire after twenty-four hours. Clients retry only on 429, 502, 503 and timeouts, with exponential backoff plus full jitter, at most three attempts, each with a two-second timeout, honouring Retry-After.",
      }),
      reflection: {
        question: "A client retries a POST after a timeout and sends a fresh idempotency key on each attempt. What is the consequence?",
        options: [
          "The protection is defeated: each attempt is a distinct operation, so the effect can happen more than once",
          "Nothing changes, because the server deduplicates on the request body anyway",
          "The server will reject the retries with a conflict, so the operation is still safe",
          "It is safer, because a fresh key avoids collisions between different callers",
        ],
        answer: 0,
        explanation:
          "The key must identify the logical operation, not the attempt. Generating a new UUID per attempt makes every retry look like a brand-new booking, so the customer gets charged twice. Servers do not deduplicate on body content by default - a body fingerprint is stored to detect key misuse, not to detect duplicate operations - and per-caller scoping, not per-attempt uniqueness, is what prevents collisions between tenants.",
      },
    }),

    written({
      id: "storage-engines-and-indexing",
      chapter: chapterTitles[9],
      title: "Pick the right store",
      subtitle: "B-trees, LSM trees, indexes, and matching an engine to a workload.",
      difficulty: "Intermediate",
      minutes: 16,
      concept: "Storage engines & indexes",
      brief:
        "Three teams ask you the same week which database to use: one ingests 200,000 sensor samples per second, one runs a checkout flow with strict invariants and complex joins, and one serves a user profile lookup by primary key at very high read volume. Answering 'Postgres' or 'just use Dynamo' to all three is the fastest way to fail a design interview. The answer comes from how the engine underneath writes bytes to disk.",
      learning: [
        "A B-tree keeps sorted pages of fixed size and updates them in place. A lookup walks from the root down a shallow tree - typically three or four levels even for large tables - so a point read is a handful of page reads and a range scan follows sibling pointers cheaply. The cost lands on writes: changing one row rewrites a whole page, a page split can cascade, and every change is first written to a write-ahead log for crash safety, so one logical update reaches disk more than once. B-trees are what relational engines like PostgreSQL, MySQL/InnoDB and SQL Server use, and they excel when reads dominate and you need range scans and transactions.",
        "An LSM tree never updates in place. Writes go to a write-ahead log and an in-memory memtable, which is flushed as an immutable sorted file when it fills, and background compaction merges those files into fewer, larger ones. Sequential writes make ingestion very fast, which is why RocksDB, Cassandra, HBase and ScyllaDB are built this way. The costs are read amplification - a key may live in several files, so lookups consult a bloom filter per file to skip most of them - and compaction, which consumes disk bandwidth and CPU in bursts and can make the tail latency of an otherwise healthy system spike.",
        "Reason about the three amplification factors explicitly, because they are the interviewer's follow-up. Write amplification is bytes actually written to disk per logical byte: modest for a B-tree at low write rates, and often ten to thirty for a compaction-heavy LSM. Read amplification is disk reads per logical read: small and predictable for a B-tree, larger for an LSM unless bloom filters and caching absorb it. Space amplification is disk used per logical byte: B-trees waste space through partly filled pages, LSMs through obsolete versions awaiting compaction. Choosing an engine is choosing which of those three you can most afford.",
        "An index is a second data structure that makes a query fast and every write slower. The primary or clustered index determines how rows are physically laid out - in InnoDB the table is the primary key index - so choosing that key decides your locality. A secondary index maps a column to primary keys, costing an extra lookup unless the index covers every column the query needs, at which point the query never touches the table at all. The rule to state out loud: each additional index adds a write per insert and update, so indexes are paid for by the write path and earn their money only on queries you actually run.",
        "Composite index order is not cosmetic. An index on (tenant_id, created_at) serves a query filtered by tenant and sorted by time, and it serves a query filtered by tenant alone, but it cannot serve one filtered only by created_at - the leftmost-prefix rule. Get that ordering right and a sort disappears; get it wrong and the planner falls back to a full scan and you add a redundant second index that slows every write. This is also the moment to mention selectivity: an index on a column with three distinct values rarely beats a scan, which is why boolean flags are usually a poor index and a poor shard key.",
        "In a partitioned store, secondary indexes force a choice. A local index lives inside each partition and covers only that partition's rows: writes stay local and cheap, but a query that does not name the partition key must fan out to every partition and merge - fine for a handful of shards, painful at a hundred. A global index is partitioned by the indexed attribute itself, so reads hit one place, but a write now touches two partitions and can only be made consistent asynchronously. DynamoDB's local and global secondary indexes are the canonical example, and naming that tradeoff is exactly the depth interviewers look for.",
        "Map the families to workloads before you name a product. Relational engines for complex invariants, joins and transactions. Wide-column LSM stores for very high write volume with known access paths. Key-value stores, in memory or on flash, for point lookups at extreme read rates. Document stores where the aggregate is the unit of access and the schema moves. Search engines with inverted indexes for full-text relevance. Time-series stores for append-only, timestamp-keyed data with rollups and retention. Object storage for blobs, always fronted by a CDN. Most real systems combine three of these, with one designated the source of truth.",
        "What this idealizes: modern engines blur the lines. PostgreSQL will happily ingest a lot with the right configuration, several distributed SQL systems run relational semantics on top of an LSM, and managed services hide the compaction tuning that dominates real operations. Data size, working-set-to-memory ratio and access-pattern skew usually matter more than the engine label - a workload that fits in RAM makes the engine choice nearly irrelevant. So state the workload first, then the engine, then the one operational cost you are accepting, and you will be right more often than a candidate who has memorised a product list.",
      ],
      defense: defense({
        prompt:
          "Exercise. Choose a storage engine for each of these three workloads and defend each choice in a short paragraph: (a) 200,000 sensor samples per second, append-only, queried as time ranges per device and kept for one year; (b) a checkout flow with inventory invariants, multi-table joins and strict transactional correctness at a few hundred writes per second; (c) a user-profile lookup by primary key at 150,000 reads per second with a small record size. For each, name the engine family and one concrete product, the index or key design, the amplification cost you are accepting, and the workload that would make you change your mind.",
        followUps: [
          "Workload (a) now needs an ad-hoc query by sensor firmware version across all devices. What does that cost with your key design, and what would you add rather than re-modelling the table?",
          "Workload (b) grows to 20,000 writes per second. Which part of your engine choice breaks first, and what do you change before reaching for a different database?",
          "Workload (c)'s working set stops fitting in memory. Which amplification factor starts to hurt, and how would you see it in your metrics before users do?",
        ],
        rubric: rubric([
          ["engine", "Names an engine family and product per workload and ties it to the write/read shape of that workload", 30],
          ["index", "Specifies the primary key or index design, including composite ordering or partition key, for each choice", 25],
          ["amp", "States the write, read or space amplification cost being accepted and why it is affordable here", 25],
          ["change", "Names the concrete change in workload that would invalidate each choice", 20],
        ]),
        modelAnswer:
          "(a) A time-series or wide-column LSM store - Cassandra or a purpose-built series database - keyed by (device_id, time_bucket) with the timestamp as the clustering column. Sequential writes and immutable segments absorb 200,000 samples per second; I accept write amplification from compaction and bursty tail latency, and I get cheap range scans per device plus retention by dropping whole segments. I would change my mind if queries became ad-hoc across devices rather than per-device time ranges. (b) A relational B-tree engine such as PostgreSQL: a few hundred writes per second is nothing, and the invariants, joins and transactions are the whole requirement. I accept in-place page writes and WAL amplification, and I index (customer_id, created_at) for order history. I would change my mind above roughly ten thousand writes per second per primary. (c) A key-value store, Redis or DynamoDB, on the primary key, with the relational store as source of truth. I accept eventual consistency and cache invalidation work in exchange for microsecond point reads. I would change my mind if the record needed multi-key transactions.",
      }),
      reflection: {
        question: "Why does adding a fourth secondary index to a high-write table usually hurt more than adding the first one did?",
        options: [
          "Every insert and update must now maintain one more index structure, so the write path pays for all four on every write",
          "Query planners degrade non-linearly once a table carries more than three indexes",
          "Secondary indexes are stored on the same pages as the table, so the fourth one causes page splits",
          "Bloom filters stop being effective beyond three indexes, so read amplification rises sharply",
        ],
        answer: 0,
        explanation:
          "Indexes are paid for on the write path: each one is a separate structure that must be updated whenever an indexed column changes, so the marginal cost of index number four is another write per row change plus its share of WAL and page churn. Planner behaviour, page layout and bloom filters are unrelated to the count in that way - the honest framing is that indexes are a read subsidy funded by the write path, so you keep only the ones a real query uses.",
      },
    }),

    written({
      id: "observability-and-slos",
      chapter: chapterTitles[9],
      title: "Know when it is broken",
      subtitle: "Golden signals, SLIs and error budgets, and alerts that page for the right reason.",
      difficulty: "Intermediate",
      minutes: 15,
      concept: "Observability & SLOs",
      brief:
        "Launch day: the design survived the spike, the dashboards are green, and support is filling up with users who cannot check out. Every metric you chose to display is about your servers, and none of them is about your users. The last five minutes of a system design interview are usually about this gap - what you would measure, what would page you at three in the morning, and what you would look at first when it does.",
      learning: [
        "Start from the four golden signals: latency, traffic, errors and saturation. Latency must be split by outcome, because a fast stream of 500s will otherwise make your latency graph look better as the system gets worse. Traffic is the demand number that gives every other graph context. Errors include the explicit ones, the wrong-answer ones and the ones hiding inside a 200 response. Saturation is how full the most constrained resource is - the queue, the connection pool, the disk - and it is the only one of the four that leads rather than lags. RED (rate, errors, duration) is the request-level restatement; USE (utilization, saturation, errors) is the resource-level one.",
        "An SLI is a ratio: good events over valid events, measured as close to the user as you can get. 'The proportion of checkout requests that return a success status in under 500 ms, measured at the load balancer' is an SLI. 'CPU below 70%' is not - it is a resource metric that may or may not correlate with anyone's experience. Measuring at the edge rather than inside a service is what catches the failures that never reach your code: DNS, TLS handshakes, a bad deploy that returns instantly with the wrong answer. If an SLI cannot go bad while users are happy, and cannot stay good while users are unhappy, it is a good one.",
        "The SLO is the target on that ratio over a window, and the error budget is what is left over. 99.9% over twenty-eight days allows about forty minutes of badness; 99.99% allows about four. That budget is a real currency: it is what you spend on risky deploys, migrations and load tests, and when it is exhausted the honest response is to stop shipping features and spend the next cycle on reliability. Setting the target slightly below what you actually achieve is deliberate - an SLO of 100% means every deploy is an incident, and it removes the freedom to take useful risks.",
        "Alert on symptoms, not on causes. A page should mean users are being harmed now or will be shortly; high CPU, a full disk on one node, or a single failed health check usually mean neither. The production-grade pattern is multiwindow, multi-burn-rate alerting: page when the budget is burning fast over a short window and is confirmed over a longer one - for example fourteen times the sustainable rate over one hour confirmed over five minutes - and open a ticket rather than a page for a slow burn over six hours or a day. The short window catches the outage, the long window suppresses the flap.",
        "Percentiles, not averages, and never average a percentile. A mean latency of 90 ms can hide a p99 of four seconds, and that p99 is where the users who leave live. Compute percentiles from histograms with fixed buckets so they can be aggregated correctly across instances and time; taking the mean of per-instance p99s is arithmetically meaningless and will quietly understate your tail. Publish p50 alongside p99 so you can tell a system that is uniformly slow from one that is fine for almost everyone and catastrophic for a few - those two have completely different causes and completely different fixes.",
        "Metrics tell you that something is wrong; traces tell you where. A distributed trace propagates a trace ID across every hop so one slow checkout can be decomposed into its gateway, service, cache and database spans, which is the only practical way to find latency in a fan-out. Sample intelligently - keep a small fraction of successful traces and as close to all of the slow and failed ones as you can afford - and attach exemplars so a spike on a latency histogram links directly to a trace that produced it. Logs stay the third pillar, but structured and correlated by trace ID, not free text.",
        "Watch cardinality, because it is what makes observability expensive. Every distinct combination of label values is a separate time series, so a label carrying user IDs or raw URLs can multiply your storage bill by thousands and slow every query. Keep labels to bounded sets - service, endpoint template, region, status class - and push the high-cardinality detail into traces and logs where it belongs. This is the operational reason the metrics pipeline in this course is write-heavy and shard-friendly: it is one of the few internal systems whose write volume rivals the product itself.",
        "What this idealizes: dashboards do not fix anything, and the graph you need is usually the one nobody built. Instrument the seams at design time - every dependency call, every queue depth, every shed request - because adding a metric during an incident is too late. Pair each alert with a runbook naming the first three checks, and rehearse it, since an alert nobody knows how to action is worse than no alert. And measure the shedding path deliberately: a system that rejects 20% of traffic to stay fast looks healthy on latency and is a genuine outage for a fifth of your users.",
      ],
      defense: defense({
        prompt:
          "Exercise. Take the launch-day system from chapter five - a load-balanced API behind a cache and a database, running through a traffic spike and a server failure under a cost cap. Define its observability plan: two SLIs with precise good-event and valid-event definitions and where each is measured, an SLO and error budget for each, the golden-signal dashboard you would build, exactly which conditions page a human versus open a ticket, and the first three things you would check when the page fires. Include one metric that would reveal deliberate shedding.",
        followUps: [
          "Your availability SLI is measured inside the application. Name two real outages that SLI would report as completely healthy, and where you would move the measurement.",
          "The page fires at three in the morning with latency at target but the error budget burning fast. What is the first graph you open, and what would each possible answer tell you to do?",
          "A product manager asks for a 99.99% SLO on every endpoint. Make the argument against it in terms of error budget, cost, and the shipping cadence they also want.",
        ],
        rubric: rubric([
          ["sli", "Defines SLIs as good-over-valid ratios with a stated measurement point close to the user", 25],
          ["budget", "Converts an SLO into a concrete error budget and says how that budget is spent", 25],
          ["alerting", "Alerts on user-visible symptoms with burn-rate thresholds and separates paging from ticketing", 25],
          ["debug", "Names the first diagnostic steps and includes saturation or shedding signals, not just latency and errors", 25],
        ]),
        modelAnswer:
          "SLI 1, availability: the proportion of HTTP requests to /checkout that return a non-5xx status, measured at the load balancer so failed deploys and dead backends are counted. SLI 2, latency: the proportion of those requests that complete in under 500 ms, from the same vantage point, computed from histogram buckets rather than averaged percentiles. SLO: 99.9% and 99% respectively over twenty-eight days, giving roughly forty minutes of availability budget per month, spent deliberately on deploys and load tests; when it is gone, feature work stops. Dashboard: request rate, error rate by class, p50/p95/p99 latency, plus saturation - queue depth, replica utilization, cache hit rate and rejected-request rate. Paging: budget burning at fourteen times the sustainable rate over one hour, confirmed over five minutes. Ticket: a six-hour slow burn or a single unhealthy replica. On a page I check traffic first for a spike, then rejected-request and queue-depth graphs to see whether we are shedding, then per-dependency latency to find the slow hop.",
      }),
      reflection: {
        question: "Your API sheds 20% of requests with a rate limiter to keep accepted requests fast. Latency and error-rate dashboards both look excellent. What does that tell you about the monitoring?",
        options: [
          "Rejected requests must be a first-class signal, because shedding is invisible to latency and error graphs but is an outage for those users",
          "Nothing is wrong: shedding is a deliberate choice, so those requests should not count against reliability",
          "The error rate is miscalculated and rejections should simply be counted as 5xx errors",
          "Latency dashboards are unreliable under load and should be replaced by saturation metrics",
        ],
        answer: 0,
        explanation:
          "Shedding improves exactly the two graphs most teams watch, because rejected requests leave the latency population and are usually classified separately from faults. To the user holding the phone, a rejection is a failure. The fix is to make rejected rate a first-class signal next to errors and latency and to include it in the availability SLI - not to relabel it as a 5xx, which would destroy your ability to tell a deliberate shed from a broken dependency.",
      },
    }),
  ],
};
