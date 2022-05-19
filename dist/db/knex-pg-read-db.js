"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgReadDb = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const db_exception_1 = require("../exceptions/db-exception");
const operation_type_1 = require("../exceptions/operation-type");
const n_ject_1 = require("@nivinjoseph/n-ject");
const query_result_1 = require("./query-result");
// public
let KnexPgReadDb = class KnexPgReadDb {
    constructor(dbConnectionFactory) {
        (0, n_defensive_1.given)(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();
        this._dbConnectionFactory = dbConnectionFactory;
    }
    get dbConnectionFactory() { return this._dbConnectionFactory; }
    executeQuery(sql, ...params) {
        const promise = new Promise((resolve, reject) => {
            this._dbConnectionFactory.create()
                .then((knex) => {
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                knex.raw(sql, params).asCallback((err, result) => {
                    if (err) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.query, sql, params, err));
                    }
                    else {
                        resolve(new query_result_1.QueryResult(result.rows));
                    }
                });
            })
                .catch(err => reject(err));
        });
        return promise;
    }
};
KnexPgReadDb = tslib_1.__decorate([
    (0, n_ject_1.inject)("ReadDbConnectionFactory"),
    tslib_1.__metadata("design:paramtypes", [Object])
], KnexPgReadDb);
exports.KnexPgReadDb = KnexPgReadDb;
//# sourceMappingURL=knex-pg-read-db.js.map