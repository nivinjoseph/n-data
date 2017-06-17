import { Exception } from "n-exception";
import { OperationType } from "./operation-type";
import { given } from "n-defensive";


export class DbException extends Exception
{ 
    private readonly _operation: string;
    private readonly _sql: string;
    private readonly _params: Array<any>;
    
    
    public get operation(): string { return this._operation; }
    public get sql(): string { return this._sql; }
    public get params(): ReadonlyArray<any> { return this._params; }
    
    
    public constructor(operationType: OperationType, sql: string, params: ReadonlyArray<any>, err?: Error)
    {
        given(operationType, "operationType").ensureHasValue();
        given(sql, "sql").ensureHasValue();
        given(params, "params").ensureHasValue();
        
        let operation = operationType === OperationType.query ? "query" : "command";
        let message = `Error during ${operation} operation with sql "${sql}" and params [${params}].`;
        super(message, err);
        
        this._operation = operation;
        this._sql = sql;
        this._params = [...params];
    }
}