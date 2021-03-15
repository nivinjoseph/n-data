import { TransactionProvider } from "./transaction-provider";
export interface UnitOfWork extends TransactionProvider {
    commit(): Promise<void>;
    rollback(): Promise<void>;
}
