"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgUnitOfWork = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
// public
let KnexPgUnitOfWork = class KnexPgUnitOfWork {
    constructor(dbConnectionFactory) {
        this._onCommits = new Array();
        this._onRollbacks = new Array();
        this._transactionScope = null;
        (0, n_defensive_1.given)(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();
        this._dbConnectionFactory = dbConnectionFactory;
    }
    getTransactionScope() {
        if (this._transactionScope) {
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                return Promise.reject(new n_exception_1.InvalidOperationException("using completed UnitOfWork"));
            return Promise.resolve(this._transactionScope.trx);
        }
        const promise = new Promise((resolve, reject) => {
            this._dbConnectionFactory.create()
                .then((knex) => {
                knex
                    .transaction((trx) => {
                    if (this._transactionScope) {
                        // eslint-disable-next-line @typescript-eslint/no-floating-promises
                        trx.rollback();
                        if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                            reject(new n_exception_1.InvalidOperationException("using completed UnitOfWork"));
                        else
                            resolve(this._transactionScope.trx);
                    }
                    else {
                        this._transactionScope = {
                            trx: trx,
                            isCommitting: false,
                            isCommitted: false,
                            isRollingBack: false,
                            isRolledBack: false
                        };
                        resolve(this._transactionScope.trx);
                    }
                })
                    .catch(() => { });
            })
                .catch(err => reject(err));
        });
        return promise;
    }
    onCommit(callback) {
        (0, n_defensive_1.given)(callback, "callback").ensureHasValue().ensureIsFunction();
        this._onCommits.push(callback);
    }
    commit() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!this._transactionScope) {
                if (this._onCommits.isNotEmpty)
                    yield Promise.all(this._onCommits.map(t => t()));
                return;
            }
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                throw new n_exception_1.InvalidOperationException("committing completed UnitOfWork");
            if (this._transactionScope.isCommitting)
                throw new n_exception_1.InvalidOperationException("double committing UnitOfWork");
            this._transactionScope.isCommitting = true;
            const promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.commit()
                    .then(() => {
                    this._transactionScope.isCommitted = true;
                    resolve();
                })
                    .catch((err) => reject(err));
            });
            yield promise;
            if (this._onCommits.isNotEmpty)
                yield Promise.all(this._onCommits.map(t => t()));
        });
    }
    onRollback(callback) {
        (0, n_defensive_1.given)(callback, "callback").ensureHasValue().ensureIsFunction();
        this._onRollbacks.push(callback);
    }
    rollback() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!this._transactionScope) {
                if (this._onRollbacks.isNotEmpty)
                    yield Promise.all(this._onRollbacks.map(t => t()));
                return;
            }
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                throw new n_exception_1.InvalidOperationException("rolling back completed UnitOfWork");
            if (this._transactionScope.isRollingBack)
                throw new n_exception_1.InvalidOperationException("double rolling back UnitOfWork");
            this._transactionScope.isRollingBack = true;
            const promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.rollback("[DELIBERATE]")
                    .then(() => {
                    this._transactionScope.isRolledBack = true;
                    resolve();
                })
                    .catch((err) => reject(err));
            });
            yield promise;
            if (this._onRollbacks.isNotEmpty)
                yield Promise.all(this._onRollbacks.map(t => t()));
        });
    }
};
KnexPgUnitOfWork = tslib_1.__decorate([
    (0, n_ject_1.inject)("DbConnectionFactory"),
    tslib_1.__metadata("design:paramtypes", [Object])
], KnexPgUnitOfWork);
exports.KnexPgUnitOfWork = KnexPgUnitOfWork;
//# sourceMappingURL=knex-pg-unit-of-work.js.map