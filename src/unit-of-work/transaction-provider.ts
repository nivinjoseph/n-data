// public
export interface TransactionProvider
{
    getTransactionScope(): Promise<object>;
}