import { Db } from "./db";
import { given } from "n-defensive";
import "n-ext";
import * as Knex from "knex";
import { DbException } from "../exceptions/db-exception";
import { OperationType } from "../exceptions/operation-type";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { inject } from "n-ject";
import { QueryResult } from "./query-result";


// public
@inject("DbConnectionFactory")
export class KnexPgDb implements Db
{
    private readonly _dbConnectionFactory: DbConnectionFactory;
    
    
    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue();
        
        this._dbConnectionFactory = dbConnectionFactory;
    }
    
    
    public executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>
    {
        let promise = new Promise<QueryResult<T>>((resolve, reject) =>
        {
            this._dbConnectionFactory.create()
                .then((knex: Knex) =>
                {
                    knex.raw(sql, params).asCallback((err, result) =>
                    {
                        if (err)
                        {
                            reject(new DbException(OperationType.query, sql, params, err));
                        }
                        else
                        {
                            resolve(new QueryResult<T>(result.rows));
                        }
                    });
                })
                .catch(err => reject(err));
        });

        return promise;
    }
    
    public executeCommand(sql: string, ...params: any[]): Promise<void>
    {
        let promise = new Promise<void>((resolve, reject) =>
        {
            this._dbConnectionFactory.create()
                .then((knex: Knex) =>
                {
                    knex.raw(sql, params).asCallback((err, result: any) =>
                    {
                        if (err)
                        {
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }
                        
                        if (!this.validateCommandResult(result))
                        {
                            reject(new DbException(OperationType.command, sql, params, new Error("No rows were affected.")));
                            return;
                        }
                        
                        resolve();
                    });
                })
                .catch(err => reject(err));
        });

        return promise;
    }
    
    public executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: any[]): Promise<void>
    {        
        let promise = new Promise<void>((resolve, reject) =>
        {
            transactionProvider.getTransactionScope()
                .then((trx: Knex.Transaction) =>
                {
                    trx.raw(sql, params).asCallback((err, result: any) =>
                    {
                        if (err)
                        {
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }

                        if (!this.validateCommandResult(result))
                        {
                            reject(new DbException(OperationType.command, sql, params, new Error("No rows were affected.")));
                            return;
                        }

                        resolve();
                    });
                })
                .catch(err => reject(err));
        });

        return promise;
    }
    
    private validateCommandResult(result: any): boolean
    {
        let command: string = result.command;
        let rowCount: number = result.rowCount;
        
        let commands = ["INSERT", "UPDATE", "DELETE"];
        if (commands.some(t => t === command))
        {
            if (rowCount === undefined || rowCount === null || Number.isNaN(rowCount) || rowCount <= 0)
                return false;
        }
        
        return true;
    }
}