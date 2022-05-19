"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryCacheService = void 0;
const tslib_1 = require("tslib");
const n_util_1 = require("@nivinjoseph/n-util");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const timers_1 = require("timers");
class InMemoryCacheService {
    constructor() {
        this._store = new Map();
        this._evictionTracking = new Map();
        this._isDisposed = false;
        this._timer = (0, timers_1.setInterval)(() => this._evict(), n_util_1.Duration.fromMinutes(5).toMilliSeconds());
    }
    store(key, value, expiryDuration) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(value, "value").ensureHasValue();
            (0, n_defensive_1.given)(expiryDuration, "expiryDuration").ensureIsInstanceOf(n_util_1.Duration);
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = key.trim();
            this._store.set(key, JSON.stringify(value));
            if (expiryDuration == null) {
                if (this._evictionTracking.has(key))
                    this._evictionTracking.delete(key);
            }
            else {
                this._evictionTracking.set(key, Date.now() + expiryDuration.toMilliSeconds());
            }
        });
    }
    retrieve(key) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = key.trim();
            return this._store.has(key) ? JSON.parse(this._store.get(key)) : null;
        });
    }
    exists(key) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            return this._store.has(key.trim());
        });
    }
    remove(key) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
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
        (0, timers_1.clearInterval)(this._timer);
        return Promise.resolve();
    }
    _evict() {
        var _a;
        if (this._isDisposed)
            return;
        for (const entry of this._store.entries()) {
            const key = entry[0];
            if (this._evictionTracking.has(key)) {
                const expiry = (_a = this._evictionTracking.get(key)) !== null && _a !== void 0 ? _a : 0;
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