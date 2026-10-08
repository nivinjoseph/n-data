import { IsAnyOrUnknown } from "../migration/snapshot-index.js";
import { ColumnType, ReadModelNumericType } from "./column-type.js";
import { AnyReadModel, ReadModelClass, ReadModelKey, ReadModelValue } from "./read-model.js";
/**
 * The column types a scalar property may be stored as, by the property's kind. Tuple-bracketed so a
 * union of kinds (`string | number`) fails as a whole rather than distributing.
 */
type ScalarColumnTypeFor<V> = [
    V
] extends [string] ? ColumnType.text : [V] extends [number] ? ReadModelNumericType | ColumnType.timestamptz : [V] extends [boolean] ? ColumnType.boolean : never;
/**
 * The array column types an array property may be stored as, by its element kind.
 */
type ArrayColumnTypeFor<E> = [
    E
] extends [string] ? ColumnType.textArray : [E] extends [number] ? ColumnType.integerArray | ColumnType.bigintArray | ColumnType.numericArray | ColumnType.doublePrecisionArray : [E] extends [boolean] ? ColumnType.booleanArray : never;
/**
 * The element type of an array property, null-stripped at the property level only: an array whose
 * elements may be null is not a column (Postgres arrays admit NULL elements, but nothing here writes
 * or compares one).
 */
type ArrayElementOf<V> = NonNullable<V> extends ReadonlyArray<infer E> ? E : never;
/**
 * One classification of a property type, used by the declaration AND by the predicate key filters,
 * so the two cannot disagree about what a column is.
 *
 * `any`/`unknown` fail closed, as do `never` (which is what n-domain's `IllegalDataKeys` turns a
 * `Map`/`Set`/function key into), objects, `Date`, mixed scalar unions and arrays with nullable
 * elements. `null`/`undefined` on the property is stripped first: every column is nullable, so
 * `string | null` and `string` declare the same column.
 */
export type ColumnKind<V> = IsAnyOrUnknown<V> extends true ? "unsupported" : [V] extends [never] ? "unsupported" : [NonNullable<V>] extends [ReadonlyArray<unknown>] ? ([ArrayColumnTypeFor<ArrayElementOf<V>>] extends [never] ? "unsupported" : "array") : [ScalarColumnTypeFor<NonNullable<V>>] extends [never] ? "unsupported" : "scalar";
/**
 * A type nothing sensible fits; its `type` property - the one every declaration writes - carries the
 * reason, so the compiler prints the instruction rather than a structural mismatch. Same idiom as
 * `SnapshotCastRequired`.
 */
export type ReadModelUnsupportedProperty<K extends string> = {
    readonly type: `property '${K}' cannot be a column: a column holds a string, number or boolean (optionally null), or an array of one of those - flatten it, or drop it from TDataKeys`;
};
/**
 * The declaration of one scalar column.
 */
export interface ReadModelScalarColumn<TType extends ColumnType> {
    /**
     * The Postgres type, checked against the property: a `string` takes `text`; a `number` takes a
     * numeric kind or `timestamptz` (epoch milliseconds, stored as a real timestamp); a `boolean`
     * takes `boolean`.
     */
    readonly type: TType;
    /**
     * Declares a btree index over the column.
     */
    readonly index?: boolean;
    /**
     * Declares a unique btree index over the column. Implies {@link index}.
     */
    readonly unique?: boolean;
    /**
     * Overrides the derived index name suffix; only with {@link index} or {@link unique}.
     */
    readonly name?: string;
}
/**
 * The declaration of one array column. Indexed with GIN, which serves containment and cannot be
 * unique - so `unique` resolves to the diagnostic rather than to `boolean`.
 */
export interface ReadModelArrayColumn<TType extends ColumnType, K extends string> {
    readonly type: TType;
    readonly index?: boolean;
    readonly name?: string;
    readonly unique?: `column '${K}' is an array; it is indexed with GIN, which cannot enforce uniqueness - remove 'unique'`;
}
/**
 * The declaration a property admits: a scalar spec, an array spec, or the diagnostic.
 */
