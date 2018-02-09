"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const Treeize = require("treeize");
// public
class QueryResult {
    constructor(rows) {
        n_defensive_1.given(rows, "rows").ensureHasValue();
        this._rows = rows;
    }
    get rows() { return this._rows; }
    toObjectTree() {
        let tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}
exports.QueryResult = QueryResult;
//# sourceMappingURL=query-result.js.map