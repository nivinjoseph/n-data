import { given } from "@nivinjoseph/n-defensive";
import { IsAnyOrUnknown, JsonScalar, PreviousDepth, SerializedShapeOf, SnapshotOpaqueContainer } from "./snapshot-index.js";
// type-only, and it has to stay that way: `snapshot-query-set` imports `SnapshotArrayIndex` as a
// value, so a value import back would close a runtime cycle. `import type` is erased, so there is
// no cycle to close - the two modules only meet in the type system
import type { SnapshotPredicate } from "./snapshot-query-set.js";

// JsonScalar moved to snapshot-index.ts (the leaf walk needs it too); re-exported here so this
// module's import surface is unchanged
export type { JsonScalar } from "./snapshot-index.js";

/**
 * The keys of an element type whose value is not a JSON scalar.
 */
type NonScalarKeys<TElement> = {
    [K in keyof TElement]-?: [NonNullable<TElement[K]>] extends [JsonScalar] ? never : K
}[keyof TElement];

/**
 * Whether every one of an element type's own members is a JSON scalar - that is, whether it is a
 * flat record.
 *
 * The caller passes the element through {@link SerializedShapeOf} first, so what is judged here is
 * the element's *stored* shape: for an n-domain 4.0.2 `DomainObject` element, that is the serialized
 * record (`DomainObjectSerialized`) - which, when flat, is legally containment-indexable, because
 * `_serializeForSnapshot` stores exactly those keys. The `$typename` every serialized element also
 * carries never blocks a match, since `@>` under `jsonb_path_ops` is subset matching - and it does
 * not count as a non-scalar (it is a `string`), so it never disqualifies a record either.
 *
 * The emptiness rule is a widening guard, not tidiness: a non-`DomainObject` `serialize()`-bearer
 * comes out of {@link SerializedShapeOf} as a keyless shape (fail-closed), and a keyless element
 * passing this check would make such arrays silently legal - while also being useless, since
 * {@link SnapshotElementFilter} over no keys is `never` and the runtime rejects an empty match
 * record anyway. `$`-prefixed keys do not count toward "has at least one matchable key": a
 * `DomainObject` with no data keys serializes to `{ $typename }` alone, and offering its array
 * would be unmatchable through the typed door ({@link SnapshotElementMatch} strips `$`-keys).
 *
 * A plain object literal is safe, because a nested plain object is copied into the snapshot through
 * `JSON.parse(JSON.stringify(...))`, so its TypeScript names *are* its stored keys.
 * {@link SnapshotArrayIndex.forRawPath} is the door for everything this rejects, where the caller
 * explicitly owns knowing the element's stored shape.
 */
type IsScalarRecord<TElement> =
    [TElement] extends [object]
        ? [Exclude<keyof TElement, `$${string}`>] extends [never] ? false
        : [NonScalarKeys<TElement>] extends [never] ? true : false
        : false;

/**
 * The raw array-path union, before {@link SnapshotArrayPath} removes what must never be indexed.
 *
 * Not exported, for the same reason `SnapshotLeafPath` is not: every *typed* signature takes
 * {@link SnapshotArrayPath}, so the rules live in one place, and the `Raw` overloads deliberately
 * take `string`, which is what makes them the escape hatch.
 */
