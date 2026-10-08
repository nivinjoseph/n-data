import { IsAnyOrUnknown, IsUnion, JsonValueType, SerializedShapeOf, SnapshotAcrossOrganizationsMessage, SnapshotIndex, SnapshotPath } from "./snapshot-index.js";
import { SnapshotArrayElement, SnapshotArrayIndex, SnapshotArrayPath, SnapshotArrayPredicate, SnapshotElementMatch } from "./snapshot-array-index.js";
import type { SnapshotDocumentOf } from "./snapshot-document.js";
/**
 * A boolean fragment and the values that bind to its `?` placeholders, in order.
 *
 * Always parenthesized, so a fragment stays contained wherever it is spliced - which is what makes
 * {@link SnapshotQuerySet.and} and {@link SnapshotQuerySet.or} safe to nest to any depth.
 * `SnapshotArrayPredicate` extends this, narrowing `params` to the jsonb documents a containment
 * fragment binds, so a containment fragment composes with the rest with no adaptation.
 *
 * **This is the only shape a repository accepts as a predicate**, everywhere one is taken: `query`,
 * `queryById`/`queryByIds`, `exists` and `count`. Every one comes from a `SnapshotQuerySet` - a typed
 * comparison, a combinator, or {@link SnapshotQuerySet.raw} - and each carries its own values, so
 * there is nothing to pass positionally and no binding order to get wrong.
 *
 * `acrossOrganizations` is the brand: whether every path the fragment reads is declared
 * `acrossOrganizations` on its set - that is, carries a prefix-free index. Whether a given plan uses
 * it follows the usual rules, exactly as within an organization: a composite serves a leading prefix,
 * and a `not` or an `is null` is not range-served. It is a real property rather than a phantom, so the org
 * repositories' cross-organization doors can check it at runtime as well as at compile time - and a
 * hand-written `{ sql, params }` literal, which nothing stamped, is not a predicate at all; build one
 * through {@link SnapshotQuerySet.raw} or {@link SnapshotQuerySet.rawAcrossOrganizations}. The type
 * parameter defaults to `boolean`, so an annotation
 * that names no brand admits both kinds; `SnapshotPredicate<true>` is what a cross-organization door
 * takes.
 *
 * @template TAcrossOrganizations - `true` when every path is declared across organizations - and for every containment predicate, since a GIN index carries no tenant prefix; `false` otherwise.
 */
export interface SnapshotPredicate<TAcrossOrganizations extends boolean = boolean> {
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
    readonly acrossOrganizations: TAcrossOrganizations;
}
/**
 * One `order by` term: an indexed expression and a direction.
 *
 * Carries the same brand a {@link SnapshotPredicate} does - whether the path is declared across
 * organizations - so a term can only order a cross-organization read when the index it would walk
 * exists without the tenant prefix.
 *
 * @template TAcrossOrganizations - `true` when the path is declared across organizations; `false` otherwise.
 */
