import { TransactionProvider } from "./transaction-provider";


// public
export interface UnitOfWork extends TransactionProvider
{
    commit(): Promise<void>;
    rollback(): Promise<void>;
}