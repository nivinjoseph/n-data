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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnexPgUnitOfWork = void 0;
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
// public
let KnexPgUnitOfWork = class KnexPgUnitOfWork {
    constructor(dbConnectionFactory) {
        this._onCommits = new Array();
        this._onRollbacks = new Array();
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
                    .then(() => { })
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
        return __awaiter(this, void 0, void 0, function* () {
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
        return __awaiter(this, void 0, void 0, function* () {
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
KnexPgUnitOfWork = __decorate([
    (0, n_ject_1.inject)("DbConnectionFactory"),
    __metadata("design:paramtypes", [Object])
], KnexPgUnitOfWork);
exports.KnexPgUnitOfWork = KnexPgUnitOfWork;
//# sourceMappingURL=knex-pg-unit-of-work.js.map