type SnapshotContainerArrayPath<T, TDepth extends number = 5> = [TDepth] extends [never] ? never
    // an index signature absorbs the literal keys, so a level carrying one offers NO paths rather
    // than `string`-widened unchecked ones - the same head guard as `SnapshotLeafPath`
    : string extends keyof T ? never
    : {
        // `Function` is named explicitly for the same reason as in `SnapshotLeafPath`: it does not match
        // the call signature below, so without it a Function-typed key falls to the object branch and
        // fabricates a subtree of its methods. The $-guard comes first, as in `SnapshotLeafPath`: the
        // segment regex rejects `$`, so a $-key must not be offered only to throw at declaration time.
        // Then any/unknown, because `any` matches every later check - including the array branch,
        // where it would infer an `any` element.
        [K in keyof T & string]:
        K extends `$${string}` ? never
        : IsAnyOrUnknown<T[K]> extends true ? never
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        : NonNullable<T[K]> extends Function ? never
        : NonNullable<T[K]> extends SnapshotOpaqueContainer ? never
        // the array branch MUST precede the object branch, because a ReadonlyArray is an object.
        : NonNullable<T[K]> extends ReadonlyArray<infer TElement>
            // an `any`/`unknown` element is unverifiable, and a Map/Set element serializes to `{}` -
            // both fail closed before the shape checks
            ? (IsAnyOrUnknown<TElement> extends true ? never
                : [NonNullable<TElement>] extends [SnapshotOpaqueContainer] ? never
                // the tuple brackets make this check NON-distributive, and that is load-bearing. Naked,
                // `string | Customer extends JsonScalar` would distribute and the `string` arm alone
                // would yield K - so an array of "strings or customers" would be offered as a scalar
                // array. Bracketed, the union is tested as a whole and fails closed.
                : [NonNullable<TElement>] extends [JsonScalar] ? K
                : IsScalarRecord<SerializedShapeOf<NonNullable<TElement>>> extends true ? K
                : never)
            : NonNullable<T[K]> extends object
                ? `${K}.${SnapshotContainerArrayPath<SerializedShapeOf<NonNullable<T[K]>>, PreviousDepth[TDepth]>}`
                : never
    }[keyof T & string];

/**
 * A dot-delimited path to an **array of JSON scalars, or of flat scalar records**, inside `T`, for
 * building a GIN containment index over it and the predicates that read it back.
 *
 * The exact mirror of `SnapshotLeafPath`: that one maps an array-valued key to `never`, this one maps
 * a leaf to `never`. The two unions are therefore **disjoint**, which is the property that makes
 * `SnapshotIndex.forPath("members")` and `SnapshotArrayIndex.forPath("status")` both compile errors,
 * and that makes a key belong to exactly one kind of index.
 *
 * Like `SnapshotLeafPath`, the walk follows the **stored** shape: an n-domain 4.0.2 `DomainObject`
 * element or nested member is judged by - and recursed into - its serialized record
 * ({@link SerializedShapeOf}). So an array of `DomainObject`s whose serialized shape is a flat
 * scalar record *is* offered, and a containment document built from those keys matches what is
 * actually stored - the `$typename` each stored element also carries never blocks `@>`, which is
 * subset matching. The residual hazard is the same as for scalar paths: an explicit
 * `@serialize("customKey")` rename is invisible to the type, so a match document built from the
 * TypeScript name would silently match nothing.
 *
 * Not offered, all of which fail closed to {@link SnapshotArrayIndex.forRawPath}:
 *
 * - **Arrays of `serialize()`-bearers that are not `DomainObject`s.** A bare, untyped, or merely
 *   structural `serialize()` gives the compiler nothing it can trust a containment document
 *   against, so such arrays offer no path (see {@link IsScalarRecord}).
 * - **Arrays whose elements nest.** An element whose *stored* shape carries an object- or
 *   array-valued member is not a flat record, and containment against it would be a far larger
 *   semantic surface than "does some element look like this".
 * - **Arrays of arrays.** The element of the outer array is itself an array, so containment would
 *   test for a whole inner array as one element - legal, but almost never what is meant.
 * - **Mixed arrays containing a non-scalar.** This is the case the non-distributive brackets above
 *   exist for; without them it would silently compile.
 *
 * `organizationId` is excluded for the same reason it is excluded from `SnapshotPath`: on an
 * org-scoped snapshot table it is a real column, and the copy inside `data` is not what any index
 * covers. The same fail-closed rules apply verbatim - a level with a string index signature, an
 * `any`/`unknown` member or element, and `Map`/`Set` members or elements all offer no paths, and a
 * union where only some members serialize offers none either (see `SerializedShapeOf`). Depth is
 * bounded at six segments, past which `forRawPath` is the way through.
 */
