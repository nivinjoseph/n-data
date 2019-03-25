import { DbConnectionFactory } from "./db-connection-factory";
import "@nivinjoseph/n-ext";
import { DbConnectionConfig } from "./db-connection-config";
export declare class KnexPgDbConnectionFactory implements DbConnectionFactory {
    private readonly _config;
    private _knex;
    private _isDisposed;
    constructor(connectionString: string);
    constructor(connectionConfig: DbConnectionConfig);
    create(): Promise<object>;
    dispose(): Promise<void>;
}
