import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { DbException } from "../exceptions/db-exception.js";
import { OperationType } from "../exceptions/operation-type.js";
import { inject } from "@nivinjoseph/n-ject";
import { KnexPgReadDb } from "./knex-pg-read-db.js";
// public
let KnexPgDb = (() => {
    let _classDecorators = [inject("DbConnectionFactory")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = KnexPgReadDb;
    var KnexPgDb = _classThis = class extends _classSuper {
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
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }
                        if (!this._validateCommandResult(result)) {
                            reject(new DbException(OperationType.command, sql, params, new Error("No rows were affected.")));
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
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }
                        if (!this._validateCommandResult(result)) {
                            reject(new DbException(OperationType.command, sql, params, new Error("No rows were affected.")));
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
    __setFunctionName(_classThis, "KnexPgDb");
    (() => {
        var _a;
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create((_a = _classSuper[Symbol.metadata]) !== null && _a !== void 0 ? _a : null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        KnexPgDb = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return KnexPgDb = _classThis;
})();
export { KnexPgDb };
//# sourceMappingURL=knex-pg-db.js.map