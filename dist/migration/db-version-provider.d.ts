export interface DbVersionProvider {
    getVersion(): Promise<number>;
    setVersion(version: number): Promise<void>;
}
//# sourceMappingURL=db-version-provider.d.ts.map