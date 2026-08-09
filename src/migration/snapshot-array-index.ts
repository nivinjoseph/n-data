import { given } from "@nivinjoseph/n-defensive";
import { PreviousDepth } from "./snapshot-index.js";

/**
 * The scalars jsonb carries, and so the only values this API can match.
 *
 * jsonb also has null, which is deliberately absent: `undefined` stringifies to `null` too, so
 * accepting one would make a forgotten lookup indistinguishable from a deliberate null-element
 * match. A null inside an indexed array is a modelling problem, not a query.
 */
export type JsonScalar = string | number | boolean;

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
 * Anything else is `false`, and the case that matters most is a `Serializable` element: it carries a
 * `serialize()` method, which is a non-scalar member, so it is excluded. That exclusion is the whole
 * point. `_serializeForSnapshot` routes a Serializable through `serialize()`, which emits
 * `field.key ?? field.name` over `@serialize` decorated getters *only* - so an undecorated property
 * is absent from the stored element, a renamed one lands under a different key, and a `$typename`
 * appears that nobody wrote. A containment document built from the TypeScript names would then match
 * nothing, silently, on a fast-looking plan.
 *
 * A plain object literal is safe, because a nested plain object is copied into the snapshot through
 * `JSON.parse(JSON.stringify(...))`, so its TypeScript names *are* its stored keys.
 * {@link SnapshotArrayIndex.forRawPath} is the door for everything this rejects, where the caller
 * explicitly owns knowing the element's stored shape.
 */
type IsScalarRecord<TElement> =
    [TElement] extends [object] ? ([NonScalarKeys<TElement>] extends [never] ? true : false) : false;

/**
 * The raw array-path union, before {@link SnapshotArrayPath} removes what must never be indexed.
 *
 * Not exported, for the same reason `SnapshotLeafPath` is not: every *typed* signature takes
 * {@link SnapshotArrayPath}, so the rules live in one place, and the `Raw` overloads deliberately
 * take `string`, which is what makes them the escape hatch.
 */
