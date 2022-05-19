import { UnitOfWork } from "./unit-of-work";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { given } from "@nivinjoseph/n-defensive";
import { Knex } from "knex";
import { InvalidOperationException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";


// public
@inject("DbConnectionFactory")
export class KnexPgUnitOfWork implements UnitOfWork
{
    private readonly _dbConnectionFactory: DbConnectionFactory;
    private readonly _onCommits = new Array<() => Promise<void>>();
    private readonly _onRollbacks = new Array<() => Promise<void>>();
    private _transactionScope: TransactionScope | null = null;


    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();

        this._dbConnectionFactory = dbConnectionFactory;
    }
    

    public getTransactionScope(): Promise<object>
    {
        if (this._transactionScope)
        {
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                return Promise.reject(new InvalidOperationException("using completed UnitOfWork"));
            return Promise.resolve(this._transactionScope.trx);
        }

        const promise = new Promise<object>((resolve, reject) =>
        {
            this._dbConnectionFactory.create()
                .then((knex: any) =>
                {

                    (<Knex>knex)
                        .transaction((trx: Knex.Transaction) =>
                        {
                            if (this._transactionScope)
                            {
                                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                                trx.rollback();
                                if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                                    reject(new InvalidOperationException("using completed UnitOfWork"));
                                else
                                    resolve(this._transactionScope.trx);
                            }
                            else
                            {
                                this._transactionScope = {
                                    trx: trx,
                                    isCommitting: false,
                                    isCommitted: false,
                                    isRollingBack: false,
                                    isRolledBack: false
                                };

                                resolve(this._transactionScope.trx);
                            }
                        })
                        .catch(() => { /** */ });
                })
                .catch(err => reject(err));
        });

        return promise;
    }
    
    public onCommit(callback: () => Promise<void>): void
    {
        given(callback, "callback").ensureHasValue().ensureIsFunction();
        this._onCommits.push(callback);
    }

    public async commit(): Promise<void>
    {
        if (!this._transactionScope)
        {
            if (this._onCommits.isNotEmpty)
                await Promise.all(this._onCommits.map(t => t()));
            return;
        }

        if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
            throw new InvalidOperationException("committing completed UnitOfWork");
        
        if (this._transactionScope.isCommitting)
            throw new InvalidOperationException("double committing UnitOfWork");

        this._transactionScope.isCommitting = true;
        const promise = new Promise<void>((resolve, reject) =>
        {
            this._transactionScope!.trx.commit()
                .then(() =>
                {
                    this._transactionScope!.isCommitted = true;
                    resolve();
                })
                .catch((err) => reject(err));
        });

        await promise;
        if (this._onCommits.isNotEmpty)
            await Promise.all(this._onCommits.map(t => t()));
    }
    
    public onRollback(callback: () => Promise<void>): void
    {
        given(callback, "callback").ensureHasValue().ensureIsFunction();
        this._onRollbacks.push(callback);
    }

    public async rollback(): Promise<void>
    {
        if (!this._transactionScope)
        {
            if (this._onRollbacks.isNotEmpty)
                await Promise.all(this._onRollbacks.map(t => t()));
            return;
        }

        if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
            throw new InvalidOperationException("rolling back completed UnitOfWork");
        
        if (this._transactionScope.isRollingBack)
            throw new InvalidOperationException("double rolling back UnitOfWork");

        this._transactionScope.isRollingBack = true;
        const promise = new Promise<void>((resolve, reject) =>
        {
            this._transactionScope!.trx.rollback("[DELIBERATE]")
                .then(() =>
                {
                    this._transactionScope!.isRolledBack = true;
                    resolve();
                })
                .catch((err) => reject(err));
        });

        await promise;
        if (this._onRollbacks.isNotEmpty)
            await Promise.all(this._onRollbacks.map(t => t()));
    }
}


interface TransactionScope
{
    trx: Knex.Transaction;
    isCommitting: boolean;
    isCommitted: boolean;
    isRollingBack: boolean;
    isRolledBack: boolean;
}