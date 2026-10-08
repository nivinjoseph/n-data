import { DomainEntity, DomainObjectData } from "@nivinjoseph/n-domain";
import { ArgumentException } from "@nivinjoseph/n-exception";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { describe } from "node:test";
import { ColumnType, DataHelper, ReadModel, ReadModelColumns, ReadModelData, ReadModelOrderBy, ReadModelPredicate, ReadModelSchema, SnapshotQuerySet } from "../src/index.js";
import { catalogTypeOf, elementTypeOf, isArrayColumnType, isColumnType, isReservedWord } from "../src/read-model/column-type.js";


/**
 * The fixture every block below declares against: one property per column kind, a nullable one,
 * a literal union, an undecorated derived getter, and a decorated getter deliberately left out of
 * TDataKeys (the one gap the types cannot see - see the verifyModel block).
 */
@serialize
class OrderSummary extends ReadModel<OrderSummary, "customerId" | "total" | "placedAt" | "note" | "tags" | "isPaid" | "scores" | "status" | "rating">
{
    private readonly _customerId: string;
    private readonly _total: number;
    private readonly _placedAt: number;
    private readonly _note: string | null;
    private readonly _tags: ReadonlyArray<string>;
    private readonly _isPaid: boolean;
    private readonly _scores: ReadonlyArray<number> | null;
    private readonly _status: "open" | "closed";
    private readonly _rating: number;

    @serialize public get customerId(): string { return this._customerId; }
    @serialize public get total(): number { return this._total; }
    @serialize public get placedAt(): number { return this._placedAt; }
    @serialize public get note(): string | null { return this._note; }
    @serialize public get tags(): ReadonlyArray<string> { return this._tags; }
    @serialize public get isPaid(): boolean { return this._isPaid; }
    @serialize public get scores(): ReadonlyArray<number> | null { return this._scores; }
    @serialize public get status(): "open" | "closed" { return this._status; }
    @serialize public get rating(): number { return this._rating; }

    // derived and undecorated: not stored, recomputed on read, never a column
    public get isLarge(): boolean { return this._total > 1000; }

    // decorated but NOT in TDataKeys: stored by serialize(), yet undeclarable as a column
    @serialize public get extra(): string { return "extra"; }

    public constructor(data: ReadModelData<OrderSummary>)
    {
        super(data);

        this._customerId = data.customerId;
        this._total = data.total;
        this._placedAt = data.placedAt;
        this._note = data.note;
        this._tags = data.tags;
        this._isPaid = data.isPaid;
        this._scores = data.scores;
        this._status = data.status;
        this._rating = data.rating;
    }
}

const sample = (): OrderSummary => new OrderSummary({
    id: "ord_1", customerId: "cus_1", total: 12.5, placedAt: 1700000000000, note: null,
    tags: ["rush", "gift"], isPaid: true, scores: null, status: "open", rating: 4
});

/**
 * The full, valid declaration - every data key, each at a fitting type. Returned fresh so the
 * compile-time blocks can spread it and override one key at a time.
 */
const columns = (): ReadModelColumns<OrderSummary> => ({
    customerId: { type: ColumnType.text, index: true },
    total: { type: ColumnType.numeric },
    placedAt: { type: ColumnType.timestamptz, index: true },
    note: { type: ColumnType.text },                   // string | null declares the same column as string
    tags: { type: ColumnType.textArray, index: true },
    isPaid: { type: ColumnType.boolean },
    scores: { type: ColumnType.integerArray },         // a nullable array, likewise
    status: { type: ColumnType.text, unique: true },
    rating: { type: ColumnType.smallint }
});

const schema = ReadModelSchema.for(OrderSummary, columns()).withIndex(["customerId", "placedAt"]);

// a second model, for the brand and cross-schema checks
@serialize
class Other extends ReadModel<Other, "name">
{
    private readonly _name: string;

    @serialize public get name(): string { return this._name; }

    public constructor(data: ReadModelData<Other>)
    {
        super(data);
        this._name = data.name;
    }
}

const otherSchema = ReadModelSchema.for(Other, { name: { type: ColumnType.text } });

