import { TransactionProvider } from "../unit-of-work/transaction-provider.js";
import { ReadDb } from "./read-db.js";


// public
export interface Db extends ReadDb
{
    executeCommand(sql: string, ...params: Array<any>): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>;
}