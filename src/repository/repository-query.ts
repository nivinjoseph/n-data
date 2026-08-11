import { given } from "@nivinjoseph/n-defensive";
import { SnapshotOrderBy, SnapshotPredicate } from "../migration/snapshot-query-set.js";

/**
 * The clauses a repository `query` may add around its predicate.
 *
 * Every repository's `query` owns the statement it runs - the select list is always `data`, and the
 * table is always the repository's own - so what a caller supplies is the `where` predicate and,
 * through this, the clauses that follow it. Pass a bare string for the common predicate-only case;
 * reach for this object when a query needs ordering or paging, or needs no predicate at all.
 *
 * On an organization-scoped repository the tenant filter is added ahead of `where` and is not
 * expressible here - that is the whole point of it being automatic. `queryAcrossOrganizations` is the
 * way out.
 *
 * @example
 * ```typescript
 * // a typed predicate from the repository's SnapshotQuerySet - it carries its own params
 * this.query({
 *     where: this.indexes.eq("status", status),
 *     orderBy: this.indexes.orderBy("placedAt", "desc"),
 *     limit: 50
 * });
 *
 * // ordering on two keys
 * this.query({
 *     where: this.indexes.eq("status", status),
 *     orderBy: [this.indexes.orderBy("series"), this.indexes.orderBy("revision", "desc")]
 * });
 *
 * // a raw predicate, with its params passed positionally
 * this.query({ where: `${this.indexes.expressionFor("status")} = ?`, limit: 50 }, status);
 *
 * // no predicate at all
 * this.query({ orderBy: this.indexes.orderBy("placedAt", "desc"), limit: 10 });
 * ```
 */
export interface RepositoryQuery
{
    /**
     * The `where` predicate, without the `where` keyword.
     *
     * A `SnapshotPredicate` from the repository's `SnapshotQuerySet` carries its own parameters, so
     * none are passed positionally alongside it - supplying any is an error rather than a silent
     * misbinding. A raw string binds with `?` placeholders and takes its values positionally; never
     * interpolate a value into it.
     *
     * Omit it to select every row the repository can see - which on an organization-scoped
     * repository still means only the current organization's.
     */
    readonly where?: string | SnapshotPredicate;

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
export interface BuiltRepositoryQuery
{
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
export class RepositoryQueryBuilder
{
    /**
     * A predicate that is really a whole statement. `with` is included because a caller reaching for
     * a CTE is reaching past what this builds, same as one writing `select`.
     */
    private static readonly _statementRegex = /^\s*(?:select|with)\b/i;

    /**
     * A predicate that has kept the keyword this builder emits.
     */
    private static readonly _whereKeywordRegex = /^\s*where\b/i;

    /**
     * @static
     */
    private constructor() { }


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
     * @param {string | SnapshotPredicate | RepositoryQuery} whereOrQuery - The predicate, or the clauses to build from.
     * @param {ReadonlyArray<any>} params - Values bound to the predicate's `?` placeholders.
     * @param {string} [organizationId] - The organization to scope to; omitted on a non-org repository.
     * @returns {BuiltRepositoryQuery} The statement and its parameters, positionally matched.
     * @throws {ArgumentNullException} If table, whereOrQuery or params is null or undefined.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; if limit or offset is not a non-negative integer; or if params are supplied with no predicate.
     */
    public static build(table: string, whereOrQuery: string | SnapshotPredicate | RepositoryQuery,
        params: ReadonlyArray<any>, organizationId?: string): BuiltRepositoryQuery
    {
        given(table, "table").ensureHasValue().ensureIsString();
        given(params, "params").ensureHasValue().ensureIsArray();
        // an empty one would pass ensureIsString and then quietly match no rows at all, which reads as
        // "this tenant has no data" rather than as the misconfigured domain context it is
        given(organizationId, "organizationId").ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "organizationId is empty");

        const query = RepositoryQueryBuilder._normalize(whereOrQuery);

        const where = RepositoryQueryBuilder._resolveWhere(query.where, params);
        const orderBy = RepositoryQueryBuilder._validateOrderBy(query.orderBy);
        const limit = RepositoryQueryBuilder._validateRowCount(query.limit, "limit");
        const offset = RepositoryQueryBuilder._validateRowCount(query.offset, "offset");

        // positional binding is unforgiving, so params are pushed in exactly the order the fragments
        // they belong to are appended
        const boundParams = new Array<any>();
        let sql = `select data from ${table.trim()}`;

        if (organizationId != null)
        {
            sql += " where organization_id = ?";
            boundParams.push(organizationId);

            if (where.sql != null)
            {
                sql += ` and (${where.sql})`;
                boundParams.push(...where.params);
            }
        }
        else if (where.sql != null)
        {
            sql += ` where (${where.sql})`;
            boundParams.push(...where.params);
        }

        if (orderBy != null)
            sql += ` order by ${orderBy}`;

        if (limit != null)
        {
            sql += " limit ?";
            boundParams.push(limit);
        }

        if (offset != null)
        {
            sql += " offset ?";
            boundParams.push(offset);
        }

        return { sql: `${sql};`, params: boundParams };
    }

