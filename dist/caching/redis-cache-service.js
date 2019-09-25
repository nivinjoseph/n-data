"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Redis = require("redis");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_config_1 = require("@nivinjoseph/n-config");
class RedisCacheService {
    constructor() {
        this._client = n_config_1.ConfigurationManager.getConfig("env") === "dev"
            ? Redis.createClient() : Redis.createClient(n_config_1.ConfigurationManager.getConfig("REDIS_URL"));
        this._isDisposed = false;
        this._disposePromise = null;
    }
    store(key, value, expiry) {
        return new Promise((resolve, reject) => {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            n_defensive_1.given(value, "value").ensureHasValue();
            n_defensive_1.given(expiry, "expiry").ensureIsNumber().ensure(t => t > 0);
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            if (expiry == null) {
                this._client.set(key.trim(), JSON.stringify(value), (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }
            else {
                this._client.setex(key.trim(), expiry, JSON.stringify(value), (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }
        });
    }
    retrieve(key) {
        return new Promise((resolve, reject) => {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            this._client.get(key.trim(), (err, value) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(JSON.parse(value));
            });
        });
    }
    exists(key) {
        return new Promise((resolve, reject) => {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            this._client.exists(key.trim(), (err, result) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(!!result);
            });
        });
    }
    remove(key) {
        return new Promise((resolve, reject) => {
            n_defensive_1.given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            this._client.del(key.trim(), (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }
    dispose() {
        if (!this._isDisposed) {
            this._isDisposed = true;
            this._disposePromise = new Promise((resolve, _) => this._client.quit(() => resolve()));
        }
        return this._disposePromise;
    }
}
exports.RedisCacheService = RedisCacheService;
//# sourceMappingURL=redis-cache-service.js.map