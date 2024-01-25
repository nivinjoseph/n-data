import { Db } from "./db.js";
import { Knex } from "knex";
import { DbException } from "../exceptions/db-exception.js";
import { OperationType } from "../exceptions/operation-type.js";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory.js";
import { TransactionProvider } from "../unit-of-work/transaction-provider.js";
import { inject } from "@nivinjoseph/n-ject";
import { KnexPgReadDb } from "./knex-pg-read-db.js";


// public
@inject("DbConnectionFactory")
export class KnexPgDb extends KnexPgReadDb implements Db
{
    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        super(dbConnectionFactory);
    }


    public executeCommand(sql: string, ...params: Array<any>): Promise<void>
    {
        const promise = new Promise<void>((resolve, reject) =>
        {
            this.dbConnectionFactory.create()
                .then((knex: any) =>
                {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    (<Knex>knex).raw(sql, params).asCallback((err: any, result: any) =>
                    {
                        if (err)
                        {
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }

                        if (!this._validateCommandResult(result))
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

    public executeCommandWithinUnitOfWork(transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>
    {
        const promise = new Promise<void>((resolve, reject) =>
        {
            transactionProvider.getTransactionScope()
                .then((trx: any) =>
                {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    (<Knex.Transaction>trx).raw(sql, params).asCallback((err: any, result: any) =>
                    {
                        if (err)
                        {
                            reject(new DbException(OperationType.command, sql, params, err));
                            return;
                        }

                        if (!this._validateCommandResult(result))
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

    private _validateCommandResult(result: any): boolean
    {
        const command: string = result.command;
        const rowCount = result.rowCount;

        const commands = ["INSERT", "UPDATE"];
        if (commands.some(t => t === command))
        {
            if (rowCount === undefined || rowCount === null || Number.isNaN(rowCount) || rowCount <= 0)
                return false;
        }

        return true;
    }
}