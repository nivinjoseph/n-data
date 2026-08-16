import { given } from "@nivinjoseph/n-defensive";
/**
 * The Postgres types a value extracted out of a jsonb column can be cast to.
 *
 * Deliberately narrow, on two counts. Extraction yields text, and an expression index
 * requires an immutable expression - so only types whose input function is immutable are
 * reachable. And the set is limited to types a JSON value actually carries: JSON has
 * strings, numbers and booleans, so those are what this covers.
 *
 * Every member is verified against Postgres 12 to work as an index expression; there is a
 * test that fails if one is added that does not.
 *
 * Notable absences:
 * - No date/time types. `date`, `time`, `timestamp`, `timestamptz` and `interval` all parse
 *   from text through stable functions (they depend on DateStyle/TimeZone), so Postgres
 *   rejects them in an index expression. Store a timestamp as epoch millis and use
 *   {@link JsonValueType.bigint} - which is what domain timestamps already are - or store an
 *   ISO-8601 string and leave it as text, which sorts chronologically anyway.
 * - No `varchar(n)`. An explicit cast to it truncates silently past n rather than erroring,
 *   and it buys nothing over {@link JsonValueType.text} in Postgres.
 * - No `jsonb`. Indexing a whole subtree with btree is rarely useful; reach a scalar inside
 *   it with a dotted path instead.
 *
 * Two things to know about the resulting index, both verified against Postgres 12 and pinned by
 * tests:
 * - {@link JsonValueType.text} is not merely a no-op, it is *elided*. Extraction already yields
 *   text, so Postgres drops the redundant cast and an index built with it is byte-for-byte the same
 *   index as one built without - their predicates are interchangeable in either direction. It is the
 *   one case where two different expression strings are equivalent; everywhere else a textual
 *   difference costs the index. Just leave the type off.
 * - The default text opclass serves `=`, range comparisons and `order by`, but **not** a prefix
 *   `LIKE 'abc%'` unless the database collation is `C`. Under a typical `en_US.utf8` database such a
 *   query silently sequential-scans past a perfectly good index. `text_pattern_ops` is what fixes
 *   it, and this API does not express opclasses - build that index by hand in a migration if a
 *   prefix search has to be fast.
 */
export var JsonValueType;
(function (JsonValueType) {
    // JSON strings
    JsonValueType["text"] = "text";
    JsonValueType["uuid"] = "uuid";
    // JSON booleans
    JsonValueType["boolean"] = "boolean";
    // JSON numbers
    JsonValueType["smallint"] = "smallint";
    JsonValueType["integer"] = "integer";
    JsonValueType["bigint"] = "bigint";
    JsonValueType["numeric"] = "numeric";
    JsonValueType["real"] = "real";
    JsonValueType["doublePrecision"] = "double precision";
})(JsonValueType || (JsonValueType = {}));
/**
 * Describes one index over the `data` column of a snapshot table, built fluently - and the source of
 * the SQL expressions that read it back.
 *
 * Start with {@link forPath} and chain {@link andPath} to make it composite, {@link asUnique} to
 * enforce a natural key, and {@link withName} to override the derived name. Each path carries its
 * own optional cast, so a composite whose members need different types is expressible.
 *
 * Paths are checked against `T`, the aggregate's state shape. Every path is validated - and its
 * extraction expression built - as it is added, so a malformed path, a bad type or a repeated path
 * throws where the index is declared rather than when the table is created.
 *
 * The same instance then hands the expression back through {@link expressionForPath}. That matters
 * because Postgres uses an expression index only when the query expression matches the indexed one
 * **textually**, and a near-miss silently becomes a sequential scan with no error and no warning.
 * The builder that produces an expression is private, so an expression can only originate from a
 * declaration that also emits the DDL - which is what makes the two impossible to diverge.
 *
 * **`SnapshotQuerySet` is how a repository normally declares these, and reaching for this class
 * directly is the exception.** The set binds the state in its own call, which is what lets it infer
 * each path as a string *literal* and so check a query's paths against what is actually indexed rather
 * than merely against the state shape. That is not available here: TypeScript has no partial
 * type-argument inference, so `forPath<OrderState>("status")` - supplying the state explicitly - cannot
 * also infer the path.
 *
 * What this class is still for is the path a typed signature cannot name: a computed or dynamic key,
 * or a whole subtree, through {@link forRawPath}. (Not a `$`-prefixed name - the segment regex
 * rejects `$` through every door; see {@link SnapshotPath}.) Pass such a declaration to
 * `DbTableCreator` alongside a set, or on its own.
 *
 * @example
 * ```typescript
 * // the escape hatch: a key outside the state shape, which SnapshotQuerySet cannot name
 * const legacyIndex = SnapshotIndex.forRawPath<OrderState>("legacy_code");
 *
 * await tableCreator.createSnapshotTableForAggregate(Order, {
 *     indexes: [...OrderRepository.indexes.indexes, legacyIndex],
 *     arrayIndexes: OrderRepository.indexes.arrayIndexes
 * });
 *
 * // and the predicate for it, built from the same declaration
 * const expression = legacyIndex.expressionForRawPath("legacy_code");
 * ```
 *
 * @class SnapshotIndex
 */
