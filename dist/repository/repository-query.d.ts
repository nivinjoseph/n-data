import { SnapshotOrderBy, SnapshotPredicate } from "../migration/snapshot-query-set.js";
/**
 * The clauses a repository `query` may add around its predicate.
 *
 * Every repository's `query` owns the statement it runs - the select list is always `data`, and the
 * table is always the repository's own - so what a caller supplies is the `where` predicate and,
 * through this, the clauses that follow it. Pass a bare {@link SnapshotPredicate} for the common
 * predicate-only case; reach for this object when a query needs ordering or paging, or needs no
 * predicate at all.
 *
 * On an organization-scoped repository the tenant filter is added ahead of `where` and is not
 * expressible here - that is the whole point of it being automatic. `queryAcrossOrganizations` is the
 * way out.
 *
 * @example
 * ```typescript
 * // a typed predicate from the repository's SnapshotQuerySet - it carries its own params
 * this.query({
 *     where: this.querySet.eq("status", status),
 *     orderBy: this.querySet.orderBy("placedAt", "desc"),
 *     limit: 50
 * });
 *
 * // ordering on two keys
 * this.query({
 *     where: this.querySet.eq("status", status),
 *     orderBy: [this.querySet.orderBy("series"), this.querySet.orderBy("revision", "desc")]
 * });
 *
 * // a hand-written predicate, through the one door that takes one
 * this.query({ where: this.querySet.raw(`${this.querySet.expressionFor("status")} = ?`, status), limit: 50 });
 *
 * // no predicate at all
 * this.query({ orderBy: this.querySet.orderBy("placedAt", "desc"), limit: 10 });
 * ```
 */
export interface RepositoryQuery {
    /**
     * The `where` predicate, without the `where` keyword.
     *
     * A {@link SnapshotPredicate} always carries its own parameters, so there is nothing to pass
     * positionally alongside it and no way to mis-order the binding. A hand-written fragment reaches
     * this through `SnapshotQuerySet.raw`, which is the library's only door for one and validates it
     * on the way in; there is deliberately no bare-string form here, because the two differed in what
     * they accepted and in where their values came from.
     *
     * Omit it to select every row the repository can see - which on an organization-scoped
     * repository still means only the current organization's.
     */
    readonly where?: SnapshotPredicate;
    /**
     * The `order by` list, without the `order by` keywords.
     *
     * Prefer `SnapshotQuerySet.orderBy`, singly or as an array for several keys: an expression index
     * serves an `order by` only when the expression matches the indexed one textually, and taking it
     * from the declaration is what guarantees that. A raw string is accepted for anything that cannot
     * express - `nulls last`, a collation, an ordering on a function of two paths.
     */
    readonly orderBy?: string | SnapshotOrderBy | ReadonlyArray<SnapshotOrderBy>;
    /**
     * The maximum number of rows to return. Bound as a parameter, not interpolated.
     */
    readonly limit?: number;
    /**
     * The number of rows to skip. Bound as a parameter, not interpolated.
     *
     * Ordering is not implied by anything else here, so pair this with {@link orderBy} - without one
     * Postgres makes no promise about which rows a given offset skips, and two pages can overlap or
     * miss rows.
     */
    readonly offset?: number;
}
/**
 * A statement and the parameters bound to it, positionally.
 */
export interface BuiltRepositoryQuery {
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
}
/**
 * Assembles the statement a repository's `query` runs.
 *
 * One builder serves all four repositories, which are siblings rather than a hierarchy - so the only
 * difference between them, whether an organization filter leads the predicate, is a parameter here
 * rather than an override somewhere.
 *
 * The snapshot repositories expose it through their `query`. The event stream repositories use it
 * privately, for the two id-shaped reads `get` and `getAll` perform - they offer no query surface of their
 * own, deliberately, so this is the one place their statement shape is assembled.
 *
 * Deliberately absent from the barrel: it is how `query` is implemented, not part of the surface a
 * subclass uses. {@link RepositoryQuery} is what consumers name.
 *
 * @class RepositoryQueryBuilder
 */
