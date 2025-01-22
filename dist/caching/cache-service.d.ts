import { Duration } from "@nivinjoseph/n-util";
export interface CacheService {
    /**
     *
     * @param key
     * @param value
     * @param expiryDuration
     */
    store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>;
    retrieve<T>(key: string): Promise<T | null>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
}
