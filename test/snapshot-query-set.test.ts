import { AggregateState, DomainObject, DomainObjectData, OrgAggregateRoot, OrgAggregateState, OrgAggregateStateFactory, OrgConfigurableDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ArgumentException, ArgumentNullException, Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, DeclaredSnapshotQuerySet, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, OrgEventStreamBaseRepository, OrgSnapshotBaseRepository, QueryResult, SnapshotArrayIndex, SnapshotArrayPath, SnapshotIndex, SnapshotPath, SnapshotOrderBy, SnapshotPathSpec, SnapshotPredicate, SnapshotQuerySet, UnitOfWork } from "../src/index.js";


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

// a real n-domain DomainObject: as of 4.0.2 the path types trust only these - the serialized shape
// (DomainObjectSerialized) is the stored shape paths follow. Never instantiated by this suite.
@serialize
class PlanVo extends DomainObject<PlanVo, "tier" | "seatLimit" | "badges">
{
    private readonly _tier: string;
    private readonly _seatLimit: number;
    private readonly _badges: Array<string>;

    @serialize public get tier(): string { return this._tier; }
    @serialize public get seatLimit(): number { return this._seatLimit; }
    // an array data key, writable only as of n-domain 4.0.3: declarable as a nested ARRAY path
    @serialize public get badges(): Array<string> { return this._badges; }
    public get isUnlimited(): boolean { return this._seatLimit === 0; }     // derived - not serialized, so not declarable as a path

    public constructor(data: DomainObjectData<PlanVo>)
    {
        super(data);
        this._tier = data.tier;
        this._seatLimit = data.seatLimit;
        this._badges = data.badges;
    }
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
    plan: PlanVo;                   // a serializable member: paths and values follow its serialized shape
    labels: Array<string>;
    lines: Array<Line>;
}

// a plain (non-org) state: the one place the acrossOrganizations option must be refused
interface PlainState extends AggregateState
{
    status: string;
}

// only the name reaches the DDL. Its own table name, because node --test runs files in parallel and
// this suite creates and drops real tables.
class Ticket extends OrgAggregateRoot<TicketState, OrgDomainEvent<TicketState>> { }

const ticketType = Ticket as any;

