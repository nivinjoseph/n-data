import { Exception } from "@nivinjoseph/n-exception";
import { OperationType } from "./operation-type";
export declare class DbException extends Exception {
    private readonly _operation;
    private readonly _sql;
    private readonly _params;
    readonly operation: string;
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
    constructor(operationType: OperationType, sql: string, params: ReadonlyArray<any>, err?: Error);
}
