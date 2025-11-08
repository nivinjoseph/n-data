/* eslint-disable @typescript-eslint/no-unsafe-call */
import { given } from "@nivinjoseph/n-defensive";
// @ts-expect-error: no types
import Treeize from "treeize";
/**
 * Represents the result of a database query.
 * Provides methods to access and transform the query results.
 *
 * @class QueryResult
 * @template T - The type of the rows in the result
 */
export class QueryResult {
    /**
     * Gets the rows returned by the query.
     *
     * @readonly
     * @type {ReadonlyArray<T>}
     */
    get rows() { return this._rows; }
    constructor(rows) {
        given(rows, "rows").ensureHasValue().ensureIsArray();
        this._rows = rows;
    }
    /**
     * Transforms the flat result rows into a tree structure.
     * Useful for converting database results with parent-child relationships into nested objects.
     *
     * @template U - The type of the transformed result
     * @returns {Array<U>} The transformed result as a tree structure
     */
    toObjectTree() {
        const tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}
//# sourceMappingURL=query-result.js.map