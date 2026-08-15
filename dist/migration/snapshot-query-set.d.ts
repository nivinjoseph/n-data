import { IsAnyOrUnknown, JsonValueType, SerializedShapeOf, SnapshotIndex, SnapshotPath } from "./snapshot-index.js";
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
export type SnapshotPathSpec<TState, TP extends SnapshotPath<TState> = SnapshotPath<TState>> = TP extends string ? TP | {
    readonly path: TP;
    readonly type?: SnapshotCastFor<TState, TP>;
} : never;
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
 * string literal, so the value type follows from it with nothing written at the call site. The walk
 * descends through the same {@link SerializedShapeOf} substitution the path union was built with, so
 * a leaf reached through a nested `Serializable` resolves to its type in the *stored* record - the
 * two must not diverge, or a path the union offers would resolve to `never` here.
 */
export type SnapshotValueAt<T, TPath extends string> = TPath extends `${infer THead}.${infer TRest}` ? THead extends keyof T ? SnapshotValueAt<SerializedShapeOf<NonNullable<T[THead]>>, TRest> : never : TPath extends keyof T ? NonNullable<T[TPath]> : never;
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
 * The casts legal for the leaf `TP` names: numeric types for a number, text or uuid for a string,
 * boolean for a boolean. Anything else - a numeric cast on a string leaf, say - would compile and
 * then make the index expression itself throw on every insert, since Postgres casts the extracted
 * text eagerly. `text` on a string is allowed although redundant (Postgres elides it).
 *
 * A leaf whose kind the type cannot pin - a union of scalar kinds - offers no cast at all; declare
 * it without one, or through the raw door where the caller owns the choice. Deliberately NOT applied to
 * `SnapshotIndex.forPath(path, type)`: there the state is supplied explicitly, and with no partial
 * type-argument inference the path parameter collapses to the whole union, which would make this
 * type reject every cast.
 */
export type SnapshotCastFor<TState, TP extends string> = [
    SnapshotValueAt<TState, TP>
] extends [number] ? SnapshotNumericType : [SnapshotValueAt<TState, TP>] extends [string] ? JsonValueType.text | JsonValueType.uuid : [SnapshotValueAt<TState, TP>] extends [boolean] ? JsonValueType.boolean : never;
/**
 * The indexed paths {@link SnapshotQuerySet.orderBy} may take: every declared path except a number
 * indexed without a numeric cast - which as text orders lexicographically, making '9' > '100'. The
 * same hazard {@link SnapshotComparable} closes for comparisons, restated for the one clause that
 * has no value argument to hang the error on. Strings order correctly as text, and booleans order
 * as 'false' < 'true', which matches boolean order.
 */
type SnapshotOrderablePath<TState, TIndexed extends SnapshotCasts> = {
    [K in keyof TIndexed & string]: [
        SnapshotValueAt<TState, K>
    ] extends [number] ? ([TIndexed[K]] extends [SnapshotNumericType] ? K : never) : K;
}[keyof TIndexed & string];
/**
 * One problem {@link SnapshotQuerySet.verifyDocument} found with a declared path, against one real
 * snapshot document.
 *
 * `severity` is the split the save-time guard acts on. A `fatal` issue is a true positive by
 * construction - `serialize()` emits a key for **every** decorated getter, null-valued ones
 * included, so a declared segment absent from an object carrying `$typename` is definitively a
 * `@serialize("customKey")` rename (or raw-path drift), never an omitted optional. An `advisory`
 * issue is ambiguous in a single document - an absent key under a *plain* parent may simply be an
 * optional the aggregate did not set - so it warrants a warning, not a blocked save.
 */
export interface SnapshotShapeIssue {
    /**
     * The declared path the issue is about.
     */
    readonly path: string;
    /**
     * The dotted prefix at which the walk stopped.
     */
    readonly failedAtSegment: string;
    readonly kind: "unresolvable-key" | "non-object-intermediate" | "non-array-leaf" | "absent-key" | "empty-object-leaf";
    readonly severity: "fatal" | "advisory";
    /**
     * Names the problem and the fix, so a log line or an exception is actionable on its own.
     */
    readonly message: string;
}
/**
 * What a snapshot base class can say about a subclass's query set without knowing its paths: the
 * declarations, and nothing queryable.
 *
 * Deliberately method-free - no `eq`, no `orderBy`, no `contains`. The abstract `querySet` getter on
 * the snapshot base classes is typed with THIS, so an override that copies the base's declared type
 * (the IDE quick-fix output) cannot build a single predicate: the mistake announces itself at the
 * first query instead of silently discarding path and cast checking, which is what the old widened
 * `SnapshotQuerySet<TState, any, any>` did - and writing THAT type is itself a compile error now,
 * through {@link SnapshotQuerySet._pathCheckingIntact}. The documented override -
 * `typeof MyRepository.indexes` - satisfies this structurally and keeps every check.
 */
