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
exports.RedisDistributedLockService = void 0;
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
    lock(key) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
                key = `n-data-dlock-${key.trim().toLowerCase()}`;
                if (this._isDisposed) {
                    reject(new n_exception_1.ObjectDisposedException(this));
                    return;
                }
                this._redLock.lock(key, 8000)
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
RedisDistributedLockService = __decorate([
    (0, n_ject_1.inject)("RedisClient"),
    __metadata("design:paramtypes", [Redis.RedisClient])
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