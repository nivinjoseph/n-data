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
exports.KnexPgUnitOfWork = void 0;
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
let KnexPgUnitOfWork = (() => {
    let KnexPgUnitOfWork = class KnexPgUnitOfWork {
        constructor(dbConnectionFactory) {
            n_defensive_1.given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue();
            this._dbConnectionFactory = dbConnectionFactory;
        }
        getTransactionScope() {
            if (this._transactionScope) {
                if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                    return Promise.reject(new n_exception_1.InvalidOperationException("using completed UnitOfWork"));
                return Promise.resolve(this._transactionScope.trx);
            }
            let promise = new Promise((resolve, reject) => {
                this._dbConnectionFactory.create()
                    .then((knex) => {
                    knex
                        .transaction((trx) => {
                        if (this._transactionScope) {
                            trx.rollback();
                            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                                reject(new n_exception_1.InvalidOperationException("using completed UnitOfWork"));
                            else
                                resolve(this._transactionScope.trx);
                        }
                        else {
                            this._transactionScope = {
                                trx: trx,
                                isCommitted: false,
                                isRolledBack: false
                            };
                            resolve(this._transactionScope.trx);
                        }
                    })
                        .then(() => { })
                        .catch(() => { });
                })
                    .catch(err => reject(err));
            });
            return promise;
        }
        commit() {
            if (!this._transactionScope)
                return Promise.resolve();
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                return Promise.reject(new n_exception_1.InvalidOperationException("committing completed UnitOfWork"));
            this._transactionScope.isCommitted = true;
            let promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.commit()
                    .then(() => resolve())
                    .catch((err) => reject(err));
            });
            return promise;
        }
        rollback() {
            if (!this._transactionScope)
                return Promise.resolve();
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                return Promise.reject(new n_exception_1.InvalidOperationException("rolling back completed UnitOfWork"));
            this._transactionScope.isRolledBack = true;
            let promise = new Promise((resolve, reject) => {
                this._transactionScope.trx.rollback("[DELIBERATE]")
                    .then(() => resolve())
                    .catch((err) => reject(err));
            });
            return promise;
        }
    };
    KnexPgUnitOfWork = __decorate([
        n_ject_1.inject("DbConnectionFactory"),
        __metadata("design:paramtypes", [Object])
    ], KnexPgUnitOfWork);
    return KnexPgUnitOfWork;
})();
exports.KnexPgUnitOfWork = KnexPgUnitOfWork;
//# sourceMappingURL=knex-pg-unit-of-work.js.map