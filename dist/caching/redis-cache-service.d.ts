import { Disposable, Duration } from "@nivinjoseph/n-util";
import * as Redis from "redis";
import { CacheService } from "./cache-service";
export declare class RedisCacheService implements CacheService, Disposable {
    private readonly _client;
    private _isDisposed;
    private _disposePromise;
    constructor(redisClient: Redis.RedisClient);
    store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>;
    retrieve<T>(key: string): Promise<T>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
    dispose(): Promise<void>;
    private _compressData;
    private _decompressData;
}