const indexes = SnapshotQuerySet.for<TicketState>()
    // declared across organizations: a second, prefix-free index, and the brand on every status predicate
    .withPath("status", { acrossOrganizations: true })
    // deliberately NOT across organizations - the control for the brand and for the planner
    .withPath("total", { type: JsonValueType.numeric })
    .withPath("openedAt")
    .withPath("isRush")
    .withPath("party.city")
    .withComposite(["series", { path: "revision", type: JsonValueType.integer }], { unique: true })
    .withArrayPath("labels")
    .withArrayPath("lines")
    // an array reached THROUGH a serialized record rather than off the state directly: its
    // expression is `#>` over a quoted path array, not `->`, and expression indexes match
    // textually - so this is declared on the seeded set to pin the plan, not just the DDL
    .withArrayPath("plan.badges");

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

        // the '9' > '100' hazard applies to ordering too, and ordering has no value argument to hang
        // the error on - so the path union itself excludes a number indexed without a numeric cast
        await test("a numeric path indexed without a cast is not orderable", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - openedAt is a number indexed as text: as text, '9' > '100'
                indexes.orderBy("openedAt");
            };

            assert.strictEqual(typeof rejected, "function");

            // a declared cast, or a leaf kind that orders correctly as text - these run
            assert.ok(indexes.orderBy("total", "desc").sql.contains("::numeric"));
            assert.ok(indexes.orderBy("status").sql.contains("data->>'status'"));
            assert.ok(indexes.orderBy("isRush").sql.length > 0);
        });

        // a cast that does not fit the leaf used to compile and then throw on every insert, since
        // Postgres casts the extracted text eagerly - now it does not compile
        await test("a declared cast must fit the leaf type", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - a numeric cast on a string leaf
                SnapshotQuerySet.for<TicketState>().withPath("status", { type: JsonValueType.numeric });

                // @ts-expect-error - a uuid cast on a number leaf
                SnapshotQuerySet.for<TicketState>().withPath("total", { type: JsonValueType.uuid });

                // @ts-expect-error - a bigint cast on a boolean leaf
                SnapshotQuerySet.for<TicketState>().withPath("isRush", { type: JsonValueType.bigint });

                // @ts-expect-error - checked inside a composite too, tied to each member's own path
                SnapshotQuerySet.for<TicketState>().withComposite([{ path: "series", type: JsonValueType.integer }]);
            };

            assert.strictEqual(typeof rejected, "function");

            // fitting casts compile - and text on a string is legal though redundant (Postgres elides it)
            SnapshotQuerySet.for<TicketState>().withPath("status", { type: JsonValueType.text });
            SnapshotQuerySet.for<TicketState>().withPath("isRush", { type: JsonValueType.boolean });
            SnapshotQuerySet.for<TicketState>().withPath("total", { type: JsonValueType.numeric });
        });

        // values resolve through the SERIALIZED shape of a nested serializable member, and the cast
        // rule still applies to a numeric leaf reached through one
        await test("values and casts follow the serialized shape of a serializable member", async () =>
        {
            const planIndexes = SnapshotQuerySet.for<TicketState>()
                .withPath("plan.tier")
                .withPath("plan.seatLimit");

            planIndexes.eq("plan.tier", "studio");

            const rejected = (): void =>
            {
                // @ts-expect-error - the value type comes from the serialized shape: tier is a string
                planIndexes.eq("plan.tier", 42);

                // @ts-expect-error - a number reached through a serialized shape still demands a cast
                planIndexes.gt("plan.seatLimit", 3);

                // @ts-expect-error - a derived getter is not a stored key, so it is not declarable
                SnapshotQuerySet.for<TicketState>().withPath("plan.isUnlimited");
            };

            assert.strictEqual(typeof rejected, "function");
        });

        // an array data key on a DomainObject was unconstructible before n-domain 4.0.3, so this is
        // the first shape where the array walk actually goes through SerializedShapeOf rather than
        // over a plain interface's own property names. The scalar/array split holds across it.
        await test("an array inside a serialized shape is an array path, not a scalar one", async () =>
        {
            const badgeIndexes = SnapshotQuerySet.for<TicketState>().withArrayPath("plan.badges");

            badgeIndexes.contains("plan.badges", "beta");
            badgeIndexes.containsAny("plan.badges", ["beta", "ga"]);

            const rejected = (): void =>
            {
                // @ts-expect-error - the element resolves through the serialized shape to string
                badgeIndexes.contains("plan.badges", 3);

                // @ts-expect-error - a container reached through a serialized shape is not a scalar path
                SnapshotQuerySet.for<TicketState>().withPath("plan.badges");

                // @ts-expect-error - and a scalar inside one is not an array path
                SnapshotQuerySet.for<TicketState>().withArrayPath("plan.tier");

                // @ts-expect-error - an array path is not orderable, nested or not
                badgeIndexes.orderBy("plan.badges", "asc");
            };

            assert.strictEqual(typeof rejected, "function");
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

        // the one silent downgrade that used to be prose only: a variable-typed argument widens the
        // path type parameter to the whole union, so TIndexed gains every state path with no cast and
        // all path/cast checking evaporates while the runtime set holds only the one path
        await test("a widened (non-literal) path argument is rejected at declaration", async () =>
        {
            // parameters, not consts: a const initialized with a literal is narrowed back to that
            // literal at the use site, so it never widened anything - the hazard is a path that
            // arrives through an opaque source, which is exactly what a parameter is
            const rejected = (
                somePath: SnapshotPath<TicketState>,
                someArrayPath: SnapshotArrayPath<TicketState>,
                someSpecs: ReadonlyArray<SnapshotPathSpec<TicketState>>,
                someSpec: SnapshotPathSpec<TicketState>): void =>
            {
                // @ts-expect-error - a union-typed variable is not an inline literal
                SnapshotQuerySet.for<TicketState>().withPath(somePath);

                // @ts-expect-error - same for an array path
                SnapshotQuerySet.for<TicketState>().withArrayPath(someArrayPath);

                // @ts-expect-error - a widened spec array is not an inline tuple
                SnapshotQuerySet.for<TicketState>().withComposite(someSpecs);

                // @ts-expect-error - a widened member inside an inline tuple is caught too
                SnapshotQuerySet.for<TicketState>().withComposite([someSpec]);
            };

            assert.strictEqual(typeof rejected, "function");

            // inline literals are unaffected, and the declarations still accumulate: the declared
            // paths remain queryable with their casts remembered
            const literal = SnapshotQuerySet.for<TicketState>()
                .withPath("status")
                .withComposite(["series", { path: "revision", type: JsonValueType.integer }])
                .withArrayPath("labels");

            assert.ok(literal.eq("status", "sent").sql.contains("data->>'status'"));
            assert.ok(literal.gte("revision", 2).sql.contains("::integer"));
            assert.ok(literal.orderBy("series").sql.length > 0);
            assert.ok(literal.contains("labels", "urgent").sql.contains("@>"));
        });

        // Every predicate carries a brand: whether every path in it is declared across organizations.
        // A containment predicate is always `true` - a GIN index has no tenant prefix - and a bare
        // literal is no predicate at all, because nothing stamped it.
        await test("a predicate is branded, and a bare literal is not a predicate", async () =>
        {
            const rejected = (): void =>
            {
                // @ts-expect-error - a hand-written literal carries no brand; build it through raw()
                const bare: SnapshotPredicate = { sql: "(data->>'status') = ?", params: ["sent"] };

                // @ts-expect-error - a containment predicate is SnapshotPredicate<true>, never <false>
                const scopedOnly: SnapshotPredicate<false> = indexes.contains("labels", "urgent");

                assert.ok(bare);
                assert.ok(scopedOnly);
            };

            assert.strictEqual(typeof rejected, "function");

            const containment: SnapshotPredicate<true> = indexes.contains("labels", "urgent");
            // the default type parameter admits both brands, so an existing annotation keeps working
            const either: SnapshotPredicate = containment;

            assert.strictEqual(containment.acrossOrganizations, true);
            assert.strictEqual(either.acrossOrganizations, true);
        });

        // The brand follows the declaration: `status` is declared across organizations in the fixture
        // and `total` is not; containment always is; a combinator is `true` only when every arm is;
        // `not` keeps what it was given; and an order by term carries it like a predicate does.
        await test("the brand follows the declaration, and combinators propagate it", async () =>
        {
            const flagged: SnapshotPredicate<true> = indexes.eq("status", "sent");
            const unflagged: SnapshotPredicate<false> = indexes.gt("total", 1);
            const allAcross: SnapshotPredicate<true> = indexes.and(indexes.eq("status", "sent"), indexes.contains("labels", "urgent"));
            const negated: SnapshotPredicate<true> = indexes.not(indexes.isNull("status"));
            const ordered: SnapshotOrderBy<true> = indexes.orderBy("status", "desc");
            const hand: SnapshotPredicate<true> = indexes.rawAcrossOrganizations(`${indexes.expressionFor("status")} like ?`, "se%");

            // a composite flagged as a whole flags each member
            const composite = SnapshotQuerySet.for<TicketState>()
                .withComposite(["series", { path: "revision", type: JsonValueType.integer }], { acrossOrganizations: true });
            const member: SnapshotPredicate<true> = composite.gte("revision", 2);

            const rejected = (): void =>
            {
                // @ts-expect-error - total is not declared across organizations
                const a: SnapshotPredicate<true> = indexes.gt("total", 1);

                // @ts-expect-error - one unflagged arm makes the whole conjunction unflagged
                const b: SnapshotPredicate<true> = indexes.and(indexes.eq("status", "sent"), indexes.gt("total", 1));

                // @ts-expect-error - raw never brands; rawAcrossOrganizations is the door for a hand-written cross-org fragment
                const c: SnapshotPredicate<true> = indexes.raw("1 = 1");

                // @ts-expect-error - nor is an order by term on an unflagged path branded
                const d: SnapshotOrderBy<true> = indexes.orderBy("total");

                assert.ok([a, b, c, d]);
            };

            assert.strictEqual(typeof rejected, "function");
            // the runtime half of the same claim
            assert.deepStrictEqual(
                [flagged, unflagged, allAcross, negated, ordered, hand, member].map(t => t.acrossOrganizations),
                [true, false, true, true, true, true, true]);
        });

        // The option is declarable only where it means something, and brands only as a literal.
        await test("acrossOrganizations is refused on a plain state, and a non-literal flag does not brand", async () =>
        {
            const rejected = (flag: boolean): void =>
            {
                // @ts-expect-error - a plain snapshot table has no organization_id column, so there is no prefix to cross
                SnapshotQuerySet.for<PlainState>().withPath("status", { acrossOrganizations: true });

                // a boolean-typed flag is not the literal `true`: the path is declared, but not branded
                const maybe = SnapshotQuerySet.for<TicketState>().withPath("status", { acrossOrganizations: flag });

                // @ts-expect-error - not branded, because the flag arrived as `boolean`
                const p: SnapshotPredicate<true> = maybe.eq("status", "sent");

                assert.ok(p);
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

        // the override trap: copying the base's DECLARED type used to compile and silently discard
        // path and cast checking. Now both spellings of the mistake announce themselves.
        await test("a widened or declaration-typed override cannot query", async () =>
        {
            const rejected = (): void =>
            {
                class TrapEventStreamRepository extends OrgEventStreamBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
                {
                    protected onSave(): Promise<void> { return Promise.resolve(); }
                }

                // spelling 1: the base's declared type. It compiles - it IS the declared type - but
                // carries no query methods, so the first predicate is where the mistake surfaces.
                class DeclarationTypedRepository extends OrgSnapshotBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
                {
                    protected override get querySet(): DeclaredSnapshotQuerySet<TicketState> { return indexes; }

                    public constructor(eventStreamRepository: TrapEventStreamRepository)
                    {
                        super(eventStreamRepository);
                    }

                    public rejectedQuery(): void
                    {
                        // @ts-expect-error - the declaration-only view cannot build a predicate: no eq
                        this.querySet.eq("status", "open"); // eslint-disable-line @typescript-eslint/no-unsafe-call
                    }
                }

                // spelling 2: the old widened type no longer satisfies the base. Under `any` the
                // phantom brand resolves to its error-message type instead of `true`, so the
                // override declaration itself is the compile error - and the message names the fix.
                // (An assignment BETWEEN the two class instantiations would pass TypeScript's
                // variance fast path; the structural check against the interface is what bites.)
                class WidenedRepository extends OrgSnapshotBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
                {
                    // @ts-expect-error - SnapshotQuerySet<TState, any, any> does not satisfy DeclaredSnapshotQuerySet
                    protected override get querySet(): SnapshotQuerySet<TicketState, any, any> { return indexes; }

                    public constructor(eventStreamRepository: TrapEventStreamRepository)
                    {
                        super(eventStreamRepository);
                    }
                }

                assert.strictEqual(typeof DeclarationTypedRepository, "function");
                assert.strictEqual(typeof WidenedRepository, "function");
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

                // the raw-string predicate and its positional parameters are gone. They enforced
                // different rules from `querySet.raw`, and which source the values came from depended
                // on the *runtime* type of `where` - so `query({ where: predicate }, value)` was
                // compile-legal and threw. A hand-written fragment goes through `raw`, which carries
                // its own values
                public rejectedRawString(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - a predicate is a SnapshotPredicate, not a string
                    return this.query("(data->>'status') = ?", "open");
                }

                public rejectedRawStringInQuery(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - and RepositoryQuery.where is narrowed the same way
                    return this.query({ where: "(data->>'status') = ?" }, "open");
                }

                public acceptedRaw(): Promise<Array<Ticket>>
                {
                    // the surviving door, and it validates the fragment on the way in
                    return this.query(this.querySet.raw(`${this.querySet.expressionFor("status")} like ?`, "op%"));
                }

                // `getAll` takes no arguments and `getByIds` takes an array, which is what keeps the
                // two apart. As one rest-parameter method they were the same *call* over an empty
                // list, so the empty case had to mean either everything or nothing - and whichever it
                // meant, the callers expecting the other got it silently.
                public async rejectedGetAllWithIds(): Promise<void>
                {
                    // @ts-expect-error - getAll is the whole set; it takes no ids
                    await this.getAll("tkt_1");
                }

                public async rejectedGetAllSpread(): Promise<void>
                {
                    const ids = ["tkt_1", "tkt_2"];

                    // @ts-expect-error - and a spread cannot reach it either, which is the point
                    await this.getAll(...ids);
                }

                public async rejectedGetByIdsSpread(): Promise<void>
                {
                    // @ts-expect-error - getByIds takes the array itself, not a rest parameter
                    await this.getByIds("tkt_1", "tkt_2");
                }

                public async acceptedReads(): Promise<void>
                {
                    await this.getAll();
                    await this.getByIds([]);
                    await this.getByIds(["tkt_1", "tkt_2"]);
                }

                // an id lookup filtered by a declared path - the one composition the query set cannot
                // express on its own, because `id` is a column beside `data` rather than a path inside
                // it. The predicate is checked exactly as it is anywhere else
                public acceptedFilteredById(): Promise<Ticket | null>
                {
                    return this.queryById("tkt_1", this.querySet.eq("status", "open"));
                }

                public acceptedFilteredByIds(): Promise<Array<Ticket>>
                {
                    return this.queryByIds(["tkt_1", "tkt_2"], this.querySet.gt("total", 10));
                }

                // The typed cross-organization doors take only a branded predicate - one whose every
                // path is declared `acrossOrganizations` (or is an array path), so that dropping the
                // organization filter still leaves an index to walk. `status` is declared so in the
                // fixture; `total` is not.
                public acceptedAcross(status: string): Promise<Array<Ticket>>
                {
                    return this.queryAcrossOrganizations(this.querySet.eq("status", status));
                }

                public acceptedAcrossComposed(status: string): Promise<Array<Ticket>>
                {
                    return this.queryAcrossOrganizations({
                        where: this.querySet.and(this.querySet.eq("status", status), this.querySet.contains("labels", "urgent")),
                        orderBy: this.querySet.orderBy("status", "desc"),
                        limit: 5
                    });
                }

                public acceptedAcrossRaw(prefix: string): Promise<Array<Ticket>>
                {
                    // the hand-written cross-org fragment, branded by the caller through the named door
                    return this.queryAcrossOrganizations(
                        this.querySet.rawAcrossOrganizations(`${this.querySet.expressionFor("status")} like ?`, prefix));
                }

                public acceptedAcrossCountAndExists(status: string): Promise<[number, boolean]>
                {
                    return Promise.all([
                        this.countAcrossOrganizations(this.querySet.eq("status", status)),
                        this.existsAcrossOrganizations(this.querySet.eq("status", status), "tkt_1")
                    ]);
                }

                public acceptedAcrossEverything(): Promise<[Array<Ticket>, number, boolean]>
                {
                    // no predicate at all: the whole table, every organization - deliberate, and spelt out
                    return Promise.all([
                        this.queryAcrossOrganizations({}),
                        this.countAcrossOrganizations(),
                        this.existsAcrossOrganizations()
                    ]);
                }

                public acceptedStatementAcross(status: string): Promise<Array<Ticket>>
                {
                    // the raw statement door, renamed to say what it is - the plain variant's `queryStatement`
                    return this.queryStatementAcrossOrganizations(
                        `select data from ${this.table} where ${this.querySet.expressionFor("status")} = ?;`, status);
                }

                public rejectedAcrossUnflagged(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - total is not declared across organizations: no index to walk once the filter is gone
                    return this.queryAcrossOrganizations(this.querySet.gt("total", 1));
                }

                public rejectedAcrossMixed(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - one unflagged arm is enough to reject the conjunction
                    return this.queryAcrossOrganizations(this.querySet.and(this.querySet.eq("status", "open"), this.querySet.gt("total", 1)));
                }

                public rejectedAcrossOrderBy(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - and an order by on an unflagged path is rejected on the query form
                    return this.queryAcrossOrganizations({ where: this.querySet.eq("status", "open"), orderBy: this.querySet.orderBy("total") });
                }

                public rejectedAcrossRaw(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - raw never brands; rawAcrossOrganizations is the door
                    return this.queryAcrossOrganizations(this.querySet.raw("1 = 1"));
                }

                public rejectedAcrossCount(): Promise<number>
                {
                    // @ts-expect-error - the count door is typed the same way
                    return this.countAcrossOrganizations(this.querySet.gt("total", 1));
                }

                public rejectedAcrossExists(): Promise<boolean>
                {
                    // @ts-expect-error - and the exists door
                    return this.existsAcrossOrganizations(this.querySet.gt("total", 1));
                }

                public rejectedOldStatementDoor(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - the typed door does not take a statement; that is queryStatementAcrossOrganizations now
                    return this.queryAcrossOrganizations(`select data from ${this.table};`);
                }

                // and the scoped doors are unmoved: a flagged predicate is index-served there too, since
                // the path keeps its org-leading index
                public acceptedFlaggedScoped(status: string): Promise<Array<Ticket>>
                {
                    return this.query({ where: this.querySet.eq("status", status), orderBy: this.querySet.orderBy("status") });
                }

                public rejectedFilteredByUndeclaredPath(): Promise<Ticket | null>
                {
                    // @ts-expect-error - the narrow type reaches the new door too: 'unindexed' was never declared
                    return this.queryById("tkt_1", this.querySet.eq("unindexed", "x"));
                }

                public rejectedFilteredByWrongValue(): Promise<Array<Ticket>>
                {
                    // @ts-expect-error - and so does the value check
                    return this.queryByIds(["tkt_1"], this.querySet.eq("total", "100"));
                }

                // the public reads stay one-argument. A predicate is publicly constructible - the
                // migration consumes the very same static a repository exposes - so an optional
                // predicate on `get` would have made every repository filterable from outside its own
                // class, which is the surface `query`, `exists` and `count` all withhold
                public async rejectedFilteredGet(): Promise<void>
                {
                    // @ts-expect-error - get takes the id alone; queryById is where a predicate goes
                    await this.get("tkt_1", this.querySet.eq("status", "open"));
                }

                public async rejectedFilteredGetByIds(): Promise<void>
                {
                    // @ts-expect-error - and getByIds likewise
                    await this.getByIds(["tkt_1"], this.querySet.eq("status", "open"));
                }

                // An org repository gets exactly one raw door, and it is named for the fact that
                // nothing scopes it. Both of the rejections below have been real at some point:
                // `queryRaw` was the inherited name before it was moved off the base, and
                // `executeRawQuery` was the neutrally-named body that briefly replaced it there -
                // which defeated the exercise, since a protected member is inherited by all four
                // classes and so left this class with two unscoped doors instead of one. Nothing
                // asserted either was gone until now.
                // `@ts-expect-error` is the assertion - tsc reports an unused one as an error, so
                // these fail the build if either door reopens. The trailing disables are for the
                // *lint* rule, which sees a call on a type the compiler could not resolve, which is
                // exactly what is being asserted. Trailing rather than on their own line because
                // `@ts-expect-error` has to be the last comment before the call.
                public async rejectedInheritedRawDoor(): Promise<void>
                {
                    // @ts-expect-error - the plain variants' name; not on an org repository
                    await this.queryRaw<unknown>("select 1;"); // eslint-disable-line @typescript-eslint/no-unsafe-call
                }

                public async rejectedNeutralRawDoor(): Promise<void>
                {
                    // @ts-expect-error - the shared body is a free function now, not an inherited member
                    await this.executeRawQuery<unknown>("select 1;"); // eslint-disable-line @typescript-eslint/no-unsafe-call
                }

                public async acceptedRawDoor(): Promise<void>
                {
                    // the one that survives, and the name says what it does not do
                    await this.queryRawAcrossOrganizations<unknown>("select 1;");
                }
            }

            // From outside the class the filtered reads are not doors at all, and that is the whole
            // reason the predicate lives on them rather than as a second argument to `get`. A
            // SnapshotPredicate is publicly constructible by necessity - the migration consumes the
            // very same `indexes` static the repository exposes - so an optional predicate on a public
            // method would have been publicly *usable*, making every repository filterable by its
            // callers. `query`, `exists` and `count` all withhold that surface; these now do too.
            const fromOutside = async (repository: TicketRepository): Promise<void> =>
            {
                // @ts-expect-error - protected: a filtered read is composed inside the class
                await repository.queryById("tkt_1", TicketRepository.indexes.eq("status", "open"));

                // @ts-expect-error - and likewise the set-shaped one
                await repository.queryByIds(["tkt_1"], TicketRepository.indexes.eq("status", "open"));

                // what a caller does get is the unfiltered pair, unchanged
                await repository.get("tkt_1");
                await repository.getByIds(["tkt_1"]);
            };

            assert.strictEqual(typeof TicketRepository, "function");
            assert.strictEqual(typeof fromOutside, "function");
        });

        // the shape that used to compile, create every btree index, and silently omit every GIN one
        await test("a query set's btree indexes alone are not accepted by the creator", async () =>
        {
            const rejected = async (creator: DbTableCreator): Promise<void> =>
            {
                // @ts-expect-error - the bare array form is gone; pass the set, or both collections
                await creator.createSnapshotTableForOrgAggregate(ticketType, indexes.indexes);

                // @ts-expect-error - and arrayIndexes is required, so it cannot be dropped by omission
                await creator.createSnapshotTableForOrgAggregate(ticketType, { indexes: [...indexes.indexes] });
            };

            assert.strictEqual(typeof rejected, "function");
        });
    });

    await describe("Emitted SQL", async () =>
    {
        await test("comparisons emit the declared expression, parenthesized, with the value bound", async () =>
        {
            assert.deepStrictEqual(indexes.eq("status", "sent"),
                { sql: `((data->>'status') = ?)`, params: ["sent"], acrossOrganizations: true });

            assert.deepStrictEqual(indexes.ne("status", "sent"),
                { sql: `((data->>'status') <> ?)`, params: ["sent"], acrossOrganizations: true });

            assert.deepStrictEqual(indexes.gt("total", 100),
                { sql: `(((data->>'total')::numeric) > ?)`, params: [100], acrossOrganizations: false });

            assert.deepStrictEqual(indexes.gte("total", 100),
                { sql: `(((data->>'total')::numeric) >= ?)`, params: [100], acrossOrganizations: false });

            assert.deepStrictEqual(indexes.lt("total", 100),
                { sql: `(((data->>'total')::numeric) < ?)`, params: [100], acrossOrganizations: false });

            assert.deepStrictEqual(indexes.lte("total", 100),
                { sql: `(((data->>'total')::numeric) <= ?)`, params: [100], acrossOrganizations: false });
        });

        await test("a nested path uses the #>> form, matching the index", async () =>
        {
            assert.deepStrictEqual(indexes.eq("party.city", "Toronto"),
                { sql: `((data#>>'{"party","city"}') = ?)`, params: ["Toronto"], acrossOrganizations: false });
        });

        await test("in emits one placeholder per value", async () =>
        {
            assert.deepStrictEqual(indexes.in("status", ["sent", "paid", "void"]),
                { sql: `((data->>'status') in (?,?,?))`, params: ["sent", "paid", "void"], acrossOrganizations: true });
        });

        await test("null checks bind nothing", async () =>
        {
            assert.deepStrictEqual(indexes.isNull("status"), { sql: `((data->>'status') is null)`, params: [], acrossOrganizations: true });
            assert.deepStrictEqual(indexes.isNotNull("status"), { sql: `((data->>'status') is not null)`, params: [], acrossOrganizations: true });
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

            // a GIN index carries no tenant prefix, so a containment predicate crosses organizations with its index
            assert.strictEqual(predicate.acrossOrganizations, true);
        });

        await test("and/or nest safely and concatenate params in fragment order", async () =>
        {
            const combined = indexes.and(
                indexes.eq("status", "sent"),
                indexes.or(indexes.gt("total", 10), indexes.eq("isRush", true)));

            assert.strictEqual(combined.sql,
                `(((data->>'status') = ?) and ((((data->>'total')::numeric) > ?) or ((data->>'isRush') = ?)))`);
            assert.deepStrictEqual(combined.params, ["sent", 10, true]);
            // total and isRush are not declared across organizations, so neither is the whole
            assert.strictEqual(combined.acrossOrganizations, false);

            // every arm declared across organizations - status is, and containment always is - so the whole is too
            assert.strictEqual(
                indexes.and(indexes.eq("status", "sent"), indexes.contains("labels", "urgent")).acrossOrganizations, true);
            assert.strictEqual(
                indexes.or(indexes.eq("status", "sent"), indexes.isNull("status")).acrossOrganizations, true);
        });

        await test("not wraps a predicate and keeps its params", async () =>
        {
            assert.deepStrictEqual(indexes.not(indexes.eq("status", "sent")),
                { sql: `(not ((data->>'status') = ?))`, params: ["sent"], acrossOrganizations: true });
        });

        await test("raw parenthesizes a hand-written fragment so it composes", async () =>
        {
            const combined = indexes.and(
                indexes.eq("status", "sent"),
                indexes.raw(`${indexes.expressionFor("party.city")} like ?`, "To%"));

            assert.strictEqual(combined.sql,
                `(((data->>'status') = ?) and ((data#>>'{"party","city"}') like ?))`);
            assert.deepStrictEqual(combined.params, ["sent", "To%"]);
            // raw never brands - the caller wrote the fragment - so neither does anything it is part of
            assert.strictEqual(combined.acrossOrganizations, false);
        });

        await test("rawAcrossOrganizations parenthesizes like raw, validates like raw, and brands the fragment", async () =>
        {
            const predicate = indexes.rawAcrossOrganizations(`${indexes.expressionFor("status")} like ?`, "se%");

            assert.deepStrictEqual(predicate, { sql: `((data->>'status') like ?)`, params: ["se%"], acrossOrganizations: true });

            assert.throws(() => indexes.rawAcrossOrganizations("select 1 from t"), ArgumentException);
            assert.throws(() => indexes.rawAcrossOrganizations("a = ?; drop table t", 1), ArgumentException);
            assert.throws(() => indexes.rawAcrossOrganizations("   "), ArgumentException);
        });

        await test("orderBy emits the declared expression and an optional direction", async () =>
        {
            assert.deepStrictEqual(indexes.orderBy("total", "desc"), { sql: `((data->>'total')::numeric) desc`, acrossOrganizations: false });
            assert.deepStrictEqual(indexes.orderBy("status"), { sql: `(data->>'status')`, acrossOrganizations: true });
        });

        await test("the set exposes real index instances, in declaration order", async () =>
        {
            assert.ok(indexes.indexes.every(t => t instanceof SnapshotIndex));
            assert.ok(indexes.arrayIndexes.every(t => t instanceof SnapshotArrayIndex));

            // five withPath calls plus one composite
            assert.deepStrictEqual(indexes.indexes.map(t => t.paths.join("+")),
                ["status", "total", "openedAt", "isRush", "party.city", "series+revision"]);

            assert.deepStrictEqual(indexes.arrayIndexes.map(t => t.path), ["labels", "lines", "plan.badges"]);

            assert.deepStrictEqual(indexes.indexes.map(t => t.isUnique),
                [false, false, false, false, false, true]);
        });

        // copy-on-write: the chain does not mutate what it was called on, so a set is safe to share
        await test("acrossOrganizationsPaths names the flagged scalar paths, and the index carries the flag", async () =>
        {
            assert.deepStrictEqual(indexes.acrossOrganizationsPaths, ["status"]);
            assert.deepStrictEqual(indexes.indexes.map(t => t.isAcrossOrganizations), [true, false, false, false, false, false]);

            // a composite flagged as a whole flags each of its paths, on one index
            const composite = SnapshotQuerySet.for<TicketState>()
                .withComposite(["series", { path: "revision", type: JsonValueType.integer }], { acrossOrganizations: true });

            assert.deepStrictEqual(composite.acrossOrganizationsPaths, ["series", "revision"]);
            assert.strictEqual(composite.indexes[0].isAcrossOrganizations, true);

            // and the receiver of a with... call is unmoved, as always
            assert.deepStrictEqual(SnapshotQuerySet.for<TicketState>().withPath("status").acrossOrganizationsPaths, []);
        });

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

        // `raw` and the predicate a RepositoryQuery carries used to enforce different rules, and
        // `raw` parenthesizes what it is given - so `raw("select 1 from t")` reached the builder as
        // "(select 1 from t)" and passed an anchored `^\s*select` guard that "select 1 from t" fails.
        // Both doors share one validator now, and it runs before the parentheses go on
        await test("a raw fragment that is a whole statement throws, at construction", async () =>
        {
            assert.throws(() => indexes.raw("select 1 from ticket_snaps"), ArgumentException);
            assert.throws(() => indexes.raw("  SELECT data from ticket_snaps"), ArgumentException);
            assert.throws(() => indexes.raw("with x as (select 1) select * from x"), ArgumentException);
        });

        await test("a raw fragment that keeps the 'where' keyword throws, at construction", async () =>
        {
            assert.throws(() => indexes.raw("where status = ?", "open"), ArgumentException);
            assert.throws(() => indexes.raw("  WHERE status = ?", "open"), ArgumentException);
        });

        await test("a legitimate raw fragment still passes, and parenthesizes itself", async () =>
        {
            const predicate = indexes.raw(`${indexes.expressionFor("status")} like ?`, "op%");

            assert.strictEqual(predicate.sql, "((data->>'status') like ?)");
            assert.deepStrictEqual(predicate.params, ["op%"]);

            // "select" only trips the guard as the leading keyword, not as a substring
            assert.ok(indexes.raw("selected = ?", true).sql.contains("selected"));
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

    // The doors' statements, pinned without a database: a recording Db hands back empty results (and
    // a count row), so what is asserted is the SQL and the bindings each door emits - and that the
    // runtime guard refuses an unbranded predicate before anything reaches the database.
    await describe("The cross-organization doors", async () =>
    {
        class RecordingDb implements Db
        {
            public readonly queries = new Array<{ sql: string; params: ReadonlyArray<any>; }>();

            public executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>
            {
                this.queries.push({ sql, params });

                // a count statement needs its one row; everything else reads as "nothing matched"
                return Promise.resolve(new QueryResult<T>(sql.startsWith("select cast(count") ? [<T><unknown>{ count: 7 }] : []));
            }

            public executeCommand(): Promise<void> { return Promise.resolve(); }
            public executeCommandWithinUnitOfWork(): Promise<void> { return Promise.resolve(); }
        }

        class NoUnitOfWork implements UnitOfWork
        {
            public getTransactionScope(): Promise<object> { return Promise.resolve({}); }
            public onCommit(): void { /* never committed here */ }
            public commit(): Promise<void> { return Promise.resolve(); }
            public onRollback(): void { /* never rolled back here */ }
            public rollback(): Promise<void> { return Promise.resolve(); }
        }

        // every read here returns no rows, so no state is ever created or deserialized
        class TicketStateFactory extends OrgAggregateStateFactory<TicketState>
        {
            public create(): TicketState { throw new Error("no ticket is ever created in this block"); }
        }

        class TicketEventStreamRepository extends OrgEventStreamBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
        {
            public constructor(db: Db)
            {
                const context = new OrgConfigurableDomainContext("user_1", ORG);

                super(context, db, new NoUnitOfWork(), new SilentLogger(), Ticket, new TicketStateFactory(context));
            }

            protected onSave(): Promise<void> { return Promise.resolve(); }
        }

        class TicketRepository extends OrgSnapshotBaseRepository<Ticket, TicketState, OrgDomainEvent<TicketState>>
        {
            public static readonly indexes = indexes;

            protected override get querySet(): typeof TicketRepository.indexes { return TicketRepository.indexes; }

            public constructor(eventStreamRepository: TicketEventStreamRepository)
            {
                super(eventStreamRepository);
            }

            public across(status: string): Promise<Array<Ticket>>
            {
                return this.queryAcrossOrganizations(this.querySet.eq("status", status));
            }

            public acrossPaged(status: string): Promise<Array<Ticket>>
            {
                return this.queryAcrossOrganizations({
                    where: this.querySet.eq("status", status),
                    orderBy: this.querySet.orderBy("status", "desc"),
                    limit: 5,
                    offset: 10
                });
            }

            public scoped(status: string): Promise<Array<Ticket>>
            {
                return this.query(this.querySet.eq("status", status));
            }

            public countAcross(status?: string): Promise<number>
            {
                return this.countAcrossOrganizations(status == null ? undefined : this.querySet.eq("status", status));
            }

            public existsAcross(status: string, excludeId?: string): Promise<boolean>
            {
                return this.existsAcrossOrganizations(this.querySet.eq("status", status), excludeId);
            }

            public statementAcross(status: string): Promise<Array<Ticket>>
            {
                return this.queryStatementAcrossOrganizations(
                    `select data from ${this.table} where ${this.querySet.expressionFor("status")} = ?;`, status);
            }

            // the runtime guard's subjects: the unbranded shapes a JavaScript caller, or an `any`, could pass
            public acrossUnchecked(whereOrQuery: any): Promise<Array<Ticket>> { return this.queryAcrossOrganizations(whereOrQuery); }
            public countUnchecked(predicate: any): Promise<number> { return this.countAcrossOrganizations(predicate); }
            public existsUnchecked(predicate: any): Promise<boolean> { return this.existsAcrossOrganizations(predicate); }
        }

        const build = (): { repository: TicketRepository; db: RecordingDb; } =>
        {
            const db = new RecordingDb();

            return { repository: new TicketRepository(new TicketEventStreamRepository(db)), db };
        };

        await test("the typed door builds the statement with no organization filter; the scoped door keeps it", async () =>
        {
            const { repository, db } = build();

            assert.deepStrictEqual(await repository.across("open"), []);
            assert.deepStrictEqual(await repository.scoped("open"), []);

            assert.deepStrictEqual(db.queries, [
                { sql: "select data from ticket_snaps where (((data->>'status') = ?));", params: ["open"] },
                { sql: "select data from ticket_snaps where organization_id = ? and (((data->>'status') = ?));", params: [ORG, "open"] }
            ]);
        });

        await test("the query form carries order by, limit and offset across organizations", async () =>
        {
            const { repository, db } = build();

            await repository.acrossPaged("open");

            assert.deepStrictEqual(db.queries, [{
                sql: "select data from ticket_snaps where (((data->>'status') = ?)) order by (data->>'status') desc limit ? offset ?;",
                params: ["open", 5, 10]
            }]);
        });

        await test("countAcrossOrganizations and existsAcrossOrganizations drop the filter too, and take no predicate at all", async () =>
        {
            const { repository, db } = build();

            assert.strictEqual(await repository.countAcross("open"), 7);
            assert.strictEqual(await repository.countAcross(), 7);
            assert.strictEqual(await repository.existsAcross("open", "tkt_1"), false);

            assert.deepStrictEqual(db.queries.map(t => t.sql), [
                "select cast(count(*) as int) as count from ticket_snaps where (((data->>'status') = ?));",
                "select cast(count(*) as int) as count from ticket_snaps;",
                "select 1 from ticket_snaps where (((data->>'status') = ?)) and id <> ? limit 1;"
            ]);
            assert.deepStrictEqual(db.queries[2].params, ["open", "tkt_1"]);
        });

        await test("the statement door runs what it is given", async () =>
        {
            const { repository, db } = build();

            await repository.statementAcross("open");

            assert.deepStrictEqual(db.queries, [{ sql: "select data from ticket_snaps where (data->>'status') = ?;", params: ["open"] }]);
        });

        // the compile-time refusal has a runtime twin, for a JavaScript caller or an `any`: nothing
        // unbranded reaches the database
        await test("an unbranded predicate or order by term is refused before any statement runs", async () =>
        {
            const { repository, db } = build();
            const unbranded = indexes.gt("total", 1);
            const bare = { sql: "1 = 1", params: [] };
            const refused = (e: any): boolean => e instanceof ArgumentException && e.message.contains("acrossOrganizations");

            await assert.rejects(() => repository.acrossUnchecked(unbranded), refused);
            await assert.rejects(() => repository.acrossUnchecked(bare), refused);
            await assert.rejects(() => repository.acrossUnchecked({ where: indexes.eq("status", "open"), orderBy: indexes.orderBy("total") }), refused);
            await assert.rejects(() => repository.acrossUnchecked({ where: indexes.eq("status", "open"), orderBy: [indexes.orderBy("status"), indexes.orderBy("total")] }), refused);
            await assert.rejects(() => repository.countUnchecked(unbranded), refused);
            await assert.rejects(() => repository.existsUnchecked(unbranded), refused);

            assert.deepStrictEqual(db.queries, []);

            // a raw string order by is the caller's, as it is on the scoped form
            await repository.acrossUnchecked({ where: indexes.eq("status", "open"), orderBy: "id" });
            assert.strictEqual(db.queries.length, 1);
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
                            'lines', json_build_array(json_build_object('sku', 'sku' || (g % 89), 'isVoid', false)),
                            -- the nested serialized record, $typename and all, so plan.badges is
                            -- reached the way a real DomainObject member is. 83 is prime, like the
                            -- moduli above, so badge and organization stay coprime
                            'plan', json_build_object(
                                'tier', 'free',
                                'seatLimit', 3,
                                'badges', json_build_array('b' || (g % 83)),
                                '$typename', 'Test.PlanVo')
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
            assert.ok(names.contains("idx_ticket_snaps_plan_badges_gin"), names.join(", "));

            // the flagged path's prefix-free twin - and no twin for the unflagged one
            assert.ok(names.contains("idx_ticket_snaps_status_xorg"), names.join(", "));
            assert.ok(!names.contains("idx_ticket_snaps_total_xorg"), names.join(", "));
        });

        // the claim that makes one declaration worth having: the predicate cannot drift from the index
        await test("a predicate from the set uses the index the set declared", async () =>
        {
            const predicate = indexes.eq("status", "st7");
            const plan = await planFor(`organization_id = ? and ${predicate.sql}`, ORG, ...predicate.params);

            assert.ok(plan.contains("idx_ticket_snaps_status"), plan);
            assert.ok(!plan.contains("Seq Scan"), plan);
            // and the organization filter is served BY the index rather than applied to its output: an
            // Index Cond naming organization_id is the org-leading index at work, where the twin (whose
            // name contains this one's) would show the column as a Filter. The planner prefers the
            // org-leading index on this fixture because it is strictly more selective - 5 organizations
            // x 499 statuses, so its lookup returns ~2 rows where the twin's returns ~11 and filters -
            // which is exactly why the twin leaves scoped reads unchanged
            assert.ok(/Index Cond:[^\n]*organization_id/.test(plan), plan);
        });

        // What "the whole index is scanned" looks like, measured rather than inferred: the pages the
        // index scan node touched, against the pages the index has. A lookup touches a handful; a scan
        // of a non-leading column touches every one.
        //
        // The index node and its own Buffers line - the heap node above a bitmap scan has one too, so
        // the match anchors on the index node, whichever shape the planner chose. Pages are hit plus
        // read, so a cold cache counts the same as a warm one.
        const indexScanOf = (plan: string): { index: string; touched: number; } | null =>
        {
            const match = /(?:Bitmap )?Index(?: Only)? Scan (?:on|using) (\S+)[^\n]*\n(?:[^\n]*\n)*?\s*Buffers: ([^\n]*)/.exec(plan);
            if (match == null)
                return null;

            const count = (kind: string): number => Number(new RegExp(`${kind}=(\\d+)`).exec(match[2])?.[1] ?? 0);

            return { index: match[1], touched: count("hit") + count("read") };
        };

        const indexScanBuffers = async (predicate: string, ...params: ReadonlyArray<any>): Promise<{ index: string; touched: number; pages: number; }> =>
        {
            const explained = await db.executeQuery<any>(
                `explain (analyze, buffers, costs off, timing off, summary off) select id from ticket_snaps where ${predicate};`, ...params);
            const plan = explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");
            const scan = indexScanOf(plan);
            assert.ok(scan != null, plan);

            // `cast(... as regclass)` rather than `?::regclass`: a `?` beside a `:` is a knex binding hazard
            const size = await db.executeQuery<any>(`select pg_relation_size(cast(? as regclass)) / 8192 as pages;`, scan.index);

            return { ...scan, pages: Number(size.rows[0].pages) };
        };

        // The reader the planner proof rests on, pinned on its own: EXPLAIN prints a bitmap scan as
        // `Bitmap Index Scan on <idx>` and a plain one as `Index Scan using <idx> on <table>`, and a cold
        // cache reports pages as `read=` beside or instead of `hit=`. Either shape is a valid lookup, and
        // both must count.
        await test("the plan reader understands both index-scan shapes and a cold cache", () =>
        {
            const bitmap = [
                "Bitmap Heap Scan on ticket_snaps (actual rows=11 loops=1)",
                "  Recheck Cond: ((data ->> 'status'::text) = 'st7'::text)",
                "  Heap Blocks: exact=11",
                "  Buffers: shared hit=13",
                "  ->  Bitmap Index Scan on idx_ticket_snaps_status_xorg (actual rows=11 loops=1)",
                "        Index Cond: ((data ->> 'status'::text) = 'st7'::text)",
                "        Buffers: shared hit=2"
            ].join("\n");
            const plain = [
                "Index Scan using idx_ticket_snaps_total on ticket_snaps (actual rows=10 loops=1)",
                "  Index Cond: (((data ->> 'total'::text))::numeric > '4990'::numeric)",
                "  Buffers: shared hit=1 read=3"
            ].join("\n");

            assert.deepStrictEqual(indexScanOf(bitmap), { index: "idx_ticket_snaps_status_xorg", touched: 2 });
            assert.deepStrictEqual(indexScanOf(plain), { index: "idx_ticket_snaps_total", touched: 4 });
            assert.strictEqual(indexScanOf("Seq Scan on ticket_snaps (actual rows=10 loops=1)\n  Buffers: shared hit=200"), null);
        });

        // The claim this feature exists to make: a predicate on a path declared across organizations is
        // an index LOOKUP with the organization filter dropped. The control is the same kind of read on
        // the unflagged path, which has only the org-leading index: btree serves a leading prefix, so
        // the planner either scans the table or - where rows are wide, as here - walks that index end to
        // end, checking the non-leading column on every entry. Neither is a lookup, and the buffers say so.
        await test("a cross-organization predicate on a flagged path is a lookup on the _xorg twin; on an unflagged path the table or the whole index is scanned", async () =>
        {
            const flagged = indexes.eq("status", "st7");
            const across = await planFor(flagged.sql, ...flagged.params);

            assert.ok(across.contains("idx_ticket_snaps_status_xorg"), across);
            assert.ok(!across.contains("Seq Scan"), across);

            const twin = await indexScanBuffers(flagged.sql, ...flagged.params);
            assert.strictEqual(twin.index, "idx_ticket_snaps_status_xorg");
            assert.ok(twin.touched <= 3, `a lookup on the twin touched ${twin.touched} of its ${twin.pages} pages`);

            // the control is a claim about the planner this proves it against: Postgres 18 adds a btree
            // skip scan that walks an org-leading index once per distinct organization_id, which would
            // make the unflagged read cheap without a twin - a changed premise rather than a regression,
            // so the control stops at the version where the premise holds
            const version = Number((await db.executeQuery<any>("show server_version_num;")).rows[0].server_version_num);
            if (version < 180000)
            {
                const unflagged = indexes.gt("total", 4990);
                const control = await planFor(unflagged.sql, ...unflagged.params);

                if (control.contains("Seq Scan"))
                    assert.ok(!control.contains("idx_ticket_snaps_total"), control);
                else
                {
                    const whole = await indexScanBuffers(unflagged.sql, ...unflagged.params);
                    assert.strictEqual(whole.index, "idx_ticket_snaps_total");
                    // relative to the lookup rather than to an absolute page count, so row width and
                    // fixture size cannot move it: a whole-index walk is many times a lookup
                    assert.ok(whole.touched > twin.touched * 4,
                        `expected the whole org-leading index (${whole.pages} pages) to be read, not a lookup; it touched ${whole.touched} where the twin's lookup touched ${twin.touched}`);
                }
            }
        });

        // ordering is served the same way: the twin is a btree over the flagged expression, so a
        // cross-organization order by walks it instead of sorting
        await test("a cross-organization order by on a flagged path walks the _xorg twin", async () =>
        {
            const term = indexes.orderBy("status", "desc");
            const explained = await db.executeQuery<any>(
                `explain (costs off) select id from ticket_snaps order by ${term.sql} limit 5;`);
            const plan = explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");

            assert.ok(plan.contains("idx_ticket_snaps_status_xorg"), plan);
            assert.ok(!plan.contains("Sort"), plan);
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

        // the same claim one level down, where the extraction is `#>` over a quoted path array
        // rather than `->`. Worth pinning separately: expression indexes match TEXTUALLY, so a
        // near-miss on the nested form would sequential-scan silently rather than error - and this
        // is the shape n-domain 4.0.3 made writable, so nothing covered it before.
        await test("a nested containment predicate uses the GIN index the set declared", async () =>
        {
            const predicate = indexes.contains("plan.badges", "b7");
            const plan = await planFor(`organization_id = ? and ${predicate.sql}`, ORG, ...predicate.params);

            assert.ok(plan.contains("idx_ticket_snaps_plan_badges_gin"), plan);
            assert.ok(!plan.contains("Seq Scan"), plan);

            const result = await db.executeQuery<any>(
                `select data from ticket_snaps where ${predicate.sql};`, ...predicate.params);

            assert.ok(result.rows.length > 0);
            assert.ok(result.rows.every(t => (<Array<string>>t.data.plan.badges).contains("b7")));
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
