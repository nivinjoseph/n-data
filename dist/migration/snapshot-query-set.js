import { given } from "@nivinjoseph/n-defensive";
import { validateBooleanFragment } from "../repository/sql-fragment.js";
import { SnapshotIndex } from "./snapshot-index.js";
import { SnapshotArrayIndex } from "./snapshot-array-index.js";
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
export class SnapshotQuerySet {
    /**
     * Positionally aligned: `_indexes[i]` is the index `_paths[i]`'s expression came from. Kept in
     * declaration order, because that is the order the creator emits the DDL in.
     */
    _indexes = new Array();
    _arrayIndexes = new Array();
    /**
     * Path to the expression that reads it, for every scalar path this set indexes.
     *
     * Read off the declaration that also emitted the DDL, never rebuilt - which is the invariant
     * `SnapshotIndex` exists to hold, and the reason a predicate from here is index-usable.
     */
    _expressionsByPath = new Map();
    /**
     * Path to the containment API for it, for every array path this set indexes.
     */
    _containmentsByPath = new Map();
    /**
     * The scalar paths declared across organizations, in declaration order - what brands a predicate at
     * runtime, as `TAcross` does at compile time.
     */
    _acrossOrganizationsPaths = new Array();
    /**
     * The btree index declarations, in declaration order.
     *
     * Named to match `SnapshotTableOptions.indexes`, which is what lets this whole object be handed
     * to `DbTableCreator` directly.
     */
    get indexes() { return [...this._indexes]; }
    /**
     * The GIN array index declarations, in declaration order.
     */
    get arrayIndexes() { return [...this._arrayIndexes]; }
    /**
     * The scalar paths this set indexes, in declaration order.
     */
    get paths() { return [...this._expressionsByPath.keys()]; }
    /**
     * The array paths this set indexes, in declaration order.
     */
    get arrayPaths() { return [...this._containmentsByPath.keys()]; }
    /**
     * The scalar paths declared `acrossOrganizations`, in declaration order - the ones a predicate can
     * still read with an index once the organization filter is dropped.
     */
    get acrossOrganizationsPaths() { return [...this._acrossOrganizationsPaths]; }
    /**
     * Use {@link for}, which binds the state so every path after it is inferred.
     */
    constructor() { }
    /**
     * Starts an empty set for `TState`.
     *
     * A repository with no indexes at all declares one of these and passes it - explicitly saying "no
     * queryable paths" rather than leaving it unsaid.
     *
     * @template TState - The aggregate's state shape; every path is checked against it.
     * @returns {SnapshotQuerySet<TState>} An empty set.
     */
    static for() {
        return new SnapshotQuerySet();
    }
    static _combine(operator, predicates) {
        given(predicates, "predicates").ensureHasValue().ensureIsArray().ensureIsNotEmpty()
            // read through `any` so a JavaScript caller passing something predicate-shaped is caught
            // here rather than emitting `undefined` into the SQL
            .ensure(t => t.every(u => typeof u?.sql === "string"), "every predicate must have sql");
        const params = new Array();
        for (const predicate of predicates)
            params.push(...predicate.params);
        // the parens are what make nesting safe: `a and (b or c)` only means that if the inner
        // fragment carries its own
        return {
            sql: `(${predicates.map(t => t.sql).join(` ${operator} `)})`, params,
            // a conjunction or disjunction can cross organizations only if every arm can
            acrossOrganizations: predicates.every(t => t.acrossOrganizations === true)
        };
    }
    /**
     * The one assertion the brand needs. A literal is shape-checked against `SnapshotPredicate` on the
     * way in - a misspelt `params` or a dropped `sql` is a compile error - and only its brand is
     * asserted on the way out, which is legal because every brand extends `boolean`, the type the
     * literal carries. Nothing else in this class casts a predicate.
     */
    static _brand(predicate) {
        return predicate;
    }
    /**
     * {@link _brand} for an order-by term.
     */
    static _brandOrderBy(term) {
        return term;
    }
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
    withPath(path, options) {
        const next = this._withComposite([options?.type != null ? { path, type: options.type } : path], options);
        // the accumulation happens in the type parameters; the instance carries the same paths either
        // way, so this is the one place the two are tied together
        return next;
    }
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
    withComposite(paths, options) {
        given(paths, "paths").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        return this._withComposite(paths, options);
    }
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
    withArrayPath(path, options) {
        const next = this._clone();
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => !next._containmentsByPath.has(t.trim()) && !next._expressionsByPath.has(t.trim()), `path '${path}' is already declared by this set`);
        let index = SnapshotArrayIndex.forPath(path);
        if (options?.name != null)
            index = index.withName(options.name);
        next._arrayIndexes.push(index);
        // <any> is deliberate: the path and element shape were already checked by this method's own
        // typed signature, and the stored containment is re-typed per call by the contains methods
        next._containmentsByPath.set(path.trim(), index.containmentForRawPath(path));
        return next;
    }
    /**
     * The expression that reads `path`, for composing a predicate by hand.
     *
     * The escape hatch that keeps {@link raw} useful: it hands back the same string the index was
     * created from, so a hand-written fragment is still index-usable.
     *
     * @param {TP} path - A scalar path this set indexes.
     * @returns {string} The parenthesized extraction expression, e.g. `(data->>'status')`.
     */
    expressionFor(path) {
        return this._expressionFor(path);
    }
    /**
     * Matches rows where `path` equals `value`.
     */
    eq(path, value) {
        return this._comparison(path, "=", value);
    }
    /**
     * Matches rows where `path` does not equal `value`.
     *
     * Rows whose `data` omits the key extract SQL NULL, and `NULL <> x` is NULL, so those rows do not
     * come back here either - pair with {@link isNull} if they should.
     */
    ne(path, value) {
        return this._comparison(path, "<>", value);
    }
    /**
     * Matches rows where `path` is greater than `value`.
     */
    gt(path, value) {
        return this._comparison(path, ">", value);
    }
    /**
     * Matches rows where `path` is greater than or equal to `value`.
     */
    gte(path, value) {
        return this._comparison(path, ">=", value);
    }
    /**
     * Matches rows where `path` is less than `value`.
     */
    lt(path, value) {
        return this._comparison(path, "<", value);
    }
    /**
     * Matches rows where `path` is less than or equal to `value`.
     */
    lte(path, value) {
        return this._comparison(path, "<=", value);
    }
    /**
     * Matches rows where `path` is any of `values`.
     *
     * @throws {ArgumentException} If values is empty - `in ()` is not valid SQL, and an empty list is a caller bug rather than a way to match nothing.
     */
    in(path, values) {
        given(values, "values").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        const expression = this._expressionFor(path);
        return SnapshotQuerySet._brand({
            sql: `(${expression} in (${values.map(() => "?").join(",")}))`,
            params: [...values],
            acrossOrganizations: this._isAcrossOrganizations(path)
        });
    }
    /**
     * Matches rows whose `data` omits `path`, or holds JSON null there - extraction yields SQL NULL
     * either way, and this API cannot tell the two apart.
     */
    isNull(path) {
        return SnapshotQuerySet._brand({
            sql: `(${this._expressionFor(path)} is null)`, params: [], acrossOrganizations: this._isAcrossOrganizations(path)
        });
    }
    /**
     * Matches rows that carry a value at `path`.
     */
    isNotNull(path) {
        return SnapshotQuerySet._brand({
            sql: `(${this._expressionFor(path)} is not null)`, params: [], acrossOrganizations: this._isAcrossOrganizations(path)
        });
    }
    /**
     * Matches rows whose array at `path` contains an element matching `match`.
     *
     * Every field named in one match must be carried by the **same** element. Two separate `contains`
     * fragments ANDed ask a weaker question - some element has one field, some possibly different
     * element has the other - and nothing in the SQL distinguishes them. Name them in one match.
     */
    contains(path, match) {
        return this._containmentFor(path).contains(match);
    }
    /**
     * Matches rows whose array at `path` contains an element for **every** match.
     */
    containsAll(path, matches) {
        return this._containmentFor(path).containsAll(matches);
    }
    /**
     * Matches rows whose array at `path` contains an element for **any** of the matches.
     */
    containsAny(path, matches) {
        return this._containmentFor(path).containsAny(matches);
    }
    /**
     * Every predicate must hold.
     *
     * Branded across organizations only when every predicate is - one arm that cannot use an index
     * without the organization filter makes the conjunction unable to as well.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `and` would emit `()`.
     */
    and(...predicates) {
        return SnapshotQuerySet._brand(SnapshotQuerySet._combine("and", predicates));
    }
    /**
     * At least one predicate must hold.
     *
     * Branded across organizations only when every predicate is, as {@link and} is: a BitmapOr needs
     * every arm served by an index.
     *
     * @throws {ArgumentException} If no predicate is given - an empty `or` would match nothing while reading as if it matched everything.
     */
    or(...predicates) {
        return SnapshotQuerySet._brand(SnapshotQuerySet._combine("or", predicates));
    }
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
    not(predicate) {
        given(predicate, "predicate").ensureHasValue().ensureIsObject();
        return SnapshotQuerySet._brand({
            sql: `(not ${predicate.sql})`, params: [...predicate.params], acrossOrganizations: predicate.acrossOrganizations
        });
    }
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
    raw(sql, ...params) {
        return this._raw(sql, params, false);
    }
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
    rawAcrossOrganizations(sql, ...params) {
        return this._raw(sql, params, true);
    }
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
    orderBy(path, direction) {
        given(direction, "direction").ensureIsString()
            .ensure(t => t === "asc" || t === "desc", "direction must be 'asc' or 'desc'");
        return SnapshotQuerySet._brandOrderBy({
            sql: `${this._expressionFor(path)}${direction != null ? ` ${direction}` : ""}`,
            acrossOrganizations: this._isAcrossOrganizations(path)
        });
    }
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
    verifyDocument(document) {
        // viewed as `object` for the ensurer: with TState unresolved, the mapped type gives the
        // defensive overloads nothing to discriminate on
        given(document, "document").ensureHasValue().ensureIsObject();
        const issues = new Array();
        for (const path of this.paths)
            this._verifyPath(document, path, false, issues);
        for (const path of this.arrayPaths)
            this._verifyPath(document, path, true, issues);
        return issues;
    }
    /**
     * Copy-on-write, so each `with...` call hands back a new set and the receiver stays usable. That
     * keeps the fluent chain from depending on evaluation order, and makes a set safe to share as a
     * base for two repositories.
     */
    _clone() {
        const next = new SnapshotQuerySet();
        next._indexes.push(...this._indexes);
        next._arrayIndexes.push(...this._arrayIndexes);
        this._expressionsByPath.forEach((v, k) => next._expressionsByPath.set(k, v));
        this._containmentsByPath.forEach((v, k) => next._containmentsByPath.set(k, v));
        next._acrossOrganizationsPaths.push(...this._acrossOrganizationsPaths);
        return next;
    }
    /**
     * `acrossOrganizations` is typed `boolean | string` rather than `boolean` because on a plain state
     * the option's type is the diagnostic string - which a TypeScript caller cannot pass, and which the
     * guard below rejects for a JavaScript one.
     */
    _withComposite(specs, options) {
        const next = this._clone();
        const normalized = specs.map(t => typeof t === "string"
            ? { path: t, type: undefined }
            : { path: t.path, type: t.type });
        for (const spec of normalized) {
            given(spec.path, "path").ensureHasValue().ensureIsString()
                .ensure(t => !next._expressionsByPath.has(t.trim()) && !next._containmentsByPath.has(t.trim()), `path '${spec.path}' is already declared by this set`);
        }
        // built through the raw door on purpose: the paths were checked against the state at the call
        // site by the type parameters, and at runtime SnapshotIndex validates their shape
        let index = SnapshotIndex.forRawPath(normalized[0].path, normalized[0].type);
        for (const spec of normalized.skip(1))
            index = index.andRawPath(spec.path, spec.type);
        if (options?.unique === true)
            index = index.asUnique();
        // `true` and only `true` flags: the type admits the literal, and a JavaScript caller passing
        // anything else is caught here rather than silently left unflagged
        given(options?.acrossOrganizations, "acrossOrganizations").ensureIsBoolean();
        // asserted back to the index: this method's own signature already gated the state, and inside
        // the class TState is generic, so the builder's conditional result type cannot resolve here
        if (options?.acrossOrganizations === true)
            index = index.acrossOrganizations();
        if (options?.name != null)
            index = index.withName(options.name);
        next._indexes.push(index);
        // read off the declaration that will emit the DDL, which is the invariant that keeps a
        // predicate from drifting away from the index it means
        for (const spec of normalized)
            next._expressionsByPath.set(spec.path.trim(), index.expressionForRawPath(spec.path));
        // the runtime half of the brand: the same paths the type parameter accumulates
        if (index.isAcrossOrganizations)
            next._acrossOrganizationsPaths.push(...normalized.map(t => t.path.trim()));
        return next;
    }
    /**
     * Walks one declared path through `document`, appending to `issues` where it stops resolving.
     *
     * The severity rules, stated once: a value of the *wrong kind* along the way is always fatal (a
     * scalar or array where an object must be, a non-array at an array leaf - no optional produces
     * those); an *absent* key is fatal only under a `$typename` parent, where `serialize()` is known
     * to have emitted every decorated key; and null anywhere is clean, because that is exactly what
     * an optional stores and extraction turns into SQL NULL.
     */
    _verifyPath(document, path, isArrayPath, issues) {
        const segments = path.split(".");
        let parent = document;
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const prefix = segments.slice(0, i + 1).join(".");
            const parentName = i === 0 ? "the top level" : `'${segments.slice(0, i).join(".")}'`;
            if (!(segment in parent)) {
                if (typeof parent["$typename"] === "string") {
                    issues.push({
                        path, failedAtSegment: prefix, kind: "unresolvable-key", severity: "fatal",
                        message: `path '${path}' does not resolve: key '${segment}' is absent from the serialized object at ${parentName}, which stores [${Object.keys(parent).join(", ")}]. serialize() emits every decorated getter - null-valued ones included - so this is a '@serialize("customKey")' rename or a raw-path typo, and the index extracts null from every row. Remove the rename, or declare the stored key through the raw door.`
                    });
                }
                else {
                    const emptyHint = Object.keys(parent).length === 0
                        ? " The parent object is empty - a Map or Set serializes to {}."
                        : "";
                    issues.push({
                        path, failedAtSegment: prefix, kind: "absent-key", severity: "advisory",
                        message: `path '${path}': key '${segment}' is absent at ${parentName} in this document. Legitimate for an optional key; if it is never optional, check for a '@serialize' rename or a raw-path typo.${emptyHint}`
                    });
                }
                return;
            }
            const value = parent[segment];
            // null is what an optional stores, and extraction turns it into SQL NULL - clean, stop
            if (value == null)
                return;
            const isLeaf = i === segments.length - 1;
            if (!isLeaf) {
                if (typeof value !== "object" || Array.isArray(value)) {
                    issues.push({
                        path, failedAtSegment: prefix, kind: "non-object-intermediate", severity: "fatal",
                        message: `path '${path}' does not resolve: segment '${prefix}' holds ${Array.isArray(value) ? "an array" : "a scalar"}, so nothing beneath it exists and the extraction is null for every row. The declaration does not match the stored shape.`
                    });
                    return;
                }
                parent = value;
                continue;
            }
            if (isArrayPath) {
                if (!Array.isArray(value)) {
                    issues.push({
                        path, failedAtSegment: prefix, kind: "non-array-leaf", severity: "fatal",
                        message: `array path '${path}' resolves to a non-array value, so no containment query would ever match. A Map or Set serializes to {} - store a plain array.`
                    });
                }
                return;
            }
            if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
                issues.push({
                    path, failedAtSegment: prefix, kind: "empty-object-leaf", severity: "advisory",
                    message: `path '${path}' resolves to an empty object. A Map or Set serializes to {} - the indexed expression extracts null for every such row.`
                });
            }
            return;
        }
    }
    _comparison(path, operator, value) {
        return SnapshotQuerySet._brand({
            sql: `(${this._expressionFor(path)} ${operator} ?)`, params: [value], acrossOrganizations: this._isAcrossOrganizations(path)
        });
    }
    /**
     * Whether a declared path was flagged - the runtime side of {@link SnapshotPathAcross}.
     */
    _isAcrossOrganizations(path) {
        return this._acrossOrganizationsPaths.includes(path.trim());
    }
    _raw(sql, params, acrossOrganizations) {
        // validated *before* the parentheses go on, which is the whole point of the shared function:
        // both of its regexes are anchored, so `(select 1 from t)` would sail past checks that
        // `select 1 from t` fails. This is the only door a *consumer* hands a fragment to, but not
        // the only place the ordering matters: `RepositoryQueryBuilder.idPredicate` splices a
        // predicate behind `id in (?) and (`, and validates before splicing for exactly this reason.
        const validated = validateBooleanFragment(sql, "sql");
        given(params, "params").ensureHasValue().ensureIsArray();
        return { sql: `(${validated})`, params: [...params], acrossOrganizations };
    }
    _expressionFor(path) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => this._expressionsByPath.has(t.trim()), `path '${path}' is not indexed by this set, which indexes: ${this.paths.join(", ")}`);
        return this._expressionsByPath.get(path.trim());
    }
    _containmentFor(path) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => this._containmentsByPath.has(t.trim()), `path '${path}' is not an array index on this set, which has: ${this.arrayPaths.join(", ")}`);
        return this._containmentsByPath.get(path.trim());
    }
}
//# sourceMappingURL=snapshot-query-set.js.map