export type ReadModelColumn<V, K extends string> = ColumnKind<V> extends "array" ? ReadModelArrayColumn<ArrayColumnTypeFor<ArrayElementOf<V>>, K> : ColumnKind<V> extends "scalar" ? ReadModelScalarColumn<ScalarColumnTypeFor<NonNullable<V>>> : ReadModelUnsupportedProperty<K>;
/**
 * The whole declaration: one entry per data key except `id`. A mapped type, so a missing key and an
 * extra key are both compile errors, and each per-key error lands on the key.
 */
export type ReadModelColumns<T extends AnyReadModel> = {
    readonly [K in ReadModelKey<T>]: ReadModelColumn<ReadModelValue<T, K>, K>;
};
/**
 * The keys whose column is a scalar: what the comparisons, `like` and `orderBy` take.
 */
export type ReadModelScalarKey<T extends AnyReadModel> = {
    [K in ReadModelKey<T>]: ColumnKind<ReadModelValue<T, K>> extends "scalar" ? K : never;
}[ReadModelKey<T>] & string;
/**
 * The keys whose column is an array: what the containment predicates take.
 */
export type ReadModelArrayKey<T extends AnyReadModel> = {
    [K in ReadModelKey<T>]: ColumnKind<ReadModelValue<T, K>> extends "array" ? K : never;
}[ReadModelKey<T>] & string;
/**
 * The keys whose column is text: what `like` and `ilike` take.
 */
export type ReadModelTextKey<T extends AnyReadModel> = {
    [K in ReadModelKey<T>]: ColumnKind<ReadModelValue<T, K>> extends "scalar" ? ([NonNullable<ReadModelValue<T, K>>] extends [string] ? K : never) : never;
}[ReadModelKey<T>] & string;
/**
 * What a comparison against `K` accepts: the property's own type, null stripped - null is never a
 * comparison value, `isNull` is.
 */
export type ReadModelComparable<T extends AnyReadModel, K extends string> = K extends ReadModelKey<T> ? NonNullable<ReadModelValue<T, K>> : never;
/**
 * What a containment match against the array column `K` accepts: its element type.
 */
export type ReadModelElement<T extends AnyReadModel, K extends string> = K extends ReadModelKey<T> ? ArrayElementOf<ReadModelValue<T, K>> : never;
/**
 * A boolean fragment and the values that bind to its `?` placeholders, in order - always
 * parenthesized, so it stays contained wherever it is spliced.
 *
 * `table` is the brand with runtime teeth: it names the schema that built the fragment, so `and`/`or`
 * refuse arms from different schemas and a repository refuses a predicate built for another table -
 * which matters, because a `timestamptz` conversion applied under the wrong schema is a silent wrong
 * answer. A hand-written `{ sql, params }` literal, which nothing stamped, is not a predicate at all;
 * build one through {@link ReadModelSchema.raw}.
 */
export interface ReadModelPredicate {
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
    readonly table: string;
}
/**
 * One `order by` term: a column and a direction, branded by its table like a predicate.
 */
export interface ReadModelOrderBy {
    readonly sql: string;
    readonly table: string;
}
/**
 * One declared column, as the table creator, the row mapper and the repository read it.
 */
export interface ReadModelColumnInfo {
    /**
     * The property name, e.g. `placedAt`.
     */
    readonly key: string;
    /**
     * The column identifier, e.g. `placed_at`.
     */
    readonly column: string;
    readonly type: ColumnType;
    /**
     * Whether a per-column index was declared - btree, or GIN for an array.
     */
    readonly index: boolean;
    readonly unique: boolean;
}
/**
 * One declared index, as the table creator emits it and drift verification expects it.
 */
export interface ReadModelIndexInfo {
    /**
     * `idx_<table>_...`, validated.
     */
    readonly name: string;
    /**
     * The keys it covers, in index order.
     */
    readonly keys: ReadonlyArray<string>;
    /**
     * The columns it covers, positionally matching {@link keys}.
     */
    readonly columns: ReadonlyArray<string>;
    readonly method: "btree" | "gin";
    readonly isUnique: boolean;
}
/**
 * One problem {@link ReadModelSchema.verifyModel} found with a model instance against its schema.
 *
 * A `fatal` issue means the row cannot be written faithfully - a value of the wrong kind, which pg
 * would otherwise coerce silently. An `advisory` is a mismatch between the class's `serialize()`
 * shape and the declaration that storage itself is unaffected by.
 */
