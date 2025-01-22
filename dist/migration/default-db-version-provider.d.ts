import { SystemRepository } from "./system/system-repository";
import { DbVersionProvider } from "./db-version-provider";
export declare class DefaultDbVersionProvider implements DbVersionProvider {
    private readonly _systemRepository;
    constructor(systemRepository: SystemRepository);
    getVersion(): Promise<number>;
    setVersion(version: number): Promise<void>;
}
