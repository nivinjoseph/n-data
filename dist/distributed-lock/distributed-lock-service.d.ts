import { Duration } from "@nivinjoseph/n-util";
export interface DistributedLockService {
    lock(key: string, ttlDuration?: Duration): Promise<DistributedLock>;
}
export interface DistributedLock {
    release(): Promise<void>;
}
//# sourceMappingURL=distributed-lock-service.d.ts.map