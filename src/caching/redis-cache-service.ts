import { Disposable } from "@nivinjoseph/n-util";
import * as Redis from "redis";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { CacheService } from "./cache-service";
import { inject } from "@nivinjoseph/n-ject";


@inject("RedisClient")
export class RedisCacheService implements CacheService, Disposable
{
    private readonly _client: Redis.RedisClient;
    private _isDisposed = false;
    private _disposePromise: Promise<void> | null = null;


    public constructor(redisClient: Redis.RedisClient)
    {
        given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
    }


    public store<T>(key: string, value: T, expiry?: number): Promise<void>
    {
        return new Promise((resolve, reject) =>
        {
            given(key, "key").ensureHasValue().ensureIsString();
            given(value, "value").ensureHasValue();
            given(expiry as number, "expiry").ensureIsNumber().ensure(t => t > 0);

            if (this._isDisposed)
            {
                reject(new ObjectDisposedException(this));
                return;
            }

            if (expiry == null)
            {
                this._client.set(key.trim(), JSON.stringify(value), (err) =>
                {
                    if (err)
                    {
                        reject(err);
                        return;
                    }

                    resolve();
                });
            }
            else
            {
                this._client.setex(key.trim(), expiry, JSON.stringify(value), (err) =>
                {
                    if (err)
                    {
                        reject(err);
                        return;
                    }

                    resolve();
                });
            }
        });
    }

    public retrieve<T>(key: string): Promise<T>
    {
        return new Promise((resolve, reject) =>
        {
            given(key, "key").ensureHasValue().ensureIsString();

            if (this._isDisposed)
            {
                reject(new ObjectDisposedException(this));
                return;
            }

            this._client.get(key.trim(), (err, value) =>
            {
                if (err)
                {
                    reject(err);
                    return;
                }

                resolve(JSON.parse(value));
            });
        });
    }

    public exists(key: string): Promise<boolean>
    {
        return new Promise((resolve, reject) =>
        {
            given(key, "key").ensureHasValue().ensureIsString();

            if (this._isDisposed)
            {
                reject(new ObjectDisposedException(this));
                return;
            }

            this._client.exists(key.trim(), (err, result) =>
            {
                if (err)
                {
                    reject(err);
                    return;
                }

                resolve(!!result);
            });
        });
    }

    public remove(key: string): Promise<void>
    {
        return new Promise((resolve, reject) =>
        {
            given(key, "key").ensureHasValue().ensureIsString();

            if (this._isDisposed)
            {
                reject(new ObjectDisposedException(this));
                return;
            }

            this._client.del(key.trim(), (err) =>
            {
                if (err)
                {
                    reject(err);
                    return;
                }

                resolve();
            });
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