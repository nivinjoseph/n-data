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
exports.RedisCacheService = void 0;
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
    store(key, value, expirySeconds) {
        return __awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(value, "value").ensureHasValue();
            (0, n_defensive_1.given)(expirySeconds, "expirySeconds").ensureIsNumber().ensure(t => t > 0);
            if (this._isDisposed)
                throw new n_exception_1.ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const data = yield this._compressData(value);
            yield new Promise((resolve, reject) => {
                if (expirySeconds == null) {
                    this._client.set(key, data, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                }
                else {
                    this._client.setex(key, expirySeconds, data, (err) => {
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
        return __awaiter(this, void 0, void 0, function* () {
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
        if (!this._isDisposed) {
            this._isDisposed = true;
            this._disposePromise = Promise.resolve();
        }
        return this._disposePromise;
    }
    _compressData(data) {
        return n_util_1.Make.callbackToPromise(Zlib.deflateRaw)(Buffer.from(JSON.stringify(data), "utf8"));
    }
    _decompressData(data) {
        return __awaiter(this, void 0, void 0, function* () {
            const decompressed = yield n_util_1.Make.callbackToPromise(Zlib.inflateRaw)(data);
            return JSON.parse(decompressed.toString("utf8"));
        });
    }
};
RedisCacheService = __decorate([
    (0, n_ject_1.inject)("CacheRedisClient"),
    __metadata("design:paramtypes", [Redis.RedisClient])
], RedisCacheService);
exports.RedisCacheService = RedisCacheService;
//# sourceMappingURL=redis-cache-service.js.map