export type SnapshotArrayPath<T> = Exclude<SnapshotContainerArrayPath<T>, "organizationId">;

/**
 * Resolves a dotted array path within `T` to the **stored** type of that array's elements - the
 * serialized shape for an n-domain `DomainObject` element ({@link SerializedShapeOf}), the
 * element itself otherwise. Resolving to the class instead would offer `serialize` and derived
 * getters as match keys, every one of which would silently match nothing.
 *
 * This is what lets {@link SnapshotArrayIndex.containmentForPath} type its match argument against the
 * *element* shape rather than against `any`, with no explicit type argument at the call site: the
 * path is inferred from the string literal, and the element type follows from it.
 *
 * Exported from the module so `SnapshotQuerySet` can type its containment methods the same way, but
 * deliberately absent from the barrel: it is how those signatures are built, not a type a consumer
 * names.
 */
export type SnapshotArrayElement<T, TPath extends string> =
    TPath extends `${infer THead}.${infer TRest}`
        ? THead extends keyof T ? SnapshotArrayElement<SerializedShapeOf<NonNullable<T[THead]>>, TRest> : never
        : TPath extends keyof T
            ? NonNullable<T[TPath]> extends ReadonlyArray<infer TElement> ? SerializedShapeOf<NonNullable<TElement>> : never
            : never;

/**
 * A partial of `TElement` carrying **at least one** key.
 *
 * The union-of-`Required<Pick<>>` construction is what rejects `{}`. That matters beyond tidiness:
 * `@> '[{}]'` is true for every array of objects, so an empty match would silently return the whole
 * table. It is rejected at runtime too, since `forRawPath` reaches this without the type.
 */
type SnapshotElementFilter<TElement> = {
    [K in keyof TElement]-?: Required<Pick<TElement, K>> & Partial<TElement>
}[keyof TElement];

/**
 * What one element must look like to match: the scalar itself for a scalar array, or a non-empty
 * partial of the record for an array of records.
 *
 * jsonb object containment is **partial and recursive**, so `{ userId, isDeactivated }` matches an
 * element that also carries `role`. Crucially, it requires *one* element to carry all the named
 * fields - which is why a multi-field match is one document rather than several ANDed predicates.
 *
 * `$`-prefixed keys are stripped: no typed door anywhere names a `$`-prefixed storage key, and a
 * polymorphic `$typename` match belongs to {@link SnapshotArrayIndex.containmentForRawPath}, where
 * the caller owns the element shape. (The rejection of a mixed literal like
 * `{ tier: "x", $typename: "y" }` rides on excess-property checking, so it catches fresh literals -
 * a widened variable slips through, the same class of gap as any excess key.)
 */
export type SnapshotElementMatch<TElement> =
    [NonNullable<TElement>] extends [JsonScalar]
        ? NonNullable<TElement>
        : SnapshotElementFilter<Omit<NonNullable<TElement>, `$${string}`>>;

/**
 * A predicate fragment and the values that bind to its `?` placeholders, in order.
 *
 * A {@link SnapshotPredicate} whose parameters are known to be jsonb documents - which is the whole
 * of the difference, and why this is a subtype rather than an alias. Being narrower, it goes
 * anywhere a `SnapshotPredicate` goes: straight to a repository's `query`, or into
 * `SnapshotQuerySet.and`/`or` alongside the scalar predicates, with no adaptation and nothing to
 * splice by hand.
 *
 * The two halves are produced by one call and never separately, because for a variadic predicate the
 * placeholder count is not fixed - {@link SnapshotArrayContainment.containsAny} over three matches
 * emits three, and pairing them up afterwards is not something a caller should be doing.
 */
export interface SnapshotArrayPredicate extends SnapshotPredicate
{
    /**
     * A fully parenthesized boolean fragment, e.g. `((data->'members') @> cast(? as jsonb))`.
     */
    readonly sql: string;