export interface DeclaredSnapshotQuerySet<TState> {
    readonly indexes: ReadonlyArray<SnapshotIndex<TState>>;
    readonly arrayIndexes: ReadonlyArray<SnapshotArrayIndex<TState>>;
    readonly paths: ReadonlyArray<string>;
    readonly arrayPaths: ReadonlyArray<string>;
    readonly _pathCheckingIntact: true;
    verifyDocument(document: object): ReadonlyArray<SnapshotShapeIssue>;
}
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
 *     // the base declares this abstract at the declaration-only DeclaredSnapshotQuerySet type,
 *     // because it does not know the paths; the `typeof` here is what gives the call sites the
 *     // narrow, queryable one
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
     * Phantom - `declare` emits nothing, the property never exists at runtime. Its type is `true`
     * for every set built through {@link for}, and becomes an error-message string when `TIndexed`
     * is `any` - which happens exactly when someone writes `SnapshotQuerySet<TState, any, any>` as
     * an annotation. That annotation used to compile and silently discard every path and cast check
     * (the querySet override trap); now the message is the compile error. Same idiom as
     * {@link SnapshotCastRequired}: the type IS the diagnostic.
     */
    readonly _pathCheckingIntact: IsAnyOrUnknown<TIndexed> extends true ? "this set is typed <TState, any, any>, which discards path and cast checking - type the override as `typeof MyRepository.indexes`" : true;
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
     * **Pass the path as an inline literal.** A `string`-typed variable widens `TP` to the whole
     * path union, so `TIndexed` gains *every* state path with no cast - after which `eq`/`orderBy`
     * accept any state path and the cast checks silently vanish, while the runtime set still holds
     * only the one path. A computed key belongs to `SnapshotIndex.forRawPath`, where owning that is
     * explicit.
     *
     * @param {TP} path - The key to index, dot delimited to reach a nested one. Checked against the state shape.
     * @param {object} [options] - `type` to cast the extracted text, checked against the leaf ({@link SnapshotCastFor}: numeric types for a number, text/uuid for a string, boolean for a boolean - a mismatch is a compile error rather than an insert-time failure); `unique` to enforce a natural key; `name` to override the derived index name.
     * @returns {SnapshotQuerySet} A set that also knows this path - the receiver is left unchanged.
     * @throws {ArgumentException} If the path is already declared by this set, malformed, or the type is not a JsonValueType.
     */
    withPath<TP extends SnapshotPath<TState>, TCast extends SnapshotCastFor<TState, TP> | undefined = undefined>(path: TP, options?: {
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
     * **Pass the specs as an inline tuple literal.** A variable typed
     * `ReadonlyArray<SnapshotPathSpec<TState>>` widens `TSpecs[number]` to the whole union, so
     * `TIndexed` gains *every* state path with no cast - after which `eq`/`orderBy` accept any state
     * path and the cast checks silently vanish, while the runtime set still holds only the declared
     * paths.
     *
     * @param {TSpecs} paths - The keys to index, in index order; each a path or a `{ path, type }` pair whose `type` is checked against that path's leaf ({@link SnapshotCastFor}), so a mismatched cast is a compile error.
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
     * A number indexed without a numeric cast is not orderable: as text it sorts '9' > '100', the
     * same hazard the comparisons reject - so it is a compile error here too, fixed by declaring the
     * cast on the path.
     *
     * @param {TP} path - A scalar path this set indexes, orderable as its leaf type.
     * @param {"asc" | "desc"} [direction] - Defaults to `asc`, as Postgres does.
     */
    orderBy<TP extends SnapshotOrderablePath<TState, TIndexed>>(path: TP, direction?: "asc" | "desc"): SnapshotOrderBy;
    /**
     * Checks every declared path - scalar and array, typed and raw - against one real snapshot
     * document, and reports what does not line up. Pure: no logging, no throwing, no state.
     *
     * This is the runtime companion to the compile-time path checking, for the one mismatch the
     * types can never see: a getter decorated `@serialize("customKey")` stores under the custom key
     * while the type offers the getter *name*, so the declared path compiles, the index extracts
     * null from every row, `asUnique` enforces nothing, and every query silently matches nothing.
     * That case is detectable here with certainty, because `serialize()` emits a key for every
     * decorated getter - null-valued ones included - so a declared segment absent from an object
     * carrying `$typename` cannot be an omitted optional (see {@link SnapshotShapeIssue}).
     *
     * The snapshot repositories run this once per process against the first document they save, and
     * act on the severity split: `fatal` throws, `advisory` logs once. Call it yourself in a test -
     * `assert.deepStrictEqual(MyRepository.indexes.verifyDocument(aggregate.snapshot()), [])` - to
     * catch the one case the save-time check can meet late: a rename inside an optional object that
     * happens to be null in every document a given process stores.
     *
     * What a clean result does *not* prove: a rename whose custom key coincidentally equals another
     * real key (the path resolves, to the wrong value), and rows written before the declaration
     * changed. It checks shape, not data.
     *
     * @param {object} document - A snapshot document, i.e. what `AggregateRoot.snapshot()` returns.
     * @returns {ReadonlyArray<SnapshotShapeIssue>} Every issue found; empty when all paths resolve.
     * @throws {ArgumentNullException} If document is null or undefined.
     * @throws {ArgumentException} If document is not an object.
     */
    verifyDocument(document: object): ReadonlyArray<SnapshotShapeIssue>;
    /**
     * Copy-on-write, so each `with...` call hands back a new set and the receiver stays usable. That
     * keeps the fluent chain from depending on evaluation order, and makes a set safe to share as a
     * base for two repositories.
     */
    private _clone;
    private _withComposite;
    /**
     * Walks one declared path through `document`, appending to `issues` where it stops resolving.
     *
     * The severity rules, stated once: a value of the *wrong kind* along the way is always fatal (a
     * scalar or array where an object must be, a non-array at an array leaf - no optional produces
     * those); an *absent* key is fatal only under a `$typename` parent, where `serialize()` is known
     * to have emitted every decorated key; and null anywhere is clean, because that is exactly what
     * an optional stores and extraction turns into SQL NULL.
     */
    private _verifyPath;
    private _comparison;
    private _expressionFor;
    private _containmentFor;
}
export {};
//# sourceMappingURL=snapshot-query-set.d.ts.map