import { OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ArgumentException, ArgumentNullException, Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, OrgEventStreamBaseRepository, OrgSnapshotBaseRepository, SnapshotArrayIndex, SnapshotIndex, SnapshotQuerySet } from "../src/index.js";


class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

interface Party
{
    name: string;
    city: string;
}

interface Line
{
    sku: string;
    quantity: number;
    isVoid: boolean;
}

interface TicketState extends OrgAggregateState
{
    status: string;
    total: number;                  // indexed WITH a numeric cast
    openedAt: number;               // indexed WITHOUT one, on purpose - the cast rule needs a subject
    isRush: boolean;
    series: string;
    revision: number;               // gets its cast from inside the composite
    unindexed: string;              // never declared, so it must not be queryable
    party: Party;
    labels: Array<string>;
    lines: Array<Line>;
}

// only the name reaches the DDL. Its own table name, because node --test runs files in parallel and
// this suite creates and drops real tables.
class Ticket extends OrgAggregateRoot<TicketState, OrgDomainEvent<TicketState>> { }

const ticketType = Ticket as any;

const indexes = SnapshotQuerySet.for<TicketState>()
    .withPath("status")
    .withPath("total", { type: JsonValueType.numeric })
    .withPath("openedAt")
    .withPath("isRush")
    .withPath("party.city")
    .withComposite(["series", { path: "revision", type: JsonValueType.integer }], { unique: true })
    .withArrayPath("labels")
    .withArrayPath("lines");

const ORG = "org1";


