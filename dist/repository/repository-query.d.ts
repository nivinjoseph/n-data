import { SnapshotOrderBy, SnapshotPredicate } from "../migration/snapshot-query-set.js";
import type { ReadModelPredicate } from "../read-model/read-model-schema.js";
import type { ReadModelQuery } from "../read-model/read-model-query.js";
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
 * expressible here - that is the whole point of it being automatic. The ways out are named for that
 * consequence rather than expressed as a flag here: `queryAcrossOrganizations`, which takes this same
 * shape at `RepositoryQuery<true>` - a predicate and order-by terms branded across organizations, so
 * that the read is still index-served with the filter gone; `queryStatementAcrossOrganizations` for a
 * whole statement; and `queryByIdAcrossOrganizations`/`queryByIdsAcrossOrganizations` when the read
 * is by id.
 *
 * @template TAcrossOrganizations - The brand the predicate and the typed order-by terms must carry. The default `boolean` admits either, which is what the scoped `query` takes; the cross-organization door takes `true`.
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
export interface RepositoryQuery<TAcrossOrganizations extends boolean = boolean> {
    /**
     * The `where` predicate, without the `where` keyword.
     *
     * A {@link SnapshotPredicate} always carries its own parameters, so there is nothing to pass
     * positionally alongside it and no way to mis-order the binding. A hand-written fragment reaches
     * this through `SnapshotQuerySet.raw`, the only door a consumer has for one, which validates it
     * on the way in; there is deliberately no bare-string form here, because the two differed in what
     * they accepted and in where their values came from.
     *
     * Omit it to select every row the repository can see - which on an organization-scoped
     * repository still means only the current organization's.
     */
    readonly where?: SnapshotPredicate<TAcrossOrganizations>;
    /**
     * The `order by` list, without the `order by` keywords.
     *
     * Prefer `SnapshotQuerySet.orderBy`, singly or as an array for several keys: an expression index
     * serves an `order by` only when the expression matches the indexed one textually, and taking it
     * from the declaration is what guarantees that. A raw string is accepted for anything that cannot
     * express - `nulls last`, a collation, an ordering on a function of two paths. A raw string is
     * the caller's on the cross-organization door too, where a typed term must be branded.
     */
    readonly orderBy?: string | SnapshotOrderBy<TAcrossOrganizations> | ReadonlyArray<SnapshotOrderBy<TAcrossOrganizations>>;
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
 * What the builders here read off a predicate: a boolean fragment and the values that bind to its
 * `?` placeholders, in order.
 *
 * The structural core both predicate families share - `SnapshotPredicate` adds the
 * `acrossOrganizations` brand over it, `ReadModelPredicate` adds the table brand - so one body
 * assembles every statement without the builder knowing which family it is serving. Module-exported
 * because it appears in public signatures; absent from the barrel, like the builder itself. A
 * consumer never names it: each repository's `query` takes its own family's predicate.
 */
export interface SqlPredicate {
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
}
/**
 * What the builders here read off an `order by` term. See {@link SqlPredicate}.
 */
export interface SqlOrderBy {
    readonly sql: string;
}
/**
 * The object form of a query as the builders here read it: the predicate and the clauses that
 * follow it. `RepositoryQuery` and `ReadModelQuery` are both this, each over its own predicate
 * family. See {@link SqlPredicate}.
 */
export interface SqlQuery {
    readonly where?: SqlPredicate;
    readonly orderBy?: string | SqlOrderBy | ReadonlyArray<SqlOrderBy>;
    readonly limit?: number;
    readonly offset?: number;
}
/**
 * Assembles the statement a repository's `query` runs.
 *
 * One builder serves all four repositories, which are siblings rather than a hierarchy - so the only
 * difference between them, whether an organization filter leads the predicate, is a parameter here
 * rather than an override somewhere.
 *
 * The snapshot repositories expose it through their `query`, and reach {@link idPredicate} a second
 * way through `queryById`/`queryByIds` - the id-shaped reads that also take a predicate, which is the
 * one composition a `SnapshotQuerySet` cannot express on its own. The event stream repositories use
 * it privately, for the two reads that build a statement - `getByIds` and `getAll`, with `get`
 * delegating to the former - and they offer no query surface of their own, deliberately, so this is
 * the one place their statement shape is assembled.
 *
 * Deliberately absent from the barrel: it is how those methods are implemented, not something a
 * subclass names. {@link RepositoryQuery} is what consumers name. A subclass does still meet its
 * validation transitively - a bad predicate handed to `queryById` surfaces as the `ArgumentException`
 * {@link idPredicate} raises.
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
     * Builds `select <selectList> from <table> [where ...] [order by ...] [limit ?] [offset ?]`.
     *
     * The body behind {@link build}, with the select list as a parameter: the aggregate repositories
     * select `data`, the column each row is deserialized from, and a read model repository selects
     * its declared columns. Everything else - the organization conjunct and its binding order, the
     * parenthesized predicate, the bound row counts - is the same statement for both, which is why
     * it is assembled once.
     *
     * The select list is interpolated, not bound, so it is validated the way the table name is: it
     * must be a non-empty list, not a statement (no leading `select`), and carry no `;`. Column
     * identifiers themselves are validated where they are declared, by the schema that emits them.
     *
     * Takes either predicate family - a `SnapshotPredicate`/`RepositoryQuery` or a
     * `ReadModelPredicate`/`ReadModelQuery` - and nothing else: a hand-built `{ sql, params }` literal,
     * which nothing branded, is a compile error here as it is on every repository door.
     *
     * @param {string} selectList - The columns to select, comma-separated, without the `select` keyword.
     * @param {string} table - The repository's table.
     * @param {string | SnapshotPredicate | RepositoryQuery | ReadModelPredicate | ReadModelQuery} whereOrQuery - The predicate, or the clauses to build from. The string form is internal; see {@link NormalizedQuery}.
     * @param {ReadonlyArray<any>} params - Values bound to the internal string form's `?` placeholders; always empty for anything a consumer supplies.
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentNullException} If selectList, table, whereOrQuery or params is null or undefined.
     * @throws {ArgumentException} If the select list is empty, is a statement, or contains a ';'; if the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; if limit or offset is not a non-negative integer; or if params are supplied with no predicate.
     */
    static buildSelect(selectList: string, table: string, whereOrQuery: string | SnapshotPredicate | RepositoryQuery | ReadModelPredicate | ReadModelQuery, params: ReadonlyArray<any>, organizationId?: string): BuiltRepositoryQuery;
    /**
     * Builds `<column> in (?, ?, ...)` over a set of ids, as a predicate carrying its own values -
     * optionally conjoined with a further predicate.
     *
     * The one fragment the library assembles for itself. All four repositories look up by id - `id`
     * on a snapshot table, `aggregate_id` on an event stream - and none of them can express it
     * through a `SnapshotQuerySet`, whose paths reach inside `data` and whose declarations belong to
     * the subclass. Building it here keeps the placeholder count and the value order derived from one
     * array in one place; positional binding gives no second chance at getting that pairing right.
     *
     * The optional `predicate` is what lets an id lookup be filtered - "this id, but only if it is
     * not archived" - which is otherwise inexpressible: the id column is not a query set path, so the
     * two halves come from different places and have to meet somewhere. They meet here, and only
     * here, because the snapshot repositories are siblings rather than a hierarchy and
     * `DeclaredSnapshotQuerySet` offers them no `and` of its own.
     *
     * @param {string} column - The id column to match against.
     * @param {ReadonlyArray<string>} values - The ids; must be non-empty, since `in ()` is not valid SQL.
     * Overloaded per predicate family: with a `SnapshotPredicate` (or none) the result is the branded
     * `SnapshotPredicate<true>` the snapshot repositories need; with a `ReadModelPredicate` it is a
     * plain `SqlPredicate`, since the brand means nothing on a read model table. A hand-built literal
     * fits neither overload.
     *
     * @param {SnapshotPredicate | ReadModelPredicate} [predicate] - A further condition every matched row must also satisfy.
     * @returns {SnapshotPredicate | SqlPredicate} The fragment and its values, positionally matched - the ids first, then the predicate's own. For the snapshot family, branded `acrossOrganizations: true` whatever the conjoined predicate carries: the id column is the primary key, which has no tenant prefix, so the lookup is index-served with or without the organization filter and the predicate only filters the rows the key found.
     * @throws {ArgumentException} If column is empty, values is empty, the predicate's params are not an array, or its sql is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    static idPredicate(column: string, values: ReadonlyArray<string>, predicate?: SnapshotPredicate): SnapshotPredicate<true>;
    static idPredicate(column: string, values: ReadonlyArray<string>, predicate?: ReadModelPredicate): SqlPredicate;
    /**
     * Builds `select 1 from <table> [where ...] limit 1;` - the statement behind a repository's `exists`.
     *
     * `select 1` rather than a column, so the read can be served index-only where the visibility map allows;
     * and `limit 1`, so it stops at the first match rather than materializing the whole matching set. That
     * second point is the reason `excludeId` is a parameter here rather than something a caller filters out
     * of the rows afterwards - a filter applied after the fact cannot be combined with a limit.
     *
     * Overloaded per predicate family; the organization filter exists only on the snapshot one.
     *
     * @param {string} table - The repository's table.
     * @param {SnapshotPredicate | ReadModelPredicate} [predicate] - What to match; omitted asks whether the repository can see any row at all.
     * @param {string} [excludeId] - An id that does not count as a match - "is this key taken by someone *else*".
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentException} If the predicate's sql is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; or if excludeId is empty.
     */
    static buildExists(table: string, predicate?: SnapshotPredicate, excludeId?: string, organizationId?: string): BuiltRepositoryQuery;
    static buildExists(table: string, predicate?: ReadModelPredicate, excludeId?: string): BuiltRepositoryQuery;
    /**
     * Builds `select cast(count(*) as int) as count from <table> [where ...];` - the statement behind a
     * repository's `count`.
     *
     * The cast is not decoration: Postgres types `count(*)` as bigint, which the driver hands back as a
     * string, so an uncast count would arrive as `"3"` rather than `3`.
     *
     * Overloaded per predicate family; the organization filter exists only on the snapshot one.
     *
     * @param {string} table - The repository's table.
     * @param {SnapshotPredicate | ReadModelPredicate} [predicate] - What to count; omitted counts every row the repository can see.
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentException} If the predicate's sql is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    static buildCount(table: string, predicate?: SnapshotPredicate, organizationId?: string): BuiltRepositoryQuery;
    static buildCount(table: string, predicate?: ReadModelPredicate): BuiltRepositoryQuery;
    /**
     * The runtime half of the brand the typed cross-organization doors require at compile time, for a
     * JavaScript caller or an `any`: the predicate - or the query form's predicate and every typed
     * order-by term - must carry `acrossOrganizations: true`.
     *
     * It lives here rather than on the repository so that "what shape arrived" is decided once: the
     * argument goes through the same {@link _normalize} `build` uses (so a predicate that also carries
     * `where` fails with the builder's own ambiguity error, and the internal string form reads as
     * unbranded), and the terms are widened by the same helper `_validateOrderBy` uses. An absent
     * predicate is the whole table, which needs no index; a raw-string order by is the caller's, as it
     * is on the scoped form.
     *
     * @param {string | SnapshotPredicate | RepositoryQuery} [whereOrQuery] - What the door was handed.
     * @throws {ArgumentException} If the predicate or a typed order-by term is not branded across organizations, or if the argument is not a shape {@link build} would accept.
     */
    static ensureAcrossOrganizations(whereOrQuery: string | SnapshotPredicate | RepositoryQuery | undefined): void;
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
     * takes no positional params at all. They stay to keep the string branch honest if an internal
     * caller reaches for it again (see {@link NormalizedQuery}: none does today), because a mis-bound
     * `in (?, ?)` would be silent.
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
     * The typed terms an `orderBy` carries, one or several, as one list.
     *
     * Widened before the test on purpose: Array.isArray's predicate is a mutable `any[]`, which does
     * not narrow a ReadonlyArray, so tested directly the check reads as vacuous. Shared by
     * {@link _validateOrderBy} and {@link ensureAcrossOrganizations}, so the two cannot disagree about
     * what a term is.
     */
    private static _orderByTerms;
    /**
     * @returns {number | null} The row count, or null when there is none.
     */
    private static _validateRowCount;
}
//# sourceMappingURL=repository-query.d.ts.map