import { given } from "@nivinjoseph/n-defensive";
import type { DomainObject, SerializedValue } from "@nivinjoseph/n-domain";

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
export enum JsonValueType
{
    // JSON strings
    text = "text",
    uuid = "uuid",

    // JSON booleans
    boolean = "boolean",

    // JSON numbers
    smallint = "smallint",
    integer = "integer",
    bigint = "bigint",
    numeric = "numeric",
    real = "real",
    doublePrecision = "double precision"
}

/**
 * Decrements the recursion budget used by `SnapshotLeafPath` and by `SnapshotArrayIndex`'s mirror of
 * it.
 *
 * Exported so the two path types share one budget - they walk the same state shape, so a leaf
 * reachable by one and not the other would be an arbitrary difference. Deliberately absent from the
 * barrel: it is an implementation detail of those types, not part of the public surface.
 */
export type PreviousDepth = [never, 0, 1, 2, 3, 4, 5];

/**
 * The scalars jsonb carries, and so the only leaf values a path can usefully name.
 *
 * jsonb also has null, which is deliberately absent: `undefined` stringifies to `null` too, so
 * accepting one would make a forgotten lookup indistinguishable from a deliberate null match.
 *
 * Lives here rather than in `snapshot-array-index` (which re-exports it, so the import surface is
 * unchanged) because both path walks consume it: the array walk to admit scalar elements, and
 * `SnapshotLeafPath` to *reject* a leaf that is not one - a member typed `string | Customer` must
 * not be offered as a leaf, since rows may hold the object.
 */
export type JsonScalar = string | number | boolean;

/**
 * True exactly for `any` and `unknown` - the two types every structural check passes vacuously.
 *
 * (`unknown extends T` holds only for those two; the `0 extends 1 & T` idiom catches only `any`.)
 * A member so typed gives the compiler nothing to verify a path against, so both walks map it to
 * `never` - fail-closed, like every other unverifiable shape, with `forRawPath` as the door.
 * Exported for the array walk; deliberately absent from the barrel, like {@link PreviousDepth}.
 */
export type IsAnyOrUnknown<T> = unknown extends T ? true : false;

/**
 * True exactly when `T` is a union of two or more members.
 *
 * The standard distribution trick: the naked `T` distributes, so each member is asked whether the
 * *whole* union fits back inside it - which fails for every member of a genuine union and holds for
 * a lone type. What it exists to catch: a path argument typed as `SnapshotPath<TState>` (a variable
 * rather than an inline literal) arrives as the whole union, and accepting it would silently widen
 * the declared-path record to every state path. Exported for the query set's declaration guards;
 * deliberately absent from the barrel, like {@link IsAnyOrUnknown}.
 */
export type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * Containers `JSON.stringify` renders as `{}`: any path into one indexes an always-null expression,
 * and as an array-index leaf one would never satisfy a containment query.
 *
 * The readonly interfaces also catch their mutable counterparts (a `Map` is structurally a
 * `ReadonlyMap`); `WeakMap`/`WeakSet` are named for completeness even though their all-method
 * surfaces contribute no paths on their own. Exported for the array walk; absent from the barrel.
 */
export type SnapshotOpaqueContainer =
    ReadonlyMap<any, any> | ReadonlySet<any> | WeakMap<any, any> | WeakSet<any>;

/**
 * The shape a nested value actually stores: n-domain's {@link SerializedValue} where the value is a
 * `DomainObject`, or the value itself where it is plain data.
 *
 * `_serializeForSnapshot` routes any `Serializable` through `serialize()`, so for such a value the
 * stored keys are the serialized shape's keys, not the class's property names. n-domain 4.0.2 types
 * that shape - `DomainObject<TThis, TDataKeys>` returns `DomainObjectSerialized<TThis, TDataKeys>` -
 * and only that contract is trusted here: a member has a compiler-visible stored shape exactly when
 * it is an n-domain `DomainObject`/`DomainEntity`. Anything else carrying a `serialize()` - a bare
 * or custom `Serializable`, even one with a typed return - fails closed, because nothing pins its
 * claimed shape to what n-domain's serializer actually emits.
 *
 * Guarded, and every guard fails CLOSED - to `Record<never, never>`, an object with no keys, whose
 * path union is `never` - because a substitution that produced an index signature would widen the
 * subtree's path union to `string` and disable checking entirely (the documented index-signature
 * gap):
 * - a serialized shape carrying a string index signature (which includes `any`) offers no nested
 *   paths at all;
 * - a serialized shape typed as an array offers none either, since an array's numeric keys are
 *   not dot-addressable jsonb keys.
 *
 * Unions resolve by what the whole union can prove. The outer check is non-distributive (tuple
 * brackets), so it succeeds only when **every** member is a `DomainObject` - {@link SerializedValue}
 * then distributes to the union of their serialized shapes, and the walk over it offers the keys
 * common to all of them, which is sound. A union where only *some* members serialize fails closed
 * (the middle branch below): the class-shape keys of the serializable members are not their stored
 * keys, so nothing checkable is on offer. A union of plain objects passes through untouched -
 * `keyof` over it already yields the common keys, and for plain objects the TypeScript names *are*
 * the stored keys.
 *
 * The substitution is idempotent through nesting: a `DomainObject` member's serialized shape holds
 * *already-serialized* values (no `serialize()` on them), so deeper levels of the walk pass them
 * through the plain-data branch untouched.
 *
 * Exported so `SnapshotArrayPath` and `SnapshotValueAt` apply the same substitution - the three
 * walk the same state shape. Deliberately absent from the barrel, like {@link PreviousDepth}.
 */
