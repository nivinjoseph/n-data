export interface CacheService {
    /**
     *
     * @param key
     * @param value
     * @param expiry seconds
     */
    store<T>(key: string, value: T, expiry?: number): Promise<void>;
    retrieve<T>(key: string): Promise<T>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
}
