// public
export interface DbConnectionFactory
{
    create(): Promise<object>;
    dispose(): Promise<void>;
}