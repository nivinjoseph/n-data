import { SystemRepository } from "./system/system-repository";
import { given } from "@nivinjoseph/n-defensive";
import * as moment from "moment";
import { DbInfo } from "./system/db-info";
import { DbVersionProvider } from "./db-version-provider";
import { inject } from "@nivinjoseph/n-ject";
import { MigrationDependencyKey } from "./migration-dependency-key";


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

        const info = new DbInfo(version, moment().format("YYYY-MM-DD"));
        await this._systemRepository.saveDbInfo(info);
    }
}