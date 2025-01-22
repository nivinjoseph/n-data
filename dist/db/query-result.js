"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryResult = void 0;
/* eslint-disable @typescript-eslint/no-unsafe-call */
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const Treeize = require("treeize");
// public
class QueryResult {
    constructor(rows) {
        (0, n_defensive_1.given)(rows, "rows").ensureHasValue().ensureIsArray();
        this._rows = rows;
    }
    get rows() { return this._rows; }
    toObjectTree() {
        const tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}
exports.QueryResult = QueryResult;
//# sourceMappingURL=query-result.js.map