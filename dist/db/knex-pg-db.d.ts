import { Db } from "./db.js";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory.js";
import { TransactionProvider } from "../unit-of-work/transaction-provider.js";
import { KnexPgReadDb } from "./knex-pg-read-db.js";
export declare class KnexPgDb extends KnexPgReadDb implements Db {
    constructor(dbConnectionFactory: DbConnectionFactory);
    executeCommand(sql: string, ...params: Array<any>): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>;
    private _validateCommandResult;
}
//# sourceMappingURL=knex-pg-db.d.ts.map