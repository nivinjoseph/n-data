import { Db } from "./db";
import { Knex } from "knex";
import { DbException } from "../exceptions/db-exception";
import { OperationType } from "../exceptions/operation-type";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { TransactionProvider } from "../unit-of-work/transaction-provider";
import { inject } from "@nivinjoseph/n-ject";
import { KnexPgReadDb } from "./knex-pg-read-db";


// public
@inject("DbConnectionFactory")
export class KnexPgDb extends KnexPgReadDb implements Db
{
    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        super(dbConnectionFactory);
    }
    
    
    public executeCommand(sql: string, ...params: any[]): Promise<void>
    {
        const promise = new Promise<void>((resolve, reject) =>
        {
            this.dbConnectionFactory.create()
                .then((knex: Knex) =>
                {
                    // tslint:disable-next-line: no-floating-promises
                    knex.raw(sql, params).asCallback((err: any, result: any) =>
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
        const promise = new Promise<void>((resolve, reject) =>
        {
            transactionProvider.getTransactionScope()
                .then((trx: Knex.Transaction) =>
                {
                    // tslint:disable-next-line: no-floating-promises
                    trx.raw(sql, params).asCallback((err: any, result: any) =>
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
        const command: string = result.command;
        const rowCount: number = result.rowCount;
        
        let commands = ["INSERT", "UPDATE"];
        if (commands.some(t => t === command))
        {
            if (rowCount === undefined || rowCount === null || Number.isNaN(rowCount) || rowCount <= 0)
                return false;
        }
        
        return true;
    }
}