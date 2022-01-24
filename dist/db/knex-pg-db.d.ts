import { Db } from "./db";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { KnexPgReadDb } from "./knex-pg-read-db";
export declare class KnexPgDb extends KnexPgReadDb implements Db {
    constructor(dbConnectionFactory: DbConnectionFactory);
    executeCommand(sql: string, ...params: any[]): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: any[]): Promise<void>;
    private validateCommandResult;
}