// compile-only fixtures: never constructed, so no decorators are needed
interface Customer { name: string; }
class WithObject extends ReadModel<WithObject, "customer"> { public get customer(): Customer { return { name: "" }; } }
class WithDate extends ReadModel<WithDate, "when"> { public get when(): Date { return new Date(); } }
class WithUnion extends ReadModel<WithUnion, "mixed"> { public get mixed(): string | number { return 1; } }
class WithAny extends ReadModel<WithAny, "loose"> { public get loose(): any { return 1; } }
class WithHoles extends ReadModel<WithHoles, "holes"> { public get holes(): Array<string | null> { return []; } }
class PlainEntity extends DomainEntity<PlainEntity, "name">
{
    public get name(): string { return ""; }
    public constructor(data: DomainObjectData<PlainEntity>) { super(data); }
}
class Hidden extends ReadModel<Hidden, "name">
{
    public get name(): string { return ""; }
    protected constructor(data: ReadModelData<Hidden>) { super(data); }
}
@serialize
class Reserved extends ReadModel<Reserved, "order">
{
    public get order(): number { return 1; }
    public constructor(data: ReadModelData<Reserved>) { super(data); }
}
@serialize
// decorated class, but one of its declared getters is not - constructible only by deserialization
@serialize
class HalfDecorated extends ReadModel<HalfDecorated, "label" | "note">
{
    private readonly _label: string;
    private readonly _note: string;
    @serialize public get label(): string { return this._label; }
    public get note(): string { return this._note; }
    public constructor(data: ReadModelData<HalfDecorated>)
    {
        super(data);
        this._label = data.label;
        this._note = data.note;
    }
}
// no class decorator at all: serialize() cannot work, so the declaration refuses it
class Undecorated extends ReadModel<Undecorated, "name">
{
    public get name(): string { return ""; }
    public constructor(data: ReadModelData<Undecorated>) { super(data); }
}
@serialize
class Renamed extends ReadModel<Renamed, "label">
{
    private readonly _label: string;
    @serialize("customKey") public get label(): string { return this._label; }
    public constructor(data: ReadModelData<Renamed>)
    {
        super(data);
        this._label = data.label;
    }
}


await describe("ReadModel", async () =>
{
    await test("is a DomainEntity: id, decorated getters and $typename round through serialize()", async () =>
    {
        const model = sample();

        assert.strictEqual(model.id, "ord_1");
        assert.deepStrictEqual(model.serialize(), {
            id: "ord_1", customerId: "cus_1", total: 12.5, placedAt: 1700000000000, note: null,
            tags: ["rush", "gift"], isPaid: true, scores: null, status: "open", rating: 4, extra: "extra",
            $typename: "OrderSummary"
        });
    });

    await test("the brand is type-only - nothing exists at runtime", async () =>
    {
        assert.strictEqual("_readModelBrand" in sample(), false);
    });
});

await describe("ColumnType", async () =>
{
    await test("values are the Postgres type spellings, and the array kinds are recognizable", async () =>
    {
        assert.strictEqual(ColumnType.doublePrecision, "double precision");
        assert.strictEqual(ColumnType.textArray, "text[]");
        assert.strictEqual(isArrayColumnType(ColumnType.textArray), true);
        assert.strictEqual(isArrayColumnType(ColumnType.doublePrecisionArray), true);
        assert.strictEqual(isArrayColumnType(ColumnType.text), false);
        assert.strictEqual(isArrayColumnType(ColumnType.timestamptz), false);
    });

    await test("an array kind names its element kind, and a scalar kind has none", async () =>
    {
        assert.strictEqual(elementTypeOf(ColumnType.integerArray), ColumnType.integer);
        assert.strictEqual(elementTypeOf(ColumnType.doublePrecisionArray), ColumnType.doublePrecision);
        assert.throws(() => elementTypeOf(ColumnType.integer), ArgumentException);
    });

    await test("the catalog spelling differs from the DDL spelling only for timestamptz", async () =>
    {
        assert.strictEqual(catalogTypeOf(ColumnType.timestamptz), "timestamp with time zone");
        assert.strictEqual(catalogTypeOf(ColumnType.doublePrecisionArray), "double precision[]");
        assert.strictEqual(catalogTypeOf(ColumnType.text), "text");
        assert.strictEqual(catalogTypeOf(ColumnType.bigintArray), "bigint[]");
    });

    await test("a JavaScript caller's stray string is not a column type", async () =>
    {
        assert.strictEqual(isColumnType("text"), true);
        assert.strictEqual(isColumnType("varchar"), false);
        assert.strictEqual(isColumnType(42), false);
    });

    await test("reserved words are the ones Postgres refuses as bare column names", async () =>
    {
        assert.strictEqual(isReservedWord("order"), true);
        assert.strictEqual(isReservedWord("user"), true);
        assert.strictEqual(isReservedWord("left"), true);
        assert.strictEqual(isReservedWord("status"), false);
        assert.strictEqual(isReservedWord("name"), false);
        assert.strictEqual(isReservedWord("data"), false);
    });
});

