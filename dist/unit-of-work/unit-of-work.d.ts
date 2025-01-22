import { TransactionProvider } from "./transaction-provider";
export interface UnitOfWork extends TransactionProvider {
    onCommit(callback: () => Promise<void>, priority?: number): void;
    commit(): Promise<void>;
    onRollback(callback: () => Promise<void>, priority?: number): void;
    rollback(): Promise<void>;
}
