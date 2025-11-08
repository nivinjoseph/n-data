import { Disposable, Duration } from "@nivinjoseph/n-util";
import { DistributedLock, DistributedLockService } from "./distributed-lock-service.js";
import { RedisClientType } from "redis";
import { ApplicationException } from "@nivinjoseph/n-exception";
export declare class RedisDistributedLockService implements DistributedLockService, Disposable {
    private readonly _defaultConfig;
    private readonly _executer;
    private _isDisposed;
    private _disposePromise;
    constructor(redisClient: RedisClientType<any, any, any, any, any>, config?: DistributedLockConfig);
    lock(key: string, ttlDuration?: Duration): Promise<DistributedLock>;
    dispose(): Promise<void>;
}
export declare class UnableToAcquireDistributedLockException extends ApplicationException {
    constructor(key: string);
}
export interface DistributedLockConfig {
    /**
     * The expected clock drift; for more details
     * see http://redis.io/topics/distlock
     *
     * This is multiplied by lock ttl to determine drift time
     * @default 0.01
     */
    driftFactor?: number;
    /**
     * The max number of times the service will attempt to acquire the lock
     * see http://redis.io/topics/distlock
     *
     * @default 25
     */
    retryCount?: number;
    /**
     * The time in between each attempt to acquire lock
     * @default 400ms
     */
    retryDelay?: Duration;
    /**
     * To improve performance under high contention some random time is added along with `retryDelay`
     * This is the max time that could be added.
     * see https://www.awsarchitectureblog.com/2015/03/backoff.html
     * @default 200ms
     */
    retryJitter?: Duration;
}
//# sourceMappingURL=redis-distributed-lock-service.d.ts.map