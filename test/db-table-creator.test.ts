import { given } from "@nivinjoseph/n-defensive";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { AggregateRootClass, DataHelper, Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, OrgAggregateRootClass, QueryResult, SnapshotIndexedPath } from "../src/index.js";
import { TransactionProvider } from "../src/unit-of-work/transaction-provider.js";


class Order { }
class Invoice { }

// snake cased this is 67 chars, so every derived table name overflows the 63 char limit
class AggregateWithAnExtremelyLongNameThatOverflowsPostgresLimit { }

const orderType = Order as unknown as AggregateRootClass;
const invoiceType = Invoice as unknown as OrgAggregateRootClass;
const overlongType = AggregateWithAnExtremelyLongNameThatOverflowsPostgresLimit as unknown as AggregateRootClass;


/**
 * Records every command instead of executing it, so the emitted DDL can be asserted exactly.
 */
class CapturingDb implements Db
{
    private readonly _commands = new Array<string>();


    public get commands(): ReadonlyArray<string> { return this._commands.map(t => normalize(t)); }


    public executeCommand(sql: string, ...params: Array<any>): Promise<void>
    {
        given(params, "params").ensure(t => t.isEmpty, "DDL should not carry bindings");

        this._commands.push(sql);

        return Promise.resolve();
    }

