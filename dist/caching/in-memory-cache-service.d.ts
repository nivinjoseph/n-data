import { CacheService } from "./cache-service";
import { Disposable, Duration } from "@nivinjoseph/n-util";
export declare class InMemoryCacheService implements CacheService, Disposable {
    private readonly _store;
    private readonly _evictionTracking;
    private readonly _timer;
    private _isDisposed;
    constructor();
    store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>;
    retrieve<T>(key: string): Promise<T | null>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
    dispose(): Promise<void>;
    private _evict;
}
