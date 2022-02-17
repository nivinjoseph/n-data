import { Disposable, Make } from "@nivinjoseph/n-util";
import * as Redis from "redis";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { CacheService } from "./cache-service";
import { inject } from "@nivinjoseph/n-ject";
import * as Zlib from "zlib";


@inject("CacheRedisClient")
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


    public async store<T>(key: string, value: T, expirySeconds?: number): Promise<void>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        given(value, "value").ensureHasValue();
        given(expirySeconds as number, "expirySeconds").ensureIsNumber().ensure(t => t > 0);
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        
        key = "bin_" + key.trim();
        
        const data = await this._compressData(value as any);
        
        await new Promise<void>((resolve, reject) =>
        {
            if (expirySeconds == null)
            {
                this._client.set(key, data as any, (err) =>
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
                this._client.setex(key, expirySeconds, data as any, (err) =>
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

    public async retrieve<T>(key: string): Promise<T>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        key = "bin_" + key.trim();
        
        const buffer = await new Promise<Buffer>((resolve, reject) =>
        {

            this._client.get(key, (err, value) =>
            {
                if (err)
                {
                    reject(err);
                    return;
                }

                resolve(value as unknown as Buffer);
            });
        });
        
        if (buffer == null)
            return null;
        
        return await this._decompressData(buffer) as unknown as T;
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
            
            key = "bin_" + key.trim();

            this._client.exists(key, (err, result) =>
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
            
            key = "bin_" + key.trim();

            this._client.del(key, (err) =>
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
    
    private _compressData(data: object): Promise<Buffer>
    {
        return Make.callbackToPromise<Buffer>(Zlib.deflateRaw)(Buffer.from(JSON.stringify(data), "utf8"));
    }
    
    private async _decompressData(data: Buffer): Promise<object>
    {
        const decompressed = await Make.callbackToPromise<Buffer>(Zlib.inflateRaw)(data);

        return JSON.parse(decompressed.toString("utf8"));
    }
}