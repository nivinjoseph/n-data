import { UnitOfWork } from "./unit-of-work.js";
import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory.js";
import { given } from "@nivinjoseph/n-defensive";
import { Knex } from "knex";
import { InvalidOperationException } from "@nivinjoseph/n-exception";
import { inject } from "@nivinjoseph/n-ject";


// public
@inject("DbConnectionFactory")
export class KnexPgUnitOfWork implements UnitOfWork
{
    private readonly _dbConnectionFactory: DbConnectionFactory;
    private readonly _onCommits = new Array<PostTransactionExec>();
    private readonly _onRollbacks = new Array<PostTransactionExec>();
    private _transactionScope: TransactionScope | null = null;
    private _transactionScopePromise: Promise<Knex.Transaction> | null = null;


    public constructor(dbConnectionFactory: DbConnectionFactory)
    {
        given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();

        this._dbConnectionFactory = dbConnectionFactory;
    }


    public async getTransactionScope(): Promise<object>
    {
        if (this._transactionScope)
        {
            if (this._transactionScope.isCommitted || this._transactionScope.isRolledBack)
                throw new InvalidOperationException("using completed UnitOfWork");
            return this._transactionScope.trx;
        }

        if (this._transactionScopePromise == null)
        {
            this._transactionScopePromise = this._createTransactionScope();
            // clear the cached promise on failure so a subsequent call can retry;
            // this handler is independent of the consumer's await, so rejection still propagates
            this._transactionScopePromise.catch(() =>
            {
                this._transactionScopePromise = null;
            });
        }

        return this._transactionScopePromise;
    }

    public onCommit(callback: () => Promise<void>, priority?: number): void
    {
        given(callback, "callback").ensureHasValue().ensureIsFunction();
        given(priority, "priority").ensureIsNumber().ensure(t => t >= 0);
        priority ??= 0;

        this._onCommits.push({
            callback,
            priority
        });
    }

    public async commit(): Promise<void>
    {
        if (!this._transactionScope)
        {
            if (this._onCommits.isNotEmpty)
                await this._onCommits
                    .groupBy(t => t.priority.toString())
                    .orderBy(t => Number.parseInt(t.key))
                    .forEachAsync(t => Promise.all(t.values.map(v => v.callback())) as unknown as Promise<void>, 1);

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
            await this._onCommits
                .groupBy(t => t.priority.toString())
                .orderBy(t => Number.parseInt(t.key))
                .forEachAsync(t => Promise.all(t.values.map(v => v.callback())) as unknown as Promise<void>, 1);
    }

    public onRollback(callback: () => Promise<void>, priority?: number): void
    {
        given(callback, "callback").ensureHasValue().ensureIsFunction();
        given(priority, "priority").ensureIsNumber().ensure(t => t >= 0);
        priority ??= 0;

        this._onRollbacks.push({
            callback,
            priority
        });
    }

    public async rollback(): Promise<void>
    {
        if (!this._transactionScope)
        {
            if (this._onRollbacks.isNotEmpty)
                await this._onRollbacks
                    .groupBy(t => t.priority.toString())
                    .orderBy(t => Number.parseInt(t.key))
                    .forEachAsync(t => Promise.all(t.values.map(v => v.callback())) as unknown as Promise<void>, 1);

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
            await this._onRollbacks
                .groupBy(t => t.priority.toString())
                .orderBy(t => Number.parseInt(t.key))
                .forEachAsync(t => Promise.all(t.values.map(v => v.callback())) as unknown as Promise<void>, 1);
    }

    private async _createTransactionScope(): Promise<Knex.Transaction>
    {
        const knex = await this._dbConnectionFactory.create() as Knex;
        const trx = await knex.transaction();

        this._transactionScope = {
            trx,
            isCommitting: false,
            isCommitted: false,
            isRollingBack: false,
            isRolledBack: false
        };

        return trx;
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

interface PostTransactionExec
{
    callback(): Promise<void>;
    priority: number;
}