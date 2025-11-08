/**
 * Represents the result of a database query.
 * Provides methods to access and transform the query results.
 *
 * @class QueryResult
 * @template T - The type of the rows in the result
 */
export declare class QueryResult<T> {
    private readonly _rows;
    /**
     * Gets the rows returned by the query.
     *
     * @readonly
     * @type {ReadonlyArray<T>}
     */
    get rows(): ReadonlyArray<T>;
    constructor(rows: Array<T>);
    /**
     * Transforms the flat result rows into a tree structure.
     * Useful for converting database results with parent-child relationships into nested objects.
     *
     * @template U - The type of the transformed result
     * @returns {Array<U>} The transformed result as a tree structure
     */
    toObjectTree<U>(): Array<U>;
}
//# sourceMappingURL=query-result.d.ts.map