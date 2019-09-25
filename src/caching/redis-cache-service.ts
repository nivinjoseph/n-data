import { Disposable } from "@nivinjoseph/n-util";
import * as Redis from "redis";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { ConfigurationManager } from "@nivinjoseph/n-config";
import { CacheService } from "./cache-service";


export class RedisCacheService implements CacheService, Disposable
{
    private readonly _client: Redis.RedisClient;
    private _isDisposed: boolean;
    private _disposePromise: Promise<void> | null;


    public constructor()
    {
        this._client = ConfigurationManager.getConfig<string>("env") === "dev"
            ? Redis.createClient() : Redis.createClient(ConfigurationManager.getConfig<string>("REDIS_URL"));

        this._isDisposed = false;
        this._disposePromise = null;
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
            this._disposePromise = new Promise((resolve, _) => this._client.quit(() => resolve()));
        }

        return this._disposePromise as Promise<void>;
    }
}