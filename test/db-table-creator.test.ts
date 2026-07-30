import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { DataHelper, Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, QueryResult, SnapshotIndex } from "../src/index.js";
import { TransactionProvider } from "../src/unit-of-work/transaction-provider.js";


// real state shapes and real aggregate classes, so the generic path typing is actually exercised -
// a cast to the non-generic alias would collapse TState to AggregateState and check nothing

interface Address
{
    city: string;
    postalCode: string;
    organizationId: string;                 // only the *top level* organizationId is excluded
}

interface Customer
{
    name: string;
    city: string;
    address: Address;
}

interface OrderState extends AggregateState
{
    status: string;
    total: number;
    email: string;
    orderNumber: string;
    tenantCode: string;
    sku: string;
    minTotal: number;
    maxTotal: number;
    customer: Customer;
    tags: Array<string>;                    // container: must not be offered as a path
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    validator: Function;                    // must not be offered, nor fabricate a subtree
    transform(x: string): string;           // must not be offered
}

interface InvoiceState extends OrgAggregateState
{
    status: string;
    total: number;
    email: string;
    invoiceNumber: string;
    series: string;
    customer: Customer;
}

// an index signature widens the path union to `string`, which disables the check entirely. Pinned
// so the Exclude in SnapshotPath cannot silently change that behaviour.
interface LooseState extends AggregateState
{
    [key: string]: any;
}

// the organizationId exclusion is unconditional, so it also lands on a PLAIN state that happens to
// keep one inside `data`. Off-pattern, but the escape hatch has to keep working for it.
interface PlainStateWithOrgId extends AggregateState
{
    organizationId: string;
    status: string;
}

class Order extends AggregateRoot<OrderState, DomainEvent<OrderState>> { }
class Invoice extends OrgAggregateRoot<InvoiceState, OrgDomainEvent<InvoiceState>> { }

// snake cased this is 67 chars, so every derived table name overflows the 63 char limit
class AggregateWithAnExtremelyLongNameThatOverflowsPostgresLimit extends AggregateRoot<OrderState, DomainEvent<OrderState>> { }

