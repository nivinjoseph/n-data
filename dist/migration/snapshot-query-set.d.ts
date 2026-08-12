import { JsonValueType, SnapshotIndex, SnapshotPath } from "./snapshot-index.js";
import { SnapshotArrayElement, SnapshotArrayIndex, SnapshotArrayPath, SnapshotElementMatch } from "./snapshot-array-index.js";
/**
 * A boolean fragment and the values that bind to its `?` placeholders, in order.
 *
 * Always parenthesized, so a fragment stays contained wherever it is spliced - which is what makes
 * {@link SnapshotQuerySet.and} and {@link SnapshotQuerySet.or} safe to nest to any depth.
 * `SnapshotArrayPredicate` extends this, narrowing `params` to the jsonb documents a containment
 * fragment binds, so a containment fragment composes with the rest with no adaptation.
 *
 * **This is the only shape a repository's `query` accepts as a predicate.** Every one comes from a
 * `SnapshotQuerySet` - a typed comparison, a combinator, or {@link SnapshotQuerySet.raw} - and each
 * carries its own values, so there is nothing to pass positionally and no binding order to get wrong.
 */
export interface SnapshotPredicate {
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
}
/**
 * One `order by` term: an indexed expression and a direction.
 */
export interface SnapshotOrderBy {
    readonly sql: string;
}
/**
 * The `JsonValueType` members that make an extracted value compare as a number.
 *
 * Naming them is what lets {@link SnapshotQuerySet} reject a numeric comparison on a path that was
 * indexed without a cast - the `'9' > '100'` hazard - at compile time rather than in prose.
 */
export type SnapshotNumericType = JsonValueType.smallint | JsonValueType.integer | JsonValueType.bigint | JsonValueType.numeric | JsonValueType.real | JsonValueType.doublePrecision;
/**
 * The declared cast for each indexed path, or `undefined` where none was declared.
 */
type SnapshotCasts = Record<string, JsonValueType | undefined>;
/**
 * One member of a composite index: a bare path, or a path with its own cast.
 *
 * The two forms coexist because a composite whose members need different types has to be
 * expressible - `["series", { path: "invoiceNumber", type: JsonValueType.integer }]`.
 */
export type SnapshotPathSpec<TState> = SnapshotPath<TState> | {
    readonly path: SnapshotPath<TState>;
    readonly type?: JsonValueType;
};
/**
 * Folds a tuple of {@link SnapshotPathSpec}s into the path-to-cast record, so a cast declared on a
 * composite member is remembered just as one declared through `withPath` is.
 */
type SpecsToCasts<TSpecs extends ReadonlyArray<any>> = {
    [K in TSpecs[number] as K extends string ? K : K extends {
        path: infer TP extends string;
    } ? TP : never]: K extends string ? undefined : K extends {
        type: infer TT;
    } ? TT : undefined;
};
/**
 * The cast record of a set that has declared nothing yet - no keys, so nothing is queryable.
 *
 * Spelled this way rather than as `{}`, which as a type would admit any non-nullish value.
 */
type NoDeclaredPaths = Record<never, never>;
/**
 * Resolves a dotted path within `T` to the type of the leaf it names.
 *
 * The scalar counterpart of `SnapshotArrayElement`, and the same mechanism: the path arrives as a
 * string literal, so the value type follows from it with nothing written at the call site.
 */
export type SnapshotValueAt<T, TPath extends string> = TPath extends `${infer THead}.${infer TRest}` ? THead extends keyof T ? SnapshotValueAt<NonNullable<T[THead]>, TRest> : never : TPath extends keyof T ? NonNullable<T[TPath]> : never;
/**
 * What a comparison against `TP` accepts: the leaf's own type, unless the leaf is a number that was
 * indexed without a numeric cast.
 *
 * In that one case it resolves to {@link SnapshotCastRequired}, whose only property *name* is the
 * explanation - so the compiler prints the reason rather than "not assignable to type 'never'".
 *
 * The rule is deliberately narrow. Text needs no cast, since extraction already yields text and
 * Postgres elides a redundant `::text`. A boolean compares correctly as `'true'`/`'false'` for
 * equality. Only a number is wrong uncast, because text ordering makes `'9' > '100'` true.
 */
export type SnapshotComparable<TState, TP extends string, TCast> = [
    SnapshotValueAt<TState, TP>
] extends [number] ? ([TCast] extends [SnapshotNumericType] ? number : SnapshotCastRequired<TP>) : SnapshotValueAt<TState, TP>;
/**
 * A type nothing can be assigned to, whose property name carries the reason.
 */
