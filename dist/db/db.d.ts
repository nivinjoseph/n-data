import { TransactionProvider } from "../unit-of-work/transaction-provider.js";
import { ReadDb } from "./read-db.js";
/**
 * Interface representing a database that supports both read and write operations.
 * Extends the ReadDb interface to provide additional write capabilities.
 *
 * @interface Db
 * @extends ReadDb
 */
export interface Db extends ReadDb {
    /**
     * Executes a SQL command that modifies data in the database.
     *
     * @param {string} sql - The SQL command to execute
     * @param {...Array<any>} params - Parameters to be bound to the SQL command
     * @returns {Promise<void>} A promise that resolves when the command is executed
     * @throws {Error} If the command execution fails
     */
    executeCommand(sql: string, ...params: Array<any>): Promise<void>;
    /**
     * Executes a SQL command within a unit of work transaction.
     * This ensures that the command is part of a larger transaction that can be rolled back if needed.
     *
     * @param {TransactionProvider} transactionProvider - The transaction provider managing the unit of work
     * @param {string} sql - The SQL command to execute
     * @param {...Array<any>} params - Parameters to be bound to the SQL command
     * @returns {Promise<void>} A promise that resolves when the command is executed
     * @throws {Error} If the command execution fails or if the transaction is not active
     */
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>;
}
//# sourceMappingURL=db.d.ts.map