    /**
     * The jsonb documents to bind, already serialized, positionally matching {@link sql}'s
     * placeholders.
     *
     * Narrower than `SnapshotPredicate.params`, which is `ReadonlyArray<any>`: every value here has
     * already been through `JSON.stringify`. That narrowing is why the two types stayed separate.
     */
    readonly params: ReadonlyArray<string>;
}

/**
 * The containment predicate builders for the path an index covers, resolved once.
 *
 * Obtained from {@link SnapshotArrayIndex.containmentForPath}, which is where a path this index does
 * not cover throws - so read it into a `static readonly` field and that surfaces at module load
 * rather than on the first call to an untested query method, exactly as
 * `SnapshotIndex.expressionForPath` is meant to be.
 *
 * Every method emits `@>` and only `@>`. That is not a simplification:
 * {@link SnapshotArrayIndex.opclass} supports no other search operator, and `=` against the indexed
 * expression asks a different question - whether the array is *exactly* that array - and
 * sequential-scans while doing it.
 */
export interface SnapshotArrayContainment<TElement>
{
    /**
     * Matches rows whose array contains an element matching `match`.
     *
     * For an array of records, every field named in `match` must be carried by the **same** element.
     * That is the whole reason this returns a predicate rather than an expression: two separate
     * containment fragments ANDed together ask a weaker question - some element has one field, some
     * possibly *different* element has the other - and there is no way to tell the two apart by
     * reading the SQL.
     *
     * @param {SnapshotElementMatch<TElement>} match - The scalar, or the non-empty partial record, an element must match.
     * @returns {SnapshotArrayPredicate} The fragment and its bound parameter.
     * @throws {ArgumentNullException} If match is null or undefined.
     * @throws {ArgumentException} If match is not a JSON scalar or a non-empty record of JSON scalars.
     */
    contains(match: SnapshotElementMatch<TElement>): SnapshotArrayPredicate;

    /**
     * Matches rows whose array contains an element for **every** match.
     *
     * One `@>` against a multi-element document, which is what jsonb containment already means - so
     * this is the same SQL as {@link contains} with a longer bound value, and costs one index scan
     * rather than N. Different matches may be satisfied by different elements; to require several
     * fields of *one* element, name them all in a single match.
     *
     * @param {ReadonlyArray<SnapshotElementMatch<TElement>>} matches - The matches, each of which some element must satisfy.
     * @returns {SnapshotArrayPredicate} The fragment and its bound parameter.
     * @throws {ArgumentNullException} If matches is null or undefined, or an element of it is.
     * @throws {ArgumentException} If matches is not an array, is empty, or an element is not a JSON scalar or a non-empty record of JSON scalars.
     */
    containsAll(matches: ReadonlyArray<SnapshotElementMatch<TElement>>): SnapshotArrayPredicate;

    /**
     * Matches rows whose array contains an element for **any** of the matches.
     *
     * `@>` cannot express a disjunction, so this emits one `@>` per match OR'd together, which the
     * planner turns into a BitmapOr over the same index. It is deliberately not `?|`: that operator
     * is unsupported by {@link SnapshotArrayIndex.opclass}, tests string elements only, and its `?`
     * is knex's binding placeholder.
     *
     * @param {ReadonlyArray<SnapshotElementMatch<TElement>>} matches - The matches, any one of which some element must satisfy.
     * @returns {SnapshotArrayPredicate} The fragment and its bound parameters, one per match.
     * @throws {ArgumentNullException} If matches is null or undefined, or an element of it is.
     * @throws {ArgumentException} If matches is not an array, is empty, or an element is not a JSON scalar or a non-empty record of JSON scalars.
     */
    containsAny(matches: ReadonlyArray<SnapshotElementMatch<TElement>>): SnapshotArrayPredicate;
}

