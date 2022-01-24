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
exports.KnexPgDb = void 0;
const db_exception_1 = require("../exceptions/db-exception");
const operation_type_1 = require("../exceptions/operation-type");
const n_ject_1 = require("@nivinjoseph/n-ject");
const knex_pg_read_db_1 = require("./knex-pg-read-db");
// public
let KnexPgDb = class KnexPgDb extends knex_pg_read_db_1.KnexPgReadDb {
    constructor(dbConnectionFactory) {
        super(dbConnectionFactory);
    }
    executeCommand(sql, ...params) {
        const promise = new Promise((resolve, reject) => {
            this.dbConnectionFactory.create()
                .then((knex) => {
                // tslint:disable-next-line: no-floating-promises
                knex.raw(sql, params).asCallback((err, result) => {
                    if (err) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, err));
                        return;
                    }
                    if (!this.validateCommandResult(result)) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, new Error("No rows were affected.")));
                        return;
                    }
                    resolve();
                });
            })
                .catch(err => reject(err));
        });
        return promise;
    }
    executeCommandWithinUnitOfWork(transactionProvider, sql, ...params) {
        const promise = new Promise((resolve, reject) => {
            transactionProvider.getTransactionScope()
                .then((trx) => {
                // tslint:disable-next-line: no-floating-promises
                trx.raw(sql, params).asCallback((err, result) => {
                    if (err) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, err));
                        return;
                    }
                    if (!this.validateCommandResult(result)) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, new Error("No rows were affected.")));
                        return;
                    }
                    resolve();
                });
            })
                .catch(err => reject(err));
        });
        return promise;
    }
    validateCommandResult(result) {
        const command = result.command;
        const rowCount = result.rowCount;
        let commands = ["INSERT", "UPDATE"];
        if (commands.some(t => t === command)) {
            if (rowCount === undefined || rowCount === null || Number.isNaN(rowCount) || rowCount <= 0)
                return false;
        }
        return true;
    }
};
KnexPgDb = __decorate([
    (0, n_ject_1.inject)("DbConnectionFactory"),
    __metadata("design:paramtypes", [Object])
], KnexPgDb);
exports.KnexPgDb = KnexPgDb;
//# sourceMappingURL=knex-pg-db.js.map