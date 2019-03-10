import { DbConnectionFactory } from "./db-connection-factory";
import "@nivinjoseph/n-ext";
export declare class KnexPgDbConnectionFactory implements DbConnectionFactory {
    private readonly _config;
    private _knex;
    private _isDisposed;
    constructor(host: string, port: string, database: string, username: string, password: string);
    create(): Promise<object>;
    dispose(): Promise<void>;
}
