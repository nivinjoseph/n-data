import { Duration } from "@nivinjoseph/n-util";

/**
 * Interface representing a distributed locking service that provides mechanisms
 * for acquiring and managing locks across distributed systems.
 * 
 * @interface DistributedLockService
 */
export interface DistributedLockService
{
    /**
     * Acquires a distributed lock for the specified key.
     * 
     * @param {string} key - The unique identifier for the lock
     * @param {Duration} [ttlDuration] - Optional time-to-live duration for the lock
     * @returns {Promise<DistributedLock>} A promise that resolves to a distributed lock instance
     * @throws {Error} If the lock cannot be acquired
     */
    lock(key: string, ttlDuration?: Duration): Promise<DistributedLock>;
}

/**
 * Interface representing an acquired distributed lock that can be released.
 * 
 * @interface DistributedLock
 */
export interface DistributedLock
{
    /**
     * Releases the distributed lock.
     * 
     * @returns {Promise<void>} A promise that resolves when the lock is released
     * @throws {Error} If the lock cannot be released
     */
    release(): Promise<void>;
}