await describe("Read model table naming", async () =>
{
    await test("the table is the class name in snake_case with the _read_model suffix", async () =>
    {
        assert.strictEqual(DataHelper.createReadModelTableName(OrderSummary), "order_summary_read_model");
    });
});


// Every closure below is referenced but never invoked: the `@ts-expect-error` lines are the
// assertions, and tsc fails the build on an unused one. Same layout as snapshot-query-set.test.ts.
await describe("Declaration checking (compile-time)", async () =>
{
    await test("every data key must be declared, and nothing else may be", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - 'status' is missing
            ReadModelSchema.for(OrderSummary, { customerId: { type: ColumnType.text }, total: { type: ColumnType.numeric }, placedAt: { type: ColumnType.bigint }, note: { type: ColumnType.text }, tags: { type: ColumnType.textArray }, isPaid: { type: ColumnType.boolean }, scores: { type: ColumnType.integerArray }, rating: { type: ColumnType.smallint } });

            ReadModelSchema.for(OrderSummary, {
                ...columns(),
                // @ts-expect-error - an undecorated derived getter is not a data key
                isLarge: { type: ColumnType.boolean }
            });

            ReadModelSchema.for(OrderSummary, {
                ...columns(),
                // @ts-expect-error - decorated, but not listed in TDataKeys: undeclarable
                extra: { type: ColumnType.text }
            });
        };

        assert.strictEqual(typeof rejected, "function");
    });

    await test("the declared type must fit the property", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - a number takes a numeric kind or timestamptz, not text
            ReadModelSchema.for(OrderSummary, { ...columns(), total: { type: ColumnType.text } });
            // @ts-expect-error - a boolean takes boolean
            ReadModelSchema.for(OrderSummary, { ...columns(), isPaid: { type: ColumnType.integer } });
            // @ts-expect-error - an array of strings takes textArray
            ReadModelSchema.for(OrderSummary, { ...columns(), tags: { type: ColumnType.integerArray } });
            // @ts-expect-error - an array property needs an array kind
            ReadModelSchema.for(OrderSummary, { ...columns(), scores: { type: ColumnType.integer } });
            // @ts-expect-error - a string never fits timestamptz
            ReadModelSchema.for(OrderSummary, { ...columns(), customerId: { type: ColumnType.timestamptz } });
            // @ts-expect-error - there is no nullable declaration: every column is nullable
            ReadModelSchema.for(OrderSummary, { ...columns(), note: { type: ColumnType.text, nullable: true } });
            // @ts-expect-error - an array is indexed with GIN, which cannot be unique
            ReadModelSchema.for(OrderSummary, { ...columns(), tags: { type: ColumnType.textArray, unique: true } });
        };

        assert.strictEqual(typeof rejected, "function");
    });

    await test("a property that is not a scalar or an array of scalars cannot be a column", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - an object
            ReadModelSchema.for(WithObject, { customer: { type: ColumnType.text } });
            // @ts-expect-error - a Date (store epoch ms as a number instead)
            ReadModelSchema.for(WithDate, { when: { type: ColumnType.timestamptz } });
            // @ts-expect-error - a union of scalar kinds
            ReadModelSchema.for(WithUnion, { mixed: { type: ColumnType.text } });
            // @ts-expect-error - any fails closed
            ReadModelSchema.for(WithAny, { loose: { type: ColumnType.text } });
            // @ts-expect-error - an array with null elements
            ReadModelSchema.for(WithHoles, { holes: { type: ColumnType.textArray } });
        };

        assert.strictEqual(typeof rejected, "function");
    });

    await test("only a ReadModel with a public constructor can be declared", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - a plain DomainEntity carries no read model brand
            ReadModelSchema.for(PlainEntity, { name: { type: ColumnType.text } });
            // @ts-expect-error - a protected constructor is not a ClassDefinition
            ReadModelSchema.for(Hidden, { name: { type: ColumnType.text } });
        };

        assert.strictEqual(typeof rejected, "function");
    });

    await test("keys and values are checked on every predicate", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - not a key
            schema.eq("nope", 1);
            // @ts-expect-error - id is the primary key, never a column
            schema.eq("id", "ord_1");
            // @ts-expect-error - customerId is a string
            schema.eq("customerId", 1);
            // @ts-expect-error - status is a literal union
            schema.eq("status", "x");
            // @ts-expect-error - null is never a comparison value; use isNull
            schema.eq("note", null);
            // @ts-expect-error - tags is an array column; use contains
            schema.eq("tags", ["rush"]);
            // @ts-expect-error - in checks every value
            schema.in("total", ["1"]);
            // @ts-expect-error - like needs a text column
            schema.like("total", "1%");
            // @ts-expect-error - contains needs an array column
            schema.contains("customerId", "cus");
            // @ts-expect-error - the element type is checked
            schema.contains("tags", 1);
            // @ts-expect-error - and for every element
            schema.containsAny("scores", ["1"]);
            // @ts-expect-error - an array column cannot order
            schema.orderBy("tags");
            // @ts-expect-error - not a key
            schema.columnFor("nope");
            // @ts-expect-error - a composite index takes scalar keys
            schema.withIndex(["customerId", "tags"]);
            // @ts-expect-error - and declared ones
            schema.withIndex(["customerId", "nope"]);
        };

        assert.strictEqual(typeof rejected, "function");

        // the accepted forms, so a key filter that over-rejects fails the build too
        const accepted = (): void =>
        {
            schema.eq("customerId", "cus_1");
            schema.eq("status", "open");
            schema.gt("placedAt", 1);
            schema.in("total", [1, 2]);
            schema.isNull("note");
            schema.isNotNull("customerId");
            schema.isNull("tags");
            schema.like("customerId", "cus%");
            schema.ilike("note", "%gift%");
            schema.contains("tags", "rush");
            schema.containsAll("scores", [1, 2]);
            schema.containsAny("tags", ["a", "b"]);
            schema.orderBy("total", "desc");
            schema.withIndex(["status", "isPaid"], { unique: true });
        };

        assert.strictEqual(typeof accepted, "function");
    });

    await test("a predicate is branded by its table, and a schema by its model", async () =>
    {
        const rejected = (): void =>
        {
            // @ts-expect-error - a bare literal carries no table brand; build it through the schema
            const bare: ReadModelPredicate = { sql: "(x = ?)", params: [1] };
            // @ts-expect-error - a snapshot predicate is a different family
            const snapshot: ReadModelPredicate = SnapshotQuerySet.for<{ x: string; }>().withPath("x").eq("x", "a");
            // @ts-expect-error - and so is its order-by term
            const term: ReadModelOrderBy = SnapshotQuerySet.for<{ x: string; }>().withPath("x").orderBy("x");
            // @ts-expect-error - another model's schema is rejected through modelType
            const wrong: ReadModelSchema<OrderSummary> = otherSchema;

            assert.ok(bare);
            assert.ok(snapshot);
            assert.ok(term);
            assert.ok(wrong);
        };

        assert.strictEqual(typeof rejected, "function");
    });
});

