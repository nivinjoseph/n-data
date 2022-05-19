import { given } from "@nivinjoseph/n-defensive";
import { Knex } from "knex";
import { DbException } from "../exceptions/db-exception";
import { OperationType } from "../exceptions/operation-type";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { inject } from "@nivinjoseph/n-ject";
import { QueryResult } from "./query-result";
import { ReadDb } from "./read-db";


// public
@inject("ReadDbConnectionFactory")
export class KnexPgReadDb implements ReadDb
{
    private readonly _dbConnectionFactory: DbConnectionFactory;
    
    
    protected get dbConnectionFactory(): DbConnectionFactory { return this._dbConnectionFactory; }


    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();

        this._dbConnectionFactory = dbConnectionFactory;
    }


    public executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>
    {
        const promise = new Promise<QueryResult<T>>((resolve, reject) =>
        {
            this._dbConnectionFactory.create()
                .then((knex: any) =>
                {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    (<Knex>knex).raw(sql, params).asCallback((err: any, result: any) =>
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
}