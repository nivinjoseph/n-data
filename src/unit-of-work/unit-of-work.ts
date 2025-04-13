import { TransactionProvider } from "./transaction-provider.js";

/**
 * Interface representing a Unit of Work pattern implementation.
 * Provides transaction management and commit/rollback functionality.
 * 
 * @interface UnitOfWork
 * @extends TransactionProvider
 */
export interface UnitOfWork extends TransactionProvider
{
    /**
     * Registers a callback to be executed when the unit of work is committed.
     * Callbacks are executed in order of priority (lower numbers first).
     * 
     * @param {() => Promise<void>} callback - The callback function to execute
     * @param {number} [priority] - The priority of the callback (lower numbers execute first)
     */
    onCommit(callback: () => Promise<void>, priority?: number): void;

    /**
     * Commits the current transaction and executes all registered commit callbacks.
     * 
     * @returns {Promise<void>} A promise that resolves when the commit is complete
     * @throws {Error} If the commit fails
     */
    commit(): Promise<void>;

    /**
     * Registers a callback to be executed when the unit of work is rolled back.
     * Callbacks are executed in order of priority (lower numbers first).
     * 
     * @param {() => Promise<void>} callback - The callback function to execute
     * @param {number} [priority] - The priority of the callback (lower numbers execute first)
     */
    onRollback(callback: () => Promise<void>, priority?: number): void;

    /**
     * Rolls back the current transaction and executes all registered rollback callbacks.
     * 
     * @returns {Promise<void>} A promise that resolves when the rollback is complete
     * @throws {Error} If the rollback fails
     */
    rollback(): Promise<void>;
}