/**
 * Describes one GIN containment index over an array inside the `data` column of a snapshot table -
 * and the source of the predicates that read it back.
 *
 * The array counterpart of `SnapshotIndex`. Where that one builds a btree over extracted *text* and
 * answers `=`, ranges and `order by`, this builds a GIN index over an extracted jsonb *array* and
 * answers containment - "does some element of this array look like this" - and nothing else.
 *
 * Four things are absent by *shape* rather than rejected by a rule, which is what makes this a
 * separate class instead of a mode on `SnapshotIndex`:
 *
 * - **No `asUnique`.** Postgres rejects `create unique index ... using gin` outright.
 * - **No `andPath`.** A multicolumn GIN needs the `btree_gin` extension and has no leading-prefix
 *   semantics; one path per index removes an entire class of misunderstanding. Two membership
 *   predicates ANDed are two GIN scans BitmapAnd-ed, which is what you want anyway.
 * - **No `JsonValueType`.** No cast applies; the extraction stays jsonb.
 * - **No expression accessor for query use.** For btree, matching the expression makes the index
 *   considerable and the operator is a separate axis. For GIN the operator is *part of* what makes
 *   the index usable, so handing back `(data->'members')` would be handing back a loaded gun. This
 *   returns whole predicates through {@link containmentForPath}.
 *
 * Everything else carries over: the path is checked against `T`, the aggregate's state shape; it is
 * validated and its expression built as the index is declared, so a malformed path throws where the
 * index is written; and the same instance hands the expression back inside a predicate, so the
 * written index and the query cannot diverge.
 *
 * **A repository normally declares these through `SnapshotQuerySet.withArrayPath`**, whose
 * `contains` / `containsAll` / `containsAny` delegate straight to the containment built here - so the
 * predicates are the same, and the paths get checked against what the repository actually indexed.
 * Reach for this class directly for an array key a typed path cannot name, through
 * {@link forRawPath}.
 *
 * @example
 * ```typescript
 * interface Member { userId: string; role: string; isDeactivated: boolean; }
 * interface TeamState extends AggregateState { members: Array<Member>; }
 *
 * export class TeamRepository extends SnapshotBaseRepository<Team, TeamState, TeamEvent>
 * {
 *     public static readonly indexes = SnapshotQuerySet.for<TeamState>().withArrayPath("members");
 *
 *     protected override get querySet(): typeof TeamRepository.indexes { return TeamRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: TeamEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getActiveTeamsForUser(userId: string): Promise<Array<Team>>
 *     {
 *         // ONE containment document: both fields must hold on the SAME member element
 *         return this.query(this.querySet.contains("members", { userId, isDeactivated: false }));
 *     }
 * }
 *
 * // in the migration
 * await tableCreator.createSnapshotTableForAggregate(Team, TeamRepository.indexes);
 * ```
 *
 * @class SnapshotArrayIndex
 */
export class SnapshotArrayIndex<T>
{
    /**
     * A name suffix that composes into a valid unquoted Postgres identifier.
     */
    private static readonly _nameRegex = /^[a-z_][a-z0-9_]*$/;

    /**
     * A bare JSON key. Constraining segments to this is what keeps the '...' string literal and the
     * '{...}' path array in a json path expression from being broken out of.
     */
    private static readonly _jsonPathSegmentRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;

    /**
     * The GIN operator class every index this class creates is built with.
     *
     * `jsonb_path_ops` stores one hash per full root-to-leaf path rather than separate entries for
     * keys and values, so it is smaller and far more selective for `@>` - the one operator this API
     * emits. It also supports *only* `@>` (plus the jsonpath operators), which is the second reason
     * it was chosen: it makes `?`, `?|` and `?&` unusable at the database as well as unreachable
     * through this API, and every one of those is knex's positional binding character.
     */
    public static readonly opclass = "jsonb_path_ops";

    private readonly _path: string;
    private readonly _expression: string;
    private _name: string | null = null;

    /**
     * The single path this index covers, trimmed.
     */
    public get path(): string { return this._path; }

