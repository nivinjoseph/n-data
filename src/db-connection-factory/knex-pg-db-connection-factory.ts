import { DbConnectionFactory } from "./db-connection-factory";
import { given } from "@nivinjoseph/n-defensive";
import "@nivinjoseph/n-ext";
import * as Knex from "knex";
import * as Pg from "pg";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { DbConnectionConfig } from "./db-connection-config";

// public
export class KnexPgDbConnectionFactory implements DbConnectionFactory
{
    private readonly _config: Knex.Config = {
        client: "pg",
        pool: {
            min: 10,
            max: 100
        }
        // debug: true
    };
    private readonly _knex: Knex;
    
    private _isDisposed = false;
    private _disposePromise: Promise<void> | null = null;
    
    
    public constructor(connectionString: string);
    public constructor(connectionConfig: DbConnectionConfig);
    public constructor(config: string | DbConnectionConfig)
    {
        if (config && typeof config === "string")
        {
            const connectionString = config;
            given(connectionString, "connectionString").ensureHasValue().ensureIsString();
            this._config.connection = connectionString.trim();
            
            Pg.defaults.ssl = true; // this is a workaround
        }
        else
        {
            const connectionConfig: DbConnectionConfig = config as DbConnectionConfig;
            given(connectionConfig, "connectionConfig").ensureHasValue().ensureIsObject()
                .ensureHasStructure({
                    host: "string",
                    port: "string",
                    database: "string",
                    username: "string",
                    password: "string"
                });
            
            this._config.connection = {
                host: connectionConfig.host.trim(),
                port: Number.parseInt(connectionConfig.port.trim()),
                database: connectionConfig.database.trim(),
                user: connectionConfig.username.trim(),
                password: connectionConfig.password.trim()
            };
        }

        this._knex = Knex(this._config);
    }
    
    
    public create(): Promise<object>
    {
        if (this._isDisposed)
            return Promise.reject(new ObjectDisposedException(this));
        
        return Promise.resolve(this._knex);
    }
    
    public dispose(): Promise<void>
    {
        if (!this._isDisposed)
        {
            this._isDisposed = true;    
            this._disposePromise = new Promise<void>((resolve, reject) =>
                this._knex.destroy().then(() => resolve()).catch((err) => reject(err)));
        }
        
        return this._disposePromise;
    }
}