export type SerializedShapeOf<V> =
    // non-distributive: succeeds only when EVERY union member is an n-domain DomainObject
    [V] extends [DomainObject<object, never>]
        ? SerializedValue<V> extends infer TData extends object
            ? [TData] extends [ReadonlyArray<any>] ? Record<never, never>
            : string extends keyof TData ? Record<never, never>
            : TData
            : Record<never, never>
        // distributive on purpose: true lands in the union exactly when SOME member serializes
        : true extends (V extends { serialize(): object; } ? true : false)
            ? Record<never, never>
            : V;

/**
 * The raw leaf-path union, before {@link SnapshotPath} removes what must never be indexed.
 *
 * Not exported: every *typed* signature takes {@link SnapshotPath}, so the rules live in one place
 * and adding one lands on the whole API at once. The `Raw` overloads deliberately take `string`,
 * which is what makes them the escape hatch.
 */
type SnapshotLeafPath<T, TDepth extends number = 5> = [TDepth] extends [never] ? never
    // an index signature absorbs the literal keys (`keyof` cannot recover them), so a level carrying
    // one offers NO paths rather than `string`-widened unchecked ones - fail-closed, forRawPath through
    : string extends keyof T ? never
    : {
        // a key that cannot hold a JSON leaf maps to never, which drops out of the union when indexed -
        // filtering here rather than with an `as` clause keeps the key set intact, so indexing stays legal.
        // `Function` is named explicitly because it does NOT match the call signature below, so without
        // it a Function-typed key falls to the object branch and fabricates a subtree of its methods.
        // The $-guard comes first: the segment regex rejects `$`, so a $-key - the `$typename` every
        // DomainObjectSerialized carries, or a plain member so named - must not be offered only to
        // throw at declaration time. Then any/unknown, because `any` matches every later check.
        [K in keyof T & string]:
        K extends `$${string}` ? never
        : IsAnyOrUnknown<T[K]> extends true ? never
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        : NonNullable<T[K]> extends Function ? never
        : NonNullable<T[K]> extends SnapshotOpaqueContainer ? never
        : NonNullable<T[K]> extends ReadonlyArray<any> ? never
        : NonNullable<T[K]> extends object ? `${K}.${SnapshotLeafPath<SerializedShapeOf<NonNullable<T[K]>>, PreviousDepth[TDepth]>}`
        // bracketed so a mixed union (`string | Customer`) fails as a whole instead of being offered
        : [NonNullable<T[K]>] extends [JsonScalar] ? K : never
    }[keyof T & string];