    public executeCommandWithinUnitOfWork(_transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>
    {
        return this.executeCommand(sql, ...params);
    }

    public executeQuery<T>(): Promise<QueryResult<T>>
    {
        throw new Error("not used");
    }
}

class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

function normalize(sql: string): string
{
    return sql.replaceAll(/\s+/g, " ").trim();
}

function createCreator(): { creator: DbTableCreator; db: CapturingDb; }
{
    const db = new CapturingDb();
    return { creator: new DbTableCreator(db, new SilentLogger()), db };
}


await describe("DbTableCreator tests", async () =>
{
    await describe("Emitted DDL", async () =>
    {
        await test("event stream table for an aggregate has a unique index on (aggregate_id, aggregate_version)", async () =>
        {
            const { creator, db } = createCreator();

            const tableName = await creator.createEventStreamTableForAggregate(orderType);

            assert.strictEqual(tableName, DataHelper.createEventStreamTableName(orderType));
            assert.strictEqual(tableName, "order_events");
            assert.deepStrictEqual(db.commands, [
                "create table if not exists order_events ( id varchar(50) primary key, aggregate_id varchar(40) not null, aggregate_version integer not null, data jsonb not null );",
                "create unique index if not exists idx_order_events on order_events(aggregate_id, aggregate_version);"
            ]);
        });

        await test("event stream table for an org aggregate leads its unique index with organization_id", async () =>
        {
            const { creator, db } = createCreator();

            const tableName = await creator.createEventStreamTableForOrgAggregate(invoiceType);

            assert.strictEqual(tableName, "invoice_events");
            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_events ( id varchar(50) primary key, aggregate_id varchar(40) not null, aggregate_version integer not null, organization_id varchar(40) not null, data jsonb not null );",
                "create unique index if not exists idx_invoice_events on invoice_events(organization_id, aggregate_id, aggregate_version);"
            ]);
        });

        await test("snapshot table for an aggregate with no indexed paths emits no index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType);

            assert.strictEqual(info.tableName, DataHelper.createSnapshotTableName(orderType));
            assert.deepStrictEqual(info.indexedExpressions, {});
            assert.deepStrictEqual(db.commands, [
                "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );"
            ]);
        });

        await test("snapshot table adds no column for an indexed path - only an expression index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType, [{ path: "status" }]);

            // the table shape is identical to the no-paths case
            assert.strictEqual(db.commands[0], "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );");
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));");
            assert.deepStrictEqual(info.indexedExpressions, { status: "(data->>'status')" });
        });

        await test("indexed path with a type casts inside the indexed expression", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [{ path: "total", type: JsonValueType.numeric }]);

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_total on order_snaps(((data->>'total')::numeric));");
        });

        await test("nested indexed path uses #>> and an underscored index name", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType, [{ path: "customer.city" }]);

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_customer_city on order_snaps((data#>>'{customer,city}'));");
            assert.deepStrictEqual(info.indexedExpressions, { "customer.city": "(data#>>'{customer,city}')" });
        });

        await test("org snapshot table with no indexed paths emits an (organization_id) index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForOrgAggregate(invoiceType);

            assert.strictEqual(info.tableName, "invoice_snaps");
            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"
            ]);
        });

        await test("org snapshot indexes lead with organization_id, and the standalone one is then skipped", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, [{ path: "status" }, { path: "total", type: JsonValueType.numeric }]);

            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps_status on invoice_snaps(organization_id, (data->>'status'));",
                "create index if not exists idx_invoice_snaps_total on invoice_snaps(organization_id, ((data->>'total')::numeric));"
            ]);

            // no standalone (organization_id) index - each composite already leads with it
            assert.ok(!db.commands.contains("create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"));
        });

        await test("an empty indexed paths array behaves like omitting it", async () =>
        {
            const withEmpty = createCreator();
            const withUndefined = createCreator();

            await withEmpty.creator.createSnapshotTableForAggregate(orderType, []);
            await withUndefined.creator.createSnapshotTableForAggregate(orderType);

            assert.deepStrictEqual(withEmpty.db.commands, withUndefined.db.commands);
        });
    });

    await describe("Returned expressions match the indexed ones", async () =>
    {
        // the whole point of returning them: Postgres only uses an expression index when the
        // query expression matches, so the creator and the caller must not be able to diverge
        await test("every returned expression is identical to DataHelper.createJsonPathExpression", async () =>
        {
            const { creator } = createCreator();
            const paths: Array<SnapshotIndexedPath> = [
                { path: "status" },
                { path: "total", type: JsonValueType.numeric },
                { path: "customer.city" },
                { path: "createdAt", type: JsonValueType.bigint }
            ];

            const info = await creator.createSnapshotTableForAggregate(orderType, paths);

            for (const p of paths)
                assert.strictEqual(info.indexedExpressions[p.path], DataHelper.createJsonPathExpression(p.path, p.type));
        });

        await test("the returned expression appears verbatim in the emitted index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType, [{ path: "total", type: JsonValueType.numeric }]);

            assert.ok(db.commands[1].contains(info.indexedExpressions["total"]));
        });
    });

    await describe("createJsonPathExpression", async () =>
    {
        await test("builds ->> for a top level key and #>> for a nested one", () =>
        {
            assert.strictEqual(DataHelper.createJsonPathExpression("status"), "(data->>'status')");
            assert.strictEqual(DataHelper.createJsonPathExpression("customer.city"), "(data#>>'{customer,city}')");
            assert.strictEqual(DataHelper.createJsonPathExpression("a.b.c"), "(data#>>'{a,b,c}')");
        });

        await test("appends the cast when a type is given", () =>
        {
            assert.strictEqual(DataHelper.createJsonPathExpression("total", JsonValueType.numeric), "((data->>'total')::numeric)");
            assert.strictEqual(DataHelper.createJsonPathExpression("ratio", JsonValueType.doublePrecision), "((data->>'ratio')::double precision)");
            assert.strictEqual(DataHelper.createJsonPathExpression("createdAt", JsonValueType.bigint), "((data->>'createdAt')::bigint)");
            assert.strictEqual(DataHelper.createJsonPathExpression("customer.id", JsonValueType.uuid), "((data#>>'{customer,id}')::uuid)");
        });

        await test("rejects a path that could break out of the string literal", () =>
        {
            assert.throws(() => DataHelper.createJsonPathExpression("status') or true--"));
            assert.throws(() => DataHelper.createJsonPathExpression("a'b"));
            assert.throws(() => DataHelper.createJsonPathExpression("a,b"));
            assert.throws(() => DataHelper.createJsonPathExpression("a}"));
        });

        await test("rejects an empty path segment", () =>
        {
            assert.throws(() => DataHelper.createJsonPathExpression("a..b"));
            assert.throws(() => DataHelper.createJsonPathExpression(".a"));
            assert.throws(() => DataHelper.createJsonPathExpression("a."));
        });

        await test("rejects a path that is null, empty or whitespace", () =>
        {
            assert.throws(() => DataHelper.createJsonPathExpression(null as unknown as string));
            assert.throws(() => DataHelper.createJsonPathExpression(""));
            assert.throws(() => DataHelper.createJsonPathExpression("   "));
        });

        await test("rejects a type outside JsonValueType", () =>
        {
            const notAType = (t: string): JsonValueType => t as JsonValueType;

            assert.throws(() => DataHelper.createJsonPathExpression("total", notAType("numeric); drop table x --")));
            assert.throws(() => DataHelper.createJsonPathExpression("total", notAType("Numeric")));
            assert.throws(() => DataHelper.createJsonPathExpression("total", notAType("int[]")));
            // reachable via an immutable cast, but excluded on purpose - see JsonValueType
            assert.throws(() => DataHelper.createJsonPathExpression("total", notAType("varchar(20)")));
            assert.throws(() => DataHelper.createJsonPathExpression("tags", notAType("jsonb")));
            // rejected by Postgres itself in an index expression, so not offered
            assert.throws(() => DataHelper.createJsonPathExpression("createdAt", notAType("timestamptz")));
            assert.throws(() => DataHelper.createJsonPathExpression("createdAt", notAType("date")));
        });
    });

    await describe("Identifier validation", async () =>
    {
        await test("validateIndexName accepts a conventional name and returns it trimmed", () =>
        {
            const { creator } = createCreator();

            assert.strictEqual(creator.validateIndexName("idx_order_snaps"), "idx_order_snaps");
            assert.strictEqual(creator.validateIndexName("  idx_order_snaps  "), "idx_order_snaps");
        });

        await test("validateIndexName rejects a missing idx_ prefix", () =>
        {
            const { creator } = createCreator();

            assert.throws(() => creator.validateIndexName("order_snaps"));
            assert.throws(() => creator.validateIndexName("ix_order_snaps"));
        });

        await test("validateIndexName rejects a name that is null, empty or whitespace", () =>
        {
            const { creator } = createCreator();

            assert.throws(() => creator.validateIndexName(null as unknown as string));
            assert.throws(() => creator.validateIndexName(""));
            assert.throws(() => creator.validateIndexName("   "));
        });

        await test("validateIndexName rejects names that are not valid unquoted identifiers", () =>
        {
            const { creator } = createCreator();

            assert.throws(() => creator.validateIndexName("idx_order snaps"));
            assert.throws(() => creator.validateIndexName("IDX_order_snaps"));
            assert.throws(() => creator.validateIndexName("idx_Order_Snaps"));
            assert.throws(() => creator.validateIndexName("idx_order-snaps"));
            assert.throws(() => creator.validateIndexName("idx_order;drop table x"));
        });

        await test("validateIndexName reports the trimmed name and its own length when too long", () =>
        {
            const { creator } = createCreator();
            const tooLong = "idx_" + "a".repeat(60); // 64 chars, one over the limit

            assert.strictEqual(tooLong.length, 64);
            assert.doesNotThrow(() => creator.validateIndexName(tooLong.substring(0, 63)));

            assert.throws(
                () => creator.validateIndexName(`  ${tooLong}  `),
                (error: Error) =>
                {
                    // the message must describe what was validated - the trimmed value - not the raw input
                    assert.ok(error.message.contains("(64 chars)"), `expected the trimmed length, got: ${error.message}`);
                    assert.ok(!error.message.contains("(68 chars)"));
                    assert.ok(error.message.contains(tooLong));
                    return true;
                });
        });

        await test("createIndexNameFromTableName trims the table name and composes the suffix", () =>
        {
            const { creator } = createCreator();

            assert.strictEqual(creator.createIndexNameFromTableName("order_snaps"), "idx_order_snaps");
            assert.strictEqual(creator.createIndexNameFromTableName("  order_snaps  "), "idx_order_snaps");
            assert.strictEqual(creator.createIndexNameFromTableName("order_snaps", "status"), "idx_order_snaps_status");
            assert.strictEqual(creator.createIndexNameFromTableName("order_snaps", "  status  "), "idx_order_snaps_status");
        });

        await test("createIndexNameFromTableName rejects a table name that would yield an invalid index name", () =>
        {
            const { creator } = createCreator();

            assert.throws(() => creator.createIndexNameFromTableName("order snaps"));
            assert.throws(() => creator.createIndexNameFromTableName("Order_Snaps"));
            assert.throws(() => creator.createIndexNameFromTableName("order_snaps", "sta tus"));
        });

        // the gap this closes: a plain snapshot table creates no index, so before this its
        // name was the one identifier never checked against the 63 char limit
        await test("an overlong table name is rejected even when no index is created", async () =>
        {
            const { creator } = createCreator();

            assert.ok(DataHelper.createSnapshotTableName(overlongType).length > 63);

            await assert.rejects(() => creator.createSnapshotTableForAggregate(overlongType));
            await assert.rejects(() => creator.createEventStreamTableForAggregate(overlongType));
        });
    });

    await describe("Indexed path validation", async () =>
    {
        await test("rejects the same path twice", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "status" }, { path: "status" }]));
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "status" }, { path: "  status  " }]));
        });

        await test("rejects distinct paths whose derived index names would collide", async () =>
        {
            const { creator } = createCreator();

            // both derive the suffix 'created_at', and `if not exists` would silently skip the second
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "created.at" }, { path: "created_at" }]));
            // case only differences fold to the same identifier
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "createdAt" }, { path: "createdat" }]));
        });

        await test("rejects a malformed path or type", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "a'b" }]));
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "" }]));
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "total", type: "int[]" as JsonValueType }]));
            await assert.rejects(() => creator.createSnapshotTableForOrgAggregate(invoiceType, [{ path: "a,b" }]));
        });

        await test("rejects a path whose index name would overflow the identifier limit", async () =>
        {
            const { creator } = createCreator();

            // idx_ (4) + order_snaps (11) + _ (1) + 48 = 64, one over
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "a".repeat(48) }]));
            await assert.doesNotReject(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "a".repeat(47) }]));
        });

        await test("no DDL is emitted when validation fails", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [{ path: "a'b" }]));

            assert.deepStrictEqual(db.commands, []);
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

            await db.executeCommand("drop table if exists order_events; drop table if exists order_snaps; drop table if exists invoice_events; drop table if exists invoice_snaps;");
        });

        after(async () =>
        {
            await db.executeCommand("drop table if exists order_events; drop table if exists order_snaps; drop table if exists invoice_events; drop table if exists invoice_snaps;");
            await dbConnectionFactory.dispose();
        });


        await test("event stream table and its unique index are created, and re-running is a no-op", async () =>
        {
            await creator.createEventStreamTableForAggregate(orderType);
            await creator.createEventStreamTableForAggregate(orderType);

            const result = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'order_events' and indexname = 'idx_order_events';`);

            assert.strictEqual(result.rows.length, 1);
            assert.ok((result.rows[0].indexdef as string).contains("UNIQUE"));
            assert.ok((result.rows[0].indexdef as string).contains("aggregate_id, aggregate_version"));
        });

        await test("expression indexes are created over the json paths, with no column added", async () =>
        {
            await creator.createSnapshotTableForOrgAggregate(invoiceType, [
                { path: "status" },
                { path: "total", type: JsonValueType.numeric },
                { path: "customer.city" }
            ]);

            const columns = await db.executeQuery<any>(
                `select column_name from information_schema.columns where table_name = 'invoice_snaps' order by ordinal_position;`);

            assert.deepStrictEqual(columns.rows.map(t => t.column_name as string), ["id", "organization_id", "data"]);

            const indexes = await db.executeQuery<any>(
                `select indexname, indexdef from pg_indexes where tablename = 'invoice_snaps' order by indexname;`);
            const byName = new Map(indexes.rows.map(t => [t.indexname as string, t.indexdef as string]));

            assert.ok(byName.has("idx_invoice_snaps_status"));
            assert.ok(byName.get("idx_invoice_snaps_status")!.contains("organization_id"));
            assert.ok(byName.get("idx_invoice_snaps_status")!.contains("'status'"));
            assert.ok(byName.get("idx_invoice_snaps_total")!.contains("numeric"));
            assert.ok(byName.get("idx_invoice_snaps_customer_city")!.contains("customer,city"));

            // the standalone (organization_id) index is skipped when composites already lead with it
            assert.ok(!byName.has("idx_invoice_snaps"));
        });

        // F2 was that a projected column broke every write, because the repositories' insert
        // column lists are fixed. These pin the created tables to the exact SQL those
        // repositories emit, so neither side can drift from the other unnoticed.
        await test("EventStreamBaseRepository's insert succeeds against the created event stream table", async () =>
        {
            await creator.createEventStreamTableForAggregate(orderType);

            await db.executeCommand(
                `insert into order_events (id, aggregate_id, aggregate_version, data) values (?, ?, ?, ?);`,
                "ord_1-1", "ord_1", 1, JSON.stringify({ $name: "OrderCreated" }));
        });

        await test("the unique index actually enforces optimistic concurrency", async () =>
        {
            await creator.createEventStreamTableForAggregate(orderType);

            await db.executeCommand(
                `insert into order_events (id, aggregate_id, aggregate_version, data) values (?, ?, ?, ?);`,
                "ord_2-1", "ord_2", 1, JSON.stringify({ $name: "OrderCreated" }));

            // same aggregate and version, different event id - the index must reject it
            await assert.rejects(() => db.executeCommand(
                `insert into order_events (id, aggregate_id, aggregate_version, data) values (?, ?, ?, ?);`,
                "ord_2-1-dupe", "ord_2", 1, JSON.stringify({ $name: "OrderAmended" })));
        });

        await test("OrgSnapshotBaseRepository's insert and upsert succeed against a table with indexed paths", async () =>
        {
            const info = await creator.createSnapshotTableForOrgAggregate(invoiceType, [{ path: "status" }]);

            // the exact statement OrgSnapshotBaseRepository.save emits for a new aggregate
            await db.executeCommand(
                `insert into invoice_snaps (id, organization_id, data) values(?, ?, ?);`,
                "inv_1", "org_1", JSON.stringify({ id: "inv_1", status: "draft" }));

            // and the one it emits for an existing aggregate
            await db.executeCommand(
                `insert into invoice_snaps (id, organization_id, data) values(?, ?, ?) on conflict (id) do update set data = excluded.data;`,
                "inv_1", "org_1", JSON.stringify({ id: "inv_1", status: "sent" }));

            // the indexed expression sees the updated value, with nothing populating a column
            const result = await db.executeQuery<any>(
                `select id from invoice_snaps where organization_id = ? and ${info.indexedExpressions["status"]} = ?;`,
                "org_1", "sent");

            assert.deepStrictEqual(result.rows.map(t => t.id as string), ["inv_1"]);
        });

        // JsonValueType claims every member works as an index expression. An expression index
        // requires an immutable expression, and text->date/timestamp/interval/money parse
        // through stable functions, so a plausible-looking addition can be silently wrong
        // until someone deploys it. This is the check that keeps the enum honest.
        await test("every JsonValueType member is usable as an index expression", async () =>
        {
            await db.executeCommand("drop table if exists json_value_type_probe; create table json_value_type_probe (data jsonb not null);");

            const types = Object.values(JsonValueType);
            assert.ok(types.isNotEmpty);

            const failures = new Array<string>();

            for (const type of types)
            {
                const expression = DataHelper.createJsonPathExpression("v", type);
                const indexName = `idx_json_value_type_probe_${type.replaceAll(" ", "_")}`;

                try
                {
                    await db.executeCommand(`create index ${indexName} on json_value_type_probe(${expression});`);
                }
                catch (error)
                {
                    failures.push(`${type} -> ${(error as Error).message}`);
                }
            }

            assert.deepStrictEqual(failures, [], `not usable as index expressions: ${failures.join("; ")}`);

            await db.executeCommand("drop table if exists json_value_type_probe;");
        });

        // this is the correctness payoff of `type`, not just a performance one
        await test("a cast expression compares numerically where an uncast one compares as text", async () =>
        {
            const info = await creator.createSnapshotTableForAggregate(orderType, [{ path: "total", type: JsonValueType.numeric }]);

            await db.executeCommand(
                `insert into order_snaps (id, data) values ('a', ?), ('b', ?) on conflict (id) do update set data = excluded.data;`,
                JSON.stringify({ total: 9 }), JSON.stringify({ total: 100 }));

            const numeric = await db.executeQuery<any>(
                `select id from order_snaps where ${info.indexedExpressions["total"]} > 50 order by id;`);
            assert.deepStrictEqual(numeric.rows.map(t => t.id as string), ["b"]);

            // the same comparison without the cast picks '9' over '100'
            const asText = await db.executeQuery<any>(
                `select id from order_snaps where data->>'total' > '50' order by id;`);
            assert.deepStrictEqual(asText.rows.map(t => t.id as string), ["a"]);
        });
    });
});