await describe("Declaration (runtime)", async () =>
{
    await test("columns come out in declaration order, named in snake_case, with their index flags", async () =>
    {
        assert.strictEqual(schema.modelType, OrderSummary);
        assert.strictEqual(schema.table, "order_summary_read_model");
        assert.deepStrictEqual(schema.columns.map(t => `${t.key}:${t.column}:${t.type}:${t.index ? "i" : "-"}${t.unique ? "u" : "-"}`), [
            "customerId:customer_id:text:i-",
            "total:total:numeric:--",
            "placedAt:placed_at:timestamptz:i-",
            "note:note:text:--",
            "tags:tags:text[]:i-",
            "isPaid:is_paid:boolean:--",
            "scores:scores:integer[]:--",
            "status:status:text:iu",
            "rating:rating:smallint:--"
        ]);
    });

    await test("indexes are named like the snapshot ones: per column, _uq, _gin, and composites", async () =>
    {
        assert.deepStrictEqual(schema.indexes.map(t => `${t.name}|${t.columns.join(",")}|${t.method}|${t.isUnique}`), [
            "idx_order_summary_read_model_customer_id|customer_id|btree|false",
            "idx_order_summary_read_model_placed_at|placed_at|btree|false",
            "idx_order_summary_read_model_tags_gin|tags|gin|false",
            "idx_order_summary_read_model_status_uq|status|btree|true",
            "idx_order_summary_read_model_customer_id_placed_at|customer_id,placed_at|btree|false"
        ]);
    });

    await test("withIndex is copy-on-write, takes a name and a unique flag", async () =>
    {
        const base = ReadModelSchema.for(OrderSummary, columns());
        const named = base.withIndex(["status", "isPaid"], { unique: true, name: "paid_status" });

        assert.strictEqual(base.indexes.length, 4);
        assert.strictEqual(named.indexes.length, 5);
        assert.strictEqual(named.indexes[4].name, "idx_order_summary_read_model_paid_status_uq");
        assert.deepStrictEqual(named.indexes[4].keys, ["status", "isPaid"]);
    });

    await test("a declaration that cannot be a table is refused at the declaration", async () =>
    {
        assert.throws(() => ReadModelSchema.for(Reserved, { order: { type: ColumnType.integer } }), (e: Error) => e instanceof ArgumentException && e.message.contains("reserved") && e.message.contains("order"));
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), Status: { type: ColumnType.text } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), id: { type: ColumnType.text } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), ["a".repeat(64)]: { type: ColumnType.text } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{}), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), total: { type: "money" } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), tags: { type: ColumnType.textArray, unique: true } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), total: { type: ColumnType.numeric, name: "by_total" } }), ArgumentException);
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), total: { type: ColumnType.numeric, index: true, name: "Bad-Name" } }), ArgumentException);
        // two columns naming the same index
        assert.throws(() => ReadModelSchema.for(OrderSummary, <any>{ ...columns(), total: { type: ColumnType.numeric, index: true, name: "same" }, isPaid: { type: ColumnType.boolean, index: true, name: "same" } }), ArgumentException);
    });

    await test("a composite index needs two or more distinct, declared scalar keys and a fresh name", async () =>
    {
        assert.throws(() => schema.withIndex(<any>["customerId"]), ArgumentException);
        assert.throws(() => schema.withIndex(<any>["customerId", "customerId"]), ArgumentException);
        assert.throws(() => schema.withIndex(<any>["customerId", "tags"]), ArgumentException);
        assert.throws(() => schema.withIndex(<any>["customerId", "nope"]), ArgumentException);
        assert.throws(() => schema.withIndex(["customerId", "placedAt"]), ArgumentException);
    });
});

