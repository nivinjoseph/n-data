import { given } from "@nivinjoseph/n-defensive";
import { validateBooleanFragment } from "./sql-fragment.js";
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
export class RepositoryQueryBuilder {
    /**
     * @static
     */
    constructor() { }
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
    static build(table, whereOrQuery, params, organizationId) {
        return RepositoryQueryBuilder.buildSelect("data", table, whereOrQuery, params, organizationId);
    }
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
    static buildSelect(selectList, table, whereOrQuery, params, organizationId) {
        given(selectList, "selectList").ensureHasValue().ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "selectList is empty")
            .ensure(t => !/^\s*select\b/i.test(t), "selectList is the list of columns, not a statement - drop the 'select' keyword")
            .ensure(t => !t.contains(";"), "selectList must not contain a ';'");
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
        const clause = RepositoryQueryBuilder._buildWhereClause(where, organizationId);
        const boundParams = [...clause.params];
        let sql = `select ${selectList.trim()} from ${table.trim()}${clause.sql}`;
        if (orderBy != null)
            sql += ` order by ${orderBy}`;
        if (limit != null) {
            sql += " limit ?";
            boundParams.push(limit);
        }
        if (offset != null) {
            sql += " offset ?";
            boundParams.push(offset);
        }
        return { sql: `${sql};`, params: boundParams };
    }
    static idPredicate(column, values, predicate) {
        given(column, "column").ensureHasValue().ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "column is empty");
        given(values, "values").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        given(predicate, "predicate").ensureIsObject()
            .ensure(t => Array.isArray(t.params), "a predicate's params must be an array");
        const ids = `${column.trim()} in (${values.map(() => "?").join(",")})`;
        if (predicate == null)
            return { sql: ids, params: [...values], acrossOrganizations: true };
        // validated *before* it is spliced behind `... and (`, for the same reason `raw` validates
        // before parenthesizing: both regexes in validateBooleanFragment are anchored, so a fragment
        // that has already been given a prefix sails past checks the bare fragment would fail
        const validated = validateBooleanFragment(predicate.sql, "predicate");
        return {
            // parenthesized: `and` binds tighter than `or`, so a bare `a = ? or b = ?` would parse as
            // `(id in (...) and a) or b` and return rows the id filter was supposed to exclude
            sql: `${ids} and (${validated})`,
            params: [...values, ...predicate.params],
            acrossOrganizations: true
        };
    }
    static buildExists(table, predicate, excludeId, organizationId) {
        const clause = RepositoryQueryBuilder._buildFilter(table, predicate, organizationId, excludeId);
        return { sql: `select 1 from ${table.trim()}${clause.sql} limit 1;`, params: clause.params };
    }
    static buildCount(table, predicate, organizationId) {
        const clause = RepositoryQueryBuilder._buildFilter(table, predicate, organizationId);
        return {
            sql: `select cast(count(*) as int) as count from ${table.trim()}${clause.sql};`,
            params: clause.params
        };
    }
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
    static ensureAcrossOrganizations(whereOrQuery) {
        if (whereOrQuery == null)
            return;
        const query = RepositoryQueryBuilder._normalize(whereOrQuery);
        const reason = "must be branded acrossOrganizations: true - build it over paths declared { acrossOrganizations: true } (or array paths), or through rawAcrossOrganizations; a predicate on an unflagged path cannot use an index once the organization filter is dropped";
        // decided ahead of the guard: `where` is a union the ensurer overloads cannot take as one, and
        // the internal string form carries no brand by construction
        if (query.where != null) {
            // the normalized form is structural, so the brand is read back through the family that carries it
            const branded = typeof query.where !== "string" && query.where.acrossOrganizations === true;
            given(branded, "where").ensure(t => t, reason);
        }
        if (query.orderBy != null && typeof query.orderBy !== "string") {
            const terms = RepositoryQueryBuilder._orderByTerms(query.orderBy);
            given(terms, "orderBy").ensure(t => t.every(u => u.acrossOrganizations === true), `every term ${reason}`);
        }
    }
    /**
     * Guards the arguments the two aggregate-free builders share, and assembles their `where` clause.
     */
    static _buildFilter(table, predicate, organizationId, excludeId) {
        given(table, "table").ensureHasValue().ensureIsString();
        given(predicate, "predicate").ensureIsObject();
        given(excludeId, "excludeId").ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "excludeId is empty");
        given(organizationId, "organizationId").ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "organizationId is empty");
        const where = RepositoryQueryBuilder._resolveWhere(predicate, []);
        return RepositoryQueryBuilder._buildWhereClause(where, organizationId, excludeId);
    }
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
    static _buildWhereClause(where, organizationId, excludeId) {
        const conjuncts = new Array();
        const params = new Array();
        if (organizationId != null) {
            conjuncts.push("organization_id = ?");
            params.push(organizationId);
        }
        if (where.sql != null) {
            conjuncts.push(`(${where.sql})`);
            params.push(...where.params);
        }
        if (excludeId != null) {
            conjuncts.push("id <> ?");
            params.push(excludeId);
        }
        return { sql: conjuncts.isEmpty ? "" : ` where ${conjuncts.join(" and ")}`, params };
    }
    /**
     * Widens whichever form arrived to the object form. The string form is internal - see
     * {@link NormalizedQuery} - and is the predicate-only case, so an empty one is a mistake rather
     * than a way to select everything; `{}` is how that is asked for.
     */
    static _normalize(value) {
        given(value, "where").ensureHasValue();
        if (typeof value === "string") {
            given(value, "where").ensure(t => t.isNotEmptyOrWhiteSpace(), "where is empty; pass '{}' to select without a predicate");
            return { where: value };
        }
        given(value, "query").ensureIsObject();
        // a SnapshotPredicate carries `sql`, a RepositoryQuery carries `where` - so which one arrived
        // is readable off the shape. Carrying both is a caller confusing the two, not a third form.
        if (RepositoryQueryBuilder._isPredicate(value)) {
            given(value, "query").ensure(t => t.where == null, "a predicate cannot also carry 'where'; pass either a predicate or a query object");
            return { where: value };
        }
        return value;
    }
    static _isPredicate(value) {
        return typeof value.sql === "string";
    }
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
    static _resolveWhere(where, params) {
        if (where == null) {
            // there is nowhere for them to bind, and silently dropping them would turn a caller's
            // mistake into a query that quietly matches more than they asked for
            given(params, "params").ensure(t => t.length === 0, "params were supplied with no where predicate to bind them to");
            return { sql: null, params: [] };
        }
        if (typeof where !== "string") {
            given(where, "where").ensureIsObject()
                .ensure(t => Array.isArray(t.params), "a predicate's params must be an array");
            given(params, "params").ensure(t => t.length === 0, "the predicate carries its own params, so none can be passed positionally alongside it");
            return { sql: RepositoryQueryBuilder._validateWhereSql(where.sql), params: [...where.params] };
        }
        return { sql: RepositoryQueryBuilder._validateWhereSql(where), params: [...params] };
    }
    /**
     * @returns {string} The trimmed predicate.
     */
    static _validateWhereSql(where) {
        return validateBooleanFragment(where, "where");
    }
    /**
     * @returns {string | null} The trimmed order by list, or null when there is none.
     */
    static _validateOrderBy(orderBy) {
        if (orderBy == null)
            return null;
        // one or several terms from a SnapshotQuerySet flatten to the same comma-joined list a raw
        // string would have been, so everything below validates one shape
        if (typeof orderBy !== "string") {
            const terms = RepositoryQueryBuilder._orderByTerms(orderBy);
            given(terms, "orderBy").ensureIsArray().ensureIsNotEmpty()
                // read through `any` so a JavaScript caller passing something order-by-shaped is caught
                // here rather than emitting `undefined` into the SQL
                .ensure(t => t.every(u => typeof u?.sql === "string" && u.sql.isNotEmptyOrWhiteSpace()), "every orderBy term must have sql");
            return RepositoryQueryBuilder._validateOrderBy(terms.map(t => t.sql.trim()).join(", "));
        }
        given(orderBy, "orderBy").ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace(), "orderBy is empty; omit it to leave the result unordered")
            .ensure(t => !/^\s*order\s+by\b/i.test(t), "orderBy must not include the 'order by' keywords, which are emitted for you")
            .ensure(t => !t.contains(";"), "orderBy must not contain a ';'");
        return orderBy.trim();
    }
    /**
     * The typed terms an `orderBy` carries, one or several, as one list.
     *
     * Widened before the test on purpose: Array.isArray's predicate is a mutable `any[]`, which does
     * not narrow a ReadonlyArray, so tested directly the check reads as vacuous. Shared by
     * {@link _validateOrderBy} and {@link ensureAcrossOrganizations}, so the two cannot disagree about
     * what a term is.
     */
    static _orderByTerms(orderBy) {
        const candidate = orderBy;
        return Array.isArray(candidate) ? candidate : [orderBy];
    }
    /**
     * @returns {number | null} The row count, or null when there is none.
     */
    static _validateRowCount(value, name) {
        if (value == null)
            return null;
        given(value, name).ensureIsNumber()
            .ensure(t => Number.isInteger(t) && t >= 0, `${name} must be a non-negative integer`);
        return value;
    }
}
//# sourceMappingURL=repository-query.js.map