import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { Delay, Duration, Make, Uuid } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException, ObjectDisposedException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
import { createHash } from "node:crypto";
let RedisDistributedLockService = (() => {
    let _classDecorators = [inject("RedisClient")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var RedisDistributedLockService = _classThis = class {
        constructor(redisClient, config) {
            this._defaultConfig = {
                driftFactor: 0.01,
                retryCount: 25,
                retryDelay: Duration.fromMilliSeconds(400),
                retryJitter: Duration.fromMilliSeconds(200)
            };
            this._isDisposed = false;
            this._disposePromise = null;
            given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
            given(config, "config").ensureIsObject().ensureHasStructure({
                "driftFactor?": "number",
                "retryCount?": "number",
                "retryDelay?": "object",
                "retryJitter?": "object"
            });
            this._executer = new _RedisScriptExecuter(redisClient, Object.assign(Object.assign({}, this._defaultConfig), config == null ? {} : config));
        }
        async lock(key, ttlDuration) {
            given(key, "key").ensureHasValue().ensureIsString();
            key = `n-data-dlock-${key.trim().toLowerCase()}`;
            given(ttlDuration, "ttlDuration").ensureIsObject();
            if (this._isDisposed)
                throw new ObjectDisposedException(this);
            return this._executer.lock(key, ttlDuration);
        }
        dispose() {
            if (!this._isDisposed) {
                this._isDisposed = true;
                this._disposePromise = Promise.resolve();
            }
            return this._disposePromise;
        }
    };
    __setFunctionName(_classThis, "RedisDistributedLockService");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        RedisDistributedLockService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return RedisDistributedLockService = _classThis;
})();
export { RedisDistributedLockService };
class RedisDistributedLock {
    get key() { return this._key; }
    get value() { return this._value; }
    get expiration() { return this._expiration; }
    constructor(executer, key, value, expiration) {
        given(executer, "executer").ensureHasValue().ensureIsObject();
        this._executer = executer;
        given(key, "key").ensureHasValue().ensureIsString();
        this._key = key;
        given(value, "value").ensureHasValue().ensureIsString();
        this._value = value;
        given(expiration, "expiration").ensureHasValue().ensureIsObject();
        this._expiration = expiration;
    }
    release() {
        return this._executer.release(this);
    }
}
class _RedisScriptExecuter {
    constructor(client, config) {
        this._lockScript = `
        -- Return 0 if an key already exists 1 otherwise.
        -- ARGV[1] = value ARGV[2] = duration
        if redis.call("exists", KEYS[1]) == 1 then
            return 0
        end

        redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])

        return 1
    `;
        this._releaseScript = `
        -- Return 0 if key is already deleted or expired 1 otherwise.
        -- ARGV[1] = value for the key

        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del",KEYS[1])
        else
            return 0
        end
    `;
        given(client, "client").ensureHasValue().ensureIsObject();
        this._client = client;
        given(config, "config").ensureHasValue().ensureIsObject();
        this._config = config;
        this._lockScriptHash = this._hashScript(this._lockScript);
        this._releaseScriptHash = this._hashScript(this._releaseScript);
    }
    async lock(key, ttlDuration) {
        given(key, "key").ensureHasValue().ensureIsString();
        given(ttlDuration, "ttlDuration").ensureIsObject();
        const randomValue = Uuid.create();
        const duration = ttlDuration !== null && ttlDuration !== void 0 ? ttlDuration : Duration.fromSeconds(30);
        let attempts = 0;
        while (attempts < this._config.retryCount) {
            const result = await this._executeScript(this._lockScriptHash, this._lockScript, key, randomValue, duration.toMilliSeconds().toString());
            if (result)
                return new RedisDistributedLock(this, key, randomValue, duration);
            attempts++;
            const delayDuration = this._config.retryDelay.toMilliSeconds()
                + Make.randomInt(0, this._config.retryJitter.toMilliSeconds());
            await Delay.milliseconds(delayDuration);
        }
        throw new UnableToAcquireDistributedLockException(key);
    }
    async release(lock) {
        given(lock, "lock").ensureHasValue().ensureIsObject();
        await this._executeScript(this._releaseScriptHash, this._releaseScript, lock.key, lock.value);
    }
    async _executeScript(scriptHash, script, key, ...args) {
        given(scriptHash, "scriptHash").ensureHasValue().ensureIsString();
        given(script, "script").ensureHasValue().ensureIsString();
        given(key, "key").ensureHasValue().ensureIsString();
        given(args, "args").ensureHasValue().ensureIsArray();
        let result;
        try {
            // Attempt to evaluate the script by its hash.
            const hashResult = await this._client.evalSha(scriptHash, {
                keys: [key],
                arguments: args
            });
            if (typeof hashResult !== "number")
                throw new ApplicationException(`Unexpected result of type ${typeof hashResult} returned from redis when executing 'evalSha' ${hashResult}.`);
            result = hashResult;
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith("NOSCRIPT")) {
                const rawResult = await this._client.eval(script, {
                    keys: [key],
                    arguments: args
                });
                if (typeof rawResult !== "number")
                    throw new ApplicationException(`Unexpected result of type ${typeof rawResult} returned from redis when executing 'eval' ${rawResult}.`);
                result = rawResult;
            }
            else
                throw error;
        }
        return result === 1;
    }
    _hashScript(script) {
        given(script, "script").ensureHasValue().ensureIsString();
        return createHash("sha1")
            .update(script).digest("hex");
    }
}
export class UnableToAcquireDistributedLockException extends ApplicationException {
    constructor(key) {
        super(`Unable to acquire distributed lock for key '${key}'`);
    }
}
//# sourceMappingURL=redis-distributed-lock-service.js.map