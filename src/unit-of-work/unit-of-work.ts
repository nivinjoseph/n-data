import { TransactionProvider } from "./transaction-provider";


// public
export interface UnitOfWork extends TransactionProvider
{
    onCommit(callback: () => Promise<void>): void;
    commit(): Promise<void>;
    
    onRollback(callback: () => Promise<void>): void;
    rollback(): Promise<void>;
}