/**
 * A dot-delimited path to a **leaf scalar** inside `T`, for indexing a snapshot's `data` column and
 * for building the predicates that read it back.
 *
 * Only leaves are offered. A container - an object- or array-valued key - is deliberately *not* a
 * path, because indexing one covers the text rendering of a whole subtree, and jsonb's rendering is
 * not `JSON.stringify`'s (jsonb orders keys itself and emits `": "` / `", "`), so a predicate built
 * in JavaScript would never match it. Use {@link SnapshotIndex.forRawPath} if you really want that.
 *
 * An **array**-valued key has a first-class answer rather than that escape hatch: `SnapshotArrayPath`
 * and `SnapshotArrayIndex`, which build a GIN containment index over the array as jsonb and ask
 * membership questions of it. The two path unions are disjoint by construction - what one offers,
 * the other maps to `never` - so a key belongs to exactly one kind of index.
 *
 * `organizationId` is excluded. On an org-scoped snapshot table it is a real column, and every index
 * leads with it - so a predicate on the column uses those indexes, while the copy inside `data` is
 * not what any index covers and querying it is always wrong. Only the bare top-level path is
 * removed; a nested `customer.organizationId` is a genuine leaf and stays.
 *
 * The exclusion is unconditional rather than conditional on an org-scoped state: one rule stated
 * once, with no dependency from this module onto the org base class. The cost is a plain
 * `AggregateState` that legitimately keeps a top-level `organizationId` inside `data` - off-pattern,
 * since n-domain offers `OrgAggregateRoot` for that - which reaches it through
 * {@link SnapshotIndex.forRawPath}, as containers do. (The exclusion used to be unreachable on a
 * state whose paths widened to `string` through an index signature; such a state now offers no
 * paths at all - see below - so the question no longer arises.)
 *
 * Depth is bounded so a self-referential state type cannot hang the compiler: paths of up to six
 * segments are offered, and a seventh is not. Because a container contributes only its nested paths,
 * exhausting the budget makes a deeper leaf unreachable rather than falling back to the container -
 * it fails closed, and `forRawPath` is the way through.
 *
 * **Nested paths follow the serialized shape, not the class shape.** `serializeStateIntoSnapshot`
 * copies the state with `Object.assign`, so `T`'s own keys are `data`'s keys. One level down,
 * `_serializeForSnapshot` routes any `Serializable` value through `serialize()`, which emits
 * `field.key ?? field.name` over `@serialize` decorated getters *only* - so this type recurses into
 * the *serialized shape* rather than the class ({@link SerializedShapeOf}). For a nested n-domain
 * 4.0.2 `DomainObject`/`DomainEntity` (whose `serialize()` returns `DomainObjectSerialized`), a path
 * segment therefore compiles only if a getter of that name is serialized - an undecorated getter is
 * a compile error rather than an always-null index. A `Serializable` member that is not a
 * `DomainObject` - bare, untyped, or even structurally typed - gives the compiler nothing it can
 * trust and offers **no** nested paths at all (fail-closed; {@link SnapshotIndex.forRawPath} is the
 * door). Nested plain objects are safe as before, since those are copied by
 * `JSON.parse(JSON.stringify(...))` and their TypeScript names are their stored keys.
 *
 * What the *type system* still cannot check: an explicit `@serialize("customKey")` rename.
 * `DomainObjectSerialized`'s keys are the getter *names* - a decorator cannot change a type - so a
 * renamed field is still offered under its TypeScript name while the data holds the custom key. It
 * is no longer silent, though: the snapshot repositories verify every declared path against the
 * first document each process saves (`SnapshotQuerySet.verifyDocument`), and a rename throws there,
 * before anything is written. What remains genuinely uncaught: a rename inside an optional member a
 * process never stores (close it with the `verifyDocument` assertion in a test), and a rename whose
 * custom key coincidentally equals another real key. Deliberately not addressable: the `$typename`
 * every serialized `Serializable` carries. As of n-domain 4.0.2 it is present in the *type* too
 * (`DomainObjectSerialized` stamps it), but the segment regex rejects `$`, so every `$`-prefixed key
 * is filtered out of the walk rather than offered only to throw - and the raw path door does not
 * reach it either. Index it by hand in a migration and query through `raw` if a polymorphic-type
 * predicate has to be fast.
 *
 * Everything unverifiable fails **closed** - no paths rather than unchecked ones, with `forRawPath`
 * as the door: a level carrying a string index signature ('keyof' cannot recover its literal keys);
 * an `any`- or `unknown`-typed member; a `Map`/`Set`/`WeakMap`/`WeakSet` member (serializes to
 * `{}`); a mixed union like `string | Customer` (rows may hold the object); a union where only
 * some members serialize (class-shape keys are not stored keys); and any `serialize()`-bearer that
 * is not an n-domain `DomainObject`, whatever its claimed return type. Unions where *every* member
 * is checkable stay useful: common keys are offered, which is sound in both the all-plain and the
 * all-DomainObject case. The remaining known gap besides the rename above: a template-literal index
 * signature (`` [k: `x${string}`] ``) still partially widens its level.
 */
export type SnapshotPath<T> = Exclude<SnapshotLeafPath<T>, "organizationId">;

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
export class SnapshotIndex<T>
{
    /**
     * A name suffix that composes into a valid unquoted Postgres identifier.
     */
    private static readonly _nameRegex = /^[a-z_][a-z0-9_]*$/;

    /**
     * A bare JSON key. Constraining segments to this is what keeps the '...' string literal
     * and the '{...}' path array in a json path expression from being broken out of.
     */
    private static readonly _jsonPathSegmentRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;

    private readonly _expressionsByPath = new Map<string, string>();
    private readonly _castsByPath = new Map<string, JsonValueType | undefined>();
    private _isUnique = false;
    private _name: string | null = null;

    /**
     * The paths this index covers, trimmed, in the order they were added - which is the order of the
     * index's columns, and so decides which predicates it can serve.
     */
    public get paths(): ReadonlyArray<string> { return [...this._expressionsByPath.keys()]; }