export type SnapshotCastRequired<TP extends string> = {
    readonly [K in `path '${TP}' is a number indexed as text; declare a numeric JsonValueType for it to compare it as a number`]: never;
};
/**
 * The declared indexes of one snapshot table, and the typed predicates over them.
 *
 * This is the single declaration of a table's queryable shape: the repository builds its predicates
 * from it, and `DbTableCreator` creates the table's indexes from the same object. So an index that is
 * queried is necessarily one that was created - the gap where a declared-but-never-migrated index
 * silently degrades to a sequential scan cannot open.
 *
 * **Every path is checked against what this set actually indexes**, not merely against the state
 * shape. A path that exists on the state but was never declared here is a compile error, as is a
 * value of the wrong type for the leaf it is compared against, as is a numeric comparison on a path
 * declared without a cast.
 *
 * The state is bound once, by {@link for}, and every path after that is inferred from its string
 * literal. That split is not stylistic: TypeScript has no partial type-argument inference, so
 * `SnapshotIndex.forPath<OrderState>("status")` - supplying the state explicitly - forces any path
 * parameter to its default and erases the literal. Binding the state in its own call is what makes
 * the rest of this possible.
 *
 * {@link SnapshotIndex} and {@link SnapshotArrayIndex} remain public underneath, for a computed or
 * `$`-prefixed key outside the state shape; this builds them, and hands them to the creator through
 * {@link indexes} and {@link arrayIndexes}.
 *
 * @example
 * ```typescript
 * @inject("OrderEventStreamRepository")
 * export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
 * {
 *     // one declaration: the migration creates these, this class queries them, and the paths below
 *     // are checked against exactly this list
 *     public static readonly indexes = SnapshotQuerySet.for<OrderState>()
 *         .withPath("status")
 *         .withPath("total", { type: JsonValueType.numeric })
 *         .withPath("orderNumber", { unique: true })
 *         .withComposite(["series", { path: "revision", type: JsonValueType.integer }], { unique: true })
 *         .withArrayPath("tags");
 *
 *     // the base declares this abstract at a widened type, because it does not know the paths; the
 *     // `typeof` here is what gives the call sites the narrow one
 *     protected override get querySet(): typeof OrderRepository.indexes { return OrderRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: OrderEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.querySet.eq("status", status));
 *     }
 *
 *     public getOverTotal(total: number): Promise<Array<Order>>
 *     {
 *         return this.query(this.querySet.gt("total", total));
 *     }
 *
 *     public getByTag(tag: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.querySet.contains("tags", tag));
 *     }
 *
 *     public getRecentRush(status: string, count: number): Promise<Array<Order>>
 *     {
 *         return this.query({
 *             where: this.querySet.and(
 *                 this.querySet.eq("status", status),
 *                 this.querySet.gt("total", 0)),
 *             orderBy: this.querySet.orderBy("total", "desc"),
 *             limit: count
 *         });
 *     }
 * }
 *
 * // in the migration - the same object
 * await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.indexes);
 * ```
 *
 * @class SnapshotQuerySet
 */
