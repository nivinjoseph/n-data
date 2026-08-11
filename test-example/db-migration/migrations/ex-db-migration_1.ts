import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, DbMigration, DbTableCreator } from "../../../src/index.js";
import { Studio } from "../../studio/studio.js";
import { SnapshotStudioRepository } from "../../studio/repositories/snapshot-studio-repository.js";

/**
 * Creates the studio tables.
 *
 * **The `_1` suffix is the version.** `DbMigrator` parses it off the class name: exactly one underscore, and
 * an integer greater than zero. So the class name is not decoration - renaming it renumbers the migration,
 * and a name with two underscores fails at bootstrap. The name is per *database* rather than per feature,
 * because the version is tracked in one system table per database and two naming schemes sharing it would
 * collide.
 *
 * Never edit a migration that has run somewhere. Version 1 is a historical fact once recorded; a change goes
 * in a new one.
 *
 * @class ExDbMigration_1
 */
@inject("Db", "Logger")
export class ExDbMigration_1 implements DbMigration
{
    private readonly _logger: Logger;
    private readonly _tableCreator: DbTableCreator;

    public constructor(db: Db, logger: Logger)
    {
        given(db, "db").ensureHasValue().ensureIsObject();
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;

        this._tableCreator = new DbTableCreator(db, logger);
    }

    public async execute(): Promise<void>
    {
        try
        {
            await this._tableCreator.createEventStreamTableForAggregate(Studio);

            // the indexes come from the repository that queries them - the same object, so the indexed
            // expression and the query expression cannot diverge
            await this._tableCreator.createSnapshotTableForAggregate(
                Studio, SnapshotStudioRepository.indexes);
        }
        catch (error)
        {
            await this._logger.logWarning("Studio table creation failed.");
            await this._logger.logError(error as any);
            throw error;
        }
    }
}