    /**
     * Widens the string form to the object form. The string form is the predicate-only case, so an
     * empty one is a mistake rather than a way to select everything - `{}` is how that is asked for.
     */
    private static _normalize(value: string | SnapshotPredicate | RepositoryQuery): RepositoryQuery
    {
        given(value, "where").ensureHasValue();

        if (typeof value === "string")
        {
            given(value, "where").ensure(
                t => t.isNotEmptyOrWhiteSpace(),
                "where is empty; pass '{}' to select without a predicate"
            );

            return { where: value };
        }

        given(<object>value, "query").ensureIsObject();

        // a SnapshotPredicate carries `sql`, a RepositoryQuery carries `where` - so which one arrived
        // is readable off the shape. Carrying both is a caller confusing the two, not a third form.
        if (RepositoryQueryBuilder._isPredicate(value))
        {
            given(value, "query").ensure(
                t => (<any>t).where == null,
                "a predicate cannot also carry 'where'; pass either a predicate or a query object"
            );

            return { where: value };
        }

        return value;
    }

    private static _isPredicate(value: object): value is SnapshotPredicate
    {
        return typeof (<any>value).sql === "string";
    }

    /**
     * Resolves the predicate and the values that bind to it, from whichever form arrived.
     *
     * A {@link SnapshotPredicate} owns its parameters, so positional ones alongside it would have
     * nowhere to go; a raw string owns none, so the positional ones are its. Either way there is
     * exactly one source, which is what keeps the binding order unambiguous.
     *
     * @returns The trimmed predicate and its parameters; `sql` is null when there is no predicate.
     */
    private static _resolveWhere(where: string | SnapshotPredicate | undefined,
        params: ReadonlyArray<any>): { sql: string | null; params: ReadonlyArray<any>; }
    {
        if (where == null)
        {
            // there is nowhere for them to bind, and silently dropping them would turn a caller's
            // mistake into a query that quietly matches more than they asked for
            given(params, "params").ensure(
                t => t.length === 0,
                "params were supplied with no where predicate to bind them to"
            );

            return { sql: null, params: [] };
        }

        if (typeof where !== "string")
        {
            given(where, "where").ensureIsObject()
                .ensure(t => Array.isArray(t.params), "a predicate's params must be an array");

            given(params, "params").ensure(
                t => t.length === 0,
                "the predicate carries its own params, so none can be passed positionally alongside it"
            );

            return { sql: RepositoryQueryBuilder._validateWhereSql(where.sql), params: [...where.params] };
        }

        return { sql: RepositoryQueryBuilder._validateWhereSql(where), params: [...params] };
    }

    /**
     * @returns {string} The trimmed predicate.
     */
    private static _validateWhereSql(where: string): string
    {
        given(where, "where").ensureHasValue().ensureIsString()
            .ensure(
                t => t.isNotEmptyOrWhiteSpace(),
                "where is empty; omit it to select without a predicate"
            )
            .ensure(
                t => !RepositoryQueryBuilder._statementRegex.test(t),
                "where is a predicate, not a whole statement - drop the 'select ... from ...' and pass only what follows 'where'"
            )
            .ensure(
                t => !RepositoryQueryBuilder._whereKeywordRegex.test(t),
                "where must not include the 'where' keyword, which is emitted for you"
            )
            .ensure(
                t => !t.contains(";"),
                "where must not contain a ';'"
            );

        return where.trim();
    }

    /**
     * @returns {string | null} The trimmed order by list, or null when there is none.
     */
    private static _validateOrderBy(orderBy?: string | SnapshotOrderBy | ReadonlyArray<SnapshotOrderBy>): string | null
    {
        if (orderBy == null)
            return null;

        // one or several terms from a SnapshotQuerySet flatten to the same comma-joined list a raw
        // string would have been, so everything below validates one shape
        if (typeof orderBy !== "string")
        {
            // widened before the test on purpose: Array.isArray's predicate is a mutable `any[]`, which
            // does not narrow a ReadonlyArray, so tested directly the check reads as vacuous
            const candidate: unknown = orderBy;
            const terms: ReadonlyArray<SnapshotOrderBy> = Array.isArray(candidate)
                ? <ReadonlyArray<SnapshotOrderBy>>candidate
                : [<SnapshotOrderBy>orderBy];

            given(terms, "orderBy").ensureIsArray().ensureIsNotEmpty()
                // read through `any` so a JavaScript caller passing something order-by-shaped is caught
                // here rather than emitting `undefined` into the SQL
                .ensure(t => t.every(u => typeof (<any>u)?.sql === "string" && (<string>(<any>u).sql).isNotEmptyOrWhiteSpace()),
                    "every orderBy term must have sql");

            return RepositoryQueryBuilder._validateOrderBy(terms.map(t => t.sql.trim()).join(", "));
        }

        given(orderBy, "orderBy").ensureIsString()
            .ensure(
                t => t.isNotEmptyOrWhiteSpace(),
                "orderBy is empty; omit it to leave the result unordered"
            )
            .ensure(
                t => !/^\s*order\s+by\b/i.test(t),
                "orderBy must not include the 'order by' keywords, which are emitted for you"
            )
            .ensure(
                t => !t.contains(";"),
                "orderBy must not contain a ';'"
            );

        return orderBy.trim();
    }

    /**
     * @returns {number | null} The row count, or null when there is none.
     */
    private static _validateRowCount(value: number | undefined, name: string): number | null
    {
        if (value == null)
            return null;

        given(value, name).ensureIsNumber()
            .ensure(
                t => Number.isInteger(t) && t >= 0,
                `${name} must be a non-negative integer`
            );

        return value;
    }
}
