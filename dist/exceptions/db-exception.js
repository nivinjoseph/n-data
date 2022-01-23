"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbException = void 0;
const n_exception_1 = require("@nivinjoseph/n-exception");
const operation_type_1 = require("./operation-type");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
class DbException extends n_exception_1.Exception {
    constructor(operationType, sql, params, err) {
        (0, n_defensive_1.given)(operationType, "operationType").ensureHasValue();
        (0, n_defensive_1.given)(sql, "sql").ensureHasValue();
        (0, n_defensive_1.given)(params, "params").ensureHasValue();
        const operation = operationType === operation_type_1.OperationType.query ? "query" : "command";
        let paramsString = null;
        try {
            paramsString = JSON.stringify(params);
        }
        catch (_a) { }
        if (paramsString == null)
            paramsString = `[${params}]`;
        const message = `Error during ${operation} operation with sql "${sql}" and params ${paramsString}.`;
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