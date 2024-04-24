import { DbConnectionFactory } from "./db-connection-factory.js";
import { DbConnectionConfig } from "./db-connection-config.js";
export declare class KnexPgDbConnectionFactory implements DbConnectionFactory {
    private readonly _config;
    private readonly _knex;
    private _isDisposed;
    private _disposePromise;
    constructor(connectionString: string);
    constructor(connectionConfig: DbConnectionConfig);
    create(): Promise<object>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=knex-pg-db-connection-factory.d.ts.map