await describe("Predicates", async () =>
{
    const t = schema.table;

    await test("comparisons bind the value, with the column bare and the fragment parenthesized", async () =>
    {
        assert.deepStrictEqual(schema.eq("customerId", "cus_1"), { sql: "(customer_id = ?)", params: ["cus_1"], table: t });
        assert.deepStrictEqual(schema.ne("status", "open"), { sql: "(status <> ?)", params: ["open"], table: t });
        assert.deepStrictEqual(schema.gt("total", 10), { sql: "(total > ?)", params: [10], table: t });
        assert.deepStrictEqual(schema.gte("total", 10), { sql: "(total >= ?)", params: [10], table: t });
        assert.deepStrictEqual(schema.lt("total", 10), { sql: "(total < ?)", params: [10], table: t });
        assert.deepStrictEqual(schema.lte("total", 10), { sql: "(total <= ?)", params: [10], table: t });
        assert.deepStrictEqual(schema.eq("isPaid", true), { sql: "(is_paid = ?)", params: [true], table: t });
    });

    await test("a timestamptz column converts the bound epoch milliseconds on the parameter side", async () =>
    {
        assert.deepStrictEqual(schema.gte("placedAt", 1700000000000), { sql: "(placed_at >= to_timestamp(? / 1000.0))", params: [1700000000000], table: t });
        assert.deepStrictEqual(schema.in("placedAt", [1, 2]), { sql: "(placed_at in (to_timestamp(? / 1000.0),to_timestamp(? / 1000.0)))", params: [1, 2], table: t });
    });

    await test("in binds one placeholder per value and refuses an empty list", async () =>
    {
        assert.deepStrictEqual(schema.in("status", ["open", "closed"]), { sql: "(status in (?,?))", params: ["open", "closed"], table: t });
        assert.throws(() => schema.in("status", []), ArgumentException);
    });

    await test("null tests take any column, since every column is nullable", async () =>
    {
        assert.deepStrictEqual(schema.isNull("note"), { sql: "(note is null)", params: [], table: t });
        assert.deepStrictEqual(schema.isNotNull("tags"), { sql: "(tags is not null)", params: [], table: t });
    });

    await test("like and ilike take a text column", async () =>
    {
        assert.deepStrictEqual(schema.like("customerId", "cus%"), { sql: "(customer_id like ?)", params: ["cus%"], table: t });
        assert.deepStrictEqual(schema.ilike("note", "%gift%"), { sql: "(note ilike ?)", params: ["%gift%"], table: t });
    });

    await test("containment binds one array, cast to the column's type, under the GIN-served operators", async () =>
    {
        assert.deepStrictEqual(schema.contains("tags", "rush"), { sql: "(tags @> cast(? as text[]))", params: [["rush"]], table: t });
        assert.deepStrictEqual(schema.containsAll("tags", ["rush", "gift"]), { sql: "(tags @> cast(? as text[]))", params: [["rush", "gift"]], table: t });
        assert.deepStrictEqual(schema.containsAny("scores", [1, 2]), { sql: "(scores && cast(? as integer[]))", params: [[1, 2]], table: t });
        assert.throws(() => schema.containsAll("tags", []), ArgumentException);
        assert.throws(() => schema.containsAny("tags", []), ArgumentException);
    });

    await test("combinators parenthesize, concatenate params in order, and refuse another schema's arms", async () =>
    {
        const combined = schema.and(schema.eq("status", "open"), schema.or(schema.gt("total", 10), schema.contains("tags", "rush")));

        assert.strictEqual(combined.sql, "((status = ?) and ((total > ?) or (tags @> cast(? as text[]))))");
        assert.deepStrictEqual(combined.params, ["open", 10, ["rush"]]);
        assert.deepStrictEqual(schema.not(schema.isNull("note")), { sql: "(not (note is null))", params: [], table: t });

        assert.throws(() => schema.and(schema.eq("status", "open"), otherSchema.eq("name", "x")), (e: Error) => e instanceof ArgumentException && e.message.contains("other_read_model"));
        assert.throws(() => schema.not(otherSchema.eq("name", "x")), ArgumentException);
        assert.throws(() => schema.and(), ArgumentException);
    });

    await test("raw wraps a validated fragment and carries the brand", async () =>
    {
        assert.deepStrictEqual(schema.raw(`${schema.columnFor("total")} > ? * 2`, 5), { sql: "(total > ? * 2)", params: [5], table: t });
        assert.throws(() => schema.raw("select 1"), ArgumentException);
        assert.throws(() => schema.raw("where total > 1"), ArgumentException);
        assert.throws(() => schema.raw("total > 1; drop table x"), ArgumentException);
    });

    await test("orderBy names the column and the direction", async () =>
    {
        assert.deepStrictEqual(schema.orderBy("placedAt", "desc"), { sql: "placed_at desc", table: t });
        assert.deepStrictEqual(schema.orderBy("total"), { sql: "total", table: t });
        assert.throws(() => schema.orderBy("total", <any>"sideways"), ArgumentException);
    });

    await test("a value of the wrong kind is refused before it is bound - pg would coerce it silently", async () =>
    {
        // a BigInt primitive is refused by name like anything else, not with a TypeError from the describer
        assert.throws(() => schema.eq("total", <any>10n), ArgumentException);
        // the integer kinds check their Postgres range, not merely that the number is an integer
        assert.throws(() => schema.eq("rating", 40000), ArgumentException);
        assert.throws(() => schema.containsAny("scores", [3000000000]), ArgumentException);
        assert.doesNotThrow(() => schema.eq("rating", -32768));
        assert.throws(() => schema.eq("customerId", <any>42), ArgumentException);
        assert.throws(() => schema.gt("total", <any>"10"), ArgumentException);
        assert.throws(() => schema.gt("total", Number.NaN), ArgumentException);
        assert.throws(() => schema.contains("tags", <any>1), ArgumentException);
        assert.throws(() => schema.eq("isPaid", <any>"true"), ArgumentException);
        assert.throws(() => schema.containsAny("scores", <any>[1.5]), ArgumentException);
    });

    await test("columnFor hands back the bare identifier for the raw door", async () =>
    {
        assert.strictEqual(schema.columnFor("placedAt"), "placed_at");
        assert.strictEqual(schema.columnFor("total"), "total");
        assert.throws(() => schema.columnFor(<any>"nope"), ArgumentException);
    });
});

