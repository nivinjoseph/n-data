"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgDb = void 0;
const tslib_1 = require("tslib");
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
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                knex.raw(sql, params).asCallback((err, result) => {
                    if (err) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, err));
                        return;
                    }
                    if (!this._validateCommandResult(result)) {
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
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                trx.raw(sql, params).asCallback((err, result) => {
                    if (err) {
                        reject(new db_exception_1.DbException(operation_type_1.OperationType.command, sql, params, err));
                        return;
                    }
                    if (!this._validateCommandResult(result)) {
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
    _validateCommandResult(result) {
        const command = result.command;
        const rowCount = result.rowCount;
        const commands = ["INSERT", "UPDATE"];
        if (commands.some(t => t === command)) {
            if (rowCount === undefined || rowCount === null || Number.isNaN(rowCount) || rowCount <= 0)
                return false;
        }
        return true;
    }
};
KnexPgDb = tslib_1.__decorate([
    (0, n_ject_1.inject)("DbConnectionFactory"),
    tslib_1.__metadata("design:paramtypes", [Object])
], KnexPgDb);
exports.KnexPgDb = KnexPgDb;
//# sourceMappingURL=knex-pg-db.js.map