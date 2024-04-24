import { Exception } from "@nivinjoseph/n-exception";
import { OperationType } from "./operation-type.js";
export declare class DbException extends Exception {
    private readonly _operation;
    private readonly _sql;
    private readonly _params;
    get operation(): string;
    get sql(): string;
    get params(): ReadonlyArray<any>;
    constructor(operationType: OperationType, sql: string, params: ReadonlyArray<any>, err?: Error);
}
//# sourceMappingURL=db-exception.d.ts.map