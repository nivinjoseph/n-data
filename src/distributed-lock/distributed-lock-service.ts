export interface DistributedLockService
{
    lock(key: string): Promise<DistributedLock>;
}

export interface DistributedLock
{
    release(): Promise<void>;
}