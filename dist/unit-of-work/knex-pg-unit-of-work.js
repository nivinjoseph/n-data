import { __esDecorate, __runInitializers } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { InvalidOperationException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
// public
let KnexPgUnitOfWork = (() => {
    let _classDecorators = [inject("DbConnectionFactory")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var KnexPgUnitOfWork = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            KnexPgUnitOfWork = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        _dbConnectionFactory;
        _onCommits = new Array();
        _onRollbacks = new Array();
        _transactionScope = null;
        _transactionScopePromise = null;
        constructor(dbConnectionFactory) {
            given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();
            this._dbConnectionFactory = dbConnectionFactory;
        }
        async getTransactionScope() {
            if (this._transactionScope) {
                if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                    throw new InvalidOperationException("using completed UnitOfWork");
                return this._transactionScope.trx;
            }
            if (this._transactionScopePromise == null) {
                this._transactionScopePromise = this._createTransactionScope();
                // clear the cached promise on failure so a subsequent call can retry;
                // this handler is independent of the consumer's await, so rejection still propagates
                this._transactionScopePromise.catch(() => {
                    this._transactionScopePromise = null;
                });
            }
            return this._transactionScopePromise;
        }
        onCommit(callback, priority) {
            given(callback, "callback").ensureHasValue().ensureIsFunction();
            given(priority, "priority").ensureIsNumber().ensure(t => t >= 0);
            priority ??= 0;
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
            priority ??= 0;
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
        async _createTransactionScope() {
            const knex = await this._dbConnectionFactory.create();
            const trx = await knex.transaction();
            this._transactionScope = {
                trx,
                isCommitting: false,
                isCommitted: false,
                isRollingBack: false,
                isRolledBack: false
            };
            return trx;
        }
    };
    return KnexPgUnitOfWork = _classThis;
})();
export { KnexPgUnitOfWork };
//# sourceMappingURL=knex-pg-unit-of-work.js.map