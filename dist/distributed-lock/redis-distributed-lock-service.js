"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisDistributedLockService = void 0;
const tslib_1 = require("tslib");
const n_util_1 = require("@nivinjoseph/n-util");
const Redis = require("redis");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
const RedLock = require("redlock");
let RedisDistributedLockService = class RedisDistributedLockService {
    constructor(redisClient) {
        this._isDisposed = false;
        this._disposePromise = null;
        (0, n_defensive_1.given)(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
        this._redLock = new RedLock([this._client], {
            // the expected clock drift; for more details
            // see http://redis.io/topics/distlock
            driftFactor: 0.01,
            // the max number of times Redlock will attempt
            // to lock a resource before erroring
            retryCount: 25,
            // the time in ms between attempts
            retryDelay: 400,
            // the max time in ms randomly added to retries
            // to improve performance under high contention
            // see https://www.awsarchitectureblog.com/2015/03/backoff.html
            retryJitter: 200 // time in ms
        });
    }
    lock(key, ttlDuration) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
                key = `n-data-dlock-${key.trim().toLowerCase()}`;
                if (this._isDisposed) {
                    reject(new n_exception_1.ObjectDisposedException(this));
                    return;
                }
                this._redLock.lock(key, (ttlDuration !== null && ttlDuration !== void 0 ? ttlDuration : n_util_1.Duration.fromSeconds(30)).toMilliSeconds())
                    .then(lock => resolve(new RedisDistributedLock(lock)))
                    .catch(e => reject(e));
            });
        });
    }
    dispose() {
        if (!this._isDisposed) {
            this._isDisposed = true;
            this._disposePromise = Promise.resolve();
        }
        return this._disposePromise;
    }
};
RedisDistributedLockService = tslib_1.__decorate([
    (0, n_ject_1.inject)("RedisClient"),
    tslib_1.__metadata("design:paramtypes", [Redis.RedisClient])
], RedisDistributedLockService);
exports.RedisDistributedLockService = RedisDistributedLockService;
class RedisDistributedLock {
    constructor(lock) {
        (0, n_defensive_1.given)(lock, "lock").ensureHasValue();
        this._lock = lock;
    }
    release() {
        return new Promise((resolve, reject) => {
            this._lock.unlock().then(() => resolve()).catch((e) => reject(e));
        });
    }
}
//# sourceMappingURL=redis-distributed-lock-service.js.map