export interface ReadModelShapeIssue {
    readonly key: string;
    /**
     * - `wrong-kind`: the value does not match the column's type or range.
     * - `undeclared-getter`: a `@serialize`d getter that is not in `TDataKeys` - emitted by
     *   `serialize()`, absent from the table, undeclarable as a column. The one gap the types cannot
     *   see.
     * - `undecorated-getter`: a declared key whose getter carries no `@serialize`. Stored and hydrated
     *   (storage reads the property, and a hydration is a deserialization), but absent from
     *   `serialize()` and `equals()` - and n-domain refuses a fresh construction carrying it, so such
     *   a model only ever arrives through deserialization.
     * - `renamed-getter`: a declared key serialized under a `@serialize("customKey")` rename. Storage
     *   reads the property directly, so the column is unaffected; `serialize()` and `equals()` name it
     *   differently.
     */
    readonly kind: "wrong-kind" | "undeclared-getter" | "undecorated-getter" | "renamed-getter";
    readonly severity: "fatal" | "advisory";
    readonly message: string;
}
/**
 * A schema whose column checking is intact: what every consumer of a schema takes - the repository
 * constructor and the table creator's three methods. The intersection is what makes
 * `ReadModelSchema<any>` a compile error *there*: two instantiations of one class are related by
 * variance, which `any` always passes, but the second member is checked structurally, and under
 * `any` the phantom resolves to its message rather than to `true`.
 *
 * The same rule reaches a generic layer of your own: an `abstract class AppRepository<T extends
 * AnyReadModel> extends ReadModelBaseRepository<T>` that forwards a schema to `super` must take it
 * as `IntactReadModelSchema<T>`, not `ReadModelSchema<T>` - under an unresolved `T` the phantom
 * cannot be known to be `true`, and the diagnostic says so.
 */
export type IntactReadModelSchema<T extends AnyReadModel> = ReadModelSchema<T> & {
    readonly _columnCheckingIntact: true;
};
/**
 * The declared columns and indexes of one read model table, and the typed predicates over them.
 *
 * This is the single declaration of a table's shape: `ReadModelTableCreator` creates the table and
 * its indexes from it, the repository writes and reads rows through it, and every predicate is
 * built by it. The declaration is an object literal keyed by every data key except `id` - a mapped
 * type, so a key left out and a key that is not a data key are both compile errors, and each
 * declared type is checked against its property's kind.
 *
 * **Every column is queryable; `index` and `unique` are performance declarations.** A real column
 * has no expression-matching hazard, and a sequential scan over an analytical table is a legitimate
 * plan - what the declaration guarantees is that an index declared here is one the migration
 * created.
 *
 * **Every column is nullable.** The DDL never emits `not null`, and there is no nullability
 * declaration: the TypeScript property type is the application's contract. A column added after
 * rows were written reads NULL for them until they are re-projected; a property typed non-null then
 * fails in the class's own constructor at hydration.
 *
 * `ReadModelSchema<T>` has one type parameter, and it is fully determined by the model - so a
 * repository holds its schema at the concrete type with no override to get wrong. A schema widened
 * to `ReadModelSchema<any>` is refused wherever one is consumed - the repository constructor and the
 * table creator take {@link IntactReadModelSchema} - rather than at the annotation itself, which
 * TypeScript's variance rule lets through; {@link _columnCheckingIntact} is what the consumers check.
 *
 * @example
 * ```typescript
 * @inject("DomainContext", "Db", "UnitOfWork", "Logger")
 * export class PgOrderSummaryRepository extends ReadModelBaseRepository<OrderSummary>
 * {
 *     public static readonly schema = ReadModelSchema.for(OrderSummary, {
 *         customerId: { type: ColumnType.text, index: true },
 *         total: { type: ColumnType.numeric },
 *         placedAt: { type: ColumnType.timestamptz, index: true },
 *         note: { type: ColumnType.text },
 *         tags: { type: ColumnType.textArray, index: true }       // GIN
 *     }).withIndex(["customerId", "placedAt"]);
 *
 *     public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
 *     {
 *         super(domainContext, db, unitOfWork, logger, PgOrderSummaryRepository.schema);
 *     }
 *
 *     public getByCustomer(customerId: string): Promise<Array<OrderSummary>>
 *     {
 *         return this.query(this.schema.eq("customerId", customerId));
 *     }
 * }
 *
 * // in the migration - the same object
 * await tableCreator.createReadModelTable(PgOrderSummaryRepository.schema);
 * ```
 *
 * @class ReadModelSchema
 */
