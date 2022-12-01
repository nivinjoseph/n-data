import { UnitOfWork } from "./unit-of-work";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
export declare class KnexPgUnitOfWork implements UnitOfWork {
    private readonly _dbConnectionFactory;
    private readonly _onCommits;
    private readonly _onRollbacks;
    private _transactionScope;
    constructor(dbConnectionFactory: DbConnectionFactory);
    getTransactionScope(): Promise<object>;
    onCommit(callback: () => Promise<void>, priority?: number): void;
    commit(): Promise<void>;
    onRollback(callback: () => Promise<void>, priority?: number): void;
    rollback(): Promise<void>;
}
