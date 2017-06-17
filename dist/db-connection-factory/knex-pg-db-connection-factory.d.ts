import { DbConnectionFactory } from "./db-connection-factory";
import "n-ext";
export declare class KnexPgDbConnectionFactory implements DbConnectionFactory {
    private readonly _config;
    private _knex;
    private _isDestroyed;
    constructor(host: string, port: string, database: string, username: string, password: string);
    create(): Promise<object>;
    destructor(): Promise<void>;
}
