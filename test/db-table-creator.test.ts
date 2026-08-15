import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { DataHelper, Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, QueryResult, SnapshotArrayIndex, SnapshotIndex, SnapshotQuerySet, SnapshotTableOptions } from "../src/index.js";
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
    nicknames: Array<string>;               // a nested scalar array: an array path, not a scalar one
    contacts: Array<Member>;                // a nested array of flat records: also an array path
}

// the driving shape: a flat record, so its TypeScript names are its stored keys
interface Member
{
    userId: string;
    role: string;
    isDeactivated: boolean;
}

// an UNTYPED serialize(): its return type is keyless, so the stored element shape is unknowable -
// which is how an array of bare Serializable is kept out (nothing checkable, so nothing offered)
interface Serialish
{
    id: string;
    serialize(): object;
}

// stand-ins for n-domain DomainObjects: a typed serialize() (n-domain >= 4.0.1) is what the path
// types recurse into, and the substitution is structural, so these exercise it without depending on
// n-domain classes

// the serialized shape drops the derived getter and the method noise
interface Plan
{
    readonly tier: string;
    readonly seatLimit: number;
    readonly isUnlimited: boolean;          // derived getter - NOT serialized, must not be a path
    serialize(): { tier: string; seatLimit: number; };
    equals(value: object | null): boolean;  // method noise the serialized shape strips
}

// a DomainObject nested in a DomainObject: the serialized shape's member is the CLASS type, so the
// substitution has to apply again one level down
interface Billing
{
    readonly plan: Plan;
    readonly currency: string;
    readonly summary: string;               // NOT serialized
    serialize(): { plan: Plan; currency: string; };
}

// extends bare Serializable: serialize() returns Record<string, any>, which must offer NO nested
// paths - substituting the index signature would widen the subtree's paths to `${string}` instead
interface BareSerialish
{
    readonly foo: string;
    serialize(): Record<string, any>;
}

// an array element with a FLAT typed serialized shape: legally containment-indexable, since the
// stored element carries exactly those keys (plus a $typename that @> subset matching ignores)
interface PlanChange
{
    readonly tier: string;
    readonly changedAt: number;
    readonly isRecent: boolean;             // derived - not serialized, must not be a match key
    serialize(): { tier: string; changedAt: number; };
}

// an element whose SERIALIZED shape nests a DomainObject: not a flat record, so still excluded
interface AuditEntry
{
    serialize(): { actor: Plan; note: string; };
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
    tags: Array<string>;                    // container: not a scalar path, but IS an array path
    scores: ReadonlyArray<number>;
    flags: Array<boolean>;
    mixed: Array<string | number>;          // a union of scalars: still an array path
    tainted: Array<string | Customer>;      // a union carrying an object: must not be offered
    matrix: Array<Array<string>>;           // an array of arrays: must not be offered
    nested: Array<{ a: string; b: Address; }>;  // an element that nests: must not be offered
    serials: Array<Serialish>;              // an element with an untyped serialize(): must not be offered
    plan: Plan;                             // typed serialize(): paths follow the serialized shape
    billing: Billing;                       // a serializable inside a serializable: substituted at every level
    bare: BareSerialish;                    // untyped serialize(): offers no nested paths at all
    planHistory: Array<PlanChange>;         // element with a flat serialized shape: an array path
    audits: Array<AuditEntry>;              // element whose serialized shape nests: must not be offered
    optionalTags?: Array<string>;
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
    labels: Array<string>;
}

