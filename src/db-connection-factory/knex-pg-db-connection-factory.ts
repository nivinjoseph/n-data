import { DbConnectionFactory } from "./db-connection-factory.js";
import { given } from "@nivinjoseph/n-defensive";
import knex, { Knex } from "knex";
import Pg from "pg";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { DbConnectionConfig } from "./db-connection-config.js";
import { Delay } from "@nivinjoseph/n-util";

// public
export class KnexPgDbConnectionFactory implements DbConnectionFactory
{
    private readonly _config: Knex.Config = {
        client: "pg",
        pool: {
            min: 5,
            max: 25
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

            // Pg.defaults.ssl = true; // this is a workaround
            Pg.defaults.ssl = {
                rejectUnauthorized: false
            }; // this is a workaround
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

        this._knex = knex(this._config);
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
            this._disposePromise = Delay.seconds(15).then(() =>
            {
                return new Promise<void>((resolve, reject) =>
                    this._knex.destroy((err: any) =>
                    {
                        if (err)
                        {
                            reject(err);
                            return;
                        }

                        resolve();
                    }));
            });
        }

        return this._disposePromise!;
    }
}