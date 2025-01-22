"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgDbConnectionFactory = void 0;
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const knex_1 = require("knex");
const Pg = require("pg");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_util_1 = require("@nivinjoseph/n-util");
// public
class KnexPgDbConnectionFactory {
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
            (0, n_defensive_1.given)(connectionString, "connectionString").ensureHasValue().ensureIsString();
            this._config.connection = connectionString.trim();
            // Pg.defaults.ssl = true; // this is a workaround
            Pg.defaults.ssl = {
                rejectUnauthorized: false
            }; // this is a workaround
        }
        else {
            const connectionConfig = config;
            (0, n_defensive_1.given)(connectionConfig, "connectionConfig").ensureHasValue().ensureIsObject()
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
        this._knex = (0, knex_1.knex)(this._config);
    }
    create() {
        if (this._isDisposed)
            return Promise.reject(new n_exception_1.ObjectDisposedException(this));
        return Promise.resolve(this._knex);
    }
    dispose() {
        if (!this._isDisposed) {
            this._isDisposed = true;
            this._disposePromise = n_util_1.Delay.seconds(15).then(() => {
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
exports.KnexPgDbConnectionFactory = KnexPgDbConnectionFactory;
//# sourceMappingURL=knex-pg-db-connection-factory.js.map