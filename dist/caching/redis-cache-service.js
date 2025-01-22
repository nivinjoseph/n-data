"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheService = void 0;
const tslib_1 = require("tslib");
const n_util_1 = require("@nivinjoseph/n-util");
const Redis = require("redis");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
const Zlib = require("zlib");
let RedisCacheService = class RedisCacheService {
    constructor(redisClient) {
        this._isDisposed = false;
        this._disposePromise = null;
        (0, n_defensive_1.given)(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
    }
    store(key, value, expiryDuration) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(value, "value").ensureHasValue();
            (0, n_defensive_1.given)(expiryDuration, "expiryDuration").ensureIsObject();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const data = yield this._compressData(value);
            yield new Promise((resolve, reject) => {
                if (expiryDuration == null) {
                    this._client.set(key, data, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                }
                else {
                    this._client.setex(key, expiryDuration.toSeconds(true), data, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                }
            });
        });
    }
    retrieve(key) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const buffer = yield new Promise((resolve, reject) => {
                this._client.get(key, (err, value) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(value);
                });
            });
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (buffer == null)
                return null;
            return yield this._decompressData(buffer);
        });
    }
    exists(key) {
        return new Promise((resolve, reject) => {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            key = "bin_" + key.trim();
            this._client.exists(key, (err, result) => {
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
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            key = "bin_" + key.trim();
            this._client.del(key, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }
    dispose() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!this._isDisposed) {
                this._isDisposed = true;
                this._disposePromise = Promise.resolve();
            }
            return this._disposePromise;
        });
    }
    _compressData(data) {
        return n_util_1.Make.callbackToPromise(Zlib.deflateRaw)(Buffer.from(JSON.stringify(data), "utf8"));
    }
    _decompressData(data) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const decompressed = yield n_util_1.Make.callbackToPromise(Zlib.inflateRaw)(data);
            return JSON.parse(decompressed.toString("utf8"));
        });
    }
};
RedisCacheService = tslib_1.__decorate([
    (0, n_ject_1.inject)("CacheRedisClient"),
    tslib_1.__metadata("design:paramtypes", [Redis.RedisClient])
], RedisCacheService);
exports.RedisCacheService = RedisCacheService;
//# sourceMappingURL=redis-cache-service.js.map