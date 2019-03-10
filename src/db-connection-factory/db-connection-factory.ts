import { Disposable } from "@nivinjoseph/n-util";

// public
export interface DbConnectionFactory extends Disposable
{
    create(): Promise<object>;
}