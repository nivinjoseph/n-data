export interface DbConnectionFactory {
    create(): Promise<object>;
    destructor(): Promise<void>;
}
