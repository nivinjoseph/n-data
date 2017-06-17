// public
export interface DbConnectionFactory
{
    create(): Promise<object>;
}