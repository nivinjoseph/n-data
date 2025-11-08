import { Disposable, Duration } from "@nivinjoseph/n-util";
import { CacheService } from "./cache-service.js";
import { RedisClientType } from "redis";
export declare class RedisCacheService implements CacheService, Disposable {
    private readonly _proxyClient;
    private _isDisposed;
    private _disposePromise;
    constructor(redisClient: RedisClientType<any, any, any, any, any>);
    store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>;
    retrieve<T>(key: string): Promise<T | null>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
    dispose(): Promise<void>;
    private _compressData;
    private _decompressData;
}
//# sourceMappingURL=redis-cache-service.d.ts.map