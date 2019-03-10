import { DbConnectionFactory } from "./db-connection-factory";
import { given } from "@nivinjoseph/n-defensive";
import "@nivinjoseph/n-ext";
import * as Knex from "knex";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";


// public
export class KnexPgDbConnectionFactory implements DbConnectionFactory
{
    private readonly _config: any = {
        client: "pg",
        pool: {
            min: 2,
            max: 10
        }
        // debug: true
    };

    private _knex: Knex;
    private _isDisposed = false;
    
    
    public constructor(host: string, port: string, database: string, username: string, password: string)
    {
        given(host, "host").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        given(port, "port").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        given(database, "database").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        given(username, "username").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());
        given(password, "password").ensureHasValue().ensure(t => !t.isEmptyOrWhiteSpace());

        this._config.connection = {
            host: host.trim(),
            port: port.trim(),
            database: database.trim(),
            user: username.trim(),
            password: password.trim()
        };

        this._knex = Knex(this._config);
    }
    
    
    public create(): Promise<object>
    {
        if (this._isDisposed)
            return Promise.reject(new ObjectDisposedException(this));
        
        return Promise.resolve(this._knex);
    }
    
    public dispose(): Promise<void>
    {
        if (this._isDisposed)
            return Promise.resolve();    
        
        this._isDisposed = true;
        
        const knex = this._knex;
        this._knex = null;
        return new Promise<void>((resolve, reject) =>
        {
            knex.destroy().then(() => resolve()).catch((err) => reject(err));
        });
    }
}