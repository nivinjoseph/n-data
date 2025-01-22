import { UnitOfWork } from "./unit-of-work.js";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory.js";
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
//# sourceMappingURL=knex-pg-unit-of-work.d.ts.map