export declare class SnapshotQuerySet<TState, TIndexed extends SnapshotCasts = NoDeclaredPaths, TArrays extends string = never> {
    /**
     * Positionally aligned: `_indexes[i]` is the index `_paths[i]`'s expression came from. Kept in
     * declaration order, because that is the order the creator emits the DDL in.
     */
    private readonly _indexes;
    private readonly _arrayIndexes;
    /**
     * Path to the expression that reads it, for every scalar path this set indexes.
     *
     * Read off the declaration that also emitted the DDL, never rebuilt - which is the invariant
     * `SnapshotIndex` exists to hold, and the reason a predicate from here is index-usable.
     */
    private readonly _expressionsByPath;
    /**
     * Path to the containment API for it, for every array path this set indexes.
     */
    private readonly _containmentsByPath;
    /**
     * The btree index declarations, in declaration order.
     *
     * Named to match `SnapshotTableOptions.indexes`, which is what lets this whole object be handed
     * to `DbTableCreator` directly.
     */
    get indexes(): ReadonlyArray<SnapshotIndex<TState>>;
    /**
     * The GIN array index declarations, in declaration order.
     */
    get arrayIndexes(): ReadonlyArray<SnapshotArrayIndex<TState>>;
    /**
     * The scalar paths this set indexes, in declaration order.
     */
    get paths(): ReadonlyArray<string>;
    /**
     * The array paths this set indexes, in declaration order.
     */
    get arrayPaths(): ReadonlyArray<string>;
    /**
     * Use {@link for}, which binds the state so every path after it is inferred.
     */
    private constructor();
    /**
     * Starts an empty set for `TState`.
     *
     * A repository with no indexes at all declares one of these and passes it - explicitly saying "no
     * queryable paths" rather than leaving it unsaid.
     *
     * @template TState - The aggregate's state shape; every path is checked against it.
     * @returns {SnapshotQuerySet<TState>} An empty set.
     */
    static for<TState>(): SnapshotQuerySet<TState>;
    private static _combine;
    /**
     * Declares a btree index over one leaf scalar inside `data`, and makes that path queryable.
     *
     * @param {TP} path - The key to index, dot delimited to reach a nested one. Checked against the state shape.
     * @param {object} [options] - `type` to cast the extracted text; `unique` to enforce a natural key; `name` to override the derived index name.
     * @returns {SnapshotQuerySet} A set that also knows this path - the receiver is left unchanged.
     * @throws {ArgumentException} If the path is already declared by this set, malformed, or the type is not a JsonValueType.
     */
    withPath<TP extends SnapshotPath<TState>, TCast extends JsonValueType | undefined = undefined>(path: TP, options?: {
        readonly type?: TCast;
        readonly unique?: boolean;
        readonly name?: string;
    }): SnapshotQuerySet<TState, TIndexed & Record<TP, TCast>, TArrays>;
    /**
     * Declares one composite btree index over several leaf scalars, and makes each of those paths
     * queryable.
     *
     * Order matters: btree serves only a leading prefix of an index's columns, so the second path of
     * a composite is not independently searchable however exactly its expression matches. That is a
     * property of the plan, not of the types, so it is not expressible here - read `info.createdIndexes`
     * from the create call for the column order.
     *
     * @param {TSpecs} paths - The keys to index, in index order; each a path or a `{ path, type }` pair.
     * @param {object} [options] - `unique` to enforce the tuple as a natural key; `name` to override the derived index name.
     * @returns {SnapshotQuerySet} A set that also knows these paths.
     * @throws {ArgumentException} If paths is empty, any path is already declared by this set, or any path is malformed.
     */
    withComposite<TSpecs extends ReadonlyArray<SnapshotPathSpec<TState>>>(paths: TSpecs, options?: {
        readonly unique?: boolean;
        readonly name?: string;
    }): SnapshotQuerySet<TState, TIndexed & SpecsToCasts<TSpecs>, TArrays>;
    /**
     * Declares a GIN containment index over an array inside `data`, and makes that path answerable by
     * {@link contains}, {@link containsAll} and {@link containsAny}.
     *
     * On an org-scoped table this also causes a standalone `(organization_id)` btree to be created,
     * because a GIN index cannot lead with that column - see `SnapshotTableIndexInfo.leadingColumn`.
     *
     * @param {TP} path - The array key to index. Checked against the state shape.
     * @param {object} [options] - `name` to override the derived index name.
     * @returns {SnapshotQuerySet} A set that also knows this array path.
     * @throws {ArgumentException} If the path is already declared by this set, or is malformed.
     */
    withArrayPath<TP extends SnapshotArrayPath<TState>>(path: TP, options?: {
        readonly name?: string;
    }): SnapshotQuerySet<TState, TIndexed, TArrays | TP>;
    /**
     * The expression that reads `path`, for composing a predicate by hand.
     *
     * The escape hatch that keeps {@link raw} useful: it hands back the same string the index was
     * created from, so a hand-written fragment is still index-usable.
     *
     * @param {TP} path - A scalar path this set indexes.
     * @returns {string} The parenthesized extraction expression, e.g. `(data->>'status')`.
     */
    expressionFor<TP extends keyof TIndexed & string>(path: TP): string;
    /**
     * Matches rows where `path` equals `value`.
     */
    eq<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` does not equal `value`.
     *
     * Rows whose `data` omits the key extract SQL NULL, and `NULL <> x` is NULL, so those rows do not
     * come back here either - pair with {@link isNull} if they should.
     */
    ne<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` is greater than `value`.
     */
    gt<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` is greater than or equal to `value`.
     */
    gte<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` is less than `value`.
     */
    lt<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` is less than or equal to `value`.
     */
    lte<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate;
    /**
     * Matches rows where `path` is any of `values`.
     *
     * @throws {ArgumentException} If values is empty - `in ()` is not valid SQL, and an empty list is a caller bug rather than a way to match nothing.
     */
    in<TP extends keyof TIndexed & string>(path: TP, values: ReadonlyArray<SnapshotComparable<TState, TP, TIndexed[TP]>>): SnapshotPredicate;
    /**
     * Matches rows whose `data` omits `path`, or holds JSON null there - extraction yields SQL NULL
     * either way, and this API cannot tell the two apart.
     */
    isNull<TP extends keyof TIndexed & string>(path: TP): SnapshotPredicate;
    /**
     * Matches rows that carry a value at `path`.
     */
    isNotNull<TP extends keyof TIndexed & string>(path: TP): SnapshotPredicate;
    /**
     * Matches rows whose array at `path` contains an element matching `match`.
     *
     * Every field named in one match must be carried by the **same** element. Two separate `contains`
     * fragments ANDed ask a weaker question - some element has one field, some possibly different
     * element has the other - and nothing in the SQL distinguishes them. Name them in one match.
     */
    contains<TP extends TArrays & string>(path: TP, match: SnapshotElementMatch<SnapshotArrayElement<TState, TP>>): SnapshotPredicate;
    /**
     * Matches rows whose array at `path` contains an element for **every** match.
     */
    containsAll<TP extends TArrays & string>(path: TP, matches: ReadonlyArray<SnapshotElementMatch<SnapshotArrayElement<TState, TP>>>): SnapshotPredicate;
    /**
     * Matches rows whose array at `path` contains an element for **any** of the matches.
     */
    containsAny<TP extends TArrays & string>(path: TP, matches: ReadonlyArray<SnapshotElementMatch<SnapshotArrayElement<TState, TP>>>): SnapshotPredicate;
    /**
     * Every predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `and` would emit `()`.
     */
    and(...predicates: ReadonlyArray<SnapshotPredicate>): SnapshotPredicate;
    /**
     * At least one predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `or` would match nothing while reading as if it matched everything.
     */
    or(...predicates: ReadonlyArray<SnapshotPredicate>): SnapshotPredicate;
    /**
     * Negates a predicate.
     *
     * Worth knowing what this does *not* do: a row whose `data` omits the key extracts NULL, and
     * `not NULL` is NULL, so negation does not bring absent rows back. Nor does a negated predicate
     * use the index - the planner cannot serve `not` from a btree range or a GIN containment.
     */
    not(predicate: SnapshotPredicate): SnapshotPredicate;
    /**
     * Wraps a hand-written fragment so it composes with the typed predicates.
     *
     * For what the operators above cannot say - a `like`, a range on a function of two paths, a
     * condition on a key outside the state shape. Build any expression inside it from
     * {@link expressionFor} rather than by hand, so it still matches the index textually.
     *
     * @param {string} sql - A boolean fragment. Parenthesized for you; bind values with `?`.
     * @param {...ReadonlyArray<any>} params - Values bound to the fragment's placeholders.
     * @throws {ArgumentException} If sql is empty, is a whole statement, keeps the `where` keyword, or contains a ';'.
     */
    raw(sql: string, ...params: ReadonlyArray<any>): SnapshotPredicate;
    /**
     * One `order by` term over an indexed path.
     *
     * Restricted to indexed paths for the same reason the predicates are: an expression index serves
     * an `order by` only when the expression matches the indexed one textually. Note that a GIN array
     * index cannot serve ordering at all, which is why an array path is not offered here.
     *
     * @param {TP} path - A scalar path this set indexes.
     * @param {"asc" | "desc"} [direction] - Defaults to `asc`, as Postgres does.
     */
    orderBy<TP extends keyof TIndexed & string>(path: TP, direction?: "asc" | "desc"): SnapshotOrderBy;
    /**
     * Copy-on-write, so each `with...` call hands back a new set and the receiver stays usable. That
     * keeps the fluent chain from depending on evaluation order, and makes a set safe to share as a
     * base for two repositories.
     */
    private _clone;
    private _withComposite;
    private _comparison;
    private _expressionFor;
    private _containmentFor;
}
export {};
//# sourceMappingURL=snapshot-query-set.d.ts.map