await describe("SnapshotQuerySet tests", async () =>
{
    // The compiler is the assertion in this block: `tsc` reports an unused '@ts-expect-error' as an
    // error, so a line that stops being rejected fails the build.
    //
    // Every rejected call lives inside a closure that is never invoked. That is not tidiness - several
    // of them would also throw at runtime, and a thrown ArgumentException would mask whether the
    // *compiler* rejected the line, which is what these tests are about. The runtime half of the same
    // guarantee is asserted separately, under "Validation".
    await describe("Path and value typing", async () =>
    {
        await test("a path that is not indexed by this set is rejected, even when it is on the state", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - 'unindexed' is a real state path, but was never declared here
                indexes.eq("unindexed", "x");

                // @ts-expect-error - and orderBy is restricted the same way
                indexes.orderBy("unindexed");

                // @ts-expect-error - as is expressionFor, so a raw fragment cannot reach an unindexed path
                indexes.expressionFor("unindexed");
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("a path that is not on the state at all is rejected", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - not a path on this state
                indexes.eq("stauts", "sent");

                // @ts-expect-error - a container is not a leaf
                indexes.eq("party", <never>null);
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("a value of the wrong type for the leaf is rejected", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - total is a number on the state
                indexes.eq("total", "100");

                // @ts-expect-error - status is a string
                indexes.eq("status", 1);

                // @ts-expect-error - isRush is a boolean
                indexes.eq("isRush", "true");

                // @ts-expect-error - and the element type of `in` is checked too
                indexes.in("total", [1, "2"]);
            };

            assert.strictEqual(typeof rejected, "function");
        });

        // the '9' > '100' hazard, made a compile error rather than a prose warning
        await test("a numeric path indexed without a cast cannot be compared numerically", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - openedAt is a number indexed as text
                indexes.gt("openedAt", 5);

                // @ts-expect-error - equality is wrong too: as text, 1 and 1.0 differ
                indexes.eq("openedAt", 5);
            };

            assert.strictEqual(typeof rejected, "function");

            // a cast was declared for these two, so they are allowed - and these do run
            assert.ok(indexes.gt("total", 5).sql.contains("::numeric"));
            assert.ok(indexes.gte("revision", 2).sql.contains("::integer"));
        });

        await test("scalar and array paths cannot be swapped", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - labels is an array path
                indexes.eq("labels", "urgent");

                // @ts-expect-error - status is a scalar path
                indexes.contains("status", "sent");
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("a containment match is checked against the element shape", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - misspelled field on the element
                indexes.contains("lines", { skuu: "a" });

                // @ts-expect-error - wrong type for a field that does exist
                indexes.contains("lines", { quantity: "2" });

                // @ts-expect-error - an empty match would be true for every array
                indexes.contains("lines", {});

                // @ts-expect-error - a scalar array takes the scalar, not a record
                indexes.contains("labels", { name: "x" });
            };

            assert.strictEqual(typeof rejected, "function");

            // a subset of the element's fields, on one element - allowed, and these run
            assert.ok(indexes.contains("lines", { sku: "a", isVoid: false }).sql.contains("@>"));
            assert.ok(indexes.contains("labels", "urgent").sql.contains("@>"));
        });

        await test("a composite member path is checked against the state", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - not a path on this state
                SnapshotQuerySet.for<TicketState>().withComposite(["series", "nope"]);

                // @ts-expect-error - and in the spec-object form
                SnapshotQuerySet.for<TicketState>().withComposite([{ path: "nope" }]);
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("organizationId is not offered, as it is a column rather than a path in data", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - not a path on this state
                SnapshotQuerySet.for<TicketState>().withPath("organizationId");
            };

            assert.strictEqual(typeof rejected, "function");
        });
    });

    // Pins the pattern the class docs tell a consumer to write. Nothing is instantiated - the point is
    // that the override's narrow type reaches the call sites, which is a compile-time claim. If this
    // stops compiling, the documented pattern is wrong.
    await describe("The documented subclass pattern", async () =>
    {
        // The base declares `querySet` abstract, so omitting it is a compile error rather than a silent
        // downgrade. That is the whole reason it is abstract: at the widened type `eq` accepts any string
        // as a path and a numeric path with no declared cast, so a subclass that simply forgot would keep
        // value checking and quietly lose path and cast checking.
        await test("a subclass that omits querySet does not compile", async () =>
        {
            const rejected = (): void =>
            {
                class NoQuerySetEventStreamRepository extends OrgEventStreamBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
                {
                    protected onSave(): Promise<void> { return Promise.resolve(); }
                }

                // @ts-expect-error - non-abstract class does not implement inherited abstract member 'querySet'
                class NoQuerySetRepository extends OrgSnapshotBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
                {
                    public constructor(eventStreamRepository: NoQuerySetEventStreamRepository)
                    {
                        super(eventStreamRepository);
                    }
                }

                // referenced so the declaration is not elided before the compiler checks it
                assert.strictEqual(typeof NoQuerySetRepository, "function");
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("an override getter carries the declared paths to the query methods", async () =>
        {
            class TicketEventStreamRepository extends OrgEventStreamBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
            {
                protected onSave(): Promise<void> { return Promise.resolve(); }
            }

            class TicketRepository extends OrgSnapshotBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
            {
                // one object, two names: the migration reads the `indexes` static to create them, and the
                // override is what the queries below are built from
                public static readonly indexes = indexes;

                protected override get querySet(): typeof TicketRepository.indexes { return TicketRepository.indexes; }

                public constructor(eventStreamRepository: TicketEventStreamRepository)
                {
                    super(eventStreamRepository);
                }

                public getByStatus(status: string): Promise<Array<Ticket>>
                {
                    return this.query(this.querySet.eq("status", status));
                }

                public getOverTotal(total: number): Promise<Array<Ticket>>
                {
                    return this.query(this.querySet.gt("total", total));
                }

                public getRecent(count: number): Promise<Array<Ticket>>
                {
                    return this.query({ orderBy: this.querySet.orderBy("total", "desc"), limit: count });
                }

                public getBySku(sku: string): Promise<Array<Ticket>>
                {
                    return this.query(this.querySet.contains("lines", { sku }));
                }

                public rejectedPath(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - the narrow type reached here: 'unindexed' was never declared
                    return this.query(this.querySet.eq("unindexed", "x"));
                }

                public rejectedValue(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - and so did the value check
                    return this.query(this.querySet.eq("total", "100"));
                }
            }

            assert.strictEqual(typeof TicketRepository, "function");
        });
    });

    await describe("Emitted SQL", async () =>
    {
        await test("comparisons emit the declared expression, parenthesized, with the value bound", async () =>
        {
            assert.deepStrictEqual(indexes.eq("status", "sent"),
                { sql: `((data->>'status') = ?)`, params: ["sent"] });

            assert.deepStrictEqual(indexes.ne("status", "sent"),
                { sql: `((data->>'status') <> ?)`, params: ["sent"] });

            assert.deepStrictEqual(indexes.gt("total", 100),
                { sql: `(((data->>'total')::numeric) > ?)`, params: [100] });

            assert.deepStrictEqual(indexes.gte("total", 100),
                { sql: `(((data->>'total')::numeric) >= ?)`, params: [100] });

            assert.deepStrictEqual(indexes.lt("total", 100),
                { sql: `(((data->>'total')::numeric) < ?)`, params: [100] });

            assert.deepStrictEqual(indexes.lte("total", 100),
                { sql: `(((data->>'total')::numeric) <= ?)`, params: [100] });
        });

        await test("a nested path uses the #>> form, matching the index", async () =>
        {
            assert.deepStrictEqual(indexes.eq("party.city", "Toronto"),
                { sql: `((data#>>'{"party","city"}') = ?)`, params: ["Toronto"] });
        });

        await test("in emits one placeholder per value", async () =>
        {
            assert.deepStrictEqual(indexes.in("status", ["sent", "paid", "void"]),
                { sql: `((data->>'status') in (?,?,?))`, params: ["sent", "paid", "void"] });
        });

        await test("null checks bind nothing", async () =>
        {
            assert.deepStrictEqual(indexes.isNull("status"), { sql: `((data->>'status') is null)`, params: [] });
            assert.deepStrictEqual(indexes.isNotNull("status"), { sql: `((data->>'status') is not null)`, params: [] });
        });

        await test("a composite member's own cast reaches its expression", async () =>
        {
            assert.strictEqual(indexes.expressionFor("series"), `(data->>'series')`);
            assert.strictEqual(indexes.expressionFor("revision"), `((data->>'revision')::integer)`);
        });

        await test("containment delegates to the array index, so the operator is the indexed one", async () =>
        {
            const predicate = indexes.contains("lines", { sku: "a", isVoid: false });

            // passed through as the array index built it - already parenthesized, so nothing is added
            assert.strictEqual(predicate.sql, `((data->'lines') @> cast(? as jsonb))`);
            assert.deepStrictEqual(predicate.params, [JSON.stringify([{ sku: "a", isVoid: false }])]);
        });

        await test("and/or nest safely and concatenate params in fragment order", async () =>
        {
            const combined = indexes.and(
                indexes.eq("status", "sent"),
                indexes.or(indexes.gt("total", 10), indexes.eq("isRush", true)));

            assert.strictEqual(combined.sql,
                `(((data->>'status') = ?) and ((((data->>'total')::numeric) > ?) or ((data->>'isRush') = ?)))`);
            assert.deepStrictEqual(combined.params, ["sent", 10, true]);
        });

        await test("not wraps a predicate and keeps its params", async () =>
        {
            assert.deepStrictEqual(indexes.not(indexes.eq("status", "sent")),
                { sql: `(not ((data->>'status') = ?))`, params: ["sent"] });
        });

        await test("raw parenthesizes a hand-written fragment so it composes", async () =>
        {
            const combined = indexes.and(
                indexes.eq("status", "sent"),
                indexes.raw(`${indexes.expressionFor("party.city")} like ?`, "To%"));

            assert.strictEqual(combined.sql,
                `(((data->>'status') = ?) and ((data#>>'{"party","city"}') like ?))`);
            assert.deepStrictEqual(combined.params, ["sent", "To%"]);
        });

        await test("orderBy emits the declared expression and an optional direction", async () =>
        {
            assert.deepStrictEqual(indexes.orderBy("total", "desc"), { sql: `((data->>'total')::numeric) desc` });
            assert.deepStrictEqual(indexes.orderBy("status"), { sql: `(data->>'status')` });
        });

        await test("the set exposes real index instances, in declaration order", async () =>
        {
            assert.ok(indexes.indexes.every(t => t instanceof SnapshotIndex));
            assert.ok(indexes.arrayIndexes.every(t => t instanceof SnapshotArrayIndex));

            // five withPath calls plus one composite
            assert.deepStrictEqual(indexes.indexes.map(t => t.paths.join("+")),
                ["status", "total", "openedAt", "isRush", "party.city", "series+revision"]);

            assert.deepStrictEqual(indexes.arrayIndexes.map(t => t.path), ["labels", "lines"]);

            assert.deepStrictEqual(indexes.indexes.map(t => t.isUnique),
                [false, false, false, false, false, true]);
        });

        // copy-on-write: the chain does not mutate what it was called on, so a set is safe to share
        await test("each with... call returns a new set and leaves the receiver alone", async () =>
        {
            const base = SnapshotQuerySet.for<TicketState>().withPath("status");
            const extended = base.withPath("total", { type: JsonValueType.numeric });

            assert.deepStrictEqual(base.paths, ["status"]);
            assert.deepStrictEqual(extended.paths, ["status", "total"]);

            const rejected = (): void =>
            {
                // @ts-expect-error - and the receiver's type did not gain the path either
                base.eq("total", 1);
            };

            assert.strictEqual(typeof rejected, "function");
        });
    });

    await describe("Validation", async () =>
    {
        await test("declaring the same path twice throws", async () =>
        {
            assert.throws(
                () => SnapshotQuerySet.for<TicketState>().withPath("status").withPath("status"),
                ArgumentException);

            // across the two kinds too, since one path cannot be both
            assert.throws(
                () => SnapshotQuerySet.for<TicketState>().withPath("status").withArrayPath(<any>"status"),
                ArgumentException);
        });

        await test("an empty composite throws", async () =>
        {
            assert.throws(() => SnapshotQuerySet.for<TicketState>().withComposite([]), ArgumentException);
        });

        await test("an empty in list throws rather than emitting invalid SQL", async () =>
        {
            assert.throws(() => indexes.in("status", []), ArgumentException);
        });

        await test("an empty and/or throws", async () =>
        {
            assert.throws(() => indexes.and(), ArgumentException);
            assert.throws(() => indexes.or(), ArgumentException);
        });

        await test("a raw fragment that is empty or holds a ';' throws", async () =>
        {
            assert.throws(() => indexes.raw(""), ArgumentException);
            assert.throws(() => indexes.raw("   "), ArgumentException);
            assert.throws(() => indexes.raw("a = ?; drop table x", 1), ArgumentException);
        });

        await test("a bad direction throws", async () =>
        {
            assert.throws(() => indexes.orderBy("status", <any>"sideways"), ArgumentException);
        });

        // the runtime half of the type check, for a JavaScript caller or a widened set
        await test("an unindexed path throws at runtime, naming what is indexed", async () =>
        {
            // the shape a JavaScript caller, or a set held at a widened type, reaches these through
            const widened = <{
                eq(path: string, value: unknown): unknown;
                contains(path: string, match: unknown): unknown;
            }><unknown>indexes;

            assert.throws(
                () => widened.eq("unindexed", "x"),
                (e: any) => e instanceof ArgumentException && e.message.contains("is not indexed by this set"));

            assert.throws(
                () => widened.contains("status", "x"),
                (e: any) => e instanceof ArgumentException && e.message.contains("is not an array index"));

            assert.throws(() => widened.eq(<any>null, "x"), ArgumentNullException);
        });
    });

    await describe("Against Postgres", async () =>
    {
        let dbConnectionFactory: DbConnectionFactory;
        let db: Db;
        let creator: DbTableCreator;

        before(async () =>
        {
            const config: DbConnectionConfig = {
                host: "localhost",
                port: "5432",
                database: "testdb",
                username: "postgres",
                password: "p@ssw0rd"
            };
            dbConnectionFactory = new KnexPgDbConnectionFactory(config);
            db = new KnexPgDb(dbConnectionFactory);
            creator = new DbTableCreator(db, new SilentLogger());

            await db.executeCommand("drop table if exists ticket_events; drop table if exists ticket_snaps;");

            // the whole point: the table is created from the SAME object the predicates come from
            await creator.createSnapshotTableForOrgAggregate(ticketType, indexes);

            // 499 is prime, so it is coprime with the 5 organizations and every (org, status) pairing
            // occurs - a round 500 would make status a function of organization
            await db.executeCommand(
                `insert into ticket_snaps (id, organization_id, data)
                 select 'tkt_' || g,
                        'org' || (g % 5),
                        json_build_object(
                            'id', 'tkt_' || g,
                            'status', 'st' || (g % 499),
                            'total', g,
                            'labels', json_build_array('l' || (g % 97)),
                            'lines', json_build_array(json_build_object('sku', 'sku' || (g % 89), 'isVoid', false))
                        )::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze ticket_snaps;");
        });

        after(async () =>
        {
            await db.executeCommand("drop table if exists ticket_events; drop table if exists ticket_snaps;");
            await dbConnectionFactory.dispose();
        });

        const planFor = async (predicate: string, ...params: ReadonlyArray<any>): Promise<string> =>
        {
            const explained = await db.executeQuery<any>(
                `explain (costs off) select id from ticket_snaps where ${predicate};`, ...params);

            return explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");
        };

        await test("the set creates the indexes it claims to index", async () =>
        {
            const result = await db.executeQuery<any>(
                `select indexname from pg_indexes where tablename = 'ticket_snaps' order by indexname;`);
            const names = result.rows.map(t => t.indexname as string);

            assert.ok(names.contains("idx_ticket_snaps_status"), names.join(", "));
            assert.ok(names.contains("idx_ticket_snaps_total"), names.join(", "));
            assert.ok(names.contains("idx_ticket_snaps_series_revision_uq"), names.join(", "));
            assert.ok(names.contains("idx_ticket_snaps_labels_gin"), names.join(", "));
            assert.ok(names.contains("idx_ticket_snaps_lines_gin"), names.join(", "));
        });

        // the claim that makes one declaration worth having: the predicate cannot drift from the index
        await test("a predicate from the set uses the index the set declared", async () =>
        {
            const predicate = indexes.eq("status", "st7");
            const plan = await planFor(`organization_id = ? and ${predicate.sql}`, ORG, ...predicate.params);

            assert.ok(plan.contains("idx_ticket_snaps_status"), plan);
            assert.ok(!plan.contains("Seq Scan"), plan);
        });

        await test("a cast comparison uses the cast index and compares numerically", async () =>
        {
            const predicate = indexes.gt("total", 4990);
            const plan = await planFor(`organization_id = ? and ${predicate.sql}`, ORG, ...predicate.params);

            assert.ok(plan.contains("idx_ticket_snaps_total"), plan);

            // and the values really compare as numbers - as text, '4991' > '999' would be false
            const result = await db.executeQuery<any>(
                `select data from ticket_snaps where ${predicate.sql};`, ...predicate.params);

            assert.ok(result.rows.length > 0);
            assert.ok(result.rows.every(t => (<number>t.data.total) > 4990));
        });

        await test("a containment predicate uses the GIN index the set declared", async () =>
        {
            const predicate = indexes.contains("lines", { sku: "sku7" });
            const plan = await planFor(`organization_id = ? and ${predicate.sql}`, ORG, ...predicate.params);

            assert.ok(plan.contains("idx_ticket_snaps_lines_gin"), plan);

            const result = await db.executeQuery<any>(
                `select data from ticket_snaps where ${predicate.sql};`, ...predicate.params);

            assert.ok(result.rows.length > 0);
            assert.ok(result.rows.every(t => (<Array<Line>>t.data.lines).some(u => u.sku === "sku7")));
        });

        await test("a composed and/or predicate is valid SQL and binds in order", async () =>
        {
            const predicate = indexes.and(
                indexes.or(indexes.eq("status", "st7"), indexes.eq("status", "st8")),
                indexes.gt("total", 0));

            const result = await db.executeQuery<any>(
                `select data from ticket_snaps where organization_id = ? and ${predicate.sql};`,
                ORG, ...predicate.params);

            assert.ok(result.rows.length > 0);
            assert.ok(result.rows.every(t => ["st7", "st8"].contains(<string>t.data.status)));
        });

        await test("the unique composite is enforced per organization", async () =>
        {
            await db.executeCommand(
                `insert into ticket_snaps (id, organization_id, data) values (?, ?, ?);`,
                "tkt_u1", "orgA", JSON.stringify({ id: "tkt_u1", series: "S", revision: 1 }));

            // the same natural key under a different organization is fine - every index leads with
            // organization_id, so uniqueness is per tenant
            await db.executeCommand(
                `insert into ticket_snaps (id, organization_id, data) values (?, ?, ?);`,
                "tkt_u2", "orgB", JSON.stringify({ id: "tkt_u2", series: "S", revision: 1 }));

            // but a repeat within the organization collides
            await assert.rejects(() => db.executeCommand(
                `insert into ticket_snaps (id, organization_id, data) values (?, ?, ?);`,
                "tkt_u3", "orgA", JSON.stringify({ id: "tkt_u3", series: "S", revision: 1 })));
        });
    });
});
