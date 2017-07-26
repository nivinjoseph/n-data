import { Db } from "./db";
import "n-ext";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { QueryResult } from "./query-result";
export declare class KnexPgDb implements Db {
    private readonly _dbConnectionFactory;
    constructor(dbConnectionFactory: DbConnectionFactory);
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
    executeCommand(sql: string, ...params: any[]): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: any[]): Promise<void>;
    private validateCommandResult(result);
}