// the use case this feature exists for: given a userId, find the teams where that user is a member
// AND that member is not deactivated - two conditions that must hold on the SAME element
interface TeamState extends AggregateState
{
    name: string;
    members: Array<Member>;
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
class Team extends AggregateRoot<TeamState, DomainEvent<TeamState>> { }

// snake cased this is 67 chars, so every derived table name overflows the 63 char limit
class AggregateWithAnExtremelyLongNameThatOverflowsPostgresLimit extends AggregateRoot<OrderState, DomainEvent<OrderState>> { }

const orderType = Order;
const invoiceType = Invoice;
const teamType = Team;
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
            assert.deepStrictEqual(info.createdIndexes, []);
            assert.deepStrictEqual(db.commands, [
                "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );"
            ]);
        });

        await test("snapshot table adds no column for an indexed path - only an expression index", async () =>
        {
            const { creator, db } = createCreator();

            const statusIndex = SnapshotIndex.forPath<OrderState>("status");
            const info = await creator.createSnapshotTableForAggregate(orderType, { indexes: [statusIndex], arrayIndexes: [] });

            // the table shape is identical to the no-indexes case
            assert.strictEqual(db.commands[0], "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );");
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));");
            assert.deepStrictEqual(info.createdIndexes.map(t => t.expressions), [["(data->>'status')"]]);

            // and the declaration hands back the very expression the index was created from
            assert.strictEqual(statusIndex.expressionForPath("status"), "(data->>'status')");
        });

        await test("indexed path with a type casts inside the indexed expression", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric)], arrayIndexes: [] });

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_total on order_snaps(((data->>'total')::numeric));");
        });

        await test("nested indexed path uses #>> and an underscored index name", async () =>
        {
            const { creator, db } = createCreator();

            const cityIndex = SnapshotIndex.forPath<OrderState>("customer.city");
            const info = await creator.createSnapshotTableForAggregate(orderType, { indexes: [cityIndex], arrayIndexes: [] });

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_customer_city on order_snaps((data#>>'{\"customer\",\"city\"}'));");
            assert.deepStrictEqual(info.createdIndexes.map(t => t.paths), [["customer.city"]]);
            assert.strictEqual(cityIndex.expressionForPath("customer.city"), "(data#>>'{\"customer\",\"city\"}')");
        });

        // the serialized-shape substitution is purely compile-time: a path through a serializable
        // member emits exactly the DDL any nested path does
        await test("a path through a serialized shape emits the same DDL as any nested path", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, {
                indexes: [SnapshotIndex.forPath<OrderState>("plan.tier")],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("planHistory")]
            });

            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_plan_tier on order_snaps((data#>>'{\"plan\",\"tier\"}'));");
            assert.strictEqual(db.commands[2], "create index if not exists idx_order_snaps_planhistory_gin on order_snaps using gin((data->'planHistory') jsonb_path_ops);");
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

            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [
                SnapshotIndex.forPath<InvoiceState>("status"),
                SnapshotIndex.forPath<InvoiceState>("total", JsonValueType.numeric)
            ], arrayIndexes: [] });

            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps_status on invoice_snaps(organization_id, (data->>'status'));",
                "create index if not exists idx_invoice_snaps_total on invoice_snaps(organization_id, ((data->>'total')::numeric));"
            ]);

            // no standalone (organization_id) index - each already leads with it
            assert.ok(!db.commands.contains("create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"));
        });

        await test("an array index emits a single-column GIN index with the jsonb_path_ops opclass", async () =>
        {
            const { creator, db } = createCreator();

            const membersIndex = SnapshotArrayIndex.forPath<TeamState>("members");
            const info = await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            // the table shape is identical to the no-indexes case: nothing is added, the index is
            // built directly over the extraction expression
            assert.deepStrictEqual(db.commands, [
                "create table if not exists team_snaps ( id varchar(40) primary key, data jsonb not null );",
                "create index if not exists idx_team_snaps_members_gin on team_snaps using gin((data->'members') jsonb_path_ops);"
            ]);

            // -> not ->>: the index is over the array AS JSONB, since @> is a jsonb operator
            assert.deepStrictEqual(info.createdIndexes, [{
                name: "idx_team_snaps_members_gin",
                paths: ["members"],
                expressions: ["(data->'members')"],
                isUnique: false,
                method: "gin"
            }]);

            // and the declaration's predicate embeds the very expression the index was created from
            assert.ok(membersIndex.containmentForPath("members").contains({ userId: "u1" }).sql
                .contains(info.createdIndexes[0].expressions[0]));
        });

        await test("a nested array path uses #> and an underscored index name", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("customer.nicknames")]
            });

            assert.strictEqual(
                db.commands[1],
                "create index if not exists idx_order_snaps_customer_nicknames_gin on order_snaps using gin((data#>'{\"customer\",\"nicknames\"}') jsonb_path_ops);");
        });

        await test("withName overrides the derived suffix, keeping the _gin marker", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(teamType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<TeamState>("members").withName("m")]
            });

            assert.strictEqual(
                db.commands[1],
                "create index if not exists idx_team_snaps_m_gin on team_snaps using gin((data->'members') jsonb_path_ops);");
        });

        // the _gin suffix is load-bearing, not descriptive: `if not exists` matches on NAME alone, so
        // an index whose name is already taken is silently skipped rather than reported. Cross-kind
        // collision through withName is what it has to survive, since one path indexed as both is
        // itself rejected (see Cross-index validation).
        await test("a GIN index name cannot collide with a btree one", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, {
                indexes: [SnapshotIndex.forPath<OrderState>("status").withName("tags_gin")],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags")]
            }));

            // and nothing was emitted - the whole plan is validated before any DDL runs
            assert.deepStrictEqual(db.commands, []);
        });

        await test("btree and GIN indexes are emitted in declaration order, btrees first", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForAggregate(orderType, {
                indexes: [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric)],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags"), SnapshotArrayIndex.forPath<OrderState>("scores")]
            });

            assert.deepStrictEqual(db.commands, [
                "create table if not exists order_snaps ( id varchar(40) primary key, data jsonb not null );",
                "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));",
                "create index if not exists idx_order_snaps_total on order_snaps(((data->>'total')::numeric));",
                "create index if not exists idx_order_snaps_tags_gin on order_snaps using gin((data->'tags') jsonb_path_ops);",
                "create index if not exists idx_order_snaps_scores_gin on order_snaps using gin((data->'scores') jsonb_path_ops);"
            ]);

            assert.deepStrictEqual(info.createdIndexes.map(t => t.method), [undefined, undefined, "gin", "gin"]);
        });

        // THE org-table change: a GIN index cannot lead with organization_id, so it is not a
        // substitute for the standalone one the way a btree expression index is
        await test("an org table declaring only array indexes still gets the standalone (organization_id) index", async () =>
        {
            const { creator, db } = createCreator();

            const info = await creator.createSnapshotTableForOrgAggregate(invoiceType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<InvoiceState>("labels")]
            });

            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps_labels_gin on invoice_snaps using gin((data->'labels') jsonb_path_ops);",
                "create index if not exists idx_invoice_snaps on invoice_snaps(organization_id);"
            ]);

            // organization_id is NOT prepended to the GIN index, and leadingColumn does not claim it -
            // reporting one would be a claim the caller builds a predicate on
            assert.strictEqual(info.createdIndexes[0].leadingColumn, undefined);
            assert.deepStrictEqual(info.createdIndexes[0].expressions, ["(data->'labels')"]);
        });

        await test("an org table with a btree index skips the standalone one even alongside an array index", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, {
                indexes: [SnapshotIndex.forPath<InvoiceState>("status")],
                arrayIndexes: [SnapshotArrayIndex.forPath<InvoiceState>("labels")]
            });

            assert.deepStrictEqual(db.commands, [
                "create table if not exists invoice_snaps ( id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null );",
                "create index if not exists idx_invoice_snaps_status on invoice_snaps(organization_id, (data->>'status'));",
                "create index if not exists idx_invoice_snaps_labels_gin on invoice_snaps using gin((data->'labels') jsonb_path_ops);"
            ]);
        });

        // a query set satisfies SnapshotTableOptions by shape, and this is the assertion that keeps
        // that true: the recommended form and the explicit one have to emit byte-identical DDL, or
        // "the migration creates what the repository queries" stops being a guarantee
        await test("a query set and the equivalent options object are interchangeable", async () =>
        {
            const viaSet = createCreator();
            const viaOptions = createCreator();

            const querySet = SnapshotQuerySet.for<OrderState>()
                .withPath("status")
                .withPath("orderNumber", { unique: true })
                .withArrayPath("tags");

            const setInfo = await viaSet.creator.createSnapshotTableForAggregate(orderType, querySet);
            const optionsInfo = await viaOptions.creator.createSnapshotTableForAggregate(orderType, {
                indexes: [...querySet.indexes],
                arrayIndexes: [...querySet.arrayIndexes]
            });

            assert.deepStrictEqual(viaSet.db.commands, viaOptions.db.commands);
            assert.deepStrictEqual(setInfo, optionsInfo);

            // and omitting the argument means the same as two empty collections
            const omitted = createCreator();
            const explicit = createCreator();

            await omitted.creator.createSnapshotTableForOrgAggregate(invoiceType);
            await explicit.creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [], arrayIndexes: [] });

            assert.deepStrictEqual(omitted.db.commands, explicit.db.commands);
        });

        // the whole reason both fields are required: this shape used to compile, create every btree
        // index, and silently omit every GIN one
        await test("passing only a query set's btree indexes does not compile", () =>
        {
            const querySet = SnapshotQuerySet.for<OrderState>().withPath("status").withArrayPath("tags");

            // @ts-expect-error - arrayIndexes is required, so the GIN index cannot be dropped silently
            const options: SnapshotTableOptions<OrderState> = { indexes: [...querySet.indexes] };

            assert.ok(options);
        });

        await test("a unique index emits a unique index under a _uq name", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });

            assert.strictEqual(db.commands[1], "create unique index if not exists idx_order_snaps_email_uq on order_snaps((data->>'email'));");
        });

        await test("a unique index on an org table leads with organization_id", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [SnapshotIndex.forPath<InvoiceState>("invoiceNumber").asUnique()], arrayIndexes: [] });

            // leading organization_id makes the uniqueness per organization rather than global
            assert.strictEqual(db.commands[1], "create unique index if not exists idx_invoice_snaps_invoicenumber_uq on invoice_snaps(organization_id, (data->>'invoiceNumber'));");
        });

        await test("asUnique is idempotent", async () =>
        {
            const once = createCreator();
            const twice = createCreator();

            await once.creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });
            await twice.creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique().asUnique()], arrayIndexes: [] });

            assert.deepStrictEqual(once.db.commands, twice.db.commands);
        });

        await test("unique and non-unique indexes can be mixed in one call", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forPath<OrderState>("status"),
                SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric).asUnique()
            ], arrayIndexes: [] });

            assert.deepStrictEqual(db.commands.slice(1), [
                "create unique index if not exists idx_order_snaps_email_uq on order_snaps((data->>'email'));",
                "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));",
                "create unique index if not exists idx_order_snaps_total_uq on order_snaps(((data->>'total')::numeric));"
            ]);
        });

        await test("an org table whose only index is unique still skips the standalone (organization_id) index", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [SnapshotIndex.forPath<InvoiceState>("email").asUnique()], arrayIndexes: [] });

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

            await untyped.creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("total")], arrayIndexes: [] });
            await typed.creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric)], arrayIndexes: [] });

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
            const paddedInfo = await padded.creator.createSnapshotTableForAggregate(orderType, { indexes: [paddedIndex], arrayIndexes: [] });
            await plain.creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status")], arrayIndexes: [] });

            // the reported path is the JSON key actually extracted, not the padded input
            assert.deepStrictEqual(paddedInfo.createdIndexes.map(t => t.paths), [["status"]]);
            assert.deepStrictEqual(padded.db.commands, plain.db.commands);

            // and the readback resolves from either spelling, since the stored key is trimmed
            assert.strictEqual(paddedIndex.expressionForRawPath("status"), "(data->>'status')");
            assert.strictEqual(paddedIndex.expressionForRawPath("  status  "), "(data->>'status')");
        });

        await test("several paths in one index make a composite, in the order given", async () =>
        {
            const { creator, db } = createCreator();

            const skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique();
            const info = await creator.createSnapshotTableForAggregate(orderType, { indexes: [skuIndex], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_order_snaps_tenantcode_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");

            // column order is declaration order, and that is what decides what is searchable:
            // 'sku' is the second column, so a predicate on it alone cannot use this index even
            // though its expression is available. `indexes` is what says so; see the test below.
            assert.deepStrictEqual(info.createdIndexes[0].paths, ["tenantCode", "sku"]);
            assert.deepStrictEqual(info.createdIndexes[0].expressions, ["(data->>'tenantCode')", "(data->>'sku')"]);

            // every member of a composite reads back, each naming its own column
            assert.strictEqual(skuIndex.expressionForPath("tenantCode"), "(data->>'tenantCode')");
            assert.strictEqual(skuIndex.expressionForPath("sku"), "(data->>'sku')");
        });

        await test("indexes reports grouping, column order and the leading column", async () =>
        {
            const plain = createCreator();
            const org = createCreator();

            const plainInfo = await plain.creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique(),
                SnapshotIndex.forPath<OrderState>("status")
            ], arrayIndexes: [] });

            assert.deepStrictEqual(plainInfo.createdIndexes, [
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
            const orgInfo = await org.creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [
                SnapshotIndex.forPath<InvoiceState>("status")
            ], arrayIndexes: [] });

            assert.deepStrictEqual(orgInfo.createdIndexes, [
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

            assert.deepStrictEqual(info.createdIndexes, []);
        });

        // the DDL and the returned metadata come from one synchronous pass, so a builder mutated
        // after the handoff cannot make the contract advertise an index that was never created
        // this used to assert that mutating a builder after the call could not put the returned
        // contract out of step, and it could: `andPath` returned `this` and mutated, so a builder handed to a
        // create call could grow a path mid-flight and afterwards answer for one no index covered.
        // The builders are copy-on-write now, matching `SnapshotQuerySet`, so there is no mutation to
        // survive - the guarantee is stronger and the test says so
        await test("a builder cannot be mutated, so it can never disagree with what was created", async () =>
        {
            const { creator, db } = createCreator();
            const index = SnapshotIndex.forPath<OrderState>("status");

            const pending = creator.createSnapshotTableForAggregate(orderType, { indexes: [index], arrayIndexes: [] });
            const grown = index.andPath("total", JsonValueType.numeric);    // a new index, not a mutation
            const info = await pending;

            assert.notStrictEqual(grown, index);
            assert.deepStrictEqual(index.paths, ["status"]);
            assert.deepStrictEqual(grown.paths, ["status", "total"]);

            // the contract describes exactly what was emitted, and so does the builder it came from
            assert.strictEqual(info.createdIndexes.length, 1);
            assert.deepStrictEqual(info.createdIndexes[0].paths, ["status"]);
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_status on order_snaps((data->>'status'));");

            // the receiver never learned the new path, so it cannot answer for one no index covers
            assert.throws(() => index.expressionForPath("total"));
            assert.strictEqual(grown.expressionForPath("total"), "((data->>'total')::numeric)");
            assert.ok(!info.createdIndexes[0].paths.contains("total"));
        });

        await test("asUnique and withName also copy, leaving the receiver as it was", async () =>
        {
            const plain = SnapshotIndex.forPath<OrderState>("email");
            const unique = plain.asUnique();
            const named = plain.withName("em");

            assert.notStrictEqual(unique, plain);
            assert.notStrictEqual(named, plain);

            assert.strictEqual(plain.isUnique, false);
            assert.strictEqual(unique.isUnique, true);

            assert.strictEqual(plain.nameSuffix, "email");
            assert.strictEqual(named.nameSuffix, "em");
            // the name went onto the copy only, so the receiver can still be named
            assert.strictEqual(unique.nameSuffix, "email");

            const array = SnapshotArrayIndex.forPath<OrderState>("tags");
            const arrayNamed = array.withName("tg");

            assert.notStrictEqual(arrayNamed, array);
            assert.strictEqual(array.nameSuffix, "tags");
            assert.strictEqual(arrayNamed.nameSuffix, "tg");
        });

        await test("a composite index need not be unique", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status").andPath("createdAt")], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_status_createdat on order_snaps((data->>'status'), (data->>'createdAt'));");
        });

        await test("a composite on an org table leads with organization_id, making the tuple unique per org", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [
                SnapshotIndex.forPath<InvoiceState>("series").andPath("invoiceNumber").asUnique()
            ], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_invoice_snaps_series_invoicenumber_uq on invoice_snaps(organization_id, (data->>'series'), (data->>'invoiceNumber'));");
        });

        await test("an explicit name replaces the derived one", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique().withName("tenant_sku")
            ], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create unique index if not exists idx_order_snaps_tenant_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");
        });

        // the whole point of the builder: each path carries its own cast, so a mixed-type composite
        // is expressible. The old index-level type could only cast all of them, which produced an
        // index whose expression fails on insert for any non-numeric value.
        await test("each path in a composite carries its own type", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("status").andPath("createdAt", JsonValueType.bigint)
            ], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_status_createdat on order_snaps((data->>'status'), ((data->>'createdAt')::bigint));");
        });

        await test("a type can also be applied to every path of a composite", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("minTotal", JsonValueType.numeric).andPath("maxTotal", JsonValueType.numeric)
            ], arrayIndexes: [] });

            assert.strictEqual(db.commands[1],
                "create index if not exists idx_order_snaps_mintotal_maxtotal on order_snaps(((data->>'minTotal')::numeric), ((data->>'maxTotal')::numeric));");
        });

        await test("an empty indexes array behaves like omitting it", async () =>
        {
            const withEmpty = createCreator();
            const withUndefined = createCreator();

            await withEmpty.creator.createSnapshotTableForAggregate(orderType, { indexes: [], arrayIndexes: [] });
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

        // nested paths follow the SERIALIZED shape: for a member with a typed serialize(), what is
        // offered is what _serializeForSnapshot actually stores - the return type of serialize()
        await test("paths through a serializable member follow its serialized shape", () =>
        {
            SnapshotIndex.forPath<OrderState>("plan.tier");
            SnapshotIndex.forPath<OrderState>("plan.seatLimit");
            SnapshotIndex.forPath<OrderState>("billing.currency");
            SnapshotIndex.forPath<OrderState>("billing.plan.tier");          // substituted twice

            // @ts-expect-error - a derived getter is absent from the stored record (the gap this closes)
            SnapshotIndex.forPath<OrderState>("plan.isUnlimited");
            // @ts-expect-error - methods are not stored keys
            SnapshotIndex.forPath<OrderState>("plan.equals");
            // $typename is stored but not addressable - and both halves are pinned at once here: the
            // type does not offer it, and the segment regex throws on '$' even through the raw door
            // @ts-expect-error - not offered by the path type
            assert.throws(() => SnapshotIndex.forPath<OrderState>("plan.$typename"));
            // @ts-expect-error - not serialized on the nested serializable either
            SnapshotIndex.forPath<OrderState>("billing.plan.isUnlimited");
            // @ts-expect-error - not serialized
            SnapshotIndex.forPath<OrderState>("billing.summary");

            // the widening guard: an UNTYPED serialize() must not substitute its index signature,
            // which would widen this subtree's paths to `${string}` and compile any suffix
            // @ts-expect-error - a bare Serializable offers no nested paths, even for real properties
            SnapshotIndex.forPath<OrderState>("bare.foo");
            // @ts-expect-error - and no fabricated ones either
            SnapshotIndex.forPath<OrderState>("bare.anything");

            // forRawPath remains the deliberate way through for what the stored shape cannot offer
            SnapshotIndex.forRawPath<OrderState>("bare.foo");

            assert.ok(true);
        });

        await test("a builder bound to the wrong state is rejected by the create method", async () =>
        {
            const { creator } = createCreator();

            // @ts-expect-error - an InvoiceState index cannot be used on an Order snapshot table
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<InvoiceState>("invoiceNumber")], arrayIndexes: [] });
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

    await describe("Array path typing", async () =>
    {
        // the two unions are mirrors: SnapshotLeafPath maps arrays to never, this one maps leaves to
        // never. Both directions are pinned, because the disjointness is what makes a key belong to
        // exactly one kind of index.
        await test("array paths and scalar paths are disjoint", () =>
        {
            SnapshotArrayIndex.forPath<OrderState>("tags");
            SnapshotArrayIndex.forPath<TeamState>("members");
            SnapshotArrayIndex.forPath<OrderState>("customer.nicknames");    // nested
            SnapshotArrayIndex.forPath<OrderState>("customer.contacts");     // nested array of records
            SnapshotArrayIndex.forPath<OrderState>("optionalTags");          // an optional array key

            // @ts-expect-error - a leaf scalar is not an array path
            SnapshotArrayIndex.forPath<OrderState>("status");
            // @ts-expect-error - nor is an object-valued key
            SnapshotArrayIndex.forPath<OrderState>("customer");
            // @ts-expect-error - array elements are not addressable by dot notation
            SnapshotArrayIndex.forPath<OrderState>("tags.length");
            // @ts-expect-error - a Function-typed key, and no fabricated subtree
            SnapshotArrayIndex.forPath<OrderState>("validator");
            // @ts-expect-error - "tgas" is not a key of OrderState
            SnapshotArrayIndex.forPath<OrderState>("tgas");

            // ...and the other direction: SnapshotIndex still refuses every one of these
            // @ts-expect-error - an array-valued key is not a leaf
            SnapshotIndex.forPath<TeamState>("members");

            // the escape hatch takes any string
            const dynamicKey: string = "tags";
            SnapshotArrayIndex.forRawPath<OrderState>(dynamicKey);

            assert.ok(true);
        });

        // scalar arrays and arrays of FLAT records are offered; everything else fails closed to
        // forRawPath, where the caller explicitly owns knowing the elements' stored shape
        await test("only arrays of scalars or of flat scalar records are offered", () =>
        {
            SnapshotArrayIndex.forPath<OrderState>("scores");                // ReadonlyArray<number>
            SnapshotArrayIndex.forPath<OrderState>("flags");                 // Array<boolean>
            SnapshotArrayIndex.forPath<OrderState>("mixed");                 // a union of scalars is fine

            // @ts-expect-error - THE case the non-distributive brackets exist for: naked, the
            // `string` arm alone would yield the key and this would silently compile
            SnapshotArrayIndex.forPath<OrderState>("tainted");
            // @ts-expect-error - an array of arrays is not offerable
            SnapshotArrayIndex.forPath<OrderState>("matrix");
            // @ts-expect-error - an element carrying a nested member is not a flat record
            SnapshotArrayIndex.forPath<OrderState>("nested");
            // @ts-expect-error - an UNTYPED serialize() yields a keyless stored shape, which is how
            // an array of bare Serializable is kept out: nothing checkable, so nothing offered
            SnapshotArrayIndex.forPath<OrderState>("serials");

            // forRawPath remains the deliberate way through for every one of those
            SnapshotArrayIndex.forRawPath<OrderState>("serials");

            assert.ok(true);
        });

        // the element judgment is also over the STORED shape: a typed serialize() makes an array of
        // serializable elements indexable when its serialized record is flat, and keeps it out when it nests
        await test("arrays of serializable elements are judged by their serialized shape", () =>
        {
            SnapshotArrayIndex.forPath<OrderState>("planHistory");           // flat serialized shape

            // @ts-expect-error - the serialized shape nests a serializable: not a flat record
            SnapshotArrayIndex.forPath<OrderState>("audits");

            const history = SnapshotArrayIndex.forPath<OrderState>("planHistory").containmentForPath("planHistory");

            // match documents are typed against the SERIALIZED element shape - which is also what is
            // stored, so these would actually match (the stored $typename never blocks @>, which is
            // subset matching)
            history.contains({ tier: "free" });
            history.contains({ tier: "free", changedAt: 1 });

            // @ts-expect-error - a derived getter is not a stored key
            history.contains({ isRecent: true });
            // @ts-expect-error - methods are not match keys
            history.contains({ serialize: "x" });
            // @ts-expect-error - $typename is not offered through the typed door; the raw door takes it
            history.contains({ $typename: "PlanChange" });

            assert.ok(true);
        });

        // organizationId is a real column on an org snapshot table, so it is excluded from this path
        // union for the same reason it is excluded from SnapshotPath
        await test("organizationId is not offered as an array path", () =>
        {
            SnapshotArrayIndex.forPath<InvoiceState>("labels");
            SnapshotArrayIndex.forPath<InvoiceState>("customer.nicknames");

            // @ts-expect-error - organizationId is a real column, not a key inside data
            SnapshotArrayIndex.forPath<InvoiceState>("organizationId");

            assert.ok(true);
        });

        // the element type is resolved FROM the path literal, so the match argument is checked
        // against the array's element shape with no explicit type argument at the call site
        await test("match values are checked against the element shape", () =>
        {
            const members = SnapshotArrayIndex.forPath<TeamState>("members").containmentForPath("members");

            members.contains({ userId: "u1", isDeactivated: false });
            members.contains({ role: "admin" });
            members.containsAll([{ userId: "u1" }, { role: "admin" }]);
            members.containsAny([{ role: "admin" }, { role: "owner" }]);

            // @ts-expect-error - a typo'd field
            members.contains({ userld: "u1" });
            // @ts-expect-error - a wrong value type
            members.contains({ isDeactivated: "false" });
            // @ts-expect-error - an empty match is true for every array, so it would return every row.
            // Both halves are pinned at once: the unused directive fails the build if the compile
            // error stops occurring, and the assert fails if the runtime guard stops firing.
            assert.throws(() => members.contains({}));
            // @ts-expect-error - a scalar against an array of records
            members.contains("u1");
            // @ts-expect-error - and the same rules apply inside containsAll
            members.containsAll([{ userld: "u1" }]);

            const tags = SnapshotArrayIndex.forPath<OrderState>("tags").containmentForPath("tags");

            tags.contains("urgent");
            tags.containsAny(["urgent", "rush"]);

            // @ts-expect-error - a record against an array of scalars
            tags.contains({ userId: "u1" });
            // @ts-expect-error - the wrong scalar type
            tags.contains(3);

            const scores = SnapshotArrayIndex.forPath<OrderState>("scores").containmentForPath("scores");
            scores.contains(3);
            // @ts-expect-error - the wrong scalar type
            scores.contains("3");

            // a nested path resolves to its element type too
            const nicknames = SnapshotArrayIndex.forPath<OrderState>("customer.nicknames").containmentForPath("customer.nicknames");
            nicknames.contains("nn");
            // @ts-expect-error - the wrong scalar type, through a nested path
            nicknames.contains(3);

            assert.ok(true);
        });

        // the read side is checked by the same type as the write side, and membership is enforced at
        // runtime - the same seam SnapshotIndex.expressionForPath has
        await test("read-side paths are checked against the state, membership at runtime", () =>
        {
            const tagsIndex = SnapshotArrayIndex.forPath<OrderState>("tags");

            // covered by this index: compiles and resolves
            assert.strictEqual(
                tagsIndex.containmentForPath("tags").contains("urgent").sql,
                "((data->'tags') @> cast(? as jsonb))");

            // a valid OrderState array path this index does not cover: type-checks, throws
            assert.throws(() => tagsIndex.containmentForPath("scores"));

            // @ts-expect-error - "tgas" is not a key of OrderState
            assert.throws(() => tagsIndex.containmentForPath("tgas"));
            // @ts-expect-error - a leaf scalar is not an array path
            assert.throws(() => tagsIndex.containmentForPath("status"));

            // the raw door stays open, and is unchecked by default
            const dynamicKey: string = "tags";
            assert.strictEqual(
                tagsIndex.containmentForRawPath(dynamicKey).contains({ anything: 1 }).params[0],
                "[{\"anything\":1}]");

            // ...and checked when the element type is supplied
            const typedRaw = tagsIndex.containmentForRawPath<{ id: string; }>("tags");
            typedRaw.contains({ id: "x" });
            // @ts-expect-error - with the element type supplied, a typo is caught
            typedRaw.contains({ idd: "x" });
        });

        await test("an array builder bound to the wrong state is rejected by the create method", async () =>
        {
            const { creator } = createCreator();

            // @ts-expect-error - an InvoiceState array index cannot be used on an Order snapshot table
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [], arrayIndexes: [SnapshotArrayIndex.forPath<InvoiceState>("labels")] });
        });
    });

    await describe("Array containment predicates", async () =>
    {
        const members = SnapshotArrayIndex.forPath<TeamState>("members").containmentForPath("members");
        const tags = SnapshotArrayIndex.forPath<OrderState>("tags").containmentForPath("tags");

        // the single-source proof for the array side: the fragment embeds the same expression the DDL
        // is emitted from, and `cast(? as jsonb)` rather than `?::jsonb` keeps no `?` adjacent to a `:`
        await test("contains emits one @> term against the declared expression", () =>
        {
            const p = members.contains({ userId: "u1", isDeactivated: false });

            assert.strictEqual(p.sql, "((data->'members') @> cast(? as jsonb))");
            assert.deepStrictEqual(p.params, ["[{\"userId\":\"u1\",\"isDeactivated\":false}]"]);
        });

        // the reason this returns a predicate rather than an expression: a multi-field match must be
        // ONE document, because two ANDed fragments ask whether some element has one field and some
        // POSSIBLY DIFFERENT element has the other
        await test("a multi-field match is a single containment document", () =>
        {
            const p = members.contains({ userId: "u1", isDeactivated: false });

            assert.strictEqual(p.params.length, 1);
            assert.strictEqual(p.sql.match(/@>/gu)!.length, 1);
        });

        await test("a nested path uses #> rather than #>>", () =>
        {
            const p = SnapshotArrayIndex.forPath<OrderState>("customer.nicknames")
                .containmentForPath("customer.nicknames").contains("nn");

            assert.strictEqual(p.sql, "((data#>'{\"customer\",\"nicknames\"}') @> cast(? as jsonb))");
        });

        await test("a scalar array binds an array-wrapped value", () =>
        {
            assert.deepStrictEqual(tags.contains("urgent").params, ["[\"urgent\"]"]);
            assert.deepStrictEqual(
                SnapshotArrayIndex.forPath<OrderState>("scores").containmentForPath("scores").contains(3).params,
                ["[3]"]);
        });

        // containsAll is one document and so one index scan, not N predicates
        await test("containsAll is one term with a multi-element document", () =>
        {
            const p = members.containsAll([{ role: "admin" }, { role: "owner" }]);

            assert.strictEqual(p.sql, "((data->'members') @> cast(? as jsonb))");
            assert.deepStrictEqual(p.params, ["[{\"role\":\"admin\"},{\"role\":\"owner\"}]"]);
        });

        // @> cannot express a disjunction, so containsAny ORs one term per match - which the planner
        // turns into a BitmapOr over the same index. Deliberately not ?|, whose ? is knex's placeholder.
        await test("containsAny ORs one term per match, parenthesized as a whole", () =>
        {
            const p = members.containsAny([{ role: "admin" }, { role: "owner" }]);

            assert.strictEqual(
                p.sql,
                "((data->'members') @> cast(? as jsonb) or (data->'members') @> cast(? as jsonb))");
            assert.deepStrictEqual(p.params, ["[{\"role\":\"admin\"}]", "[{\"role\":\"owner\"}]"]);

            // the outer parens are load-bearing: `where organization_id = ? and A or B` binds `or` at
            // the top and returns other organizations' rows
            assert.ok(p.sql.startsWith("(") && p.sql.endsWith(")"));
        });

        // sql and params are produced together precisely so this cannot drift: a caller counting
        // placeholders by hand is a positional-binding bug waiting to happen
        await test("the placeholder count always matches the parameter count", () =>
        {
            for (const n of [1, 2, 3, 4])
            {
                const matches = Array.from({ length: n }, (_, i) => ({ role: `r${i}` }));
                const p = members.containsAny(matches);

                assert.strictEqual(p.params.length, n);
                assert.strictEqual(p.sql.match(/\?/gu)!.length, n);
            }
        });

        // nothing this API emits contains a `?` other than knex's own placeholders - the jsonb
        // existence operators are knex's binding character, and jsonb_path_ops cannot serve them anyway
        await test("no jsonb ? operator is ever emitted", () =>
        {
            for (const p of [members.contains({ role: "a" }), members.containsAll([{ role: "a" }]), members.containsAny([{ role: "a" }, { role: "b" }])])
                assert.strictEqual(p.sql.replaceAll("cast(? as jsonb)", ""), p.sql.replaceAll("cast(? as jsonb)", "").replaceAll("?", ""));
        });

        // every rule here rejects a silent WRONG ANSWER rather than a malformed query
        await test("matches that would silently match everything are rejected", () =>
        {
            // @> '[]' is true for every array, so this would return the whole table
            assert.throws(() => members.containsAll([]));
            // ...and this would emit no predicate at all
            assert.throws(() => members.containsAny([]));
        });

        await test("values that do not survive JSON.stringify are rejected", () =>
        {
            const raw = SnapshotArrayIndex.forRawPath<OrderState>("tags").containmentForRawPath("tags");

            // all four render as `null`, turning a bug into a null-element match
            assert.throws(() => raw.contains(null));
            assert.throws(() => raw.contains(undefined));
            assert.throws(() => raw.contains(Number.NaN));
            assert.throws(() => raw.contains(Number.POSITIVE_INFINITY));

            // an empty record, reached through the raw door where the type does not stop it
            assert.throws(() => raw.contains({}));
            // a record with a nested value
            assert.throws(() => raw.contains({ a: { b: 1 } }));
            // a record whose only value is undefined - JSON.stringify would drop it to `{}`
            assert.throws(() => raw.contains({ a: undefined }));
            // an array as a match: not what any typed path offers
            assert.throws(() => raw.contains(["a"]));

            // and the valid ones still pass
            assert.deepStrictEqual(raw.contains("a").params, ["[\"a\"]"]);
            assert.deepStrictEqual(raw.contains(0).params, ["[0]"]);
            assert.deepStrictEqual(raw.contains(false).params, ["[false]"]);
        });

        await test("withName overrides the derived suffix and cannot be set twice", () =>
        {
            assert.strictEqual(SnapshotArrayIndex.forPath<TeamState>("members").nameSuffix, "members");
            assert.strictEqual(
                SnapshotArrayIndex.forPath<OrderState>("customer.nicknames").nameSuffix, "customer_nicknames");
            assert.strictEqual(SnapshotArrayIndex.forPath<TeamState>("members").withName("m").nameSuffix, "m");

            assert.throws(() => SnapshotArrayIndex.forPath<TeamState>("members").withName("m").withName("n"));
            assert.throws(() => SnapshotArrayIndex.forPath<TeamState>("members").withName("Bad-Name"));
        });

        await test("a path that could break out of the string literal is rejected", () =>
        {
            assert.throws(() => SnapshotArrayIndex.forRawPath<OrderState>("tags'); drop table order_snaps; --"));
            assert.throws(() => SnapshotArrayIndex.forRawPath<OrderState>("ta gs"));
            assert.throws(() => SnapshotArrayIndex.forRawPath<OrderState>(""));
            assert.throws(() => SnapshotArrayIndex.forRawPath<OrderState>("a..b"));
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
                orderType, { indexes: [statusIndex, totalIndex, cityIndex, skuIndex], arrayIndexes: [] });

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
                assert.ok(info.createdIndexes.some(t => t.expressions.contains(expression)));
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
                () => creator.createSnapshotTableForAggregate(overlongType, { indexes: [SnapshotIndex.forPath<OrderState>("status")], arrayIndexes: [] }),
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

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forPath<OrderState>("status")], arrayIndexes: [] }));
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forRawPath<OrderState>("  status  ")], arrayIndexes: [] }));
        });

        await test("rejects the same index declared twice under different names", async () =>
        {
            const { creator } = createCreator();

            // distinct names, so a name collision cannot be what rejects this
            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(orderType, { indexes: [
                    SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").withName("a"),
                    SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").withName("b")
                ], arrayIndexes: [] }),
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
                () => creator.createSnapshotTableForAggregate(orderType, { indexes: [
                    SnapshotIndex.forPath<OrderState>("total").withName("a"),
                    SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric).withName("b")
                ], arrayIndexes: [] }),
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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("sku"),
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ], arrayIndexes: [] });

            assert.strictEqual(db.commands.length, 3);
            assert.strictEqual(db.commands[1], "create index if not exists idx_order_snaps_sku on order_snaps((data->>'sku'));");
            assert.strictEqual(db.commands[2],
                "create unique index if not exists idx_order_snaps_tenantcode_sku_uq on order_snaps((data->>'tenantCode'), (data->>'sku'));");
        });

        await test("rejects distinct paths whose derived index names would collide", async () =>
        {
            const { creator } = createCreator();

            // both derive the suffix 'created_at', and `if not exists` would silently skip the second
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("created.at"), SnapshotIndex.forRawPath<OrderState>("created_at")], arrayIndexes: [] }));
            // case only differences fold to the same identifier
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("createdAt"), SnapshotIndex.forRawPath<OrderState>("createdat")], arrayIndexes: [] }));
        });

        await test("rejects a path whose index name would overflow the identifier limit", async () =>
        {
            const { creator } = createCreator();

            // idx_ (4) + order_snaps (11) + _ (1) + 48 = 64, one over
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("a".repeat(48))], arrayIndexes: [] }));
            await assert.doesNotReject(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("a".repeat(47))], arrayIndexes: [] }));
        });

        await test("the identifier limit is 3 chars tighter for a unique index, because of the _uq suffix", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("a".repeat(45)).asUnique()], arrayIndexes: [] }));
            await assert.doesNotReject(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("a".repeat(44)).asUnique()], arrayIndexes: [] }));
        });

        await test("rejects a unique index whose _uq name collides with a plain index's name", async () =>
        {
            const { creator } = createCreator();

            // 'email' + unique -> idx_order_snaps_email_uq, and so does the literal path 'email_uq'
            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forRawPath<OrderState>("email_uq")
            ], arrayIndexes: [] }));
        });

        // the contrast to the above, and the reason the _uq suffix exists: the same path can
        // carry both a unique index and a plain one, because their names differ
        await test("allows one path indexed both uniquely and not", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("email").asUnique(),
                SnapshotIndex.forPath<OrderState>("email")
            ], arrayIndexes: [] });

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

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [notABuilder as unknown as SnapshotIndex<OrderState>], arrayIndexes: [] }));
        });

        await test("no DDL is emitted when validation fails", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status"), SnapshotIndex.forPath<OrderState>("status")], arrayIndexes: [] }));

            assert.deepStrictEqual(db.commands, []);
        });

        await test("rejects the same array index declared twice", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(teamType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<TeamState>("members"), SnapshotArrayIndex.forPath<TeamState>("members")]
            }));

            // identity is the path alone - an explicit name does not make it a different index
            await assert.rejects(() => creator.createSnapshotTableForAggregate(teamType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<TeamState>("members"), SnapshotArrayIndex.forPath<TeamState>("members").withName("m")]
            }));

            assert.deepStrictEqual(db.commands, []);
        });

        // one key inside `data` holds one kind of value: indexing it as a scalar means the text
        // rendering of the whole subtree, which jsonb orders itself - so one of the two declarations
        // has the wrong idea of the state. Unreachable through the typed doors, since the two path
        // unions are disjoint, but forRawPath makes it reachable.
        await test("rejects one path indexed both as a scalar and as an array", async () =>
        {
            const { creator, db } = createCreator();

            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(orderType, {
                    indexes: [SnapshotIndex.forRawPath<OrderState>("tags")],
                    arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags")]
                }),
                (e: Error) => e.message.contains("both as a scalar and as an array"));

            assert.deepStrictEqual(db.commands, []);
        });

        await test("rejects a plain object masquerading as a SnapshotArrayIndex", async () =>
        {
            const { creator } = createCreator();
            // structurally complete, so only the instanceof check can reject it
            const notABuilder = {
                path: "members", paths: ["members"], expressions: ["(data->'members')"], nameSuffix: "members",
                containmentForPath: (): any => ({}),
                containmentForRawPath: (): any => ({})
            };

            await assert.rejects(() => creator.createSnapshotTableForAggregate(teamType, {
                indexes: [],
                arrayIndexes: [notABuilder as unknown as SnapshotArrayIndex<TeamState>]
            }));
        });

        await test("rejects a second argument that is not an options object", async () =>
        {
            const { creator } = createCreator();

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, "status" as any));
            await assert.rejects(() => creator.createSnapshotTableForOrgAggregate(invoiceType, 7 as any));

            // the bare array is gone, and a JavaScript caller still passing one has to be told rather
            // than quietly given a table with no indexes - which is what reading `.indexes` off an
            // array would have produced
            await assert.rejects(
                () => creator.createSnapshotTableForAggregate(orderType, [SnapshotIndex.forPath<OrderState>("status")] as any));
        });

        // the budget is one char tighter than a unique index's, because _gin is one char longer
        // than _uq. `order_snaps` leaves 63 - 4 (idx_) - 11 (table) - 1 (_) - 4 (_gin) = 43.
        await test("the identifier limit is 4 chars tighter for an array index, because of the _gin suffix", async () =>
        {
            const { creator, db } = createCreator();

            await creator.createSnapshotTableForAggregate(orderType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags").withName("a".repeat(43))]
            });
            assert.strictEqual(db.commands.length, 2);

            await assert.rejects(() => creator.createSnapshotTableForAggregate(orderType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags").withName("a".repeat(44))]
            }));
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

            await db.executeCommand("drop table if exists order_events; drop table if exists order_snaps; drop table if exists invoice_events; drop table if exists invoice_snaps; drop table if exists team_snaps;");
        });

        after(async () =>
        {
            await db.executeCommand("drop table if exists order_events; drop table if exists order_snaps; drop table if exists invoice_events; drop table if exists invoice_snaps; drop table if exists team_snaps;");
            await dbConnectionFactory.dispose();
        });

        // Whether a predicate can *use* an index is not decidable by comparing strings: Postgres
        // normalizes an index expression when it stores it, and the planner matches parse trees. So
        // ask the planner. Callers must seed enough rows and `analyze` first, or every plan is a seq
        // scan and the assertions pass vacuously.
        // `params` is a strict superset of the original signature, and it makes these tests exercise
        // the real knex binding path - which is itself a claim under test for the array predicates,
        // whose values must arrive as bindings rather than as interpolated literals.
        const planFor = async (table: string, predicate: string, ...params: ReadonlyArray<any>): Promise<string> =>
        {
            const explained = await db.executeQuery<any>(
                `explain (costs off) select id from ${table} where ${predicate};`, ...params);

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
            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [
                SnapshotIndex.forPath<InvoiceState>("status"),
                SnapshotIndex.forPath<InvoiceState>("total", JsonValueType.numeric),
                SnapshotIndex.forPath<InvoiceState>("customer.city")
            ], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [statusIndex, totalIndex, cityIndex], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [skuIndex], arrayIndexes: [] });
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

        // the org counterpart, and the reason OrgSnapshotBaseRepository.query prepends
        // organization_id rather than leaving it to the caller: omitting it is not only a
        // tenant-isolation bug, it also loses the index outright, because organization_id is the
        // leading column of every index on the table
        await test("on an org table nothing is searchable until organization_id is constrained", async () =>
        {
            const statusIndex = SnapshotIndex.forPath<InvoiceState>("status");

            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [statusIndex], arrayIndexes: [] });
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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [emailIndex], arrayIndexes: [] });
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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [uncast], arrayIndexes: [] });
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [textCast], arrayIndexes: [] });

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
            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [statusIndex], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });

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
            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [SnapshotIndex.forPath<InvoiceState>("invoiceNumber").asUnique()], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [totalIndex], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("tenantCode").andPath("sku").asUnique()
            ], arrayIndexes: [] });

            const insert = `insert into order_snaps (id, data) values(?, ?);`;

            await db.executeCommand(insert, "ord_1", JSON.stringify({ tenantCode: "acme" }));
            await db.executeCommand(insert, "ord_2", JSON.stringify({ tenantCode: "acme" }));

            const result = await db.executeQuery<any>(`select cast(count(*) as int) as count from order_snaps;`);
            assert.strictEqual(result.rows[0].count, 2);
        });

        await test("a composite non-unique index is created and is not unique", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("status").andPath("createdAt")], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [
                SnapshotIndex.forPath<OrderState>("status").andPath("createdAt", JsonValueType.bigint)
            ], arrayIndexes: [] });

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
            await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [
                SnapshotIndex.forPath<InvoiceState>("series").andPath("invoiceNumber").asUnique()
            ], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [nullIndex], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forRawPath<OrderState>("notes")], arrayIndexes: [] });

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
            await creator.createSnapshotTableForAggregate(orderType, { indexes: [SnapshotIndex.forPath<OrderState>("email").asUnique()], arrayIndexes: [] });

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

        // ---- array containment -------------------------------------------------------------------

        const membersIndex = SnapshotArrayIndex.forPath<TeamState>("members");
        const members = membersIndex.containmentForPath("members");

        const createTeams = async (): Promise<void> =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });
        };

        // 50,000 teams, each with two members: userId is highly selective (500 distinct),
        // isDeactivated is not (every team has an active member) - the real shape of the driving
        // query, and the one where a flat selectivity estimate could mislead the planner.
        //
        // The row count is load-bearing and is NOT the 5000 the btree planner tests use. A GIN scan
        // carries a large fixed startup cost - scanning the entry tree for each search key - so at
        // 5000 rows the bitmap index scan costs ~284 against a ~218 sequential scan of the whole
        // table, and Postgres correctly prefers the seq scan. The index is *matched* either way
        // (`set enable_seqscan = off` produces the bitmap plan with the right Index Cond), but
        // asserting on the unaided plan needs a table big enough for the index to be the cheaper
        // option. That is a real property of GIN, and it is why the caveats say a small snapshot
        // table is better served by no index at all.
        const seedTeams = async (): Promise<void> =>
        {
            await createTeams();

            await db.executeCommand(
                `insert into team_snaps (id, data)
                 select 'team_' || g,
                        json_build_object(
                            'name', 'team' || g,
                            'members', json_build_array(
                                json_build_object('userId', 'u' || (g % 500), 'role', 'member', 'isDeactivated', g % 2 = 0),
                                json_build_object('userId', 'other' || g, 'role', 'owner', 'isDeactivated', false)))::jsonb
                 from generate_series(1, 50000) g;`);
            await db.executeCommand("analyze team_snaps;");
        };

        await test("the GIN index is created with the jsonb_path_ops opclass and no column is added", async () =>
        {
            await seedTeams();

            const columns = await db.executeQuery<any>(
                `select column_name from information_schema.columns where table_name = 'team_snaps' order by ordinal_position;`);
            assert.deepStrictEqual(columns.rows.map(t => t.column_name as string), ["id", "data"]);

            const indexes = await db.executeQuery<any>(
                `select indexdef from pg_indexes where tablename = 'team_snaps' and indexname = 'idx_team_snaps_members_gin';`);

            assert.strictEqual(indexes.rows.length, 1);
            assert.ok((indexes.rows[0].indexdef as string).contains("USING gin"), indexes.rows[0].indexdef);
            assert.ok((indexes.rows[0].indexdef as string).contains("jsonb_path_ops"), indexes.rows[0].indexdef);
        });

        // the array-side equivalent of the expressionForPath proof, with TWO near-miss controls -
        // without them a passing test cannot distinguish "the expression matched" from "the planner
        // would have used an index anyway"
        await test("a predicate built from containmentForPath uses the GIN index; two near-misses do not", async () =>
        {
            await seedTeams();

            const p = members.contains({ userId: "u1", isDeactivated: false });
            const plan = await planFor("team_snaps", p.sql, ...p.params);

            assert.ok(plan.contains("idx_team_snaps_members_gin"), plan);
            assert.ok(plan.contains("Bitmap Index Scan"), plan);

            // control 1: `=` is not `@>`. It asks whether the array is EXACTLY that array, and the
            // GIN opclass does not serve equality at all.
            const equality = await planFor(
                "team_snaps", `(data->'members') = cast(? as jsonb)`, "[{\"userId\":\"u1\"}]");
            assert.ok(!equality.contains("idx_team_snaps_members_gin"), equality);
            assert.ok(equality.contains("Seq Scan"), equality);

            // control 2: the whole-document form. The index covers the DECLARED PATH, not `data`, so
            // this cannot use it - which is precisely why a whole-document GIN was rejected.
            const wholeDocument = await planFor(
                "team_snaps", `data @> cast(? as jsonb)`, "{\"members\":[{\"userId\":\"u1\"}]}");
            assert.ok(!wholeDocument.contains("idx_team_snaps_members_gin"), wholeDocument);
            assert.ok(wholeDocument.contains("Seq Scan"), wholeDocument);
        });

        // THE correctness claim of this whole feature, and the reason the API returns a predicate
        // rather than an expression: both fields must hold on the SAME element. A developer writing
        // the SQL by hand reaches for two ANDed fragments, which silently asks a weaker question.
        await test("a multi-field match requires one element to carry every field", async () =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            // u1 IS a member, but deactivated. u2 is active. No single member is both u1 and active.
            await db.executeCommand(
                `insert into team_snaps (id, data) values(?, ?);`,
                "team_1", JSON.stringify({
                    name: "t1",
                    members: [
                        { userId: "u1", role: "member", isDeactivated: true },
                        { userId: "u2", role: "owner", isDeactivated: false }
                    ]
                }));

            const p = members.contains({ userId: "u1", isDeactivated: false });
            const correct = await db.executeQuery<any>(
                `select id from team_snaps where ${p.sql};`, ...p.params);

            assert.deepStrictEqual(correct.rows.map(t => t.id as string), []);

            // the hand-written form a developer would reach for: two separate containment tests.
            // Same intent, different question - and it returns the row.
            const byUser = members.contains({ userId: "u1" });
            const byActive = members.contains({ isDeactivated: false });
            const wrong = await db.executeQuery<any>(
                `select id from team_snaps where ${byUser.sql} and ${byActive.sql};`,
                ...byUser.params, ...byActive.params);

            assert.deepStrictEqual(wrong.rows.map(t => t.id as string), ["team_1"]);

            // and the same match against a team where one member IS both does return it
            await db.executeCommand(
                `insert into team_snaps (id, data) values(?, ?);`,
                "team_2", JSON.stringify({ name: "t2", members: [{ userId: "u1", role: "member", isDeactivated: false }] }));

            const found = await db.executeQuery<any>(`select id from team_snaps where ${p.sql};`, ...p.params);
            assert.deepStrictEqual(found.rows.map(t => t.id as string), ["team_2"]);
        });

        // jsonb object containment is partial and recursive: a match names a SUBSET of the element's
        // fields, and an element that omits a named field never matches one
        await test("containment is partial over an element's fields, and absent fields never match", async () =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            await db.executeCommand(`insert into team_snaps (id, data) values(?, ?);`,
                "full", JSON.stringify({ name: "f", members: [{ userId: "u1", role: "admin", isDeactivated: false }] }));
            // a member missing isDeactivated altogether
            await db.executeCommand(`insert into team_snaps (id, data) values(?, ?);`,
                "partial", JSON.stringify({ name: "p", members: [{ userId: "u1" }] }));

            const idsFor = async (p: { sql: string; params: ReadonlyArray<string>; }): Promise<Array<string>> =>
                (await db.executeQuery<any>(`select id from team_snaps where ${p.sql} order by id;`, ...p.params))
                    .rows.map(t => t.id as string);

            // naming a subset matches the element that also carries more
            assert.deepStrictEqual(await idsFor(members.contains({ userId: "u1" })), ["full", "partial"]);
            // ...but naming a field the element does not carry does not
            assert.deepStrictEqual(await idsFor(members.contains({ userId: "u1", isDeactivated: false })), ["full"]);
        });

        await test("containsAll and containsAny mean intersection and union", async () =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            const insert = `insert into team_snaps (id, data) values(?, ?);`;
            await db.executeCommand(insert, "both", JSON.stringify({ name: "b", members: [{ role: "admin" }, { role: "owner" }] }));
            await db.executeCommand(insert, "admin", JSON.stringify({ name: "a", members: [{ role: "admin" }] }));
            await db.executeCommand(insert, "owner", JSON.stringify({ name: "o", members: [{ role: "owner" }] }));

            const idsFor = async (p: { sql: string; params: ReadonlyArray<string>; }): Promise<Array<string>> =>
                (await db.executeQuery<any>(`select id from team_snaps where ${p.sql} order by id;`, ...p.params))
                    .rows.map(t => t.id as string);

            assert.deepStrictEqual(await idsFor(members.containsAll([{ role: "admin" }, { role: "owner" }])), ["both"]);
            assert.deepStrictEqual(await idsFor(members.containsAny([{ role: "admin" }, { role: "owner" }])), ["admin", "both", "owner"]);

            // containment is set-like: order and multiplicity are irrelevant
            assert.deepStrictEqual(await idsFor(members.containsAll([{ role: "owner" }, { role: "admin" }])), ["both"]);
            assert.deepStrictEqual(await idsFor(members.containsAll([{ role: "admin" }, { role: "admin" }])), ["admin", "both"]);
        });

        await test("containsAny becomes a BitmapOr over the same index", async () =>
        {
            await seedTeams();

            const p = members.containsAny([{ userId: "u1" }, { userId: "u2" }]);
            const plan = await planFor("team_snaps", p.sql, ...p.params);

            assert.ok(plan.contains("BitmapOr"), plan);
            assert.ok(plan.contains("idx_team_snaps_members_gin"), plan);
        });

        // an absent key extracts SQL NULL, and NULL @> anything is NULL - so absent rows correctly
        // never match, but `not (...)` does not return them either
        await test("absent keys and empty arrays never match, in either direction", async () =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            const insert = `insert into team_snaps (id, data) values(?, ?);`;
            await db.executeCommand(insert, "absent", JSON.stringify({ name: "a" }));
            await db.executeCommand(insert, "empty", JSON.stringify({ name: "e", members: [] }));
            await db.executeCommand(insert, "hit", JSON.stringify({ name: "h", members: [{ userId: "u1" }] }));

            const p = members.contains({ userId: "u1" });

            const matched = await db.executeQuery<any>(`select id from team_snaps where ${p.sql};`, ...p.params);
            assert.deepStrictEqual(matched.rows.map(t => t.id as string), ["hit"]);

            // three-valued logic: negating the fragment returns NEITHER of the other two
            const negated = await db.executeQuery<any>(`select id from team_snaps where not (${p.sql});`, ...p.params);
            assert.deepStrictEqual(negated.rows.map(t => t.id as string), ["empty"]);
        });

        // the knex trap, pinned in both directions so the opclass choice cannot go stale
        await test("the jsonb ? operator is unreachable, at the driver and at the index", async () =>
        {
            await db.executeCommand("drop table if exists order_snaps;");
            await creator.createSnapshotTableForAggregate(orderType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<OrderState>("tags")]
            });
            await db.executeCommand(
                `insert into order_snaps (id, data)
                 select 'ord_' || g, json_build_object('tags', json_build_array('t' || (g % 500)))::jsonb
                 from generate_series(1, 5000) g;`);
            await db.executeCommand("analyze order_snaps;");

            // escaped, it survives knex end to end - the pg dialect's positionBindings turns `\?`
            // back into a literal `?`. So the operator is reachable by hand...
            const escaped = await planFor("order_snaps", `(data->'tags') \\? 't7'`);
            // ...but jsonb_path_ops cannot serve it, which is the second reason that opclass was
            // chosen: the trap is closed at the database as well as in this API
            assert.ok(!escaped.contains("idx_order_snaps_tags_gin"), escaped);
            assert.ok(escaped.contains("Seq Scan"), escaped);

            // unescaped, knex eats the operator as a placeholder and the call fails outright
            await assert.rejects(() => planFor("order_snaps", `(data->'tags') ? 't7'`));
            await assert.rejects(() => planFor("order_snaps", `(data->'tags') ? 't7'`, "x"));

            // and @> over the same table is served
            const containment = SnapshotArrayIndex.forPath<OrderState>("tags").containmentForPath("tags").contains("t7");
            const plan = await planFor("order_snaps", containment.sql, ...containment.params);
            assert.ok(plan.contains("idx_order_snaps_tags_gin"), plan);
        });

        // the org-table change: a GIN index does not lead with organization_id, so the standalone
        // btree must still be there for the planner to work with
        await test("an org table with only an array index carries both indexes, and scopes correctly", async () =>
        {
            await db.executeCommand("drop table if exists invoice_snaps;");

            const labelsIndex = SnapshotArrayIndex.forPath<InvoiceState>("labels");
            const info = await creator.createSnapshotTableForOrgAggregate(invoiceType, { indexes: [], arrayIndexes: [labelsIndex] });

            const indexes = await db.executeQuery<any>(
                `select indexname, indexdef from pg_indexes where tablename = 'invoice_snaps' order by indexname;`);
            const byName = new Map(indexes.rows.map(t => [t.indexname as string, t.indexdef as string]));

            assert.ok(byName.has("idx_invoice_snaps_labels_gin"));
            assert.ok(byName.get("idx_invoice_snaps_labels_gin")!.contains("USING gin"));
            assert.ok(byName.get("idx_invoice_snaps_labels_gin")!.contains("jsonb_path_ops"));
            // the GIN index does NOT carry organization_id...
            assert.ok(!byName.get("idx_invoice_snaps_labels_gin")!.contains("organization_id"));
            // ...so the standalone one must exist, and leadingColumn must not claim otherwise
            assert.ok(byName.has("idx_invoice_snaps"));
            assert.strictEqual(info.createdIndexes[0].leadingColumn, undefined);

            // 7 organizations against 500 labels, deliberately coprime: with a shared factor every
            // row carrying a given label lands in ONE organization, and the scoped-vs-unscoped
            // comparison below passes vacuously
            await db.executeCommand(
                `insert into invoice_snaps (id, organization_id, data)
                 select 'inv_' || g, 'org_' || (g % 7),
                        json_build_object('labels', json_build_array('l' || (g % 500)))::jsonb
                 from generate_series(1, 50000) g;`);
            await db.executeCommand("analyze invoice_snaps;");

            const p = labelsIndex.containmentForPath("labels").contains("l7");

            // the GIN index is used even with the org filter present. Deliberately NOT asserting
            // BitmapAnd: the planner may legitimately use the GIN alone and filter on the heap.
            const plan = await planFor("invoice_snaps", `organization_id = ? and ${p.sql}`, "org_2", ...p.params);
            assert.ok(plan.contains("idx_invoice_snaps_labels_gin"), plan);

            // and the results are org-scoped, which is the caller's job rather than the index's
            const scoped = await db.executeQuery<any>(
                `select id from invoice_snaps where organization_id = ? and ${p.sql};`, "org_2", ...p.params);
            assert.ok(scoped.rows.length > 0);

            const all = await db.executeQuery<any>(`select id from invoice_snaps where ${p.sql};`, ...p.params);
            assert.ok(all.rows.length > scoped.rows.length);
        });

        // pins the PREMISES the design rests on, so its rationale cannot silently go stale
        await test("the multicolumn GIN and unique GIN forms this design rejects are genuinely unavailable", async () =>
        {
            await createTeams();

            // why an array index does not lead with organization_id: a varchar has no GIN opclass in
            // core, so this needs btree_gin - not a trusted extension on PG 12
            await db.executeCommand("drop table if exists invoice_snaps;");
            await creator.createSnapshotTableForOrgAggregate(invoiceType, {
                indexes: [],
                arrayIndexes: [SnapshotArrayIndex.forPath<InvoiceState>("labels")]
            });
            await assert.rejects(() => db.executeCommand(
                `create index idx_probe_multicolumn on invoice_snaps using gin (organization_id, (data->'labels') jsonb_path_ops);`));

            // why SnapshotArrayIndex has no asUnique: GIN cannot enforce uniqueness at all
            await assert.rejects(() => db.executeCommand(
                `create unique index idx_probe_unique on team_snaps using gin((data->'members') jsonb_path_ops);`));
        });

        // jsonb stores numbers as numeric, so equality is numeric equality. Both sides of this API
        // stringify from JavaScript so they agree by construction, but a value written by anything
        // else may not - pinned so the doc bullet cannot drift from the behaviour.
        await test("jsonb normalizes numbers, so 1 and 1.0 are the same element", async () =>
        {
            const result = await db.executeQuery<any>(
                `select ('[1]'::jsonb @> '[1.0]'::jsonb) as forward, ('[1.0]'::jsonb @> '[1]'::jsonb) as backward;`);

            assert.strictEqual(result.rows[0].forward, true);
            assert.strictEqual(result.rows[0].backward, true);
        });

        // the write path the repositories actually emit, against a table carrying a GIN index
        await test("SnapshotBaseRepository's insert and upsert succeed against a table with an array index", async () =>
        {
            await db.executeCommand("drop table if exists team_snaps;");
            await creator.createSnapshotTableForAggregate(teamType, { indexes: [], arrayIndexes: [membersIndex] });

            // the exact statement SnapshotBaseRepository.save emits for a new aggregate
            await db.executeCommand(
                `insert into team_snaps (id, data) values(?, ?);`,
                "team_1", JSON.stringify({ id: "team_1", name: "t", members: [{ userId: "u1", role: "member", isDeactivated: true }] }));

            // and the one it emits for an existing aggregate
            await db.executeCommand(
                `insert into team_snaps (id, data) values(?, ?) on conflict (id) do update set data = excluded.data;`,
                "team_1", JSON.stringify({ id: "team_1", name: "t", members: [{ userId: "u1", role: "member", isDeactivated: false }] }));

            // the GIN index sees the updated value, with nothing populating a column
            const p = members.contains({ userId: "u1", isDeactivated: false });
            const result = await db.executeQuery<any>(`select id from team_snaps where ${p.sql};`, ...p.params);

            assert.deepStrictEqual(result.rows.map(t => t.id as string), ["team_1"]);

            // ...and the pre-update value no longer matches
            const stale = members.contains({ userId: "u1", isDeactivated: true });
            const staleResult = await db.executeQuery<any>(`select id from team_snaps where ${stale.sql};`, ...stale.params);

            assert.deepStrictEqual(staleResult.rows.map(t => t.id as string), []);
        });
    });
});