const orderType = Order;
const invoiceType = Invoice;
const overlongType = AggregateWithAnExtremelyLongNameThatOverflowsPostgresLimit;


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

        await test("snapshot table for an aggregate with no indexes emits no index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType);

            assert.strictEqual(info.tableName, DataHelper.createSnapshotTableName(orderType));
            assert.deepStrictEqual(info.indexes, []);
            assert.deepStrictEqual(db.commands, [
                "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );"
            ]);
        });

        await test("snapshot table adds no column for an indexed path - only an expression index", async () =>
        {
            const { creator, db } = createCreator();

            const statusIndex = SnapshotIndex.forPath<OrderState>("status");
            const info = await creator.createSnapshotTableForAggregate(orderType, [statusIndex]);

            // the table shape is identical to the no-indexes case
            assert.strictEqual(db.commands[0], "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );");
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));");
            assert.deepStrictEqual(info.indexes.map(t => t.expressions), [["(data->>'status')"]]);

            // and the declaration hands back the very expression the index was created from
            assert.strictEqual(statusIndex.expressionForPath("status"), "(data->>'status')");
        });

        await test("indexed path with a type casts inside the indexed expression", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric)]);

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_total on order_snaps(((data->>'total')::numeric));");
        });

        await test("nested indexed path uses #>> and an underscored index name", async () =>
        {
            const { creator, db } = createCreator();

            const cityIndex = SnapshotIndex.forPath<OrderState>("customer.city");
            const info = await creator.createSnapshotTableForAggregate(orderType, [cityIndex]);

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_customer_city on order_snaps((data#>>'{\"customer\",\"city\"}'));");
            assert.deepStrictEqual(info.indexes.map(t => t.paths), [["customer.city"]]);
            assert.strictEqual(cityIndex.expressionForPath("customer.city"), "(data#>>'{\"customer\",\"city\"}')");
        });

        await test("org snapshot table with no indexes emits an (organization_id) index", async () =>
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

            await creator.createSnapshotTableForOrgAggregate(invoiceType, [
                SnapshotIndex.forPath<InvoiceState>("status"),
                SnapshotIndex.forPath<InvoiceState>("total", JsonValueType.numeric)
            ]);

            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps_status on invoice_snaps(organization_id, (data->>'status'));",
                "create index if not exists idx_invoice_snaps_total on invoice_snaps(organization_id, ((data->>'total')::numeric));"
            ]);

            // no standalone (organization_id) index - each already leads with it
            assert.ok(!db.commands.contains("create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"));
        });

        await test("a unique index emits a unique index under a _uq name", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);

            assert.strictEqual(db.commands[1], "create unique index if not exists idx_order_snaps_email_uq on order_snaps((data->>'email'));");
        });

        await test("a unique index on an org table leads with organization_id", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, [SnapshotIndex.forPath<InvoiceState>("invoiceNumber").asUnique()]);

            // leading organization_id makes the uniqueness per organization rather than global
            assert.strictEqual(db.commands[1], "create unique index if not exists idx_invoice_snaps_invoicenumber_uq on invoice_snaps(organization_id, (data->>'invoiceNumber'));");
        });

        await test("asUnique is idempotent", async () =>
        {
            const once = createCreator();
            const twice = createCreator();

            await once.creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);
            await twice.creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique().asUnique()]);

            assert.deepStrictEqual(once.db.commands, twice.db.commands);
        });

        await test("unique and non-unique indexes can be mixed in one call", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forPath<OrderState>("status"),
                SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric).asUnique()
            ]);

            assert.deepStrictEqual(db.commands.slice(1), [
                "create unique index if not exists idx_order_snaps_email_uq on order_snaps((data->>'email'));",
                "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));",
                "create unique index if not exists idx_order_snaps_total_uq on order_snaps(((data->>'total')::numeric));"
            ]);
        });

        await test("an org table whose only index is unique still skips the standalone (organization_id) index", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, [SnapshotIndex.forPath<InvoiceState>("email").asUnique()]);

            assert.strictEqual(db.commands.length, 2);
            assert.ok(!db.commands.contains("create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"));
        });

        // pinned deliberately: the name encodes the paths and uniqueness, not the type. Creation is
        // `if not exists`, which matches on name alone, so this only matters when re-running against
        // a table that already exists - which is out of scope, since indexes are created once.
        await test("the index name does not encode the type", async () =>
        {
            const untyped = createCreator();
            const typed = createCreator();

            await untyped.creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("total")]);
            await typed.creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric)]);

            const nameOf = (sql: string): string => sql.split(" on ")[0].replace("create index if not exists ", "");

            assert.strictEqual(nameOf(untyped.db.commands[1]), "idx_order_snaps_total");
            assert.strictEqual(nameOf(typed.db.commands[1]), "idx_order_snaps_total");
            assert.notStrictEqual(untyped.db.commands[1], typed.db.commands[1]);
        });

        await test("a padded path is trimmed for the index name, the reported path and the readback", async () =>
        {
            const padded = createCreator();
            const plain = createCreator();

            const paddedIndex = SnapshotIndex.forRawPath<OrderState>("  status  ");
            const paddedInfo = await padded.creator.createSnapshotTableForAggregate(orderType, [paddedIndex]);
            await plain.creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status")]);

            // the reported path is the JSON key actually extracted, not the padded input
            assert.deepStrictEqual(paddedInfo.indexes.map(t => t.paths), [["status"]]);
            assert.deepStrictEqual(padded.db.commands, plain.db.commands);

            // and the readback resolves from either spelling, since the stored key is trimmed
            assert.strictEqual(paddedIndex.expressionForRawPath("status"), "(data->>'status')");
            assert.strictEqual(paddedIndex.expressionForRawPath("  status  "), "(data->>'status')");
        });

        await test("several paths in one index make a composite, in the order given", async () =>
        {
            const { creator, db } = createCreator();

            const skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique();
            const info = await creator.createSnapshotTableForAggregate(orderType, [skuIndex]);

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_order_snaps_tenantcode_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");

            // column order is declaration order, and that is what decides what is searchable:
            // 'sku' is the second column, so a predicate on it alone cannot use this index even
            // though its expression is available. `indexes` is what says so; see the test below.
            assert.deepStrictEqual(info.indexes[0].paths, ["tenantCode", "sku"]);
            assert.deepStrictEqual(info.indexes[0].expressions, ["(data->>'tenantCode')", "(data->>'sku')"]);

            // every member of a composite reads back, each naming its own column
            assert.strictEqual(skuIndex.expressionForPath("tenantCode"), "(data->>'tenantCode')");
            assert.strictEqual(skuIndex.expressionForPath("sku"), "(data->>'sku')");
        });

        await test("indexes reports grouping, column order and the leading column", async () =>
        {
            const plain = createCreator();
            const org = createCreator();

            const plainInfo = await plain.creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique(),
                SnapshotIndex.forPath<OrderState>("status")
            ]);

            assert.deepStrictEqual(plainInfo.indexes, [
                {
                    name: "idx_order_snaps_tenantcode_sku_uq",
                    paths: ["tenantCode", "sku"],
                    expressions: ["(data->>'tenantCode')", "(data->>'sku')"],
                    isUnique: true,
                    leadingColumn: undefined
                },
                {
                    name: "idx_order_snaps_status",
                    paths: ["status"],
                    expressions: ["(data->>'status')"],
                    isUnique: false,
                    leadingColumn: undefined
                }
            ]);

            // an org index reports the real column a predicate must also constrain
            const orgInfo = await org.creator.createSnapshotTableForOrgAggregate(invoiceType, [
                SnapshotIndex.forPath<InvoiceState>("status")
            ]);

            assert.deepStrictEqual(orgInfo.indexes, [
                {
                    name: "idx_invoice_snaps_status",
                    paths: ["status"],
                    expressions: ["(data->>'status')"],
                    isUnique: false,
                    leadingColumn: "organization_id"
                }
            ]);
        });

        await test("indexes is empty when nothing was declared", async () =>
        {
            const { creator } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType);

            assert.deepStrictEqual(info.indexes, []);
        });

        // the DDL and the returned metadata come from one synchronous pass, so a builder mutated
        // after the handoff cannot make the contract advertise an index that was never created
        await test("mutating a builder after the call cannot desynchronise the returned contract", async () =>
        {
            const { creator, db } = createCreator();
            const index = SnapshotIndex.forPath<OrderState>("status");

            const pending = creator.createSnapshotTableForAggregate(orderType, [index]);
            index.andPath("total", JsonValueType.numeric);          // mid-flight mutation
            const info = await pending;

            // the contract describes exactly what was emitted, not the mutated builder
            assert.strictEqual(info.indexes.length, 1);
            assert.deepStrictEqual(info.indexes[0].paths, ["status"]);
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));");

            // and this is exactly why the returned record is not a pointer back to the builder: the
            // builder now answers for a path no index covers, while the record still does not list it
            assert.strictEqual(index.expressionForPath("total"), "((data->>'total')::numeric)");
            assert.ok(!info.indexes[0].paths.contains("total"));
        });

        await test("a composite index need not be unique", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status").andPath("createdAt")]);

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_status_createdat on order_snaps((data->>'status'), (data->>'createdAt'));");
        });

        await test("a composite on an org table leads with organization_id, making the tuple unique per org", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, [
                SnapshotIndex.forPath<InvoiceState>("series").andPath("invoiceNumber").asUnique()
            ]);

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_invoice_snaps_series_invoicenumber_uq on invoice_snaps(organization_id, (data->>'series'), (data->>'invoiceNumber'));");
        });

        await test("an explicit name replaces the derived one", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique().withName("tenant_sku")
            ]);

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_order_snaps_tenant_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");
        });

        // the whole point of the builder: each path carries its own cast, so a mixed-type composite
        // is expressible. The old index-level type could only cast all of them, which produced an
        // index whose expression fails on insert for any non-numeric value.
        await test("each path in a composite carries its own type", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("status").andPath("createdAt", JsonValueType.bigint)
            ]);

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_status_createdat on order_snaps((data->>'status'), ((data->>'createdAt')::bigint));");
        });

        await test("a type can also be applied to every path of a composite", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("minTotal", JsonValueType.numeric).andPath("maxTotal", JsonValueType.numeric)
            ]);

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_mintotal_maxtotal on order_snaps(((data->>'minTotal')::numeric), ((data->>'maxTotal')::numeric));");
        });

        await test("an empty indexes array behaves like omitting it", async () =>
        {
            const withEmpty = createCreator();
            const withUndefined = createCreator();

            await withEmpty.creator.createSnapshotTableForAggregate(orderType, []);
            await withUndefined.creator.createSnapshotTableForAggregate(orderType);

            assert.deepStrictEqual(withEmpty.db.commands, withUndefined.db.commands);
        });
    });

    await describe("Path typing", async () =>
    {
        // compile-time coverage: each @ts-expect-error fails the build if the error stops occurring,
        // so "paths are checked against the state" is verified rather than asserted
        await test("valid paths compile and invalid ones do not", () =>
        {
            SnapshotIndex.forPath<OrderState>("status");
            SnapshotIndex.forPath<OrderState>("customer.city");
            SnapshotIndex.forPath<OrderState>("customer.address.postalCode");
            SnapshotIndex.forPath<OrderState>("updatedAt");                              // inherited from AggregateState
            SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku");

            // @ts-expect-error - "stauts" is not a key of OrderState
            SnapshotIndex.forPath<OrderState>("stauts");
            // @ts-expect-error - "customer.ctiy" is not a nested key of OrderState
            SnapshotIndex.forPath<OrderState>("customer.ctiy");
            // @ts-expect-error - "invoiceNumber" belongs to InvoiceState, not OrderState
            SnapshotIndex.forPath<OrderState>("invoiceNumber");
            // @ts-expect-error - andPath is checked too
            SnapshotIndex.forPath<OrderState>("status").andPath("stauts");

            // the escape hatch takes any string, for computed keys
            const dynamicKey: string = "status";
            SnapshotIndex.forRawPath<OrderState>(dynamicKey);

            assert.ok(true);
        });

        // containers are not paths: indexing one covers jsonb's own text rendering of a subtree,
        // which orders keys itself, so a predicate built in JS could never match it
        await test("container keys are not offered as paths", () =>
        {
            // @ts-expect-error - an object-valued key is not a leaf
            SnapshotIndex.forPath<OrderState>("customer");
            // @ts-expect-error - an array-valued key is not offerable at all
            SnapshotIndex.forPath<OrderState>("tags");
            // @ts-expect-error - array elements are not addressable by dot notation
            SnapshotIndex.forPath<OrderState>("tags.length");

            // forRawPath remains the deliberate way through
            SnapshotIndex.forRawPath<OrderState>("customer");

            assert.ok(true);
        });

        // `Function` does not match a call signature in TypeScript, so without naming it explicitly
        // a Function-typed key falls through to the object branch and fabricates its own methods
        // as paths. Verified by compiling both forms before choosing this one.
        await test("function-valued keys are not offered, nor is a subtree fabricated from them", () =>
        {
            // @ts-expect-error - a Function-typed key is not a leaf
            SnapshotIndex.forPath<OrderState>("validator");
            // @ts-expect-error - and its members must not become paths
            SnapshotIndex.forPath<OrderState>("validator.name");
            // @ts-expect-error - an arrow-typed key is not a leaf either
            SnapshotIndex.forPath<OrderState>("transform");

            assert.ok(true);
        });

        await test("a builder bound to the wrong state is rejected by the create method", async () =>
        {
            const { creator } = createCreator();

            // @ts-expect-error - an InvoiceState index cannot be used on an Order snapshot table
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<InvoiceState>("invoiceNumber")]);
        });

        // the read side is checked by the same type as the write side, so there is one rule, not two.
        // NOTE: unlike the write-side fixtures above, these EXECUTE against a real index - and
        // expressionForPath enforces membership at runtime - so each negative sits inside
        // assert.throws. That pins both halves at once: if the compile error stops occurring the
        // unused directive fails the build, and if the runtime guard stops firing the assert fails.
        await test("read-side paths are checked against the state, membership at runtime", () =>
        {
            const statusIndex = SnapshotIndex.forPath<OrderState>("status");

            // covered by this index: compiles and resolves
            assert.strictEqual(statusIndex.expressionForPath("status"), "(data->>'status')");

            // a valid OrderState path this index does not cover: type-checks, throws. This is the
            // seam - the type checks the path exists, the index checks that it covers it.
            assert.throws(() => statusIndex.expressionForPath("customer.city"));

            // @ts-expect-error - "stauts" is not a key of OrderState
            assert.throws(() => statusIndex.expressionForPath("stauts"));
            // @ts-expect-error - a container key is not a path
            assert.throws(() => statusIndex.expressionForPath("customer"));
            // @ts-expect-error - "invoiceNumber" belongs to InvoiceState, not OrderState
            assert.throws(() => statusIndex.expressionForPath("invoiceNumber"));

            // the raw door stays open, for a path declared with forRawPath
            const dynamicKey: string = "status";
            assert.strictEqual(statusIndex.expressionForRawPath(dynamicKey), "(data->>'status')");
        });

        // organizationId is a real column on an org snapshot table, indexed as one and leading every
        // index. The copy inside `data` is not what any index covers, so the path is always wrong.
        await test("organizationId is not offered as a path, at the top level only", () =>
        {
            SnapshotIndex.forPath<InvoiceState>("status");
            SnapshotIndex.forPath<InvoiceState>("customer.address.organizationId");   // a genuine nested leaf

            // @ts-expect-error - organizationId is a real column, not a key inside data
            SnapshotIndex.forPath<InvoiceState>("organizationId");
            // @ts-expect-error - nor addable to a composite
            SnapshotIndex.forPath<InvoiceState>("status").andPath("organizationId");

            // forRawPath remains the deliberate way through, as it is for containers
            SnapshotIndex.forRawPath<InvoiceState>("organizationId");

            // the exclusion is unconditional, so a plain state carrying one loses forPath too - and
            // forRawPath is what that case is expected to use
            SnapshotIndex.forPath<PlainStateWithOrgId>("status");
            // @ts-expect-error - excluded on every state, not only org-scoped ones
            SnapshotIndex.forPath<PlainStateWithOrgId>("organizationId");
            assert.strictEqual(
                SnapshotIndex.forRawPath<PlainStateWithOrgId>("organizationId").expressions[0],
                "(data->>'organizationId')");

            // Exclude<string, "organizationId"> is still string, so a state whose paths widen to
            // `string` is unaffected - the widening hole swallows this rule along with all the others
            SnapshotIndex.forPath<LooseState>("anythingGoes");
            SnapshotIndex.forPath<LooseState>("organizationId");

            assert.ok(true);
        });
    });

    await describe("Query expressions come from the declaration", async () =>
    {
        // the single-source proof: Postgres only uses an expression index when the query expression
        // matches the indexed one textually, so a predicate built off the declaration and the DDL
        // emitted from it must be byte-identical. There is no second builder to diverge from.
        await test("expressionForPath is byte-identical to what the index was created from", async () =>
        {
            const { creator, db } = createCreator();

            const statusIndex = SnapshotIndex.forPath<OrderState>("status");
            const totalIndex = SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric);
            const cityIndex = SnapshotIndex.forPath<OrderState>("customer.city");
            const skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique();

            const info = await creator.createSnapshotTableForAggregate(
                orderType, [statusIndex, totalIndex, cityIndex, skuIndex]);

            assert.strictEqual(statusIndex.expressionForPath("status"), "(data->>'status')");
            assert.strictEqual(totalIndex.expressionForPath("total"), "((data->>'total')::numeric)");
            assert.strictEqual(cityIndex.expressionForPath("customer.city"), "(data#>>'{\"customer\",\"city\"}')");
            assert.strictEqual(skuIndex.expressionForPath("tenantCode"), "(data->>'tenantCode')");
            assert.strictEqual(skuIndex.expressionForPath("sku"), "(data->>'sku')");

            // each one appears verbatim in the DDL that was emitted, and in the created record
            const ddl = db.commands.join("\n");
            const expected = [
                statusIndex.expressionForPath("status"),
                totalIndex.expressionForPath("total"),
                cityIndex.expressionForPath("customer.city"),
                skuIndex.expressionForPath("tenantCode"),
                skuIndex.expressionForPath("sku")
            ];

            for (const expression of expected)
            {
                assert.ok(ddl.contains(expression), `expected the DDL to contain ${expression}`);
                assert.ok(info.indexes.some(t => t.expressions.contains(expression)));
            }
        });

        await test("a path this index does not cover throws, and names what it does cover", () =>
        {
            const statusIndex = SnapshotIndex.forPath<OrderState>("status");
            const skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku");

            // "email" is a perfectly valid OrderState path - it just is not in this index
            assert.throws(() => statusIndex.expressionForPath("email"), (e: Exception) =>
                e.message.contains("email") && e.message.contains("status"));

            assert.throws(() => skuIndex.expressionForRawPath("nope"), (e: Exception) =>
                e.message.contains("tenantCode, sku"));
        });

        await test("expressionForRawPath rejects a path that is null, empty or whitespace", () =>
        {
            const statusIndex = SnapshotIndex.forPath<OrderState>("status");

            assert.throws(() => statusIndex.expressionForRawPath(null as unknown as string));
            assert.throws(() => statusIndex.expressionForRawPath(""));
            assert.throws(() => statusIndex.expressionForRawPath("   "));
        });

        await test("paths and expressions stay aligned and in declaration order", () =>
        {
            const index = SnapshotIndex.forPath<OrderState>("tenantCode")
                .andPath("total", JsonValueType.numeric)
                .andPath("sku")
                .asUnique()
                .withName("natural_key");

            assert.deepStrictEqual(index.paths, ["tenantCode", "total", "sku"]);
            assert.deepStrictEqual(index.expressions, [
                "(data->>'tenantCode')", "((data->>'total')::numeric)", "(data->>'sku')"
            ]);

            // positionally matched, which is the contract SnapshotTableIndexInfo repeats.
            // Read back through the raw door, since `paths` is a plain string array here.
            index.paths.forEach((path, i) =>
                assert.strictEqual(index.expressionForRawPath(path), index.expressions[i]));
        });
    });

    await describe("Expression building", async () =>
    {
        // the builder itself is private - reached only through a declaration, which is the point.
        // These go through forRawPath so a malformed path can be exercised at all.
        const expressionFor = (path: string, type?: JsonValueType): string =>
            SnapshotIndex.forRawPath<OrderState>(path, type).expressions[0];

        await test("builds ->> for a top level key and #>> for a nested one", () =>
        {
            assert.strictEqual(expressionFor("status"), "(data->>'status')");
            assert.strictEqual(expressionFor("customer.city"), "(data#>>'{\"customer\",\"city\"}')");
            assert.strictEqual(expressionFor("a.b.c"), "(data#>>'{\"a\",\"b\",\"c\"}')");
        });

        await test("appends the cast when a type is given", () =>
        {
            assert.strictEqual(expressionFor("total", JsonValueType.numeric), "((data->>'total')::numeric)");
            assert.strictEqual(expressionFor("ratio", JsonValueType.doublePrecision), "((data->>'ratio')::double precision)");
            assert.strictEqual(expressionFor("createdAt", JsonValueType.bigint), "((data->>'createdAt')::bigint)");
            assert.strictEqual(expressionFor("customer.id", JsonValueType.uuid), "((data#>>'{\"customer\",\"id\"}')::uuid)");
        });

        await test("rejects a path that could break out of the string literal", () =>
        {
            assert.throws(() => expressionFor("status') or true--"));
            assert.throws(() => expressionFor("a'b"));
            assert.throws(() => expressionFor("a,b"));
            assert.throws(() => expressionFor("a}"));
        });

        await test("rejects an empty path segment", () =>
        {
            assert.throws(() => expressionFor("a..b"));
            assert.throws(() => expressionFor(".a"));
            assert.throws(() => expressionFor("a."));
        });

        await test("rejects a path that is null, empty or whitespace", () =>
        {
            assert.throws(() => expressionFor(null as unknown as string));
            assert.throws(() => expressionFor(""));
            assert.throws(() => expressionFor("   "));
        });

        await test("rejects a type outside JsonValueType", () =>
        {
            const notAType = (t: string): JsonValueType => t as JsonValueType;

            assert.throws(() => expressionFor("total", notAType("numeric); drop table x --")));
            assert.throws(() => expressionFor("total", notAType("Numeric")));
            assert.throws(() => expressionFor("total", notAType("int[]")));
            // reachable via an immutable cast, but excluded on purpose - see JsonValueType
            assert.throws(() => expressionFor("total", notAType("varchar(20)")));
            assert.throws(() => expressionFor("tags", notAType("jsonb")));
            // rejected by Postgres itself in an index expression, so not offered
            assert.throws(() => expressionFor("createdAt", notAType("timestamptz")));
            assert.throws(() => expressionFor("createdAt", notAType("date")));
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

        // the table name is validated before any index name is composed, so the error names the
        // identifier that is actually at fault rather than a derived one
        await test("an overlong table name is blamed on the table, not on a derived index name", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(overlongType, [SnapshotIndex.forPath<OrderState>("status")]),
                (error: Error) =>
                {
                    assert.ok(error.message.contains("tableName"), `expected a tableName error, got: ${error.message}`);
                    assert.ok(!error.message.contains("indexName"));
                    return true;
                });
        });
    });

    // the builder validates as each path is added, so these throw where the index is declared
    // rather than when the table is created
    await describe("Builder validation", async () =>
    {
        await test("rejects a malformed path at the declaration site", () =>
        {
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>("a'b"));
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>(""));
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>("   "));
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>("a,b"));
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>("a..b"));
            assert.throws(() => SnapshotIndex.forRawPath<OrderState>(null as unknown as string));
        });

        await test("rejects a type outside JsonValueType at the declaration site", () =>
        {
            assert.throws(() => SnapshotIndex.forPath<OrderState>("total", "int[]" as JsonValueType));
        });

        await test("rejects an index that repeats a path within itself", () =>
        {
            assert.throws(() => SnapshotIndex.forPath<OrderState>("sku").andPath("sku"));
            assert.throws(() => SnapshotIndex.forPath<OrderState>("sku").andRawPath("  sku  "));
        });

        await test("rejects an invalid explicit name", () =>
        {
            assert.throws(() => SnapshotIndex.forPath<OrderState>("status").withName("Status"));
            assert.throws(() => SnapshotIndex.forPath<OrderState>("status").withName("has space"));
            assert.throws(() => SnapshotIndex.forPath<OrderState>("status").withName("1status"));
            assert.throws(() => SnapshotIndex.forPath<OrderState>("status").withName(""));
        });

        await test("rejects setting the name twice", () =>
        {
            assert.throws(() => SnapshotIndex.forPath<OrderState>("status").withName("a").withName("b"));
        });

        // an index with no paths is unrepresentable: the only way to get one is forPath/forRawPath,
        // which supplies the first
        await test("nameSuffix, isUnique and paths reflect what was declared", () =>
        {
            const index = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique();

            assert.strictEqual(index.nameSuffix, "tenantcode_sku");
            assert.strictEqual(index.isUnique, true);
            assert.deepStrictEqual(index.paths, ["tenantCode", "sku"]);

            assert.strictEqual(SnapshotIndex.forPath<OrderState>("status").withName("custom").nameSuffix, "custom");
            assert.strictEqual(SnapshotIndex.forPath<OrderState>("status").isUnique, false);
        });
    });

    // these need the whole set, or the table name, so they throw from the create call
    await describe("Cross-index validation", async () =>
    {
        await test("rejects two indexes over the same path, since they derive one name", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forPath<OrderState>("status")]));
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forRawPath<OrderState>("  status  ")]));
        });

        await test("rejects the same index declared twice under different names", async () =>
        {
            const { creator } = createCreator();

            // distinct names, so a name collision cannot be what rejects this
            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(orderType, [
                    SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").withName("a"),
                    SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").withName("b")
                ]),
                (error: Error) =>
                {
                    assert.ok(error.message.contains("declared twice"), `expected a duplicate-index error, got: ${error.message}`);
                    return true;
                });
        });

        await test("rejects one path indexed with different types across indexes", async () =>
        {
            const { creator } = createCreator();

            // distinct names, so only the type conflict can be what rejects this
            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(orderType, [
                    SnapshotIndex.forPath<OrderState>("total").withName("a"),
                    SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric).withName("b")
                ]),
                (error: Error) =>
                {
                    assert.ok(error.message.contains("different types"), `expected a type-conflict error, got: ${error.message}`);
                    assert.ok(error.message.contains("total"));
                    return true;
                });
        });

        await test("allows one path across several indexes when the type agrees", async () =>
        {
            const { creator, db } = createCreator();

            // 'sku' alone for lookups, and as part of a composite natural key
            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("sku"),
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ]);

            assert.strictEqual(db.commands.length, 3);
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_sku on order_snaps((data->>'sku'));");
            assert.strictEqual(db.commands[2],
                "create unique index if not exists idx_order_snaps_tenantcode_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");
        });

        await test("rejects distinct paths whose derived index names would collide", async () =>
        {
            const { creator } = createCreator();

            // both derive the suffix 'created_at', and `if not exists` would silently skip the second
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("created.at"), SnapshotIndex.forRawPath<OrderState>("created_at")]));
            // case only differences fold to the same identifier
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("createdAt"), SnapshotIndex.forRawPath<OrderState>("createdat")]));
        });

        await test("rejects a path whose index name would overflow the identifier limit", async () =>
        {
            const { creator } = createCreator();

            // idx_ (4) + order_snaps (11) + _ (1) + 48 = 64, one over
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("a".repeat(48))]));
            await assert.doesNotReject(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("a".repeat(47))]));
        });

        await test("the identifier limit is 3 chars tighter for a unique index, because of the _uq suffix", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("a".repeat(45)).asUnique()]));
            await assert.doesNotReject(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("a".repeat(44)).asUnique()]));
        });

        await test("rejects a unique index whose _uq name collides with a plain index's name", async () =>
        {
            const { creator } = createCreator();

            // 'email' + unique -> idx_order_snaps_email_uq, and so does the literal path 'email_uq'
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forRawPath<OrderState>("email_uq")
            ]));
        });

        // the contrast to the above, and the reason the _uq suffix exists: the same path can
        // carry both a unique index and a plain one, because their names differ
        await test("allows one path indexed both uniquely and not", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forPath<OrderState>("email")
            ]);

            assert.strictEqual(db.commands[1], "create unique index if not exists idx_order_snaps_email_uq on order_snaps((data->>'email'));");
            assert.strictEqual(db.commands[2], "create index if not exists idx_order_snaps_email on order_snaps((data->>'email'));");
        });

        await test("rejects a plain object masquerading as a SnapshotIndex", async () =>
        {
            const { creator } = createCreator();
            // structurally complete, so only the instanceof check can reject it
            const notABuilder = {
                paths: ["status"], expressions: ["(data->>'status')"], isUnique: false, nameSuffix: "status",
                expressionForPath: (): string => "(data->>'status')",
                expressionForRawPath: (): string => "(data->>'status')"
            };

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [notABuilder as unknown as SnapshotIndex<OrderState>]));
        });

        await test("no DDL is emitted when validation fails", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forPath<OrderState>("status")]));

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

        // Whether a predicate can *use* an index is not decidable by comparing strings: Postgres
        // normalizes an index expression when it stores it, and the planner matches parse trees. So
        // ask the planner. Callers must seed enough rows and `analyze` first, or every plan is a seq
        // scan and the assertions pass vacuously.
        const planFor = async (table: string, predicate: string): Promise<string> =>
        {
            const explained = await db.executeQuery<any>(
                `explain (costs off) select id from ${table} where ${predicate};`);

            return explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");
        };


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
                SnapshotIndex.forPath<InvoiceState>("status"),
                SnapshotIndex.forPath<InvoiceState>("total", JsonValueType.numeric),
                SnapshotIndex.forPath<InvoiceState>("customer.city")
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

            // none of these declared isUnique, so none may have come out unique
            // (the primary key index is excluded - it is legitimately unique)
            for (const [name, definition] of byName)
                if (name.startsWith("idx_"))
                    assert.ok(!definition.contains("UNIQUE"), `${name} should not be unique: ${definition}`);

            // the standalone (organization_id) index is skipped when others already lead with it
            assert.ok(!byName.has("idx_invoice_snaps"));
        });

        // The one claim this whole design exists to guarantee: a predicate built off the declaration
        // actually *uses* the index. This cannot be checked by comparing strings. Postgres normalizes
        // an index expression when it stores it - `(data->>'status')` comes back as
        // `((data ->> 'status'::text))`, and a quoted #>> path array loses its quotes entirely - and
        // the planner matches parse trees, not text. So ask the planner instead. The near-miss is the
        // control: without it, a test that only shows the matching form working proves nothing, since
        // it cannot distinguish "the expression matched" from "the planner would have used it anyway".
        await test("a predicate built from expressionForPath uses the index; a hand-written near-miss does not", async () =>
        {
            const statusIndex = SnapshotIndex.forPath<OrderState>("status");
            const totalIndex = SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric);
            const cityIndex = SnapshotIndex.forPath<OrderState>("customer.city");

            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [statusIndex, totalIndex, cityIndex]);

            // enough rows, with statistics, that an index scan is the cheaper plan for a selective
            // predicate - otherwise every plan is a seq scan and the assertions below are vacuous
            await db.executeCommand(
                `insert into order_snaps (id, data)
                 select 'ord_' || g,
                        json_build_object('status', 'st' || (g % 500), 'total', g,
                                          'customer', json_build_object('city', 'city' || (g % 500)))::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze order_snaps;");

            // each expression comes from the declaration the index was created from
            const onStatus = await planFor("order_snaps", `${statusIndex.expressionForPath("status")} = 'st7'`);
            assert.ok(onStatus.contains("idx_order_snaps_status"), onStatus);

            const onTotal = await planFor("order_snaps", `${totalIndex.expressionForPath("total")} > 4990`);
            assert.ok(onTotal.contains("idx_order_snaps_total"), onTotal);

            // the nested one also proves the quoted '{"a","b"}' form matches an index Postgres stored
            // as the unquoted '{a,b}'::text[] - both literals parse to the same constant
            const onCity = await planFor("order_snaps", `${cityIndex.expressionForPath("customer.city")} = 'city7'`);
            assert.ok(onCity.contains("idx_order_snaps_customer_city"), onCity);

            // the control: the same path, hand-written without the cast, cannot use the numeric index
            const nearMiss = await planFor("order_snaps", `data->>'total' > '4990'`);
            assert.ok(!nearMiss.contains("idx_order_snaps_total"), nearMiss);
            assert.ok(nearMiss.contains("Seq Scan"), nearMiss);

            await db.executeCommand("drop table if exists order_snaps;");
        });

        // The leading-prefix rule is asserted all over these docs - it decides whether the second
        // path of a composite is searchable at all - and until now nothing demonstrated it. The two
        // predicates below are equally selective and built from the same declaration; the only
        // variable is column position, which is what makes this a demonstration and not a
        // coincidence.
        await test("only a leading prefix of a composite is searchable", async () =>
        {
            const skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku");

            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [skuIndex]);
            await db.executeCommand(
                `insert into order_snaps (id, data)
                 select 'ord_' || g, json_build_object('tenantCode', 'tc' || (g % 500), 'sku', 'sku' || (g % 500))::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze order_snaps;");

            const leading = await planFor("order_snaps", `${skuIndex.expressionForPath("tenantCode")} = 'tc7'`);
            assert.ok(leading.contains("idx_order_snaps_tenantcode_sku"), leading);

            // the second column alone cannot be served, however exactly the expression matches
            const second = await planFor("order_snaps", `${skuIndex.expressionForPath("sku")} = 'sku7'`);
            assert.ok(!second.contains("idx_order_snaps_tenantcode_sku"), second);
            assert.ok(second.contains("Seq Scan"), second);

            // both together is the full prefix
            const both = await planFor("order_snaps",
                `${skuIndex.expressionForPath("tenantCode")} = 'tc7' and ${skuIndex.expressionForPath("sku")} = 'sku7'`);
            assert.ok(both.contains("idx_order_snaps_tenantcode_sku"), both);

            await db.executeCommand("drop table if exists order_snaps;");
        });

        // the org counterpart, and the reason OrgSnapshotBaseRepository.query insists the caller
        // filters organization_id: omitting it is not only a tenant-isolation bug, it also loses the
        // index outright, because organization_id is the leading column of every index on the table
        await test("on an org table nothing is searchable until organization_id is constrained", async () =>
        {
            const statusIndex = SnapshotIndex.forPath<InvoiceState>("status");

            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, [statusIndex]);
            await db.executeCommand(
                `insert into invoice_snaps (id, organization_id, data)
                 select 'inv_' || g, 'org' || (g % 5), json_build_object('status', 'st' || (g % 500))::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze invoice_snaps;");

            const scoped = await planFor("invoice_snaps",
                `organization_id = 'org1' and ${statusIndex.expressionForPath("status")} = 'st7'`);
            assert.ok(scoped.contains("idx_invoice_snaps_status"), scoped);

            // the same expression without the org filter falls off the index entirely
            const unscoped = await planFor("invoice_snaps", `${statusIndex.expressionForPath("status")} = 'st7'`);
            assert.ok(!unscoped.contains("idx_invoice_snaps_status"), unscoped);
            assert.ok(unscoped.contains("Seq Scan"), unscoped);

            // and organization_id alone is a valid leading prefix, which is why the creator skips a
            // standalone (organization_id) index whenever any expression index is declared
            const orgOnly = await planFor("invoice_snaps", `organization_id = 'org1'`);
            assert.ok(orgOnly.contains("idx_invoice_snaps_status"), orgOnly);

            await db.executeCommand("drop table if exists invoice_snaps;");
        });

        // documented limit: the default text opclass serves = and ordering, but not a prefix LIKE,
        // unless the database collation is C. Pinned so the doc claim cannot quietly go stale.
        await test("a prefix LIKE does not use the index under a non-C collation", async () =>
        {
            const emailIndex = SnapshotIndex.forPath<OrderState>("email");

            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [emailIndex]);
            await db.executeCommand(
                `insert into order_snaps (id, data)
                 select 'ord_' || g, json_build_object('email', 'user' || (g % 500) || '@x.com')::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze order_snaps;");

            const collation = await db.executeQuery<any>("show lc_collate;");
            assert.notStrictEqual(collation.rows[0].lc_collate, "C", "this limit only holds for a non-C collation");

            // the control: the index is usable, so a failure below is about LIKE and nothing else
            const equality = await planFor("order_snaps", `${emailIndex.expressionForPath("email")} = 'user7@x.com'`);
            assert.ok(equality.contains("idx_order_snaps_email"), equality);

            const prefix = await planFor("order_snaps", `${emailIndex.expressionForPath("email")} like 'user7@%'`);
            assert.ok(!prefix.contains("idx_order_snaps_email"), prefix);
            assert.ok(prefix.contains("Seq Scan"), prefix);

            await db.executeCommand("drop table if exists order_snaps;");
        });

        // documented limit: uniqueness is over the extracted text exactly as stored, so it does not
        // collapse case or trim. Anyone reading `asUnique` as "unique email" needs to see this.
        await test("a unique index compares extracted text exactly - no case folding, no trimming", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);

            const insert = `insert into order_snaps (id, data) values(?, ?);`;
            await db.executeCommand(insert, "ord_1", JSON.stringify({ email: "a@x.com" }));
            await db.executeCommand(insert, "ord_2", JSON.stringify({ email: "A@x.com" }));      // differing case
            await db.executeCommand(insert, "ord_3", JSON.stringify({ email: " a@x.com " }));    // padded

            // the control: an exact repeat is still rejected, so the index really is enforcing
            await assert.rejects(() => db.executeCommand(insert, "ord_4", JSON.stringify({ email: "a@x.com" })));

            const rows = await db.executeQuery<any>("select count(*)::int as n from order_snaps;");
            assert.strictEqual(rows.rows[0].n, 3);

            await db.executeCommand("drop table if exists order_snaps;");
        });

        // JsonValueType.text is documented as a no-op. It is more than that: Postgres elides the
        // redundant cast, so the two forms are the SAME index and their predicates are
        // interchangeable. Worth pinning, because it is the one case where two different expression
        // strings are equivalent - everywhere else textual divergence costs the index.
        await test("JsonValueType.text is elided, so the cast and uncast forms are one index", async () =>
        {
            const uncast = SnapshotIndex.forPath<OrderState>("status");
            const textCast = SnapshotIndex.forPath<OrderState>("status", JsonValueType.text).withName("status_text");

            assert.notStrictEqual(uncast.expressionForPath("status"), textCast.expressionForPath("status"));

            await db.executeCommand("drop table if exists order_snaps;");

            // two calls, not one: declaring both together trips the cross-index rule that one path
            // may not be indexed with two different types (pinned separately above). That rule is
            // stricter than Postgres needs for this particular pair - which is exactly what the
            // identical index definitions below show - but it costs nothing, since declaring both is
            // a modelling mistake regardless.
            await creator.createSnapshotTableForAggregate(orderType, [uncast]);
            await creator.createSnapshotTableForAggregate(orderType, [textCast]);

            const defs = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'order_snaps' and indexname like 'idx_%' order by indexname;`);
            const normalized = defs.rows.map(t => (t.indexdef as string).replace(/idx_order_snaps\w*/, "NAME"));

            // different declarations, byte-identical stored definitions
            assert.strictEqual(normalized.length, 2);
            assert.strictEqual(normalized[0], normalized[1]);

            await db.executeCommand(
                `insert into order_snaps (id, data)
                 select 'ord_' || g, json_build_object('status', 'st' || (g % 500))::jsonb from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze order_snaps;");

            // and either expression uses an index, in either direction
            for (const expression of [uncast.expressionForPath("status"), textCast.expressionForPath("status")])
            {
                const plan = await planFor("order_snaps", `${expression} = 'st7'`);
                assert.ok(plan.contains("Index Scan"), `${expression} -> ${plan}`);
            }

            await db.executeCommand("drop table if exists order_snaps;");
        });

        // these pin the created tables to the exact SQL the repositories emit, so neither side can
        // drift from the other unnoticed
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

        await test("OrgSnapshotBaseRepository's insert and upsert succeed against a table with indexes", async () =>
        {
            const statusIndex = SnapshotIndex.forPath<InvoiceState>("status");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, [statusIndex]);

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
                `select id from invoice_snaps where organization_id = ? and ${statusIndex.expressionForPath("status")} = ?;`,
                "org_1", "sent");

            assert.deepStrictEqual(result.rows.map(t => t.id as string), ["inv_1"]);
        });

        await test("a unique expression index is accepted and enforces uniqueness on the extracted value", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);

            const indexes = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'order_snaps' and indexname = 'idx_order_snaps_email_uq';`);

            assert.strictEqual(indexes.rows.length, 1);
            assert.ok((indexes.rows[0].indexdef as string).contains("UNIQUE"));

            // the exact statement SnapshotBaseRepository.save emits for a new aggregate
            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            await db.executeCommand(insert, "ord_1", JSON.stringify({ email: "a@b.com" }));
            await db.executeCommand(insert, "ord_2", JSON.stringify({ email: "c@d.com" }));

            // a different aggregate claiming an email that is already taken must fail
            await assert.rejects(() => db.executeCommand(insert, "ord_3", JSON.stringify({ email: "a@b.com" })));
        });

        // an absent key extracts as null, and Postgres allows any number of nulls in a unique
        // index - which is what makes a sparse natural key usable
        await test("rows whose data omits the unique key do not collide with each other", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);

            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            await db.executeCommand(insert, "ord_1", JSON.stringify({ status: "draft" }));
            await db.executeCommand(insert, "ord_2", JSON.stringify({ status: "draft" }));

            const result = await db.executeQuery<any>(`select cast(count(*) as int) as count from order_snaps;`);
            assert.strictEqual(result.rows[0].count, 2);
        });

        // this is the claim that justifies leading org indexes with organization_id
        await test("uniqueness on an org table is scoped to the organization, not global", async () =>
        {
            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, [SnapshotIndex.forPath<InvoiceState>("invoiceNumber").asUnique()]);

            // the exact statement OrgSnapshotBaseRepository.save emits for a new aggregate
            const insert = `insert into invoice_snaps (id, organization_id, data) values(?, ?, ?);`;

            await db.executeCommand(insert, "inv_1", "org_1", JSON.stringify({ invoiceNumber: "INV-001" }));

            // the same natural key under a different organization is fine
            await assert.doesNotReject(
                () => db.executeCommand(insert, "inv_2", "org_2", JSON.stringify({ invoiceNumber: "INV-001" })));

            // but a duplicate within one organization is not
            await assert.rejects(
                () => db.executeCommand(insert, "inv_3", "org_1", JSON.stringify({ invoiceNumber: "INV-001" })));
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
                const expression = SnapshotIndex.forRawPath<OrderState>("v", type).expressions[0];
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
            const totalIndex = SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric);
            await creator.createSnapshotTableForAggregate(orderType, [totalIndex]);

            await db.executeCommand(
                `insert into order_snaps (id, data) values ('a', ?), ('b', ?) on conflict (id) do update set data = excluded.data;`,
                JSON.stringify({ total: 9 }), JSON.stringify({ total: 100 }));

            const numeric = await db.executeQuery<any>(
                `select id from order_snaps where ${totalIndex.expressionForPath("total")} > 50 order by id;`);
            assert.deepStrictEqual(numeric.rows.map(t => t.id as string), ["b"]);

            // the same comparison without the cast picks '9' over '100'
            const asText = await db.executeQuery<any>(
                `select id from order_snaps where data->>'total' > '50' order by id;`);
            assert.deepStrictEqual(asText.rows.map(t => t.id as string), ["a"]);
        });

        await test("a composite unique constraint enforces the tuple, not the members", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ]);

            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            await db.executeCommand(insert, "ord_1", JSON.stringify({ tenantCode: "acme", sku: "A1" }));

            // differing in either member is fine
            await assert.doesNotReject(() => db.executeCommand(insert, "ord_2", JSON.stringify({ tenantCode: "acme", sku: "A2" })));
            await assert.doesNotReject(() => db.executeCommand(insert, "ord_3", JSON.stringify({ tenantCode: "globex", sku: "A1" })));

            // the same pair is not
            await assert.rejects(() => db.executeCommand(insert, "ord_4", JSON.stringify({ tenantCode: "acme", sku: "A1" })));
        });

        // the fixed null behavior: Postgres treats nulls as distinct, so a row missing any
        // member of the tuple never collides
        await test("a composite does not constrain rows missing a member", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ]);

            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            await db.executeCommand(insert, "ord_1", JSON.stringify({ tenantCode: "acme" }));
            await db.executeCommand(insert, "ord_2", JSON.stringify({ tenantCode: "acme" }));

            const result = await db.executeQuery<any>(`select cast(count(*) as int) as count from order_snaps;`);
            assert.strictEqual(result.rows[0].count, 2);
        });

        await test("a composite non-unique index is created and is not unique", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status").andPath("createdAt")]);

            const indexes = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'order_snaps' and indexname = 'idx_order_snaps_status_createdat';`);

            assert.strictEqual(indexes.rows.length, 1);
            assert.ok(!(indexes.rows[0].indexdef as string).contains("UNIQUE"));
            assert.ok((indexes.rows[0].indexdef as string).contains("'status'"));
            assert.ok((indexes.rows[0].indexdef as string).contains("'createdAt'"));
        });

        // the payoff of per-path types, and the case the old index-level `type` broke: casting the
        // whole index would emit ((data->>'status')::bigint), which is accepted on an empty table and
        // then fails every insert whose status is not numeric
        await test("a mixed-type composite is created and accepts inserts", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [
                SnapshotIndex.forPath<OrderState>("status").andPath("createdAt", JsonValueType.bigint)
            ]);

            const indexes = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'order_snaps' and indexname = 'idx_order_snaps_status_createdat';`);
            assert.strictEqual(indexes.rows.length, 1);
            assert.ok((indexes.rows[0].indexdef as string).contains("bigint"));

            // a non-numeric status inserts fine, because only createdAt is cast
            await db.executeCommand(
                `insert into order_snaps (id, data) values(?, ?);`,
                "ord_1", JSON.stringify({ status: "draft", createdAt: 1700000000000 }));

            const result = await db.executeQuery<any>(`select cast(count(*) as int) as count from order_snaps;`);
            assert.strictEqual(result.rows[0].count, 1);
        });

        // the failure the per-path design removes, demonstrated rather than assumed: casting a text
        // value in an index expression is accepted at create time and breaks writes afterward
        await test("casting a non-numeric path would have broken inserts", async () =>
        {
            await db.executeCommand("drop table if exists cast_trap_probe; create table cast_trap_probe (data jsonb not null);");

            // accepted, because an empty table never evaluates the expression
            await assert.doesNotReject(() => db.executeCommand(
                `create index idx_cast_trap_probe on cast_trap_probe(((data->>'status')::bigint));`));

            // and then rejects a perfectly ordinary row
            await assert.rejects(() => db.executeCommand(
                `insert into cast_trap_probe (data) values(?);`, JSON.stringify({ status: "draft" })));

            await db.executeCommand("drop table if exists cast_trap_probe;");
        });

        await test("a composite on an org table is unique per organization", async () =>
        {
            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, [
                SnapshotIndex.forPath<InvoiceState>("series").andPath("invoiceNumber").asUnique()
            ]);

            const insert = `insert into invoice_snaps (id, organization_id, data) values(?, ?, ?);`;
            const tuple = JSON.stringify({ series: "A", invoiceNumber: "001" });

            await db.executeCommand(insert, "inv_1", "org_1", tuple);

            // the same tuple under a different organization is fine
            await assert.doesNotReject(() => db.executeCommand(insert, "inv_2", "org_2", tuple));

            // within one organization it is not
            await assert.rejects(() => db.executeCommand(insert, "inv_3", "org_1", tuple));
        });

        await test("the org event stream table and its 3-column unique index are created", async () =>
        {
            await db.executeCommand("drop table if exists invoice_events;");
            await creator.createEventStreamTableForOrgAggregate(invoiceType);

            const columns = await db.executeQuery<any>(
                `select column_name from information_schema.columns where table_name = 'invoice_events' order by ordinal_position;`);
            assert.deepStrictEqual(columns.rows.map(t => t.column_name as string),
                ["id", "aggregate_id", "aggregate_version", "organization_id", "data"]);

            const indexes = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'invoice_events' and indexname = 'idx_invoice_events';`);
            assert.strictEqual(indexes.rows.length, 1);
            assert.ok((indexes.rows[0].indexdef as string).contains("UNIQUE"));
            assert.ok((indexes.rows[0].indexdef as string).contains("organization_id, aggregate_id, aggregate_version"));

            // the exact statement OrgEventStreamBaseRepository.save emits
            const insert = `insert into invoice_events (id, aggregate_id, aggregate_version, organization_id, data) values (?, ?, ?, ?, ?);`;

            await db.executeCommand(insert, "inv_1-1", "inv_1", 1, "org_1", JSON.stringify({ $name: "InvoiceCreated" }));

            // concurrency is enforced per aggregate within the organization
            await assert.rejects(() => db.executeCommand(
                insert, "inv_1-1-dupe", "inv_1", 1, "org_1", JSON.stringify({ $name: "InvoiceAmended" })));
        });

        // L2: an *unquoted* element matching NULL in a '{...}' array literal is a null element, and
        // #>> returns null when any element is null - so the segments must be quoted or a key
        // literally named "null" yields an index that is null for every row.
        await test("a path segment named null is indexed as itself, not as a SQL NULL element", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            // declared raw, since "meta" is not on OrderState - so it reads back raw too
            const nullIndex = SnapshotIndex.forRawPath<OrderState>("meta.null");
            await creator.createSnapshotTableForAggregate(orderType, [nullIndex]);

            await db.executeCommand(
                `insert into order_snaps (id, data) values(?, ?);`,
                "ord_1", JSON.stringify({ meta: { null: "present" } }));

            // the extracted value is the key's value, not null
            const result = await db.executeQuery<any>(
                `select ${nullIndex.expressionForRawPath("meta.null")} as v from order_snaps;`);
            assert.strictEqual(result.rows[0].v, "present");

            // and the unquoted form it replaced really would have been null
            const unquoted = await db.executeQuery<any>(
                `select (data#>>'{meta,null}') is null as was_null from order_snaps;`);
            assert.strictEqual(unquoted.rows[0].was_null, true);
        });

        // L3: the btree index-tuple limit is checked on insert, and applies to the COMPRESSED size -
        // so a repetitive 4KB value indexes fine while an incompressible one of the same length does
        // not. A test using repeat('x', 4000) would pass and prove nothing.
        await test("an index over an unbounded value breaks writes only once the value is incompressible", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forRawPath<OrderState>("notes")]);

            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            // highly compressible: fits after compression
            await assert.doesNotReject(() => db.executeCommand(insert, "ord_1", JSON.stringify({ notes: "x".repeat(4000) })));

            // incompressible at the same length: exceeds the 2704 byte index tuple limit on INSERT
            const incompressible = Array.from({ length: 250 }, (_, i) => `${i}-${Math.random().toString(36).slice(2)}`).join("");
            assert.ok(incompressible.length > 2704);
            await assert.rejects(() => db.executeCommand(insert, "ord_2", JSON.stringify({ notes: incompressible })));
        });

        // G1: asUnique documents that a violation raises rather than being absorbed, because the
        // repositories name (id) as the on-conflict arbiter and Postgres only routes conflicts on the
        // arbiter. Nothing exercised that, so a change making the unique index the arbiter would
        // silently swallow duplicates with the suite still green.
        await test("the repositories' on-conflict upsert does not absorb a unique-expression violation", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("email").asUnique()]);

            await db.executeCommand(
                `insert into order_snaps (id, data) values(?, ?);`,
                "ord_1", JSON.stringify({ email: "a@b.com" }));

            // the exact statement SnapshotBaseRepository.save emits for an EXISTING aggregate
            const upsert = `insert into order_snaps (id, data) values(?, ?) on conflict (id) do update set data = excluded.data;`;

            // a different id claiming a taken email must raise, not be absorbed as an update
            await assert.rejects(() => db.executeCommand(upsert, "ord_2", JSON.stringify({ email: "a@b.com" })));

            // while the same id updating its own row still works
            await assert.doesNotReject(() => db.executeCommand(upsert, "ord_1", JSON.stringify({ email: "c@d.com" })));
        });

        await test("a plain snapshot table with no indexes is just (id, data) with only its primary key", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType);

            const columns = await db.executeQuery<any>(
                `select column_name from information_schema.columns where table_name = 'order_snaps' order by ordinal_position;`);
            assert.deepStrictEqual(columns.rows.map(t => t.column_name as string), ["id", "data"]);

            // the primary key index, and nothing else
            const indexes = await db.executeQuery<any>(
                `select indexname from pg_indexes where tablename = 'order_snaps' order by indexname;`);
            assert.deepStrictEqual(indexes.rows.map(t => t.indexname as string), ["order_snaps_pkey"]);
        });

        await test("an org snapshot table with no indexes gets the standalone (organization_id) index", async () =>
        {
            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType);

            const indexes = await db.executeQuery<any>(
                `select indexname, indexdef from pg_indexes where tablename = 'invoice_snaps' order by indexname;`);
            const byName = new Map(indexes.rows.map(t => [t.indexname as string, t.indexdef as string]));

            // the inverse of the "skipped when others lead with it" case asserted above
            assert.ok(byName.has("idx_invoice_snaps"));
            assert.ok(byName.get("idx_invoice_snaps")!.contains("organization_id"));
            assert.ok(!byName.get("idx_invoice_snaps")!.contains("UNIQUE"));
        });
    });
});
