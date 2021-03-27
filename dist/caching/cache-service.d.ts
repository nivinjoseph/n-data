export interface CacheService {
    /**
     *
     * @param key
     * @param value
     * @param expirySeconds seconds
     */
    store<T>(key: string, value: T, expirySeconds?: number): Promise<void>;
    retrieve<T>(key: string): Promise<T>;
    exists(key: string): Promise<boolean>;
    remove(key: string): Promise<void>;
}
export declare class CacheDuration {
    private constructor();
    private static fromSeconds;
    static fromMinutes(minutes: number): number;
    static fromHours(hours: number): number;
    static fromDays(days: number): number;
}
