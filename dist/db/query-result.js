"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const n_defensive_1 = require("n-defensive");
const Treeize = require("treeize");
// public
class QueryResult {
    get rows() { return this._rows; }
    constructor(rows) {
        n_defensive_1.given(rows, "rows").ensureHasValue();
        this._rows = rows;
    }
    toObjectTree() {
        let tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}
exports.QueryResult = QueryResult;
//# sourceMappingURL=query-result.js.map