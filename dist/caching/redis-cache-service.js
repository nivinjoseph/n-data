import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { Make } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
import { deflateRaw, inflateRaw } from "zlib";
import { commandOptions } from "redis";
let RedisCacheService = (() => {
    let _classDecorators = [inject("CacheRedisClient")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var RedisCacheService = _classThis = class {
        constructor(redisClient) {
            this._isDisposed = false;
            this._disposePromise = null;
            given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
            this._client = redisClient;
        }
        async store(key, value, expiryDuration) {
            given(key, "key").ensureHasValue().ensureIsString();
            given(value, "value").ensureHasValue();
            given(expiryDuration, "expiryDuration").ensureIsObject();
            if (this._isDisposed)
                throw new ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const data = await this._compressData(value);
            if (expiryDuration == null)
                await this._client.set(key, data);
            else
                await this._client.setEx(key, expiryDuration.toSeconds(true), data);
        }
        async retrieve(key) {
            given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const buffer = await this._client.get(commandOptions({
                returnBuffers: true
            }), key);
            if (buffer == null)
                return null;
            return await this._decompressData(buffer);
        }
        async exists(key) {
            given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new ObjectDisposedException(this);
            key = "bin_" + key.trim();
            const val = await this._client.exists(key);
            return !!val;
        }
        async remove(key) {
            given(key, "key").ensureHasValue().ensureIsString();
            if (this._isDisposed)
                throw new ObjectDisposedException(this);
            key = "bin_" + key.trim();
            await this._client.del(key);
        }
        async dispose() {
            if (!this._isDisposed) {
                this._isDisposed = true;
                this._disposePromise = Promise.resolve();
            }
            return this._disposePromise;
        }
        _compressData(data) {
            return Make.callbackToPromise(deflateRaw)(Buffer.from(JSON.stringify(data), "utf8"));
        }
        async _decompressData(data) {
            const decompressed = await Make.callbackToPromise(inflateRaw)(data);
            return JSON.parse(decompressed.toString("utf8"));
        }
    };
    __setFunctionName(_classThis, "RedisCacheService");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        RedisCacheService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return RedisCacheService = _classThis;
})();
export { RedisCacheService };
//# sourceMappingURL=redis-cache-service.js.map