export class SnapshotIndex {
    /**
     * A name suffix that composes into a valid unquoted Postgres identifier.
     */
    static _nameRegex = /^[a-z_][a-z0-9_]*$/;
    /**
     * A bare JSON key. Constraining segments to this is what keeps the '...' string literal
     * and the '{...}' path array in a json path expression from being broken out of.
     */
    static _jsonPathSegmentRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
    _expressionsByPath = new Map();
    _castsByPath = new Map();
    _isUnique = false;
    _name = null;
    /**
     * The paths this index covers, trimmed, in the order they were added - which is the order of the
     * index's columns, and so decides which predicates it can serve.
     */
    get paths() { return [...this._expressionsByPath.keys()]; }
    /**
     * The extraction expressions, positionally matching {@link paths}.
     *
     * Public because `DbTableCreator` reads them across a module boundary. To build a predicate use
     * {@link expressionForPath} instead, which names the column it means rather than relying on a
     * position - and which fails loudly on a path this index does not cover.
     */
    get expressions() { return [...this._expressionsByPath.values()]; }
    /**
     * The declared casts, positionally matching {@link paths} and {@link expressions}; `undefined`
     * where a path was declared without one.
     *
     * Public for the same reason as {@link expressions}: `DbTableCreator` reads them across a module
     * boundary - drift verification compares each declared cast against the type Postgres actually
     * indexed, which the expression string also encodes but would have to be parsed back out of.
     */
    get casts() { return [...this._castsByPath.values()]; }
    /**
     * Whether this index enforces uniqueness.
     */
    get isUnique() { return this._isUnique; }
    /**
     * The index name suffix: the name given to {@link withName}, or the paths lowercased with their
     * dots turned into underscores and joined - so `["tenantCode", "sku"]` gives `tenantcode_sku`.
     *
     * Note what the derivation does *not* include: the cast type. Two declarations over one path that
     * differ only in `type` derive the same name, and index creation is `if not exists`, which
     * matches on name alone. See {@link asUnique} for the same hazard on the uniqueness flag.
     */
    get nameSuffix() {
        return this._name
            ?? [...this._expressionsByPath.keys()].map(t => t.toLowerCase().replaceAll(".", "_")).join("_");
    }
    /**
     * Use {@link forPath} or {@link forRawPath} - an index always has at least one path.
     */
    constructor() { }
    /**
     * Starts an index over the given key within `data`, dot delimited to reach a nested key.
     *
     * @param {SnapshotPath<T>} path - The key to index, checked against the state shape.
     * @param {JsonValueType} [type] - Optional type to cast the extracted text to. Supply it whenever the value is not a string, since an uncast comparison orders lexicographically and '9' > '100'. A cast also changes what counts as equal for {@link asUnique} - as text `1` and `1.0` differ, as numeric they do not. Unlike `SnapshotQuerySet.withPath`, the cast is NOT checked against the leaf type here: the state is supplied explicitly, and with no partial type-argument inference the path collapses to the whole union, which would make the leaf check reject every cast - so prefer declaring casts through the set, where the mismatch is a compile error.
     * @returns {SnapshotIndex<T>} A new index over that path.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, is not one or more '.' delimited bare JSON keys, or type is not a JsonValueType.
     */
    static forPath(path, type) {
        return SnapshotIndex.forRawPath(path, type);
    }
    /**
     * Like {@link forPath} but takes any string, for a computed or dynamic key outside the state
     * shape. Prefer {@link forPath} so typos are caught at compile time.
     *
     * @param {string} path - The key to index.
     * @param {JsonValueType} [type] - Optional type to cast the extracted text to.
     * @returns {SnapshotIndex<T>} A new index over that path.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, is not one or more '.' delimited bare JSON keys, or type is not a JsonValueType.
     */
    static forRawPath(path, type) {
        return new SnapshotIndex().andRawPath(path, type);
    }
    /**
     * Builds the SQL expression that extracts a key out of a snapshot table's `data` jsonb column.
     *
     * Private on purpose. An expression is only useful if some index was actually built from it, so
     * the only way to obtain one is through a declaration that also emits the DDL - which is what
     * keeps the read side from diverging from the written index. {@link forRawPath} is the escape
     * hatch for a key outside the state shape, and it goes through here too.
     *
     * A `type` produces a cast, which matters for correctness and not merely for speed:
     * `->>` yields text, so an uncast comparison orders lexicographically and '9' > '100'.
     * See {@link JsonValueType} for which types are available and why the set is narrow.
     *
     * Two limits worth knowing, both of which surface long after this call:
     * - A key whose serialized name is not a bare JSON key is not addressable at all. That includes
     *   any `$` prefixed name, which is what a nested value decorated `@serialize("$x")` is stored
     *   under.
     * - A btree index over the result must fit Postgres's 2704 byte index-tuple limit, measured
     *   *after* compression - so it depends on the value's entropy, not just its length. A
     *   repetitive 4KB value indexes fine while an incompressible one fails, and the failure
     *   arrives on insert rather than at create time. Index bounded scalars only.
     *
     * @param {string} path - The key within `data`; dot delimited to reach a nested key.
     * @param {JsonValueType} [type] - Optional type to cast the extracted text to; defaults to leaving it as text.
     * @returns {string} A parenthesized expression, e.g. `(data->>'status')` or `((data->>'total')::numeric)`.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, any segment is not a bare JSON key, or type is not a JsonValueType.
     */
    static _createExpression(path, type) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().split(".").every(u => SnapshotIndex._jsonPathSegmentRegex.test(u)), `path '${path}' must be one or more '.' delimited bare JSON keys`);
        given(type, "type").ensureIsString().ensureIsEnum(JsonValueType);
        const segments = path.trim().split(".");
        // ->> extracts a top level key as text; #>> walks a path array to reach a nested one.
        // The path array's elements are double quoted because an *unquoted* element matching
        // NULL (any case) parses as a null element, not the string - and #>> returns null when
        // any element is null, which would make the index null for every row. Both forms parse to
        // the same text[] constant for every other segment, so this does not invalidate indexes
        // already built from the unquoted form.
        const extraction = segments.length === 1
            ? `data->>'${segments[0]}'`
            : `data#>>'{"${segments.join("\",\"")}"}'`;
        return type != null ? `((${extraction})::${type})` : `(${extraction})`;
    }
    /**
     * Adds another path, making this a composite index. Order matters: Postgres only uses a
     * composite index for predicates matching a leading prefix of its columns.
     *
     * @param {SnapshotPath<T>} path - The key to add, checked against the state shape.
     * @param {JsonValueType} [type] - Optional type to cast this path's extracted text to.
     * @returns {this} This index, for chaining.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, is not one or more '.' delimited bare JSON keys, is already indexed by this index, or type is not a JsonValueType.
     */
    andPath(path, type) {
        return this.andRawPath(path, type);
    }
    /**
     * Like {@link andPath} but takes any string, for a computed or dynamic key outside the state
     * shape. Prefer {@link andPath} so typos are caught at compile time.
     *
     * @param {string} path - The key to add.
     * @param {JsonValueType} [type] - Optional type to cast this path's extracted text to.
     * @returns {this} A new index covering this one's paths and that one - the receiver is unchanged.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, is not one or more '.' delimited bare JSON keys, is already indexed by this index, or type is not a JsonValueType.
     */
    andRawPath(path, type) {
        given(path, "path").ensureHasValue().ensureIsString();
        const trimmedPath = path.trim();
        // named for the argument rather than `this`, because n-defensive throws
        // InvalidOperationException when the arg name is "this" - which would make this the one
        // guard in the API raising a different branch of the exception hierarchy
        given(trimmedPath, "path").ensure(t => !this._expressionsByPath.has(t), `path '${trimmedPath}' is already indexed by this index`);
        const next = this._clone();
        // built eagerly, so a malformed path or type throws at the declaration site; and built once,
        // so the expression the index is created from is the same one handed back for predicates
        next._expressionsByPath.set(trimmedPath, SnapshotIndex._createExpression(trimmedPath, type));
        next._castsByPath.set(trimmedPath, type);
        return next;
    }
    /**
     * The expression that extracts `path`, for building a query predicate.
     *
     * This is the same string this index's DDL was emitted from, which is the point: Postgres uses
     * an expression index only when the query expression matches the indexed one textually, so
     * taking it from the declaration is what makes a predicate index-usable. Never hand-write it.
     *
     * Two things it does not promise. The path must be one **this** index covers - a path valid on
     * the state but belonging to a different index throws, so read the expression into a `static`
     * field where that surfaces at module load. And matching the expression is necessary, not
     * sufficient: btree serves only a leading prefix of an index's columns, so the second path of a
     * composite is not independently searchable. On an org-scoped table nothing is searchable until
     * the predicate also constrains `organization_id` - which `OrgSnapshotBaseRepository.query` does
     * for you, ahead of whatever predicate you pass it.
     *
     * @param {SnapshotPath<T>} path - A path this index covers, checked against the state shape.
     * @returns {string} The parenthesized extraction expression, e.g. `(data->>'status')`.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not covered by this index.
     */
    expressionForPath(path) {
        return this.expressionForRawPath(path);
    }
    /**
     * Like {@link expressionForPath} but takes any string, for a path declared with
     * {@link forRawPath} or {@link andRawPath}. Prefer {@link expressionForPath}.
     *
     * @param {string} path - A path this index covers.
     * @returns {string} The parenthesized extraction expression.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, or is not covered by this index.
     */
    expressionForRawPath(path) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
        // trimmed on both sides of the map: andRawPath stores the trimmed key, so a padded
        // path has to resolve to the same entry it created
        t => this._expressionsByPath.has(t.trim()), `path '${path}' is not indexed by this index, which covers: ${this.paths.join(", ")}`);
        return this._expressionsByPath.get(path.trim());
    }
    /**
     * Enforces uniqueness over the indexed value, or over the tuple of them for a composite.
     *
     * Rows whose `data` omits an indexed key are unconstrained: extraction yields null, and Postgres
     * treats nulls as distinct, so any number of them coexist. For a composite that means a row
     * missing *any* member never collides.
     *
     * **Comparison is over the extracted text exactly as stored.** Nothing is folded or trimmed, so a
     * "unique email" index accepts `a@x.com`, `A@x.com` and `" a@x.com "` as three distinct values -
     * verified against Postgres, and pinned by a test. There is no `lower()` or `trim()` option here
     * on purpose: every additional expression form is another spelling the read side has to match
     * exactly, which is the divergence this design exists to prevent. Normalize in the domain, before
     * the value reaches the snapshot, where it is enforced for every reader rather than one index.
     *
     * On an org-scoped table the index leads with `organization_id`, so uniqueness is scoped to the
     * organization rather than global.
     *
     * A violation surfaces from a repository's `save` as a DbException rather than a domain error:
     * the repositories upsert with `on conflict (id)`, and Postgres only routes conflicts on the
     * named arbiter index, so a collision here raises and rolls the unit of work back.
     *
     * A unique index is named with a `_uq` suffix, so the same path can carry both a lookup index
     * and a unique one without their derived names colliding. The corollary is that *clearing*
     * `asUnique` on an existing declaration does not drop the `_uq` index - creation is
     * `if not exists` and nothing here drops anything, so the constraint stays enforced until the
     * index is dropped by hand.
     *
     * @returns {this} A new index, unique - the receiver is unchanged.
     */
    asUnique() {
        const next = this._clone();
        next._isUnique = true;
        return next;
    }
    /**
     * Overrides the derived name suffix, giving `idx_<table>_<name>` (plus `_uq` when unique).
     *
     * Supply it when the derivation from the paths would exceed the Postgres identifier limit of 63
     * characters, which a composite over a long table name will.
     *
     * @param {string} name - The suffix to use.
     * @returns {this} A new index under that name - the receiver is unchanged.
     * @throws {ArgumentNullException} If name is null or undefined.
     * @throws {ArgumentException} If name is not a string, is empty or whitespace, is not a valid identifier fragment, or is already set.
     */
    withName(name) {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(t => SnapshotIndex._nameRegex.test(t.trim()), `name '${name}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`)
            // named for the argument rather than `this`, so this throws ArgumentException like the
            // rest of the API instead of InvalidOperationException
            .ensure(() => this._name == null, "name is already set");
        const next = this._clone();
        next._name = name.trim();
        return next;
    }
    /**
     * Copy-on-write, so each builder call hands back a new index and the receiver stays as it was.
     *
     * This matches `SnapshotQuerySet`, which has always cloned. The two used to disagree: `andPath`,
     * `asUnique` and `withName` returned `this` and mutated in place, so `const b = a.asUnique()` left
     * `a` unique as well - and carrying one builder's mental model over to the other silently changed
     * what got created. `SnapshotTableInfo` even documented the consequence, that a builder mutated
     * after a create call still answered for a path no index covered. It cannot now.
     *
     * The `this` return type is kept rather than widened to `SnapshotIndex<T>`: the constructor is
     * private, so there is no subclass for the two to differ on, and keeping it means no signature
     * here changed shape.
     */
    _clone() {
        const next = new SnapshotIndex();
        this._expressionsByPath.forEach((v, k) => next._expressionsByPath.set(k, v));
        this._castsByPath.forEach((v, k) => next._castsByPath.set(k, v));
        next._isUnique = this._isUnique;
        next._name = this._name;
        return next;
    }
}
//# sourceMappingURL=snapshot-index.js.map