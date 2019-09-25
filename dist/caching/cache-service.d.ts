export interface CacheService {
    store<T>(key: string, value: T, expiry?: number): Promise<void>;
    retrieve<T>(key: string): Promise<T>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
}
