import { DbConnectionFactory } from "./db-connection-factory";
import { DbConnectionConfig } from "./db-connection-config";
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
