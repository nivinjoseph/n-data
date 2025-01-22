import { given } from "@nivinjoseph/n-defensive";
import knex from "knex";
import Pg from "pg";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { Delay } from "@nivinjoseph/n-util";
// public
export class KnexPgDbConnectionFactory {
    constructor(config) {
        this._config = {
            client: "pg",
            pool: {
                min: 5,
                max: 25
            }
            // debug: true
        };
        this._isDisposed = false;
        this._disposePromise = null;
        if (config && typeof config === "string") {
            const connectionString = config;
            given(connectionString, "connectionString").ensureHasValue().ensureIsString();
            this._config.connection = connectionString.trim();
            // Pg.defaults.ssl = true; // this is a workaround
            Pg.defaults.ssl = {
                rejectUnauthorized: false
            }; // this is a workaround
        }
        else {
            const connectionConfig = config;
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
    create() {
        if (this._isDisposed)
            return Promise.reject(new ObjectDisposedException(this));
        return Promise.resolve(this._knex);
    }
    dispose() {
        if (!this._isDisposed) {
            this._isDisposed = true;
            this._disposePromise = Delay.seconds(15).then(() => {
                return new Promise((resolve, reject) => this._knex.destroy((err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                }));
            });
        }
        return this._disposePromise;
    }
}
//# sourceMappingURL=knex-pg-db-connection-factory.js.map