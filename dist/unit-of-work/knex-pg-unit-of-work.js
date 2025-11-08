import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { InvalidOperationException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
// public
let KnexPgUnitOfWork = (() => {
    let _classDecorators = [inject("DbConnectionFactory")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var KnexPgUnitOfWork = _classThis = class {
        constructor(dbConnectionFactory) {
            this._onCommits = new Array();
            this._onRollbacks = new Array();
            this._transactionScope = null;
            given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();
            this._dbConnectionFactory = dbConnectionFactory;
        }
        getTransactionScope() {
            if (this._transactionScope) {
                if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                    return Promise.reject(new InvalidOperationException("using completed UnitOfWork"));
                return Promise.resolve(this._transactionScope.trx);
            }
            const promise = new Promise((resolve, reject) => {
                this._dbConnectionFactory.create()
                    .then((knex) => {
                    knex
                        .transaction((trx) => {
                        if (this._transactionScope) {
                            trx.rollback();
                            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                                reject(new InvalidOperationException("using completed UnitOfWork"));
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
        onCommit(callback, priority) {
            given(callback, "callback").ensureHasValue().ensureIsFunction();
            given(priority, "priority").ensureIsNumber().ensure(t => t >= 0);
            priority !== null && priority !== void 0 ? priority : (priority = 0);
            this._onCommits.push({
                callback,
                priority
            });
        }
        async commit() {
            if (!this._transactionScope) {
                if (this._onCommits.isNotEmpty)
                    await this._onCommits
                        .groupBy(t => t.priority.toString())
                        .orderBy(t => Number.parseInt(t.key))
                        .forEachAsync(t => Promise.all(t.values.map(v => v.callback())), 1);
                return;
            }
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                throw new InvalidOperationException("committing completed UnitOfWork");
            if (this._transactionScope.isCommitting)
                throw new InvalidOperationException("double committing UnitOfWork");
            this._transactionScope.isCommitting = true;
            const promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.commit()
                    .then(() => {
                    this._transactionScope.isCommitted = true;
                    resolve();
                })
                    .catch((err) => reject(err));
            });
            await promise;
            if (this._onCommits.isNotEmpty)
                await this._onCommits
                    .groupBy(t => t.priority.toString())
                    .orderBy(t => Number.parseInt(t.key))
                    .forEachAsync(t => Promise.all(t.values.map(v => v.callback())), 1);
        }
        onRollback(callback, priority) {
            given(callback, "callback").ensureHasValue().ensureIsFunction();
            given(priority, "priority").ensureIsNumber().ensure(t => t >= 0);
            priority !== null && priority !== void 0 ? priority : (priority = 0);
            this._onRollbacks.push({
                callback,
                priority
            });
        }
        async rollback() {
            if (!this._transactionScope) {
                if (this._onRollbacks.isNotEmpty)
                    await this._onRollbacks
                        .groupBy(t => t.priority.toString())
                        .orderBy(t => Number.parseInt(t.key))
                        .forEachAsync(t => Promise.all(t.values.map(v => v.callback())), 1);
                return;
            }
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                throw new InvalidOperationException("rolling back completed UnitOfWork");
            if (this._transactionScope.isRollingBack)
                throw new InvalidOperationException("double rolling back UnitOfWork");
            this._transactionScope.isRollingBack = true;
            const promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.rollback("[DELIBERATE]")
                    .then(() => {
                    this._transactionScope.isRolledBack = true;
                    resolve();
                })
                    .catch((err) => reject(err));
            });
            await promise;
            if (this._onRollbacks.isNotEmpty)
                await this._onRollbacks
                    .groupBy(t => t.priority.toString())
                    .orderBy(t => Number.parseInt(t.key))
                    .forEachAsync(t => Promise.all(t.values.map(v => v.callback())), 1);
        }
    };
    __setFunctionName(_classThis, "KnexPgUnitOfWork");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        KnexPgUnitOfWork = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return KnexPgUnitOfWork = _classThis;
})();
export { KnexPgUnitOfWork };
//# sourceMappingURL=knex-pg-unit-of-work.js.map