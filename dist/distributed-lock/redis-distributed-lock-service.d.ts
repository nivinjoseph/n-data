import { Disposable } from "@nivinjoseph/n-util";
import { DistributedLock, DistributedLockService } from "./distributed-lock-service";
import * as Redis from "redis";
export declare class RedisDistributedLockService implements DistributedLockService, Disposable {
    private readonly _client;
    private readonly _redLock;
    private _isDisposed;
    private _disposePromise;
    constructor(redisClient: Redis.RedisClient);
    lock(key: string): Promise<DistributedLock>;
    dispose(): Promise<void>;
}
