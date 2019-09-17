export interface DbVersionProvider {
    getVersion(): Promise<number>;
    setVersion(version: number): Promise<void>;
}
