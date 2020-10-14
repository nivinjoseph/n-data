import { Disposable } from "@nivinjoseph/n-util";
import { DistributedLock, DistributedLockService } from "./distributed-lock-service";
import * as Redis from "redis";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";
import * as RedLock from "redlock";


@inject("RedisClient")
export class RedisDistributedLockService implements DistributedLockService, Disposable
{
    private readonly _client: Redis.RedisClient;
    private readonly _redLock: RedLock;
    private _isDisposed = false;
    private _disposePromise: Promise<void> | null = null;


    public constructor(redisClient: Redis.RedisClient)
    {
        given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
        
        this._redLock = new RedLock([this._client], {
            // the expected clock drift; for more details
            // see http://redis.io/topics/distlock
            driftFactor: 0.01, // multiplied by lock ttl to determine drift time

            // the max number of times Redlock will attempt
            // to lock a resource before erroring
            retryCount: 25,

            // the time in ms between attempts
            retryDelay: 400, // time in ms

            // the max time in ms randomly added to retries
            // to improve performance under high contention
            // see https://www.awsarchitectureblog.com/2015/03/backoff.html
            retryJitter: 200 // time in ms
        });
    }
    
    
    public async lock(key: string): Promise<DistributedLock>
    {
        return new Promise((resolve, reject) =>
        {
            given(key, "key").ensureHasValue().ensureIsString();
            key = `n-data-dlock-${key.trim().toLowerCase()}`;

            if (this._isDisposed)
            {
                reject(new ObjectDisposedException(this));
                return;
            }

            this._redLock.lock(key, 8000)
                .then(lock => resolve(new RedisDistributedLock(lock)))
                .catch(e => reject(e));
         });
    }
    
    
    public dispose(): Promise<void>
    {
        if (!this._isDisposed)
        {
            this._isDisposed = true;
            this._disposePromise = Promise.resolve();
        }

        return this._disposePromise;
    }
}

class RedisDistributedLock implements DistributedLock
{
    private readonly _lock: RedLock.Lock;
    
    
    public constructor(lock: RedLock.Lock)
    {
        given(lock, "lock").ensureHasValue();
        this._lock = lock;
    }
    
    
    public release(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            this._lock.unlock().then(() => resolve()).catch((e) => reject(e));
        });
    }
}