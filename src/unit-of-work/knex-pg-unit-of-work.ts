import { UnitOfWork } from "./unit-of-work";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { given } from "n-defensive";
import * as Knex from "knex";
import { InvalidOperationException } from "n-exception";
import { inject } from "n-ject";


// public
@inject("DbConnectionFactory")
export class KnexPgUnitOfWork implements UnitOfWork
{
    private readonly _dbConnectionFactory: DbConnectionFactory;
    private _transactionScope: TransactionScope;
    
    
    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue();
        
        this._dbConnectionFactory = dbConnectionFactory;
    }
    
    public getTransactionScope(): Promise<object>
    {
        if (this._transactionScope)
        {
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                return Promise.reject(new InvalidOperationException("using completed transaction scope"));    
            return Promise.resolve(this._transactionScope.trx);
        }
        
        let promise = new Promise<object>((resolve, reject) =>
        {
            this._dbConnectionFactory.create()
                .then((knex: Knex) =>
                {
                    knex.transaction((trx: Knex.Transaction) =>
                    {
                        if (this._transactionScope)
                        {
                            trx.rollback();
                            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                                reject(new InvalidOperationException("using completed transaction scope")); 
                            else
                                resolve(this._transactionScope.trx);
                        }
                        else
                        {
                            this._transactionScope = {
                                trx: trx,
                                isCommitted: false,
                                isRolledBack: false
                            };
                            
                            resolve(this._transactionScope.trx);
                        }
                    });
                })
                .catch(err => reject(err));
        });
        
        return promise;
    }
    
    public commit(): Promise<void>
    {
        if (!this._transactionScope)
            return Promise.resolve();
        
        if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
            return Promise.reject(new InvalidOperationException("using completed transaction scope"));    
        
        this._transactionScope.isCommitted = true;
        let promise = new Promise<void>((resolve, reject) =>
        {
            this._transactionScope.trx.commit()
                .then(() => resolve())
                .catch((err) => reject(err));
        });
        
        return promise;
    }
    
    public rollback(): Promise<void>
    {
        if (!this._transactionScope)
            return Promise.resolve();

        if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
            return Promise.reject(new InvalidOperationException("using completed transaction scope"));

        this._transactionScope.isCommitted = true;
        let promise = new Promise<void>((resolve, reject) =>
        {
            this._transactionScope.trx.rollback("[DELIBERATE]")
                .then(() => resolve())
                .catch((err) => reject(err));
        });

        return promise;
    }
}

interface TransactionScope
{
    trx: Knex.Transaction;
    isCommitted: boolean;
    isRolledBack: boolean;
}