    /**
     * The extraction expressions, positionally matching {@link paths}.
     *
     * Public because `DbTableCreator` reads them across a module boundary. To build a predicate use
     * {@link expressionForPath} instead, which names the column it means rather than relying on a
     * position - and which fails loudly on a path this index does not cover.
     */
    public get expressions(): ReadonlyArray<string> { return [...this._expressionsByPath.values()]; }

    /**
     * The declared casts, positionally matching {@link paths} and {@link expressions}; `undefined`
     * where a path was declared without one.
     *
     * Public for the same reason as {@link expressions}: `DbTableCreator` reads them across a module
     * boundary - drift verification compares each declared cast against the type Postgres actually
     * indexed, which the expression string also encodes but would have to be parsed back out of.
     */
    public get casts(): ReadonlyArray<JsonValueType | undefined> { return [...this._castsByPath.values()]; }

    /**
     * Whether this index enforces uniqueness.
     */
    public get isUnique(): boolean { return this._isUnique; }

    /**
     * The index name suffix: the name given to {@link withName}, or the paths lowercased with their
     * dots turned into underscores and joined - so `["tenantCode", "sku"]` gives `tenantcode_sku`.
     *
     * Note what the derivation does *not* include: the cast type. Two declarations over one path that
     * differ only in `type` derive the same name, and index creation is `if not exists`, which
     * matches on name alone. See {@link asUnique} for the same hazard on the uniqueness flag.
     */
    public get nameSuffix(): string
    {
        return this._name
            ?? [...this._expressionsByPath.keys()].map(t => t.toLowerCase().replaceAll(".", "_")).join("_");
    }

    /**
     * Use {@link forPath} or {@link forRawPath} - an index always has at least one path.
     */
    private constructor() { }

    /**
     * Starts an index over the given key within `data`, dot delimited to reach a nested key.
     *
     * @param {SnapshotPath<T>} path - The key to index, checked against the state shape.
     * @param {JsonValueType} [type] - Optional type to cast the extracted text to. Supply it whenever the value is not a string, since an uncast comparison orders lexicographically and '9' > '100'. A cast also changes what counts as equal for {@link asUnique} - as text `1` and `1.0` differ, as numeric they do not. Unlike `SnapshotQuerySet.withPath`, the cast is NOT checked against the leaf type here: the state is supplied explicitly, and with no partial type-argument inference the path collapses to the whole union, which would make the leaf check reject every cast - so prefer declaring casts through the set, where the mismatch is a compile error.
     * @returns {SnapshotIndex<T>} A new index over that path.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, is empty or whitespace, is not one or more '.' delimited bare JSON keys, or type is not a JsonValueType.
     */
    public static forPath<T>(path: SnapshotPath<T>, type?: JsonValueType): SnapshotIndex<T>
    {
        return SnapshotIndex.forRawPath<T>(path, type);
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
    public static forRawPath<T>(path: string, type?: JsonValueType): SnapshotIndex<T>
    {
        return new SnapshotIndex<T>().andRawPath(path, type);
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
    private static _createExpression(path: string, type?: JsonValueType): string
    {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
                t => t.trim().split(".").every(u => SnapshotIndex._jsonPathSegmentRegex.test(u)),
                `path '${path}' must be one or more '.' delimited bare JSON keys`
            );
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
    public andPath(path: SnapshotPath<T>, type?: JsonValueType): this
    {
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
    public andRawPath(path: string, type?: JsonValueType): this
    {
        given(path, "path").ensureHasValue().ensureIsString();

        const trimmedPath = path.trim();

        // named for the argument rather than `this`, because n-defensive throws
        // InvalidOperationException when the arg name is "this" - which would make this the one
        // guard in the API raising a different branch of the exception hierarchy
        given(trimmedPath, "path").ensure(
            t => !this._expressionsByPath.has(t),
            `path '${trimmedPath}' is already indexed by this index`
        );

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
    public expressionForPath(path: SnapshotPath<T>): string
    {
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
    public expressionForRawPath(path: string): string
    {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(
                // trimmed on both sides of the map: andRawPath stores the trimmed key, so a padded
                // path has to resolve to the same entry it created
                t => this._expressionsByPath.has(t.trim()),
                `path '${path}' is not indexed by this index, which covers: ${this.paths.join(", ")}`
            );

        return this._expressionsByPath.get(path.trim())!;
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
    public asUnique(): this
    {
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
    public withName(name: string): this
    {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(
                t => SnapshotIndex._nameRegex.test(t.trim()),
                `name '${name}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`
            )
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
    private _clone(): this
    {
        const next = new SnapshotIndex<T>();

        this._expressionsByPath.forEach((v, k) => next._expressionsByPath.set(k, v));
        this._castsByPath.forEach((v, k) => next._castsByPath.set(k, v));
        next._isUnique = this._isUnique;
        next._name = this._name;

        return <this>next;
    }
}
