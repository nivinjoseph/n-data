import { Exception } from "@nivinjoseph/n-exception";
import { OperationType } from "./operation-type.js";
import { given } from "@nivinjoseph/n-defensive";
export class DbException extends Exception {
    get operation() { return this._operation; }
    get sql() { return this._sql; }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    get params() { return this._params; }
    constructor(operationType, sql, params, err) {
        given(operationType, "operationType").ensureHasValue();
        given(sql, "sql").ensureHasValue();
        given(params, "params").ensureHasValue();
        const operation = operationType === OperationType.query ? "query" : "command";
        let paramsString = null;
        try {
            paramsString = JSON.stringify(params);
        }
        catch (_a) {
            // deliberate suppress?
        }
        if (paramsString == null)
            paramsString = `[${params}]`;
        const message = `Error during ${operation} operation with sql "${sql}" and params ${paramsString}.`;
        super(message, err);
        this._operation = operation;
        this._sql = sql;
        this._params = [...params];
    }
}
//# sourceMappingURL=db-exception.js.map