export declare class ReadModelSchema<T extends AnyReadModel> {
    /**
     * A camelCase property name: a lowercase letter, then letters and digits. The derived column is
     * then a clean identifier with no folding, and no two keys can derive the same column.
     */
    private static readonly _keyRegex;
    private readonly _modelType;
    /**
     * The type name `@serialize` registered for the class - what a hydration stamps as `$typename`.
     */
    private readonly _typeName;
    private readonly _table;
    /**
     * In declaration order, which is the order the DDL emits the columns in.
     */
    private readonly _columns;
    private readonly _columnsByKey;
    /**
     * Per-column indexes first, in declaration order; composites appended by {@link withIndex}.
     */
    private readonly _indexes;
    /**
     * Phantom - `declare` emits nothing. `true` for every schema built through {@link for}, and an
     * error-message string when `T` is `any` - so a `ReadModelSchema<any>`, which would accept any
     * key and any value, cannot be handed to a consumer: each takes {@link IntactReadModelSchema},
     * whose structural check reads this member. The type IS the diagnostic, and it names the other
     * way to meet it - a generic layer forwarding `ReadModelSchema<T>` under an unresolved `T`.
     */
    readonly _columnCheckingIntact: IsAnyOrUnknown<T> extends true ? "this schema is typed ReadModelSchema<any>, which discards column and value checking - keep the type ReadModelSchema.for(MyModel, {...}) infers; a generic layer forwarding a schema takes IntactReadModelSchema<T>" : true;
    /**
     * The read model class - what the repository hydrates rows into.
     */
    get modelType(): ReadModelClass<T>;
    /**
     * The type name `@serialize` registered for the class (`"Prefix.ClassName"` or `"ClassName"`).
     * A hydration stamps it as `$typename`, exactly as the deserializer does, so the class's
     * constructor treats a row as the stored artifact it is.
     */
    get typeName(): string;
    /**
     * The table, derived from the class name: `OrderSummary` is `order_summary_read_model`.
     */
    get table(): string;
    /**
     * The declared columns, in declaration order.
     */
    get columns(): ReadonlyArray<ReadModelColumnInfo>;
    /**
     * The declared indexes: per-column ones in declaration order, then composites.
     */
    get indexes(): ReadonlyArray<ReadModelIndexInfo>;
    /**
     * Use {@link for}.
     */
    private constructor();
    /**
     * Declares a read model's table: one column per data key.
     *
     * The class is an argument rather than a type parameter so that `T` is inferred from it, the
     * schema can hand the repository the class to hydrate with, and two constraints land as compile
     * errors here: the class must extend `ReadModel` (its brand), and its constructor must be public.
     *
     * @template T - The read model; inferred from the class.
     * @param {ReadModelClass<T>} modelType - The read model class.
     * @param {ReadModelColumns<T>} columns - One declaration per data key, checked against the property kinds.
     * @returns {ReadModelSchema<T>} The schema.
     * @throws {ArgumentException} If the class carries no class-level `@serialize`; if a key is not camelCase, derives `id`, a reserved word, an overlong or duplicate column; if a type is not a ColumnType; if `unique` is set on an array column; if `name` is malformed or set without an index; if two indexes derive one name; or if no column is declared.
     */
    static for<T extends AnyReadModel>(modelType: ReadModelClass<T>, columns: ReadModelColumns<T>): ReadModelSchema<T>;
    private static _combine;
    /**
     * `placedAt` -> `placed_at`: each uppercase letter becomes an underscore and its lowercase. The
     * same naive rule `DomainHelper.aggregateTypeToSnakeCase` applies to table names.
     */
    private static _toColumnName;
    /**
     * Why `value` cannot be stored in a column of `type`, or null when it can. `null`/`undefined`
     * always can - every column is nullable.
     */
    private static _kindError;
    /**
     * An integer within the column's Postgres range - checked here so an out-of-range value is refused
     * before the row is queued, rather than failing at the database after the unit of work is rolled back.
     */
    private static _integerError;
    private static _describe;
    /**
     * Declares one composite btree index over several scalar columns.
     *
     * Order matters: btree serves only a leading prefix of an index's columns, so the second key of
     * a composite is not independently searchable. A single key is declared with `index: true` on
     * the column, not here.
     *
     * @param {ReadonlyArray<ReadModelScalarKey<T>>} keys - Two or more distinct scalar keys, in index order.
     * @param {object} [options] - `unique` to enforce the tuple as a natural key; `name` to override the derived index name suffix.
     * @returns {ReadModelSchema<T>} A schema that also carries this index - the receiver is left unchanged.
     * @throws {ArgumentException} If fewer than two keys are given, a key is repeated, undeclared or an array column, the name is malformed, or the derived name is already declared.
     */
    withIndex(keys: ReadonlyArray<ReadModelScalarKey<T>>, options?: {
        readonly unique?: boolean;
        readonly name?: string;
    }): ReadModelSchema<T>;
    /**
     * The column identifier behind a key, for composing a statement by hand through {@link raw} or
     * a repository's raw door.
     *
     * @param {ReadModelKey<T>} key - A declared key.
     * @returns {string} The bare column identifier, e.g. `placed_at`.
     */
    columnFor(key: ReadModelKey<T>): string;
    /**
     * Matches rows where `key` equals `value`.
     */
    eq<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` does not equal `value`. A NULL column compares as neither, so those
     * rows do not come back here - pair with {@link isNull} if they should.
     */
    ne<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` is greater than `value`.
     */
    gt<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` is greater than or equal to `value`.
     */
    gte<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` is less than `value`.
     */
    lt<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` is less than or equal to `value`.
     */
    lte<K extends ReadModelScalarKey<T>>(key: K, value: ReadModelComparable<T, K>): ReadModelPredicate;
    /**
     * Matches rows where `key` is any of `values`.
     *
     * @throws {ArgumentException} If values is empty - `in ()` is not valid SQL, and an empty list is a caller bug rather than a way to match nothing.
     */
    in<K extends ReadModelScalarKey<T>>(key: K, values: ReadonlyArray<ReadModelComparable<T, K>>): ReadModelPredicate;
    /**
     * Matches rows whose column at `key` is NULL - which any column can be: a column added after
     * rows were written reads NULL for them until they are re-projected.
     */
    isNull(key: ReadModelKey<T>): ReadModelPredicate;
    /**
     * Matches rows that carry a value at `key`.
     */
    isNotNull(key: ReadModelKey<T>): ReadModelPredicate;
    /**
     * Matches rows where the text column at `key` matches `pattern` under `like`. A btree does not
     * serve a prefix pattern under a non-C collation; a hand-built `text_pattern_ops` index does.
     */
    like<K extends ReadModelTextKey<T>>(key: K, pattern: string): ReadModelPredicate;
    /**
     * The case-insensitive counterpart of {@link like}.
     */
    ilike<K extends ReadModelTextKey<T>>(key: K, pattern: string): ReadModelPredicate;
    /**
     * Matches rows whose array at `key` contains `element` - `@>`, which the GIN index serves.
     */
    contains<K extends ReadModelArrayKey<T>>(key: K, element: ReadModelElement<T, K>): ReadModelPredicate;
    /**
     * Matches rows whose array at `key` contains **every** one of `elements`.
     *
     * @throws {ArgumentException} If elements is empty - `@> '{}'` is true for every row.
     */
    containsAll<K extends ReadModelArrayKey<T>>(key: K, elements: ReadonlyArray<ReadModelElement<T, K>>): ReadModelPredicate;
    /**
     * Matches rows whose array at `key` contains **any** of `elements` - `&&`, overlap, which the
     * GIN index serves. `= any(column)` is deliberately not offered: it is index-blind.
     *
     * @throws {ArgumentException} If elements is empty - `&& '{}'` is false for every row.
     */
    containsAny<K extends ReadModelArrayKey<T>>(key: K, elements: ReadonlyArray<ReadModelElement<T, K>>): ReadModelPredicate;
    /**
     * Every predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given, or one was built by another schema.
     */
    and(...predicates: ReadonlyArray<ReadModelPredicate>): ReadModelPredicate;
    /**
     * At least one predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given, or one was built by another schema.
     */
    or(...predicates: ReadonlyArray<ReadModelPredicate>): ReadModelPredicate;
    /**
     * Negates a predicate. `not NULL` is NULL, so negation does not bring NULL rows back; nor does
     * a negated predicate use an index.
     *
     * @throws {ArgumentException} If the predicate was built by another schema.
     */
    not(predicate: ReadModelPredicate): ReadModelPredicate;
    /**
     * Wraps a hand-written fragment so it composes with the typed predicates.
     *
     * For what the operators above cannot say - a function of two columns, a range on an
     * expression. Name columns through {@link columnFor} rather than by hand.
     *
     * @param {string} sql - A boolean fragment. Parenthesized for you; bind values with `?`.
     * @param {...ReadonlyArray<any>} params - Values bound to the fragment's placeholders.
     * @throws {ArgumentException} If sql is empty, is a whole statement, keeps the `where` keyword, or contains a ';'.
     */
    raw(sql: string, ...params: ReadonlyArray<any>): ReadModelPredicate;
    /**
     * One `order by` term over a scalar column. A GIN array index cannot serve ordering, so an
     * array key is not offered.
     *
     * @param {K} key - A declared scalar key.
     * @param {"asc" | "desc"} [direction] - Defaults to `asc`, as Postgres does.
     */
    orderBy<K extends ReadModelScalarKey<T>>(key: K, direction?: "asc" | "desc"): ReadModelOrderBy;
    /**
     * Checks one model instance against this declaration: {@link verifyValues} and {@link verifyShape}
     * together. Pure: no logging, no throwing, no state.
     *
     * Call it in a test - `assert.deepStrictEqual(MyRepository.schema.verifyModel(model), [])` - to
     * catch the advisories as well as the fatal issues the repositories throw on.
     *
     * @param {T} model - An instance of the schema's model.
     * @returns {ReadonlyArray<ReadModelShapeIssue>} Every issue found; empty when the instance fits.
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyModel(model: T): ReadonlyArray<ReadModelShapeIssue>;
    /**
     * The per-instance half of {@link verifyModel}: every column's value against its declared type
     * and range. A failure here is fatal - the row cannot be written faithfully, and pg would
     * otherwise coerce a number bound to a text column into `'42'` silently - so the repositories
     * run this on every save and throw.
     *
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyValues(model: T): ReadonlyArray<ReadModelShapeIssue>;
    /**
     * The per-class half of {@link verifyModel}: the declaration against the getters `@serialize`
     * recorded for the class, read from the class's metadata rather than by serializing the instance.
     * Every finding is an advisory - storage reads properties directly and a hydration is a
     * deserialization, so none of them moves a column - and the repositories log them once per
     * schema.
     *
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyShape(model: T): ReadonlyArray<ReadModelShapeIssue>;
    /**
     * Copy-on-write, so {@link withIndex} hands back a new schema and the receiver stays usable.
     */
    private _clone;
    private _columnInfo;
    /**
     * The placeholder a value for `column` binds through - the same one the row mapper writes with.
     */
    private _valueTerm;
    /**
     * Thrown directly rather than through an ensurer: the value's static type is `unknown` here, and
     * the kind check IS the guard.
     */
    private _ensureKind;
    private _comparison;
    private _containment;
}
export {};
//# sourceMappingURL=read-model-schema.d.ts.map