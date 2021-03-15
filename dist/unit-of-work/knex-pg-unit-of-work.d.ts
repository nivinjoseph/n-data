import { UnitOfWork } from "./unit-of-work";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
export declare class KnexPgUnitOfWork implements UnitOfWork {
    private readonly _dbConnectionFactory;
    private _transactionScope;
    constructor(dbConnectionFactory: DbConnectionFactory);
    getTransactionScope(): Promise<object>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
}
