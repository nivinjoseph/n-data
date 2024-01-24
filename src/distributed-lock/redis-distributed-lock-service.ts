import { Delay, Disposable, Duration, Make, Uuid } from "@nivinjoseph/n-util";
import { DistributedLock, DistributedLockService } from "./distributed-lock-service.js";
import { RedisClientType } from "redis";
import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException, ObjectDisposedException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
import { createHash } from "node:crypto";


@inject("RedisClient")
export class RedisDistributedLockService implements DistributedLockService, Disposable
{
    private readonly _defaultConfig: DistributedLockConfigInternal = {
        driftFactor: 0.01,
        retryCount: 25,
        retryDelay: Duration.fromMilliSeconds(400),
        retryJitter: Duration.fromMilliSeconds(200)
    };

    // private readonly _redLock: RedLock;
    private readonly _executer: _RedisScriptExecuter;

    private _isDisposed = false;
    private _disposePromise: Promise<void> | null = null;


    public constructor(redisClient: RedisClientType<any, any, any>, config?: DistributedLockConfig)
    {
        given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        given(config, "config").ensureIsObject().ensureHasStructure({
            "driftFactor?": "number",
            "retryCount?": "number",
            "retryDelay?": "object",
            "retryJitter?": "object"
        });

        this._executer = new _RedisScriptExecuter(redisClient, {
            ...this._defaultConfig,
            ...config == null ? {} : config
        });
    }


    public async lock(key: string, ttlDuration?: Duration): Promise<DistributedLock>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        key = `n-data-dlock-${key.trim().toLowerCase()}`;

        given(ttlDuration, "ttlDuration").ensureIsObject();

        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        return this._executer.lock(key, ttlDuration);
    }


    public dispose(): Promise<void>
    {
        if (!this._isDisposed)
        {
            this._isDisposed = true;
            this._disposePromise = Promise.resolve();
        }

        return this._disposePromise!;
    }
}

class RedisDistributedLock implements DistributedLock
{
    private readonly _executer: _RedisScriptExecuter;
    private readonly _key: string;
    private readonly _value: string;
    private readonly _expiration: Duration;

    public get key(): string { return this._key; }
    public get value(): string { return this._value; }
    public get expiration(): Duration { return this._expiration; }


    public constructor(executer: _RedisScriptExecuter, key: string, value: string, expiration: Duration)
    {
        given(executer, "executer").ensureHasValue().ensureIsObject();
        this._executer = executer;

        given(key, "key").ensureHasValue().ensureIsString();
        this._key = key;

        given(value, "value").ensureHasValue().ensureIsString();
        this._value = value;

        given(expiration, "expiration").ensureHasValue().ensureIsInstanceOf(Duration);
        this._expiration = expiration;
    }


    public release(): Promise<void>
    {
        return this._executer.release(this);
    }
}



class _RedisScriptExecuter
{
    private readonly _lockScript: string = `
        -- Return 0 if an key already exists 1 otherwise.
        -- ARGV[1] = value ARGV[2] = duration
        if redis.call("exists", KEYS[1]) == 1 then
            return 0
        end

        redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])

        return 1
    `;
    private readonly _releaseScript: string = `
        -- Return 0 if key is already deleted or expired 1 otherwise.
        -- ARGV[1] = value for the key

        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del",KEYS[1])
        else
            return 0
        end
    `;

    private readonly _lockScriptHash: string;
    private readonly _releaseScriptHash: string;


    private readonly _client: RedisClientType<any, any, any>;
    private readonly _config: DistributedLockConfigInternal;


    public constructor(client: RedisClientType<any, any, any>, config: DistributedLockConfigInternal)
    {
        given(client, "client").ensureHasValue().ensureIsObject();
        this._client = client;

        given(config, "config").ensureHasValue().ensureIsObject();
        this._config = config;

        this._lockScriptHash = this._hashScript(this._lockScript);
        this._releaseScriptHash = this._hashScript(this._releaseScript);
    }


    public async lock(key: string, ttlDuration?: Duration): Promise<RedisDistributedLock>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        given(ttlDuration, "ttlDuration").ensureIsInstanceOf(Duration);

        const randomValue = Uuid.create();
        const duration = ttlDuration ?? Duration.fromSeconds(30);

        let attempts = 0;
        while (attempts < this._config.retryCount)
        {
            const result = await this._executeScript(
                this._lockScriptHash,
                this._lockScript,
                key,
                randomValue, duration.toMilliSeconds().toString()
            );

            if (result)
                return new RedisDistributedLock(this, key, randomValue, duration);

            attempts++;

            const delayDuration = this._config.retryDelay.toMilliSeconds()
                + Make.randomInt(0, this._config.retryJitter.toMilliSeconds());

            await Delay.milliseconds(delayDuration);
        }

        throw new UnableToAcquireDistributedLockException(key);
    }

    public async release(lock: RedisDistributedLock): Promise<void>
    {
        given(lock, "lock").ensureHasValue().ensureIsObject();

        await this._executeScript(
            this._releaseScriptHash,
            this._releaseScript,
            lock.key,
            lock.value
        );
    }


    private async _executeScript(scriptHash: string, script: string, key: string, ...args: Array<string>): Promise<boolean>
    {
        given(scriptHash, "scriptHash").ensureHasValue().ensureIsString();
        given(script, "script").ensureHasValue().ensureIsString();
        given(key, "key").ensureHasValue().ensureIsString();
        given(args, "args").ensureHasValue().ensureIsArray();

        let result: number;
        try
        {
            // Attempt to evaluate the script by its hash.
            const hashResult = await this._client.evalSha(scriptHash, {
                keys: [key],
                arguments: args
            });

            if (typeof hashResult !== "number")
                throw new ApplicationException(
                    `Unexpected result of type ${typeof hashResult} returned from redis when executing 'evalSha' ${hashResult}.`
                );

            result = hashResult;
        }
        catch (error: any)
        {
            if (error instanceof Error && error.message.startsWith("NOSCRIPT"))
            {
                const rawResult = await this._client.eval(script, {
                    keys: [key],
                    arguments: args
                });

                if (typeof rawResult !== "number")
                    throw new ApplicationException(
                        `Unexpected result of type ${typeof rawResult} returned from redis when executing 'eval' ${rawResult}.`
                    );

                result = rawResult;
            }
            else
                throw error;
        }


        return result === 1;
    }

    private _hashScript(script: string): string
    {
        given(script, "script").ensureHasValue().ensureIsString();

        return createHash("sha1")
            .update(script).digest("hex");
    }
}

export class UnableToAcquireDistributedLockException extends ApplicationException
{
    public constructor(key: string)
    {
        super(`Unable to acquire distributed lock for key '${key}'`);
    }
}


type DistributedLockConfigInternal = Required<DistributedLockConfig>;

export interface DistributedLockConfig
{
    /**
     * The expected clock drift; for more details
     * see http://redis.io/topics/distlock
     *
     * This is multiplied by lock ttl to determine drift time
     * @default 0.01
     */
    driftFactor?: number;

    /**
     * The max number of times the service will attempt to acquire the lock
     * see http://redis.io/topics/distlock
     *
     * @default 25
     */
    retryCount?: number;
    /**
     * The time in between each attempt to acquire lock
     * @default 400ms
     */
    retryDelay?: Duration;
    /**
     * To improve performance under high contention some random time is added along with `retryDelay`
     * This is the max time that could be added.
     * see https://www.awsarchitectureblog.com/2015/03/backoff.html
     * @default 200ms
     */
    retryJitter?: Duration;
}