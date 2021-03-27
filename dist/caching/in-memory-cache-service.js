"use strict";
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
exports.InMemoryCacheService = void 0;
const n_util_1 = require("@nivinjoseph/n-util");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const timers_1 = require("timers");
class InMemoryCacheService {
    constructor() {
        this._store = new Map();
        this._evictionTracking = new Map();
        this._isDisposed = false;
        this._timer = timers_1.setInterval(() => this.evict(), n_util_1.Duration.fromMinutes(5));
    }
    store(key, value, expirySeconds) {
        return __awaiter(this, void 0, void 0, function* () {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            n_defensive_1.given(value, "value").ensureHasValue();
            n_defensive_1.given(expirySeconds, "expirySeconds").ensureIsNumber().ensure(t => t > 0);
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = key.trim();
            this._store.set(key, JSON.stringify(value));
            if (expirySeconds == null) {
                if (this._evictionTracking.has(key))
                    this._evictionTracking.delete(key);
            }
            else {
                this._evictionTracking.set(key, Date.now() + n_util_1.Duration.fromSeconds(expirySeconds));
            }
        });
    }
    retrieve(key) {
        n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
        if (this._isDisposed)
            throw new n_exception_1.ObjectDisposedException(this);
        key = key.trim();
        return this._store.has(key) ? JSON.parse(this._store.get(key)) : null;
    }
    exists(key) {
        return __awaiter(this, void 0, void 0, function* () {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            return this._store.has(key.trim());
        });
    }
    remove(key) {
        return __awaiter(this, void 0, void 0, function* () {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = key.trim();
            if (this._store.has(key))
                this._store.delete(key);
            if (this._evictionTracking.has(key))
                this._evictionTracking.delete(key);
        });
    }
    dispose() {
        if (this._isDisposed)
            return Promise.resolve();
        this._isDisposed = true;
        timers_1.clearInterval(this._timer);
        return Promise.resolve();
    }
    evict() {
        if (this._isDisposed)
            return;
        for (let entry of this._store.entries()) {
            const key = entry[0];
            if (this._evictionTracking.has(key)) {
                const expiry = this._evictionTracking.get(key);
                if (expiry <= Date.now()) {
                    this._store.delete(key);
                    this._evictionTracking.delete(key);
                }
            }
        }
    }
}
exports.InMemoryCacheService = InMemoryCacheService;
//# sourceMappingURL=in-memory-cache-service.js.map