    /**
     * {@link path} as a one-element list, so this reads like `SnapshotIndex` where `DbTableCreator`
     * consumes both.
     */
    public get paths(): ReadonlyArray<string> { return [this._path]; }

    /**
     * The jsonb extraction expression, as a one-element list.
     *
     * Public because `DbTableCreator` reads it across a module boundary. There is deliberately no
     * accessor that returns it for query use: an expression alone is not a usable predicate here,
     * and `=` against it both misses the index and asks a different question. Use
     * {@link containmentForPath}.
     */
    public get expressions(): ReadonlyArray<string> { return [this._expression]; }

    /**
     * The index name suffix: the name given to {@link withName}, or the path lowercased with its dots
     * turned into underscores. `DbTableCreator` appends `_gin` to it, so a btree and a GIN over the
     * same path cannot derive the same name - which `create index if not exists`, matching on name
     * alone, would silently resolve by keeping whichever was created first.
     */
    public get nameSuffix(): string { return this._name ?? this._path.toLowerCase().replaceAll(".", "_"); }

    /**
     * Use {@link forPath} or {@link forRawPath} - an index always has a path.
     */
    private constructor(path: string)
    {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
                t => t.trim().split(".").every(u => SnapshotArrayIndex._jsonPathSegmentRegex.test(u)),
                `path '${path}' must be one or more '.' delimited bare JSON keys`
            );

        this._path = path.trim();

