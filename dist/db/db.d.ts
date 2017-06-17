import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { QueryResult } from "./query-result";
export interface Db {
    executeQuery(sql: string, ...params: Array<any>): Promise<QueryResult>;
    executeCommand(sql: string, ...params: Array<any>): Promise<void>;
    executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>;
}
