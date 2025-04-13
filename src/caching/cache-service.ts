import { Duration } from "@nivinjoseph/n-util";

/**
 * Interface representing a caching service that provides methods for storing, retrieving,
 * and managing cached data with optional expiration.
 * 
 * @interface CacheService
 */
export interface CacheService
{
    /**
     * Stores a value in the cache with an optional expiration duration.
     * 
     * @template T - The type of the value to store
     * @param {string} key - The key under which to store the value
     * @param {T} value - The value to store in the cache
     * @param {Duration} [expiryDuration] - Optional duration after which the cached value should expire
     * @returns {Promise<void>} A promise that resolves when the value is stored
     * @throws {Error} If the storage operation fails
     */
    store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>;

    /**
     * Retrieves a value from the cache.
     * 
     * @template T - The expected type of the retrieved value
     * @param {string} key - The key of the value to retrieve
     * @returns {Promise<T | null>} A promise that resolves to the retrieved value or null if not found
     * @throws {Error} If the retrieval operation fails
     */
    retrieve<T>(key: string): Promise<T | null>;

    /**
     * Checks if a key exists in the cache.
     * 
     * @param {string} key - The key to check
     * @returns {Promise<boolean>} A promise that resolves to true if the key exists, false otherwise
     * @throws {Error} If the existence check fails
     */
    exists(key: string): Promise<boolean>;

    /**
     * Removes a value from the cache.
     * 
     * @param {string} key - The key of the value to remove
     * @returns {Promise<void>} A promise that resolves when the value is removed
     * @throws {Error} If the removal operation fails
     */
    remove(key: string): Promise<void>;
}

// export class CacheDuration
// {
//     private constructor() { }

//     // this is deliberately private because the lowest common denominator for caching is always seconds
//     private static fromSeconds(seconds: number): number
//     {
//         given(seconds, "seconds").ensureHasValue().ensureIsNumber();

//         return seconds;
//     }

//     public static fromMinutes(minutes: number): number
//     {
//         given(minutes, "minutes").ensureHasValue().ensureIsNumber();

//         return this.fromSeconds(minutes * 60);
//     }

//     public static fromHours(hours: number): number
//     {
//         given(hours, "hours").ensureHasValue().ensureIsNumber();

//         return this.fromMinutes(hours * 60);
//     }

//     public static fromDays(days: number): number
//     {
//         given(days, "days").ensureHasValue().ensureIsNumber();

//         return this.fromHours(days * 24);
//     }
// }