import { ReadModelOrderBy, ReadModelPredicate } from "./read-model-schema.js";

/**
 * The clauses a read model repository's `query` may add around its predicate - the counterpart of
 * `RepositoryQuery`, over the read model predicate family.
 *
 * `query` owns the statement: the select list is the declared columns and the table is the
 * repository's own, so what a caller supplies is the `where` predicate and, through this, the
 * clauses that follow it. Pass a bare {@link ReadModelPredicate} for the common predicate-only
 * case; reach for this object when a query needs ordering or paging, or needs no predicate at all.
 *
 * @example
 * ```typescript
 * this.query({
 *     where: this.schema.eq("customerId", customerId),
 *     orderBy: this.schema.orderBy("placedAt", "desc"),
 *     limit: 50
 * });
 *
 * // no predicate at all
 * this.query({ orderBy: this.schema.orderBy("placedAt", "desc"), limit: 10 });
 * ```
 */
export interface ReadModelQuery
{
    /**
     * The `where` predicate, without the `where` keyword. Built by the repository's schema; a
     * hand-written fragment reaches this through `ReadModelSchema.raw`.
     */
    readonly where?: ReadModelPredicate;

    /**
     * The `order by` list, without the `order by` keywords. Prefer `ReadModelSchema.orderBy`, singly
     * or as an array for several keys; a raw string is accepted for what it cannot express - `nulls
     * last`, a collation, an expression.
     */
    readonly orderBy?: string | ReadModelOrderBy | ReadonlyArray<ReadModelOrderBy>;

    /**
     * The maximum number of rows to return. Bound as a parameter, not interpolated.
     */
    readonly limit?: number;

    /**
     * The number of rows to skip. Bound as a parameter. Pair it with {@link orderBy}: without one
     * Postgres makes no promise about which rows a given offset skips.
     */
    readonly offset?: number;
}
