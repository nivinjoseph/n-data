import { Disposable } from "@nivinjoseph/n-util";
import { CacheService } from "./cache-service";
export declare class RedisCacheService implements CacheService, Disposable {
    private readonly _client;
    private _isDisposed;
    private _disposePromise;
    constructor();
    store<T>(key: string, value: T, expiry?: number): Promise<void>;
    retrieve<T>(key: string): Promise<T>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
    dispose(): Promise<void>;
}
