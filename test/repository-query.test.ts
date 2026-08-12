import { ArgumentException, ArgumentNullException, Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, SnapshotIndex, SnapshotQuerySet } from "../src/index.js";
import { RepositoryQueryBuilder } from "../src/repository/repository-query.js";
import { OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";


class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

interface ReceiptState extends OrgAggregateState
{
    status: string;
    total: number;
}

// only its name reaches the DDL, so the body can be empty - the shape that matters is ReceiptState.
// Deliberately not Invoice/Order/Team: node --test runs test files in parallel, and this suite creates
// and drops real tables, so it has to own a table name db-table-creator.test.ts does not touch.
class Receipt extends OrgAggregateRoot<ReceiptState, OrgDomainEvent<ReceiptState>> { }

const receiptType = Receipt as any;

const ORG = "org1";


await describe("RepositoryQueryBuilder tests", async () =>
{
    // the four repositories differ only in whether an organization id is passed, so both paths are
    // asserted side by side rather than in separate blocks
    await describe("Emitted SQL", async () =>
    {
        await test("an org-scoped predicate is preceded by organization_id, which binds first", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", "(data->>'status') = ?", ["sent"], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? and ((data->>'status') = ?);`);

            // leading, because every btree index on an org table leads with the column - and because
            // positional binding means the order here is the order in the statement
            assert.deepStrictEqual(built.params, [ORG, "sent"]);
        });

        await test("a non-org predicate gets a where clause of its own", async () =>
        {
            const built = RepositoryQueryBuilder.build("order_snaps", "(data->>'status') = ?", ["sent"]);

            assert.strictEqual(built.sql, `select data from order_snaps where ((data->>'status') = ?);`);
            assert.deepStrictEqual(built.params, ["sent"]);
        });

        // the reason the predicate is parenthesized at all: `and` binds tighter than `or`, so a bare
        // splice would parse as `(org and a) or b` and return other organizations' rows
        await test("a top-level or in the predicate cannot escape the organization filter", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps",
                "(data->>'status') = ? or (data->>'status') = ?", ["sent", "paid"], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? and ((data->>'status') = ? or (data->>'status') = ?);`);
            assert.deepStrictEqual(built.params, [ORG, "sent", "paid"]);
        });

        await test("no predicate leaves just the organization filter on the org path", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", {}, [], ORG);

            assert.strictEqual(built.sql, `select data from receipt_snaps where organization_id = ?;`);
            assert.deepStrictEqual(built.params, [ORG]);
        });

        await test("no predicate leaves no where clause at all on the non-org path", async () =>
        {
            const built = RepositoryQueryBuilder.build("order_snaps", {}, []);

            assert.strictEqual(built.sql, `select data from order_snaps;`);
            assert.deepStrictEqual(built.params, []);
        });

        await test("orderBy, limit and offset are appended in SQL order, with the row counts bound", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", {
                // a hand-written predicate now reaches `where` as a SnapshotPredicate, which carries
                // its own values - the bare-string form and its positional params are gone
                where: { sql: "(data->>'status') = ?", params: ["sent"] },
                orderBy: "((data->>'total')::numeric) desc",
                limit: 20,
                offset: 40
            }, [], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? and ((data->>'status') = ?) `
                + `order by ((data->>'total')::numeric) desc limit ? offset ?;`);

            // bound, not interpolated - and after the predicate's params, matching where they appear
            assert.deepStrictEqual(built.params, [ORG, "sent", 20, 40]);
        });

        await test("ordering and paging work with no predicate", async () =>
        {
            const built = RepositoryQueryBuilder.build("order_snaps",
                { orderBy: "((data->>'total')::numeric) desc", limit: 10 }, []);

            assert.strictEqual(built.sql,
                `select data from order_snaps order by ((data->>'total')::numeric) desc limit ?;`);
            assert.deepStrictEqual(built.params, [10]);
        });

        await test("a zero limit is emitted rather than treated as absent", async () =>
        {
            const built = RepositoryQueryBuilder.build("order_snaps", { limit: 0 }, []);

            assert.strictEqual(built.sql, `select data from order_snaps limit ?;`);
            assert.deepStrictEqual(built.params, [0]);
        });

        await test("the table name is trimmed", async () =>
        {
            const built = RepositoryQueryBuilder.build("  order_snaps  ", "id = ?", ["o1"]);

            assert.strictEqual(built.sql, `select data from order_snaps where (id = ?);`);
        });

        await test("the predicate is trimmed", async () =>
        {
            const built = RepositoryQueryBuilder.build("order_snaps", "  id = ?  ", ["o1"]);

            assert.strictEqual(built.sql, `select data from order_snaps where (id = ?);`);
        });

        // the shapes get/getAll emit, so the statements every repository runs by default are pinned here
        await test("the statements get and getAll build are pinned", async () =>
        {
            assert.strictEqual(
                RepositoryQueryBuilder.build("receipt_snaps", "id = ?", ["rec_1"], ORG).sql,
                `select data from receipt_snaps where organization_id = ? and (id = ?);`);

            assert.strictEqual(
                RepositoryQueryBuilder.build("receipt_snaps", "id in (?,?)", ["rec_1", "rec_2"], ORG).sql,
                `select data from receipt_snaps where organization_id = ? and (id in (?,?));`);

            // the event stream repositories load by id only, and both `get` and `getAll` go through the same
            // `in` shape - a single-element IN, which Postgres rewrites to an equality
            assert.strictEqual(
                RepositoryQueryBuilder.build("order_events", "aggregate_id in (?)", ["o1"]).sql,
                `select data from order_events where (aggregate_id in (?));`);

            assert.strictEqual(
                RepositoryQueryBuilder.build("order_events", {}, []).sql,
                `select data from order_events;`);
        });
    });

    // the forms a SnapshotQuerySet hands to `query`: a predicate that owns its params, and order-by
    // terms that own their expressions
    await describe("Predicate and orderBy forms", async () =>
    {
        const querySet = SnapshotQuerySet.for<ReceiptState>()
            .withPath("status")
            .withPath("total", { type: JsonValueType.numeric });

        await test("a predicate supplies both the fragment and its params", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", querySet.eq("status", "sent"), [], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? and (((data->>'status') = ?));`);

            // the org id still leads, and the predicate's own values follow it
            assert.deepStrictEqual(built.params, [ORG, "sent"]);
        });

        await test("a predicate as the where of a query object works the same way", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", {
                where: querySet.and(querySet.eq("status", "sent"), querySet.gt("total", 10)),
                orderBy: querySet.orderBy("total", "desc"),
                limit: 5
            }, [], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? `
                + `and ((((data->>'status') = ?) and (((data->>'total')::numeric) > ?))) `
                + `order by ((data->>'total')::numeric) desc limit ?;`);
            assert.deepStrictEqual(built.params, [ORG, "sent", 10, 5]);
        });

        await test("several orderBy terms become one comma-joined list", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", {
                orderBy: [querySet.orderBy("status"), querySet.orderBy("total", "desc")]
            }, [], ORG);

            assert.strictEqual(built.sql,
                `select data from receipt_snaps where organization_id = ? `
                + `order by (data->>'status'), ((data->>'total')::numeric) desc;`);
        });

        // the predicate owns its params, so positional ones would have nowhere to bind - and a silent
        // misbinding is exactly what positional binding punishes
        await test("params passed alongside a predicate throw", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", querySet.eq("status", "sent"), ["extra"], ORG),
                (e: any) => e instanceof ArgumentException && e.message.contains("carries its own params"));

            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps",
                    { where: querySet.eq("status", "sent") }, ["extra"], ORG),
                ArgumentException);
        });

        await test("the predicate guards apply to a predicate's sql too", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", { sql: "select data from x", params: [] }, [], ORG),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", { sql: "a = ?; drop table x", params: [1] }, [], ORG),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", { sql: "   ", params: [] }, [], ORG),
                ArgumentException);
        });

        await test("an object carrying both sql and where is rejected rather than guessed at", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps",
                    <any>{ sql: "a = ?", params: [1], where: "b = ?" }, [], ORG),
                ArgumentException);
        });

        await test("a malformed orderBy term throws", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", { orderBy: <any>[{ sql: "  " }] }, [], ORG),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", { orderBy: <any>[] }, [], ORG),
                ArgumentException);
        });
    });

    // `exists` and `count` share the where-clause assembly with `build`, so what is asserted here is the two
    // things that differ: the select list, and where `id <> ?` lands relative to the organization filter.
    await describe("Existence and count statements", async () =>
    {
        await test("exists selects a constant and stops at the first match", async () =>
        {
            const built = RepositoryQueryBuilder.buildExists("order_snaps", { sql: "(data->>'slug') = ?", params: ["a"] });

            assert.strictEqual(built.sql, `select 1 from order_snaps where ((data->>'slug') = ?) limit 1;`);
            assert.deepStrictEqual(built.params, ["a"]);
        });

        // organization first, excluded id last - and the values in exactly that order, because binding is
        // positional
        await test("exists orders the organization filter, the predicate and the excluded id", async () =>
        {
            const built = RepositoryQueryBuilder.buildExists("receipt_snaps",
                { sql: "(data->>'email') = ?", params: ["a@b.c"] }, "rec_1", ORG);

            assert.strictEqual(built.sql,
                `select 1 from receipt_snaps where organization_id = ? and ((data->>'email') = ?) and id <> ? limit 1;`);
            assert.deepStrictEqual(built.params, [ORG, "a@b.c", "rec_1"]);
        });

        await test("exists with no predicate asks whether there is any row at all", async () =>
        {
            assert.strictEqual(RepositoryQueryBuilder.buildExists("order_snaps").sql,
                `select 1 from order_snaps limit 1;`);

            // on the org path that means any row in this organization
            const scoped = RepositoryQueryBuilder.buildExists("receipt_snaps", undefined, undefined, ORG);
            assert.strictEqual(scoped.sql, `select 1 from receipt_snaps where organization_id = ? limit 1;`);
            assert.deepStrictEqual(scoped.params, [ORG]);
        });

        await test("exists takes an excluded id without a predicate", async () =>
        {
            const built = RepositoryQueryBuilder.buildExists("order_snaps", undefined, "ord_1");

            assert.strictEqual(built.sql, `select 1 from order_snaps where id <> ? limit 1;`);
            assert.deepStrictEqual(built.params, ["ord_1"]);
        });

        // the cast matters: Postgres types count(*) as bigint, which the driver returns as a string
        await test("count casts to int and scopes the same way", async () =>
        {
            assert.strictEqual(RepositoryQueryBuilder.buildCount("order_snaps").sql,
                `select cast(count(*) as int) as count from order_snaps;`);

            const built = RepositoryQueryBuilder.buildCount("receipt_snaps",
                { sql: "(data->>'isDeactivated') = ?", params: [false] }, ORG);

            assert.strictEqual(built.sql,
                `select cast(count(*) as int) as count from receipt_snaps where organization_id = ? and ((data->>'isDeactivated') = ?);`);
            assert.deepStrictEqual(built.params, [ORG, false]);
        });

        await test("both reject a predicate that is really a whole statement, or a blank excluded id", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.buildExists("order_snaps", { sql: "select 1 from x", params: [] }),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.buildCount("order_snaps", { sql: "a = ?; drop table x", params: [1] }),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.buildExists("order_snaps", undefined, "   "),
                ArgumentException);
        });
    });

    await describe("Validation", async () =>
    {
        // the guard that matters most for anyone porting a subclass off the old whole-statement
        // signature: a precise message instead of a Postgres syntax error
        await test("a whole statement passed as a predicate throws, saying so", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps",
                    "select data from order_snaps where id = ?", ["o1"]),
                (e: any) => e instanceof ArgumentException && e.message.contains("whole statement"));

            // a CTE is reaching past what this builds, the same way
            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps", "with x as (select 1) select data from x", []),
                ArgumentException);
        });

        await test("keeping the where keyword throws", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps", "where id = ?", ["o1"]),
                (e: any) => e instanceof ArgumentException && e.message.contains("'where' keyword"));
        });

        await test("keeping the order by keywords throws", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps", { orderBy: "order by id desc" }, []),
                (e: any) => e instanceof ArgumentException && e.message.contains("'order by' keywords"));
        });

        await test("a ';' in the predicate or the order by throws", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps", "id = ?; drop table order_snaps", ["o1"]),
                ArgumentException);

            assert.throws(
                () => RepositoryQueryBuilder.build("order_snaps", { orderBy: "id; drop table order_snaps" }, []),
                ArgumentException);
        });

        await test("an empty predicate throws rather than selecting everything", async () =>
        {
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", "", []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", "   ", []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { where: { sql: "  ", params: [] } }, []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { orderBy: "" }, []), ArgumentException);
        });

        await test("a missing predicate throws", async () =>
        {
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", <any>null, []), ArgumentNullException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", <any>undefined, []), ArgumentNullException);
        });

        // silently dropping them would turn a caller's mistake into a query matching more than asked
        await test("params with no predicate to bind them to throw", async () =>
        {
            assert.throws(() => RepositoryQueryBuilder.build("receipt_snaps", {}, ["sent"], ORG), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { limit: 10 }, ["sent"]), ArgumentException);
        });

        await test("a limit or offset that is not a non-negative integer throws", async () =>
        {
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { limit: 1.5 }, []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { limit: -1 }, []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { offset: -1 }, []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { offset: NaN }, []), ArgumentException);
            assert.throws(() => RepositoryQueryBuilder.build("order_snaps", { limit: <any>"10" }, []), ArgumentException);
        });

        await test("a missing table throws", async () =>
        {
            assert.throws(() => RepositoryQueryBuilder.build(<any>null, "id = ?", ["o1"]), ArgumentNullException);
        });

        // it would pass ensureIsString and then match no rows, reading as an empty tenant rather than
        // as the misconfigured domain context it is
        await test("an empty organizationId throws rather than matching nothing", async () =>
        {
            assert.throws(
                () => RepositoryQueryBuilder.build("receipt_snaps", "id = ?", ["rec_1"], "   "),
                ArgumentException);
        });
    });

    await describe("Against Postgres", async () =>
    {
        let dbConnectionFactory: DbConnectionFactory;
        let db: Db;
        let creator: DbTableCreator;

        const statusIndex = SnapshotIndex.forPath<ReceiptState>("status");

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

            await db.executeCommand("drop table if exists receipt_events; drop table if exists receipt_snaps;");
            await creator.createSnapshotTableForOrgAggregate(receiptType, { indexes: [statusIndex], arrayIndexes: [] });

            // enough rows, spread over enough organizations and statuses, that the planner has a real
            // choice - without this every plan is a seq scan and the index assertions pass vacuously.
            // 499 is prime, so it is coprime with the 5 organizations and every (org, status) pairing
            // occurs; a round 500 would make status a function of organization and leave the isolation
            // assertions below with nothing to catch.
            await db.executeCommand(
                `insert into receipt_snaps (id, organization_id, data)
                 select 'rec_' || g,
                        'org' || (g % 5),
                        json_build_object('id', 'rec_' || g, 'status', 'st' || (g % 499))::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze receipt_snaps;");
        });

        after(async () =>
        {
            await db.executeCommand("drop table if exists receipt_events; drop table if exists receipt_snaps;");
            await dbConnectionFactory.dispose();
        });

        await test("a built statement is valid SQL and returns only the current organization's rows", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps",
                `${statusIndex.expressionForPath("status")} = ?`, ["st7"], ORG);

            const result = await db.executeQuery<any>(built.sql, ...built.params);

            assert.ok(result.rows.length > 0);
            assert.ok(result.rows.every(t => (<string>t.data.status) === "st7"));

            // the isolation claim: the same status exists under the other four organizations, and the
            // ids that came back are exactly the ones belonging to this one
            const unscoped = await db.executeQuery<any>(
                `select id, organization_id from receipt_snaps where ${statusIndex.expressionForPath("status")} = ?;`,
                "st7");

            assert.ok(unscoped.rows.length > result.rows.length);
            assert.deepStrictEqual(
                result.rows.map(t => t.data.id as string).sort(),
                unscoped.rows.filter(t => (<string>t.organization_id) === ORG).map(t => t.id as string).sort());
        });

        await test("a top-level or predicate stays scoped once built", async () =>
        {
            const expression = statusIndex.expressionForPath("status");

            const built = RepositoryQueryBuilder.build("receipt_snaps",
                `${expression} = ? or ${expression} = ?`, ["st7", "st8"], ORG);

            const result = await db.executeQuery<any>(built.sql, ...built.params);

            assert.ok(result.rows.length > 0);

            // the whole point of the parens: without them the `or` arm would bring in every
            // organization's st8 rows
            const scopedIds = await db.executeQuery<any>(
                `select id from receipt_snaps where organization_id = ? and (${expression} = ? or ${expression} = ?);`,
                ORG, "st7", "st8");

            assert.deepStrictEqual(
                result.rows.map(t => t.data.id as string).sort(),
                scopedIds.rows.map(t => t.id as string).sort());
        });

        // the performance half of the same claim: the filter leads, so the index is still reachable
        await test("a built statement still uses the index the predicate was declared from", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps",
                `${statusIndex.expressionForPath("status")} = ?`, ["st7"], ORG);

            const explained = await db.executeQuery<any>(
                `explain (costs off) ${built.sql.replace(";", "")}`, ...built.params);
            const plan = explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");

            assert.ok(plan.contains("idx_receipt_snaps_status"), plan);
            assert.ok(!plan.contains("Seq Scan"), plan);
        });

        await test("ordering and paging survive the round trip", async () =>
        {
            const built = RepositoryQueryBuilder.build("receipt_snaps", {
                orderBy: `${statusIndex.expressionForPath("status")} desc`,
                limit: 3
            }, [], ORG);

            const result = await db.executeQuery<any>(built.sql, ...built.params);

            assert.strictEqual(result.rows.length, 3);

            const statuses = result.rows.map(t => t.data.status as string);
            assert.deepStrictEqual(statuses, [...statuses].sort().reverse());
        });
    });
});
