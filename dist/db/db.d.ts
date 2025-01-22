import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { ReadDb } from "./read-db";
export interface Db extends ReadDb {
    executeCommand(sql: string, ...params: Array<any>): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>;
}