type SnapshotContainerArrayPath<T, TDepth extends number = 5> = [TDepth] extends [never] ? never : {
    // `Function` is named explicitly for the same reason as in `SnapshotLeafPath`: it does not match
    // the call signature below, so without it a Function-typed key falls to the object branch and
    // fabricates a subtree of its methods.
    [K in keyof T & string]:
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    NonNullable<T[K]> extends Function ? never
        // the array branch MUST precede the object branch, because a ReadonlyArray is an object.
        : NonNullable<T[K]> extends ReadonlyArray<infer TElement>
            // the tuple brackets make this check NON-distributive, and that is load-bearing. Naked,
            // `string | Customer extends JsonScalar` would distribute and the `string` arm alone
            // would yield K - so an array of "strings or customers" would be offered as a scalar
            // array. Bracketed, the union is tested as a whole and fails closed.
            ? ([NonNullable<TElement>] extends [JsonScalar] ? K
                : IsScalarRecord<NonNullable<TElement>> extends true ? K
                    : never)
            : NonNullable<T[K]> extends object
                ? `${K}.${SnapshotContainerArrayPath<NonNullable<T[K]>, PreviousDepth[TDepth]>}`
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
 * Not offered, all of which fail closed to {@link SnapshotArrayIndex.forRawPath}:
 *
 * - **Arrays of `Serializable`.** See {@link IsScalarRecord} - the stored keys are not the TypeScript
 *   names, so a containment document built in JavaScript would match nothing.
 * - **Arrays whose elements nest.** An element carrying an object- or array-valued member is not a
 *   flat record, and containment against it would be a far larger semantic surface than "does some
 *   element look like this".
 * - **Arrays of arrays.** The element of the outer array is itself an array, so containment would
 *   test for a whole inner array as one element - legal, but almost never what is meant.
 * - **Mixed arrays containing a non-scalar.** This is the case the non-distributive brackets above
 *   exist for; without them it would silently compile.
 *
 * `organizationId` is excluded for the same reason it is excluded from `SnapshotPath`: on an
 * org-scoped snapshot table it is a real column, and the copy inside `data` is not what any index
 * covers. The same known gaps apply verbatim - `Map`- and `Set`-valued keys are recursed into
 * although they serialize to `{}`, a union-typed object member loses its nested paths, and an index
 * signature or an `any`-typed member widens the result to `string`, disabling the check. Depth is
 * bounded at six segments, past which `forRawPath` is the way through.
 */
export type SnapshotArrayPath<T> = Exclude<SnapshotContainerArrayPath<T>, "organizationId">;

/**
 * Resolves a dotted array path within `T` to the type of that array's elements.
 *
 * This is what lets {@link SnapshotArrayIndex.containmentForPath} type its match argument against the
 * *element* shape rather than against `any`, with no explicit type argument at the call site: the
 * path is inferred from the string literal, and the element type follows from it.
 */
type SnapshotArrayElement<T, TPath extends string> =
    TPath extends `${infer THead}.${infer TRest}`
        ? THead extends keyof T ? SnapshotArrayElement<NonNullable<T[THead]>, TRest> : never
        : TPath extends keyof T
            ? NonNullable<T[TPath]> extends ReadonlyArray<infer TElement> ? NonNullable<TElement> : never
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
 */
export type SnapshotElementMatch<TElement> =
    [NonNullable<TElement>] extends [JsonScalar]
        ? NonNullable<TElement>
        : SnapshotElementFilter<NonNullable<TElement>>;

/**
 * A predicate fragment and the values that bind to its `?` placeholders, in order.
 *
 * The two are produced by one call and never separately, because for a variadic predicate the
 * placeholder count is not fixed - {@link SnapshotArrayContainment.containsAny} over three matches
 * emits three. Splice `sql` into the where clause and spread `params` into the call in the **same
 * order the fragment appears**: `where organization_id = ? and ${p.sql}` takes
 * `[orgId, ...p.params]`, and the reverse order takes `[...p.params, orgId]`. Positional binding is
 * unforgiving.
 */
export interface SnapshotArrayPredicate
{
    /**
     * A fully parenthesized boolean fragment, e.g. `((data->'members') @> cast(? as jsonb))`.
     */
    readonly sql: string;

    /**
     * The jsonb documents to bind, already serialized, positionally matching {@link sql}'s
     * placeholders.
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
 * @example
 * ```typescript
 * interface Member { userId: string; role: string; isDeactivated: boolean; }
 * interface TeamState extends AggregateState { members: Array<Member>; }
 *
 * export class TeamRepository extends SnapshotBaseRepository<Team, TeamState, TeamEvent>
 * {
 *     public static readonly membersIndex = SnapshotArrayIndex.forPath<TeamState>("members");
 *
 *     public static readonly snapshotArrayIndexes: ReadonlyArray<SnapshotArrayIndex<TeamState>> =
 *         [TeamRepository.membersIndex];
 *
 *     // resolved at module load, so a path this index does not cover throws at startup rather than
 *     // on the first call to an untested query method
 *     private static readonly _members = TeamRepository.membersIndex.containmentForPath("members");
 *
 *     public getActiveTeamsForUser(userId: string): Promise<Array<Team>>
 *     {
 *         // ONE containment document: both fields must hold on the SAME member element
 *         const predicate = TeamRepository._members.contains({ userId, isDeactivated: false });
 *
 *         return this.query(`select data from ${this.table} where ${predicate.sql};`, ...predicate.params);
 *     }
 * }
 *
 * // in the migration
 * await tableCreator.createSnapshotTableForAggregate(Team, {
 *     arrayIndexes: TeamRepository.snapshotArrayIndexes
 * });
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
     * an array of `Serializable`, an array whose elements nest, or a computed key. Prefer
     * {@link forPath} so typos are caught at compile time, and note that the caller then owns knowing
     * the elements' *stored* shape, which for a Serializable is what `serialize()` emits rather than
     * the TypeScript names.
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
     * @returns {this} This index, for chaining.
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

        this._name = name.trim();

        return this;
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
     * `TElement` defaults to `any`, so matches are unchecked - which is the raw door's contract: the
     * caller owns knowing the elements' stored shape. Supply it explicitly to get the checking back.
     *
     * @param {string} path - The path this index covers.
     * @returns {SnapshotArrayContainment<TElement>} The predicate builders.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not the path this index covers.
     */
    public containmentForRawPath<TElement = any>(path: string): SnapshotArrayContainment<TElement>
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

                // the outer parens are not cosmetic: `where organization_id = ? and A or B` binds
                // `or` at the top and returns other organizations' rows
                return {
                    sql: `(${matches.map(() => term).join(" or ")})`,
                    params: matches.map(t => toDocument([t]))
                };
            }
        };
    }
}
