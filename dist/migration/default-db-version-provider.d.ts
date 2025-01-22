import { SystemRepository } from "./system/system-repository.js";
import { DbVersionProvider } from "./db-version-provider.js";
export declare class DefaultDbVersionProvider implements DbVersionProvider {
    private readonly _systemRepository;
    constructor(systemRepository: SystemRepository);
    getVersion(): Promise<number>;
    setVersion(version: number): Promise<void>;
}
//# sourceMappingURL=default-db-version-provider.d.ts.map