export interface SnapshotOrderBy<TAcrossOrganizations extends boolean = boolean> {
    readonly sql: string;
    readonly acrossOrganizations: TAcrossOrganizations;
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
 * A type nothing can be assigned to, intersected into a declaration parameter when the argument's
 * type shows it was not an inline literal. Same idiom as {@link SnapshotCastRequired}: the property
 * name is the diagnostic the compiler prints.
 */
export type SnapshotInlineLiteralRequired = {
    readonly [K in "pass the path as an inline string literal - a variable-typed path arrives as the whole path union, which would silently widen the declared paths and discard path and cast checking"]: never;
};
/**
 * The composite counterpart of {@link SnapshotInlineLiteralRequired}.
 */
export type SnapshotInlineTupleRequired = {
    readonly [K in "pass the specs as an inline tuple literal - a variable-typed array or member arrives as the whole spec union, which would silently widen the declared paths and discard path and cast checking"]: never;
};
/**
 * The `acrossOrganizations` declaration option, offered only where it means something.
 *
 * On an organization-scoped state - one carrying `organizationId`, which is what `OrgAggregateState`
 * adds - the option is a boolean, and `true` flags the path for a second, prefix-free index (see
 * `SnapshotIndex.acrossOrganizations`). On any other state the property's type is the diagnostic, in
 * the {@link SnapshotCastRequired} idiom: a plain snapshot table has no `organization_id` column, so
 * there is no tenant prefix to cross, and `true` is a compile error whose message says so. (A plain
 * state that keeps a top-level `organizationId` inside `data` is off-pattern and passes this check;
 * `DbTableCreator` refuses the flag on a plain table at plan time, so it fails closed there instead.)
 *
 * `TFlag` is inferred from the literal written at the call site - `true` brands, anything else does
 * not - so a flag that arrives as a `boolean` variable declares the path without branding it. Exported
 * because it appears in a public signature; absent from the barrel, like {@link SnapshotSpecsAreLiteral}.
 */
export type SnapshotAcrossOrganizationsOption<TState, TFlag extends boolean> = [
    TState
] extends [{
    readonly organizationId: string;
}] ? {
    readonly acrossOrganizations?: TFlag;
} : {
    readonly acrossOrganizations?: SnapshotAcrossOrganizationsMessage;
};
/**
 * The brand a predicate or order-by term over `TP` carries: `true` exactly when the path is in the
 * set's flagged union. Non-distributive, so a union-typed path brands only when every member is
 * flagged - fail-closed, like every other widened argument.
 */
type SnapshotPathAcross<TP extends string, TAcross extends string> = [TP] extends [TAcross] ? true : false;
/**
 * The brand a combinator carries: `true` only when every arm is `true`. A single `false` arm widens
 * the indexed union to `boolean`, which is not `true`.
 */
type SnapshotAllAcross<TPredicates extends ReadonlyArray<SnapshotPredicate>> = [
    TPredicates[number]["acrossOrganizations"]
] extends [true] ? true : false;
/**
 * The path a spec names, distributing over a union spec so a widened member yields a union of paths.
 */
type SpecPath<K> = K extends string ? K : K extends {
    readonly path: infer TP extends string;
} ? TP : never;
/**
 * Resolves to `unknown` (a no-op under intersection) when `TSpecs` is an inline tuple of
 * single-path specs, and to the diagnostic type otherwise.
 *
 * Two ways a composite declaration loses its literal-ness, checked in order: the array itself is a
 * variable (its `length` is `number`, where a tuple's is a literal - the `const` type parameter on
 * {@link SnapshotQuerySet.withComposite} is what makes an inline literal infer as a tuple), or a
 * member inside an inline tuple is a union-typed variable. Either would widen `TIndexed` to every
 * state path with no cast. Exported because it appears in a public signature; absent from the barrel.
 */
export type SnapshotSpecsAreLiteral<TSpecs extends ReadonlyArray<any>> = number extends TSpecs["length"] ? SnapshotInlineTupleRequired : true extends {
    [I in keyof TSpecs]: IsUnion<SpecPath<TSpecs[I]>>;
}[number] ? SnapshotInlineTupleRequired : unknown;
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
    readonly acrossOrganizationsPaths: ReadonlyArray<string>;
    readonly _pathCheckingIntact: true;
    verifyDocument(document: SnapshotDocumentOf<TState>): ReadonlyArray<SnapshotShapeIssue>;
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
 * A path declared `{ acrossOrganizations: true }` is also indexed *without* the `organization_id`
 * prefix on an org-scoped table, and every predicate and order-by term carries a brand saying whether
 * all of its paths are so declared - `SnapshotPredicate<true>` - which is what the org repository's
 * typed cross-organization reads accept. Containment is always branded, since a GIN index has no
 * prefix; `and`/`or` are branded only when every arm is; {@link raw} never is, and
 * {@link rawAcrossOrganizations} is the door for a hand-written fragment that must be.
 *
 * The state is bound once, by {@link for}, and every path after that is inferred from its string
 * literal. That split is not stylistic: TypeScript has no partial type-argument inference, so
 * `SnapshotIndex.forPath<OrderState>("status")` - supplying the state explicitly - forces any path
 * parameter to its default and erases the literal. Binding the state in its own call is what makes
 * the rest of this possible.
 *
 * {@link SnapshotIndex} and {@link SnapshotArrayIndex} remain public underneath, for a computed or
 * dynamic key outside the state shape; this builds them, and hands them to the creator through
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
 *
 * // and in an integration test - the same object again, so drift has a detector
 * assert.deepStrictEqual(await tableCreator.verifySnapshotTableForAggregate(Order, OrderRepository.indexes), []);
 * ```
 *
 * @class SnapshotQuerySet
 */
export declare class SnapshotQuerySet<TState, TIndexed extends SnapshotCasts = NoDeclaredPaths, TArrays extends string = never, TAcross extends string = never> {
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
     * The scalar paths declared across organizations, in declaration order - what brands a predicate at
     * runtime, as `TAcross` does at compile time.
     */
    private readonly _acrossOrganizationsPaths;
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
     * The scalar paths declared `acrossOrganizations`, in declaration order - the ones a predicate can
     * still read with an index once the organization filter is dropped.
     */
    get acrossOrganizationsPaths(): ReadonlyArray<string>;
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
     * The one assertion the brand needs. A literal is shape-checked against `SnapshotPredicate` on the
     * way in - a misspelt `params` or a dropped `sql` is a compile error - and only its brand is
     * asserted on the way out, which is legal because every brand extends `boolean`, the type the
     * literal carries. Nothing else in this class casts a predicate.
     */
    private static _brand;
    /**
     * {@link _brand} for an order-by term.
     */
    private static _brandOrderBy;
    /**
     * Declares a btree index over one leaf scalar inside `data`, and makes that path queryable.
     *
     * Pass the path as an inline literal: a variable typed as the path union arrives as the whole
     * union, which would make `TIndexed` gain *every* state path with no cast - so the signature
     * rejects a union-typed argument outright ({@link SnapshotInlineLiteralRequired} is the
     * diagnostic). A computed key belongs to `SnapshotIndex.forRawPath`, where owning that is
     * explicit. The one shape the guard cannot see: a state with exactly one declarable path has a
     * one-member "union", indistinguishable from a literal - and harmless, since widening to one
     * path declares that path.
     *
     * @param {TP} path - The key to index, dot delimited to reach a nested one. Checked against the state shape.
     * @param {object} [options] - `type` to cast the extracted text, checked against the leaf ({@link SnapshotCastFor}: numeric types for a number, text/uuid for a string, boolean for a boolean - a mismatch is a compile error rather than an insert-time failure); `unique` to enforce a natural key; `name` to override the derived index name; `acrossOrganizations` to also index the path without the organization prefix on an org-scoped table and brand predicates over it ({@link SnapshotAcrossOrganizationsOption}: refused on a plain state, and only the literal `true` brands).
     * @returns {SnapshotQuerySet} A set that also knows this path - the receiver is left unchanged.
     * @throws {ArgumentException} If the path is already declared by this set, malformed, or the type is not a JsonValueType.
     */
    withPath<TP extends SnapshotPath<TState>, TCast extends SnapshotCastFor<TState, TP> | undefined = undefined, TFlag extends boolean = false>(path: TP & (IsUnion<TP> extends true ? SnapshotInlineLiteralRequired : unknown), options?: {
        readonly type?: TCast;
        readonly unique?: boolean;
        readonly name?: string;
    } & SnapshotAcrossOrganizationsOption<TState, TFlag>): SnapshotQuerySet<TState, TIndexed & Record<TP, TCast>, TArrays, TAcross | ([TFlag] extends [true] ? TP : never)>;
    /**
     * Declares one composite btree index over several leaf scalars, and makes each of those paths
     * queryable.
     *
     * Order matters: btree serves only a leading prefix of an index's columns, so the second path of
     * a composite is not independently searchable however exactly its expression matches. That is a
     * property of the plan, not of the types, so it is not expressible here - read `info.createdIndexes`
     * from the create call for the column order.
     *
     * Pass the specs as an inline tuple literal: a variable typed
     * `ReadonlyArray<SnapshotPathSpec<TState>>` - or a union-typed member inside an inline tuple -
     * would widen `TIndexed` to *every* state path with no cast, so the signature rejects both
     * ({@link SnapshotSpecsAreLiteral} is the guard; the `const` type parameter is what makes an
     * inline literal infer as a tuple for it).
     *
     * @param {TSpecs} paths - The keys to index, in index order; each a path or a `{ path, type }` pair whose `type` is checked against that path's leaf ({@link SnapshotCastFor}), so a mismatched cast is a compile error.
     * @param {object} [options] - `unique` to enforce the tuple as a natural key; `name` to override the derived index name; `acrossOrganizations` to also index the tuple without the organization prefix on an org-scoped table and brand predicates over every member ({@link SnapshotAcrossOrganizationsOption}).
     * @returns {SnapshotQuerySet} A set that also knows these paths.
     * @throws {ArgumentException} If paths is empty, any path is already declared by this set, or any path is malformed.
     */
    withComposite<const TSpecs extends ReadonlyArray<SnapshotPathSpec<TState>>, TFlag extends boolean = false>(paths: TSpecs & SnapshotSpecsAreLiteral<TSpecs>, options?: {
        readonly unique?: boolean;
        readonly name?: string;
    } & SnapshotAcrossOrganizationsOption<TState, TFlag>): SnapshotQuerySet<TState, TIndexed & SpecsToCasts<TSpecs>, TArrays, TAcross | ([TFlag] extends [true] ? keyof SpecsToCasts<TSpecs> & string : never)>;
    /**
     * Declares a GIN containment index over an array inside `data`, and makes that path answerable by
     * {@link contains}, {@link containsAll} and {@link containsAny}.
     *
     * On an org-scoped table this also causes a standalone `(organization_id)` btree to be created,
     * because a GIN index cannot lead with that column - see `SnapshotTableIndexInfo.leadingColumn`.
     *
     * Pass the path as an inline literal - a union-typed variable is rejected for the same reason as
     * in {@link withPath}.
     *
     * @param {TP} path - The array key to index. Checked against the state shape.
     * @param {object} [options] - `name` to override the derived index name.
     * @returns {SnapshotQuerySet} A set that also knows this array path.
     * @throws {ArgumentException} If the path is already declared by this set, or is malformed.
     */
    withArrayPath<TP extends SnapshotArrayPath<TState>>(path: TP & (IsUnion<TP> extends true ? SnapshotInlineLiteralRequired : unknown), options?: {
        readonly name?: string;
    }): SnapshotQuerySet<TState, TIndexed, TArrays | TP, TAcross>;
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
    eq<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` does not equal `value`.
     *
     * Rows whose `data` omits the key extract SQL NULL, and `NULL <> x` is NULL, so those rows do not
     * come back here either - pair with {@link isNull} if they should.
     */
    ne<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` is greater than `value`.
     */
    gt<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` is greater than or equal to `value`.
     */
    gte<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` is less than `value`.
     */
    lt<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` is less than or equal to `value`.
     */
    lte<TP extends keyof TIndexed & string>(path: TP, value: SnapshotComparable<TState, TP, TIndexed[TP]>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows where `path` is any of `values`.
     *
     * @throws {ArgumentException} If values is empty - `in ()` is not valid SQL, and an empty list is a caller bug rather than a way to match nothing.
     */
    in<TP extends keyof TIndexed & string>(path: TP, values: ReadonlyArray<SnapshotComparable<TState, TP, TIndexed[TP]>>): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows whose `data` omits `path`, or holds JSON null there - extraction yields SQL NULL
     * either way, and this API cannot tell the two apart.
     */
    isNull<TP extends keyof TIndexed & string>(path: TP): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows that carry a value at `path`.
     */
    isNotNull<TP extends keyof TIndexed & string>(path: TP): SnapshotPredicate<SnapshotPathAcross<TP, TAcross>>;
    /**
     * Matches rows whose array at `path` contains an element matching `match`.
     *
     * Every field named in one match must be carried by the **same** element. Two separate `contains`
     * fragments ANDed ask a weaker question - some element has one field, some possibly different
     * element has the other - and nothing in the SQL distinguishes them. Name them in one match.
     */
    contains<TP extends TArrays & string>(path: TP, match: SnapshotElementMatch<SnapshotArrayElement<TState, TP>>): SnapshotArrayPredicate;
    /**
     * Matches rows whose array at `path` contains an element for **every** match.
     */
    containsAll<TP extends TArrays & string>(path: TP, matches: ReadonlyArray<SnapshotElementMatch<SnapshotArrayElement<TState, TP>>>): SnapshotArrayPredicate;
    /**
     * Matches rows whose array at `path` contains an element for **any** of the matches.
     */
    containsAny<TP extends TArrays & string>(path: TP, matches: ReadonlyArray<SnapshotElementMatch<SnapshotArrayElement<TState, TP>>>): SnapshotArrayPredicate;
    /**
     * Every predicate must hold.
     *
     * Branded across organizations only when every predicate is - one arm that cannot use an index
     * without the organization filter makes the conjunction unable to as well.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `and` would emit `()`.
     */
    and<const TPredicates extends ReadonlyArray<SnapshotPredicate>>(...predicates: TPredicates): SnapshotPredicate<SnapshotAllAcross<TPredicates>>;
    /**
     * At least one predicate must hold.
     *
     * Branded across organizations only when every predicate is, as {@link and} is: a BitmapOr needs
     * every arm served by an index.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `or` would match nothing while reading as if it matched everything.
     */
    or<const TPredicates extends ReadonlyArray<SnapshotPredicate>>(...predicates: TPredicates): SnapshotPredicate<SnapshotAllAcross<TPredicates>>;
    /**
     * Negates a predicate.
     *
     * Worth knowing what this does *not* do: a row whose `data` omits the key extracts NULL, and
     * `not NULL` is NULL, so negation does not bring absent rows back. Nor does a negated predicate
     * use the index - the planner cannot serve `not` from a btree range or a GIN containment.
     *
     * The brand is kept as given, for the same reason it is kept within an organization: the brand
     * says every path is declared across organizations, which `not` does not change - whether a
     * particular plan uses an index is Postgres's, here as there.
     */
    not<TPredicate extends SnapshotPredicate>(predicate: TPredicate): SnapshotPredicate<TPredicate["acrossOrganizations"]>;
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
    raw(sql: string, ...params: ReadonlyArray<any>): SnapshotPredicate<false>;
    /**
     * {@link raw} for a fragment that is meant to run across organizations.
     *
     * Same validation, same parenthesizing, one difference: the result is branded
     * `acrossOrganizations: true`, so the org repository's typed cross-organization reads accept it. The
     * brand is a claim the caller makes - that every expression in the fragment is served by an index
     * that carries no tenant prefix - and nothing here checks it. Build the expressions from
     * {@link expressionFor} over paths declared `acrossOrganizations`, or over array paths, and it
     * holds; write anything else and the read runs, and is no index lookup. Named for its consequence,
     * like the doors that take it.
     *
     * @param {string} sql - A boolean fragment. Parenthesized for you; bind values with `?`.
     * @param {...ReadonlyArray<any>} params - Values bound to the fragment's placeholders.
     * @throws {ArgumentException} If sql is empty, is a whole statement, keeps the `where` keyword, or contains a ';'.
     */
    rawAcrossOrganizations(sql: string, ...params: ReadonlyArray<any>): SnapshotPredicate<true>;
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
    orderBy<TP extends SnapshotOrderablePath<TState, TIndexed>>(path: TP, direction?: "asc" | "desc"): SnapshotOrderBy<SnapshotPathAcross<TP & string, TAcross>>;
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
     * `assert.deepStrictEqual(MyRepository.indexes.verifyDocument(toSnapshotDocument(aggregate)), [])`
     * - to catch the one case the save-time check can meet late: a rename inside an optional object
     * that happens to be null in every document a given process stores.
     *
     * What a clean result does *not* prove: a rename whose custom key coincidentally equals another
     * real key (the path resolves, to the wrong value), and rows written before the declaration
     * changed. It checks shape, not data.
     *
     * @param {SnapshotDocumentOf} document - A snapshot document - what `AggregateRoot.snapshot()` returns, as `toSnapshotDocument` types it.
     * @returns {ReadonlyArray<SnapshotShapeIssue>} Every issue found; empty when all paths resolve.
     * @throws {ArgumentNullException} If document is null or undefined.
     * @throws {ArgumentException} If document is not an object.
     */
    verifyDocument(document: SnapshotDocumentOf<TState>): ReadonlyArray<SnapshotShapeIssue>;
    /**
     * Copy-on-write, so each `with...` call hands back a new set and the receiver stays usable. That
     * keeps the fluent chain from depending on evaluation order, and makes a set safe to share as a
     * base for two repositories.
     */
    private _clone;
    /**
     * `acrossOrganizations` is typed `boolean | string` rather than `boolean` because on a plain state
     * the option's type is the diagnostic string - which a TypeScript caller cannot pass, and which the
     * guard below rejects for a JavaScript one.
     */
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
    /**
     * Whether a declared path was flagged - the runtime side of {@link SnapshotPathAcross}.
     */
    private _isAcrossOrganizations;
    private _raw;
    private _expressionFor;
    private _containmentFor;
}
export {};
//# sourceMappingURL=snapshot-query-set.d.ts.map