await describe("verifyModel", async () =>
{
    await test("reports the decorated-but-undeclared getter as an advisory, and nothing else on a clean model", async () =>
    {
        const issues = schema.verifyModel(sample());

        assert.deepStrictEqual(issues.map(t => `${t.kind}(${t.severity}):${t.key}`), ["undeclared-getter(advisory):extra"]);
        assert.ok(issues[0].message.contains("TDataKeys"));
    });

    await test("a value of the wrong kind is fatal, named by key; null is never an issue", async () =>
    {
        const model = new OrderSummary(<any>{
            id: "ord_2", customerId: "cus_1", total: "12.5", placedAt: 1700000000000, note: null,
            tags: ["rush", null], isPaid: true, scores: [1.5], status: "open"
        });

        const fatals = schema.verifyModel(model).filter(t => t.severity === "fatal");

        assert.deepStrictEqual(fatals.map(t => `${t.kind}:${t.key}`), ["wrong-kind:total", "wrong-kind:tags", "wrong-kind:scores"]);
    });

    await test("an integer kind outside its Postgres range is fatal, so it fails before the row is queued", async () =>
    {
        const model = new OrderSummary(<any>{ ...sample().serialize(), rating: 40000, scores: [2147483648] });

        assert.deepStrictEqual(schema.verifyModel(model).filter(t => t.severity === "fatal").map(t => `${t.kind}:${t.key}`), ["wrong-kind:scores", "wrong-kind:rating"]);
        assert.ok(schema.verifyModel(model).find(t => t.key === "rating")!.message.contains("32767"));
    });

    await test("a key declared in TDataKeys whose getter is undecorated is its own advisory, and the shape checks never serialize", async () =>
    {
        // a model like this cannot be constructed fresh (n-domain's constructor refuses the undecorated
        // key), but it can arrive through deserialization - which is exactly what a hydration is
        const halfSchema = ReadModelSchema.for(HalfDecorated, { label: { type: ColumnType.text }, note: { type: ColumnType.text } });
        const model = new HalfDecorated(<any>{ $typename: "HalfDecorated", id: "hd_1", label: "a", note: "b" });

        assert.deepStrictEqual(halfSchema.verifyModel(model).map(t => `${t.kind}(${t.severity}):${t.key}`), ["undecorated-getter(advisory):note"]);
        assert.ok(halfSchema.verifyModel(model)[0].message.contains("@serialize"));
        assert.deepStrictEqual(halfSchema.verifyValues(model), []);
        assert.strictEqual(halfSchema.verifyShape(model).length, 1);
        assert.strictEqual(halfSchema.typeName, "HalfDecorated");
    });

    await test("a class without the class-level @serialize is refused at the declaration", async () =>
    {
        assert.throws(() => ReadModelSchema.for(Undecorated, { name: { type: ColumnType.text } }), (e: Error) => e instanceof ArgumentException && e.message.contains("@serialize"));
    });

    await test("a @serialize rename is an advisory - storage reads the property, not serialize()", async () =>
    {
        const renamedSchema = ReadModelSchema.for(Renamed, { label: { type: ColumnType.text } });
        const issues = renamedSchema.verifyModel(new Renamed({ id: "ren_1", label: "x" }));

        // read from the class's metadata, the rename is one finding: the getter is declared and decorated, under another key
        assert.deepStrictEqual(issues.map(t => `${t.kind}(${t.severity}):${t.key}`), ["renamed-getter(advisory):label"]);
    });

    await test("refuses an instance of another model", async () =>
    {
        assert.throws(() => schema.verifyModel(<any>new Other({ id: "oth_1", name: "x" })), ArgumentException);
    });
});