export declare class RepositoryQueryBuilder {
    /**
     * @static
     */
    private constructor();
    /**
     * Builds `select data from <table> [where ...] [order by ...] [limit ?] [offset ?]`.
     *
     * When `organizationId` is supplied the predicate is preceded by `organization_id = ?`, bound as
     * the **first** parameter. Leading is not cosmetic: every btree index on an org-scoped table
     * leads with that column, so the filter both isolates the tenant and lets the index be used.
     *
     * A supplied predicate is always parenthesized. That is load bearing rather than tidy: `and`
     * binds tighter than `or`, so splicing `a = ? or b = ?` in bare would produce
     * `organization_id = ? and a = ? or b = ?`, which parses as `(org and a) or b` and returns other
     * organizations' rows. The non-org path parenthesizes too, so the two forms cannot behave
     * differently.
     *
     * @param {string} table - The repository's table.
     * @param {string | SnapshotPredicate | RepositoryQuery} whereOrQuery - The predicate, or the clauses to build from. The string form is internal; see {@link NormalizedQuery}.
     * @param {ReadonlyArray<any>} params - Values bound to the internal string form's `?` placeholders; always empty for anything a consumer supplies.
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentNullException} If table, whereOrQuery or params is null or undefined.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; if limit or offset is not a non-negative integer; or if params are supplied with no predicate.
     */
    static build(table: string, whereOrQuery: string | SnapshotPredicate | RepositoryQuery, params: ReadonlyArray<any>, organizationId?: string): BuiltRepositoryQuery;
    /**
     * Builds `<column> in (?, ?, ...)` over a set of ids, as a predicate carrying its own values.
     *
     * The one fragment the library assembles for itself. All four repositories look up by id - `id`
     * on a snapshot table, `aggregate_id` on an event stream - and none of them can express it
     * through a `SnapshotQuerySet`, whose paths reach inside `data` and whose declarations belong to
     * the subclass. Building it here keeps the placeholder count and the value order derived from one
     * array in one place; positional binding gives no second chance at getting that pairing right.
     *
     * @param {string} column - The id column to match against.
     * @param {ReadonlyArray<string>} values - The ids; must be non-empty, since `in ()` is not valid SQL.
     * @returns {SnapshotPredicate} The fragment and its values, positionally matched.
     * @throws {ArgumentException} If column is empty, or values is empty.
     */
    static idPredicate(column: string, values: ReadonlyArray<string>): SnapshotPredicate;
    /**
     * Builds `select 1 from <table> [where ...] limit 1;` - the statement behind a repository's `exists`.
     *
     * `select 1` rather than a column, so the read can be served index-only where the visibility map allows;
     * and `limit 1`, so it stops at the first match rather than materializing the whole matching set. That
     * second point is the reason `excludeId` is a parameter here rather than something a caller filters out
     * of the rows afterwards - a filter applied after the fact cannot be combined with a limit.
     *
     * @param {string} table - The repository's table.
     * @param {SnapshotPredicate} [predicate] - What to match; omitted asks whether the repository can see any row at all.
     * @param {string} [excludeId] - An id that does not count as a match - "is this key taken by someone *else*".
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentException} If the predicate's sql is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; or if excludeId is empty.
     */
    static buildExists(table: string, predicate?: SnapshotPredicate, excludeId?: string, organizationId?: string): BuiltRepositoryQuery;
    /**
     * Builds `select cast(count(*) as int) as count from <table> [where ...];` - the statement behind a
     * repository's `count`.
     *
     * The cast is not decoration: Postgres types `count(*)` as bigint, which the driver hands back as a
     * string, so an uncast count would arrive as `"3"` rather than `3`.
     *
     * @param {string} table - The repository's table.
     * @param {SnapshotPredicate} [predicate] - What to count; omitted counts every row the repository can see.
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentException} If the predicate's sql is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    static buildCount(table: string, predicate?: SnapshotPredicate, organizationId?: string): BuiltRepositoryQuery;
    /**
     * Guards the arguments the two aggregate-free builders share, and assembles their `where` clause.
     */
    private static _buildFilter;
    /**
     * Assembles the `where` clause every statement here shares, as an ordered list of conjuncts.
     *
     * The order is load bearing twice over. `organization_id` leads because every btree index on an
     * org-scoped table leads with it, so the filter both isolates the tenant and lets the index be used. And
     * because binding is positional, the order the fragments are appended in *is* the order their values must
     * be bound in - which is why the parameters are collected here alongside the SQL rather than anywhere
     * else.
     *
     * The predicate is parenthesized. That is not tidiness: `and` binds tighter than `or`, so splicing
     * `a = ? or b = ?` in bare would produce `organization_id = ? and a = ? or b = ?`, which parses as
     * `(org and a) or b` and returns other organizations' rows.
     */
    private static _buildWhereClause;
    /**
     * Widens whichever form arrived to the object form. The string form is internal - see
     * {@link NormalizedQuery} - and is the predicate-only case, so an empty one is a mistake rather
     * than a way to select everything; `{}` is how that is asked for.
     */
    private static _normalize;
    private static _isPredicate;
    /**
     * Resolves the predicate and the values that bind to it, from whichever form arrived.
     *
     * A {@link SnapshotPredicate} owns its parameters, so positional ones alongside it would have
     * nowhere to go; the internal string form owns none, so the positional ones are its. Either way
     * there is exactly one source, which is what keeps the binding order unambiguous.
     *
     * Both guards below are now internal invariants rather than consumer-facing errors - a consumer
     * cannot reach either, since `where` is a `SnapshotPredicate` on the public type and `query`
     * takes no positional params at all. They stay because the string branch is still live for
     * `_load`, and a mis-bound `in (?, ?)` would be silent.
     *
     * @returns The trimmed predicate and its parameters; `sql` is null when there is no predicate.
     */
    private static _resolveWhere;
    /**
     * @returns {string} The trimmed predicate.
     */
    private static _validateWhereSql;
    /**
     * @returns {string | null} The trimmed order by list, or null when there is none.
     */
    private static _validateOrderBy;
    /**
     * @returns {number | null} The row count, or null when there is none.
     */
    private static _validateRowCount;
}
//# sourceMappingURL=repository-query.d.ts.map