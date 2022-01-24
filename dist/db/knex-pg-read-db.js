"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgReadDb = void 0;
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
                // tslint:disable-next-line: no-floating-promises
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
KnexPgReadDb = __decorate([
    (0, n_ject_1.inject)("ReadDbConnectionFactory"),
    __metadata("design:paramtypes", [Object])
], KnexPgReadDb);
exports.KnexPgReadDb = KnexPgReadDb;
//# sourceMappingURL=knex-pg-read-db.js.map