        // built eagerly, so a malformed path throws at the declaration site; and built once, so the
        // expression the index is created from is the same one every predicate is built from
        this._expression = SnapshotArrayIndex._createExpression(this._path);
    }

    /**
     * Starts an index over the given array within `data`, dot delimited to reach a nested one.
     *
     * @param {SnapshotArrayPath<T>} path - The array to index, checked against the state shape.
     * @returns {SnapshotArrayIndex<T>} A new index over that path.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not one or more '.' delimited bare JSON keys.
     */
    public static forPath<T>(path: SnapshotArrayPath<T>): SnapshotArrayIndex<T>
    {
        return SnapshotArrayIndex.forRawPath<T>(path);
    }

    /**
     * Like {@link forPath} but takes any string, for an array outside what the state shape offers -
     * an array of *untyped* `Serializable`, an array whose stored elements nest, an element with
     * `@serialize("customKey")` renames, or a computed key. Prefer {@link forPath} so typos are
     * caught at compile time, and note that the caller then owns knowing the elements' *stored*
     * shape, which for a Serializable is what `serialize()` emits rather than the TypeScript names.
     *
     * @param {string} path - The array to index.
     * @returns {SnapshotArrayIndex<T>} A new index over that path.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not one or more '.' delimited bare JSON keys.
     */
    public static forRawPath<T>(path: string): SnapshotArrayIndex<T>
    {
        return new SnapshotArrayIndex<T>(path);
    }

    /**
     * Builds the SQL expression that extracts an array out of a snapshot table's `data` column **as
     * jsonb**.
     *
     * `->` and `#>`, not `->>` and `#>>`. That is the whole difference from `SnapshotIndex`'s
     * builder, and it is load-bearing: `->>` yields text, and `@>` is a jsonb operator, so an index
     * built over the text form would answer no containment query at all.
     *
     * Private for the same reason as there: an expression is only useful if some index was actually
     * built from it, so the only way one reaches a query is through a declaration that also emits the
     * DDL.
     *
     * @param {string} path - The array within `data`; dot delimited to reach a nested one.
     * @returns {string} A parenthesized expression, e.g. `(data->'members')` or `(data#>'{"team","members"}')`.
     */
    private static _createExpression(path: string): string
    {
        const segments = path.split(".");

        // The path array's elements are double quoted because an *unquoted* element matching NULL
        // (any case) parses as a null element, not the string - and #> returns null when any element
        // is null, which would make the index null for every row.
        return segments.length === 1
            ? `(data->'${segments[0]}')`
            : `(data#>'{"${segments.join("\",\"")}"}')`;
    }

    /**
     * Validates the matches a containment predicate will bind, and returns them as one jsonb
     * document each.
     *
     * Every rule here rejects a *silent wrong answer* rather than a malformed query:
     *
     * - An empty list throws. `@> '[]'` is true for every array, so `containsAll([])` would return
     *   the whole table and `containsAny([])` would emit no predicate at all.
     * - An empty record throws, for the same reason - `@> '[{}]'` matches every array of objects.
     * - null, undefined, NaN and Infinity throw. `JSON.stringify` renders all four as `null`, so an
     *   arithmetic bug or a forgotten lookup would become a null-element match instead of an error.
     * - A nested value inside a record throws. Containment against it is legal SQL but a far larger
     *   semantic surface than this API's contract, and it is not what the typed door offers.
     *
     * @param {ReadonlyArray<any>} matches - The matches to validate.
     * @param {string} argName - The argument name to report in errors.
     * @throws {ArgumentNullException} If matches is null or undefined, or an element of it is.
     * @throws {ArgumentException} If matches is not an array, is empty, or an element is not a JSON scalar or a non-empty record of JSON scalars.
     */
    private static _validateMatches(matches: ReadonlyArray<any>, argName: string): void
    {
        given(matches, argName).ensureHasValue().ensureIsArray().ensureIsNotEmpty()
            .ensure(
                t => t.every(u => SnapshotArrayIndex._isValidMatch(u)),
                `${argName} must be JSON scalars, or objects of one or more JSON scalar values - jsonb has nothing else this index can match`
            );
    }

    /**
     * Whether one match is a JSON scalar or a non-empty flat record of them.
     *
     * @param {any} match - The candidate match.
     * @returns {boolean} True if it is bindable.
     */
    private static _isValidMatch(match: any): boolean
    {
        if (SnapshotArrayIndex._isValidScalar(match))
            return true;

        // an array is excluded along with everything else non-object: as a match it would mean "some
        // element IS this array", which is not what any typed path offers
        if (typeof match !== "object" || match == null || Array.isArray(match))
            return false;

        const values = Object.values(match);

        return values.length > 0 && values.every(t => SnapshotArrayIndex._isValidScalar(t));
    }

    /**
     * Whether a value is a JSON scalar that survives a round trip through `JSON.stringify` intact.
     *
     * @param {any} value - The candidate value.
     * @returns {boolean} True if it is bindable.
     */
    private static _isValidScalar(value: any): boolean
    {
        return typeof value === "string"
            || typeof value === "boolean"
            || (typeof value === "number" && Number.isFinite(value));
    }

    /**
     * Overrides the derived name suffix, giving `idx_<table>_<name>_gin`.
     *
     * Supply it when the derivation from the path would exceed the Postgres identifier limit of 63
     * characters.
     *
     * @param {string} name - The suffix to use.
     * @returns {this} A new index under that name - the receiver is unchanged.
     * @throws {ArgumentNullException} If name is null or undefined.
     * @throws {ArgumentException} If name is not a string, is empty or whitespace, is not a valid identifier fragment, or is already set.
     */
    public withName(name: string): this
    {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(
                t => SnapshotArrayIndex._nameRegex.test(t.trim()),
                `name '${name}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`
            )
            // named for the argument rather than `this`, so this throws ArgumentException like the
            // rest of the API instead of InvalidOperationException
            .ensure(() => this._name == null, "name is already set");

        // copy-on-write, matching `SnapshotIndex` and `SnapshotQuerySet`. The `this` return type is
        // kept rather than widened: the constructor is private, so there is no subclass for the two
        // to differ on, and keeping it means this signature did not change shape
        const next = new SnapshotArrayIndex<T>(this._path);
        next._name = name.trim();

        return <this>next;
    }

    /**
     * The containment predicate builders for `path`, for building a query predicate.
     *
     * The fragments are built from the same expression this index's DDL was emitted from, which is
     * the point: Postgres uses an expression index only when the query expression matches the
     * indexed one textually, so taking it from the declaration is what makes a predicate
     * index-usable. Never hand-write it.
     *
     * The path must be the one **this** index covers - a path valid on the state but belonging to a
     * different index throws, so read the result into a `static` field where that surfaces at module
     * load. `TPath` is inferred from the string literal, so the element type - and therefore the
     * field names and value types `contains` accepts - follows from the path with no explicit type
     * argument at the call site.
     *
     * Matching the expression is necessary, not sufficient: on an org-scoped table this index does
     * *not* lead with `organization_id` (a multicolumn GIN would need the `btree_gin` extension), so
     * the predicate must still constrain that column - for tenant isolation, which is a correctness
     * rule independent of the plan.
     *
     * @param {TPath} path - The path this index covers, checked against the state shape.
     * @returns {SnapshotArrayContainment<SnapshotArrayElement<T, TPath>>} The predicate builders, typed to the array's element shape.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not the path this index covers.
     */
    public containmentForPath<TPath extends SnapshotArrayPath<T>>(path: TPath): SnapshotArrayContainment<SnapshotArrayElement<T, TPath>>
    {
        return this.containmentForRawPath<SnapshotArrayElement<T, TPath>>(path);
    }

    /**
     * Like {@link containmentForPath} but takes any string, for a path declared with
     * {@link forRawPath}. Prefer {@link containmentForPath}.
     *
     * `TElement` has no silent default: it defaults to `never`, under which no match document can
     * be built, so the raw door forces a choice - supply the elements' stored shape to get
     * checking, or `<any>` to explicitly own the lack of it.
     *
     * A raw match document may also name `$typename` - only path segments go through the segment
     * regex, never match keys - which is the escape hatch for filtering a polymorphic element by its
     * stored type, something the typed door deliberately does not offer.
     *
     * @param {string} path - The path this index covers.
     * @returns {SnapshotArrayContainment<TElement>} The predicate builders.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not the path this index covers.
     */
    public containmentForRawPath<TElement = never>(path: string): SnapshotArrayContainment<TElement>
    {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
                // trimmed on both sides: the constructor stores the trimmed path, so a padded one has
                // to resolve to the same index
                t => t.trim() === this._path,
                `path '${path}' is not indexed by this index, which covers: ${this._path}`
            );

        const expression = this._expression;

        // `cast(? as jsonb)` rather than `?::jsonb`: text @> jsonb does not resolve, so the cast is
        // mandatory, and this form puts no `?` adjacent to a `:`, which keeps it safe under knex's
        // named-binding path as well as the positional one
        const term = `${expression} @> cast(? as jsonb)`;

        const toDocument = (matches: ReadonlyArray<any>): string => JSON.stringify(matches);

        return {
            contains(match: SnapshotElementMatch<TElement>): SnapshotArrayPredicate
            {
                SnapshotArrayIndex._validateMatches([match], "match");

                return { sql: `(${term})`, params: [toDocument([match])] };
            },
            containsAll(matches: ReadonlyArray<SnapshotElementMatch<TElement>>): SnapshotArrayPredicate
            {
                SnapshotArrayIndex._validateMatches(matches, "matches");

                // one document, one index scan - jsonb containment already means "every one of
                // these", so N matches do not need N predicates
                return { sql: `(${term})`, params: [toDocument([...matches])] };
            },
            containsAny(matches: ReadonlyArray<SnapshotElementMatch<TElement>>): SnapshotArrayPredicate
            {
                SnapshotArrayIndex._validateMatches(matches, "matches");

                // the outer parens are not cosmetic: spliced beside another term, `A or B` bare would
                // bind `or` at the top and match rows neither term was meant to reach. The repository's
                // query builder parenthesizes the whole predicate for the same reason; this keeps the
                // fragment safe to compose before it gets there.
                return {
                    sql: `(${matches.map(() => term).join(" or ")})`,
                    params: matches.map(t => toDocument([t]))
                };
            }
        };
    }
}
