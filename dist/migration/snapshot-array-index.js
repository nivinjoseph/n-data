import { given } from "@nivinjoseph/n-defensive";
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
export class SnapshotArrayIndex {
    /**
     * A name suffix that composes into a valid unquoted Postgres identifier.
     */
    static _nameRegex = /^[a-z_][a-z0-9_]*$/;
    /**
     * A bare JSON key. Constraining segments to this is what keeps the '...' string literal and the
     * '{...}' path array in a json path expression from being broken out of.
     */
    static _jsonPathSegmentRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
    /**
     * The GIN operator class every index this class creates is built with.
     *
     * `jsonb_path_ops` stores one hash per full root-to-leaf path rather than separate entries for
     * keys and values, so it is smaller and far more selective for `@>` - the one operator this API
     * emits. It also supports *only* `@>` (plus the jsonpath operators), which is the second reason
     * it was chosen: it makes `?`, `?|` and `?&` unusable at the database as well as unreachable
     * through this API, and every one of those is knex's positional binding character.
     */
    static opclass = "jsonb_path_ops";
    _path;
    _expression;
    _name = null;
    /**
     * The single path this index covers, trimmed.
     */
    get path() { return this._path; }
    /**
     * {@link path} as a one-element list, so this reads like `SnapshotIndex` where `DbTableCreator`
     * consumes both.
     */
    get paths() { return [this._path]; }
    /**
     * The jsonb extraction expression, as a one-element list.
     *
     * Public because `DbTableCreator` reads it across a module boundary. There is deliberately no
     * accessor that returns it for query use: an expression alone is not a usable predicate here,
     * and `=` against it both misses the index and asks a different question. Use
     * {@link containmentForPath}.
     */
    get expressions() { return [this._expression]; }
    /**
     * The index name suffix: the name given to {@link withName}, or the path lowercased with its dots
     * turned into underscores. `DbTableCreator` appends `_gin` to it, so a btree and a GIN over the
     * same path cannot derive the same name - which `create index if not exists`, matching on name
     * alone, would silently resolve by keeping whichever was created first.
     */
    get nameSuffix() { return this._name ?? this._path.toLowerCase().replaceAll(".", "_"); }
    /**
     * Use {@link forPath} or {@link forRawPath} - an index always has a path.
     */
    constructor(path) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().split(".").every(u => SnapshotArrayIndex._jsonPathSegmentRegex.test(u)), `path '${path}' must be one or more '.' delimited bare JSON keys`);
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
    static forPath(path) {
        return SnapshotArrayIndex.forRawPath(path);
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
    static forRawPath(path) {
        return new SnapshotArrayIndex(path);
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
    static _createExpression(path) {
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
    static _validateMatches(matches, argName) {
        given(matches, argName).ensureHasValue().ensureIsArray().ensureIsNotEmpty()
            .ensure(t => t.every(u => SnapshotArrayIndex._isValidMatch(u)), `${argName} must be JSON scalars, or objects of one or more JSON scalar values - jsonb has nothing else this index can match`);
    }
    /**
     * Whether one match is a JSON scalar or a non-empty flat record of them.
     *
     * @param {any} match - The candidate match.
     * @returns {boolean} True if it is bindable.
     */
    static _isValidMatch(match) {
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
    static _isValidScalar(value) {
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
    withName(name) {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(t => SnapshotArrayIndex._nameRegex.test(t.trim()), `name '${name}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`)
            // named for the argument rather than `this`, so this throws ArgumentException like the
            // rest of the API instead of InvalidOperationException
            .ensure(() => this._name == null, "name is already set");
        // copy-on-write, matching `SnapshotIndex` and `SnapshotQuerySet`. The `this` return type is
        // kept rather than widened: the constructor is private, so there is no subclass for the two
        // to differ on, and keeping it means this signature did not change shape
        const next = new SnapshotArrayIndex(this._path);
        next._name = name.trim();
        return next;
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
    containmentForPath(path) {
        return this.containmentForRawPath(path);
    }
    /**
     * Like {@link containmentForPath} but takes any string, for a path declared with
     * {@link forRawPath}. Prefer {@link containmentForPath}.
     *
     * `TElement` defaults to `any`, so matches are unchecked - which is the raw door's contract: the
     * caller owns knowing the elements' stored shape. Supply it explicitly to get the checking back.
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
    containmentForRawPath(path) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
        // trimmed on both sides: the constructor stores the trimmed path, so a padded one has
        // to resolve to the same index
        t => t.trim() === this._path, `path '${path}' is not indexed by this index, which covers: ${this._path}`);
        const expression = this._expression;
        // `cast(? as jsonb)` rather than `?::jsonb`: text @> jsonb does not resolve, so the cast is
        // mandatory, and this form puts no `?` adjacent to a `:`, which keeps it safe under knex's
        // named-binding path as well as the positional one
        const term = `${expression} @> cast(? as jsonb)`;
        const toDocument = (matches) => JSON.stringify(matches);
        return {
            contains(match) {
                SnapshotArrayIndex._validateMatches([match], "match");
                return { sql: `(${term})`, params: [toDocument([match])] };
            },
            containsAll(matches) {
                SnapshotArrayIndex._validateMatches(matches, "matches");
                // one document, one index scan - jsonb containment already means "every one of
                // these", so N matches do not need N predicates
                return { sql: `(${term})`, params: [toDocument([...matches])] };
            },
            containsAny(matches) {
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
//# sourceMappingURL=snapshot-array-index.js.map