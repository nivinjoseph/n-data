import { SystemRepository } from "./system/system-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DbInfo } from "./system/db-info.js";
import { DbVersionProvider } from "./db-version-provider.js";
import { inject } from "@nivinjoseph/n-ject";
import { MigrationDependencyKey } from "./migration-dependency-key.js";
import { DateTime } from "@nivinjoseph/n-util";


@inject(MigrationDependencyKey.dbSystemRepository)
export class DefaultDbVersionProvider implements DbVersionProvider
{
    private readonly _systemRepository: SystemRepository;


    public constructor(systemRepository: SystemRepository)
    {
        given(systemRepository, "systemRepository").ensureHasValue().ensureIsObject();
        this._systemRepository = systemRepository;
    }


    public async getVersion(): Promise<number>
    {
        const isDbInitialized = await this._systemRepository.checkIsInitialized();
        if (!isDbInitialized)
            await this._systemRepository.initialize();

        const info = await this._systemRepository.getDbInfo();
        return info.version;
    }

    public async setVersion(version: number): Promise<void>
    {
        given(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        const info = new DbInfo(version, DateTime.now().dateValue);
        await this._systemRepository.saveDbInfo(info);
    }
}