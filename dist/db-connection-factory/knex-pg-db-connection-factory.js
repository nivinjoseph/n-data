"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const n_defensive_1 = require("n-defensive");
require("n-ext");
const Knex = require("knex");
const n_exception_1 = require("n-exception");
// public
class KnexPgDbConnectionFactory {
    constructor(host, port, database, username, password) {
        this._config = {
            client: "pg",
            pool: {
                min: 2,
                max: 10
            }
            // debug: true
        };
        this._isDestroyed = false;
        n_defensive_1.given(host, "host").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        n_defensive_1.given(port, "port").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        n_defensive_1.given(database, "database").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        n_defensive_1.given(username, "username").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        n_defensive_1.given(password, "password").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        this._config.connection = {
            host: host.trim(),
            port: port.trim(),
            database: database.trim(),
            user: username.trim(),
            password: password.trim()
        };
        this._knex = Knex(this._config);
    }
    create() {
        if (this._isDestroyed)
            throw new n_exception_1.InvalidOperationException("using destroyed instance");
        return Promise.resolve(this._knex);
    }
    destructor() {
        if (this._isDestroyed)
            return Promise.resolve();
        let knex = this._knex;
        this._knex = null;
        return new Promise((resolve, reject) => {
            knex.destroy().then(() => resolve()).catch((err) => reject(err));
        });
    }
}
exports.KnexPgDbConnectionFactory = KnexPgDbConnectionFactory;
//# sourceMappingURL=knex-pg-db-connection-factory.js.map