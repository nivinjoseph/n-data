import { Disposable, Duration, Make } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { CacheService } from "./cache-service.js";
import { inject } from "@nivinjoseph/n-ject";
import { deflateRaw, inflateRaw } from "zlib";
import { RedisClientType, commandOptions } from "redis";


@inject("CacheRedisClient")
export class RedisCacheService implements CacheService, Disposable
{
    private readonly _client: RedisClientType<any, any, any>;
    private _isDisposed = false;
    private _disposePromise: Promise<void> | null = null;


    public constructor(redisClient: RedisClientType<any, any, any>)
    {
        given(redisClient, "redisClient").ensureHasValue().ensureIsObject();
        this._client = redisClient;
    }


    public async store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        given(value, "value").ensureHasValue();
        given(expiryDuration as Duration, "expiryDuration").ensureIsObject();

        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        key = "bin_" + key.trim();

        const data = await this._compressData(value as any);

        if (expiryDuration == null)
            await this._client.set(key, data);
        else
            await this._client.setEx(key, expiryDuration.toSeconds(true), data);
    }

    public async retrieve<T>(key: string): Promise<T | null>
    {
        given(key, "key").ensureHasValue().ensureIsString();

        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        key = "bin_" + key.trim();

        const buffer = await this._client.get(commandOptions({
            returnBuffers: true
        }), key);

        if (buffer == null)
            return null;

        return await this._decompressData(buffer) as T;
    }

    public async exists(key: string): Promise<boolean>
    {
        given(key, "key").ensureHasValue().ensureIsString();

        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        key = "bin_" + key.trim();

        const val = await this._client.exists(key);

        return !!val;
    }

    public async remove(key: string): Promise<void>
    {
        given(key, "key").ensureHasValue().ensureIsString();

        if (this._isDisposed)
            throw new ObjectDisposedException(this);

        key = "bin_" + key.trim();

        await this._client.del(key);
    }

    public async dispose(): Promise<void>
    {
        if (!this._isDisposed)
        {
            this._isDisposed = true;
            this._disposePromise = Promise.resolve();
        }

        return this._disposePromise!;
    }

    private _compressData(data: object): Promise<Buffer>
    {
        return Make.callbackToPromise<Buffer>(deflateRaw)(Buffer.from(JSON.stringify(data), "utf8"));
    }

    private async _decompressData(data: Buffer): Promise<object>
    {
        const decompressed = await Make.callbackToPromise<Buffer>(inflateRaw)(data);

        return JSON.parse(decompressed.toString("utf8")) as object;
    }
}