"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const n_exception_1 = require("@nivinjoseph/n-exception");
const operation_type_1 = require("./operation-type");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
class DbException extends n_exception_1.Exception {
    constructor(operationType, sql, params, err) {
        n_defensive_1.given(operationType, "operationType").ensureHasValue();
        n_defensive_1.given(sql, "sql").ensureHasValue();
        n_defensive_1.given(params, "params").ensureHasValue();
        let operation = operationType === operation_type_1.OperationType.query ? "query" : "command";
        let message = `Error during ${operation} operation with sql "${sql}" and params [${params}].`;
        super(message, err);
        this._operation = operation;
        this._sql = sql;
        this._params = [...params];
    }
    get operation() { return this._operation; }
    get sql() { return this._sql; }
    get params() { return this._params; }
}
exports.DbException = DbException;
//# sourceMappingURL=db-exception.js.map