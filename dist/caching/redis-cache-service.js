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
exports.RedisCacheService = void 0;
const Redis = require("redis");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_exception_1 = require("@nivinjoseph/n-exception");
const n_ject_1 = require("@nivinjoseph/n-ject");
let RedisCacheService = class RedisCacheService {
    constructor(redisClient) {
        this._isDisposed = false;
        this._disposePromise = null;
        (0, n_defensive_1.given)(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
    }
    store(key, value, expirySeconds) {
        return new Promise((resolve, reject) => {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(value, "value").ensureHasValue();
            (0, n_defensive_1.given)(expirySeconds, "expirySeconds").ensureIsNumber().ensure(t => t > 0);
            if (this._isDisposed) {
                reject(new n_exception_1.ObjectDisposedException(this));
                return;
            }
            if (expirySeconds == null) {
                this._client.set(key.trim(), JSON.stringify(value), (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }
            else {
                this._client.setex(key.trim(), expirySeconds, JSON.stringify(value), (err) => {
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
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
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
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
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
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
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
            this._disposePromise = Promise.resolve();
        }
        return this._disposePromise;
    }
};
RedisCacheService = __decorate([
    (0, n_ject_1.inject)("RedisClient"),
    __metadata("design:paramtypes", [Redis.RedisClient])
], RedisCacheService);
exports.RedisCacheService = RedisCacheService;
//# sourceMappingURL=redis-cache-service.js.map