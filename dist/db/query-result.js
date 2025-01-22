/* eslint-disable @typescript-eslint/no-unsafe-call */
import { given } from "@nivinjoseph/n-defensive";
// @ts-expect-error: no types
import Treeize from "treeize";
// public
export class QueryResult {
    get rows() { return this._rows; }
    constructor(rows) {
        given(rows, "rows").ensureHasValue().ensureIsArray();
        this._rows = rows;
    }
    toObjectTree() {
        const tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}
//# sourceMappingURL=query-result.js.map