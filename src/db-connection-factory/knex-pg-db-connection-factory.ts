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
            min: 2,
            max: 10
        }
        // debug: true
    };

    private _knex: Knex;
    private _isDisposed = false;
    
    
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
                port: connectionConfig.port.trim(),
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
        if (this._isDisposed)
            return Promise.resolve();    
        
        this._isDisposed = true;
        
        const knex = this._knex;
        this._knex = null;
        return new Promise<void>((resolve, reject) =>
        {
            knex.destroy().then(() => resolve()).catch((err) => reject(err));
        });
    }
}