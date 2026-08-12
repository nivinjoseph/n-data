import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, DbMigration, DbTableCreator } from "../../../src/index.js";
import { Creator } from "../../creator/creator.js";
import { SnapshotCreatorRepository } from "../../creator/repositories/snapshot-creator-repository.js";

/**
 * Creates the creator tables - the organization-scoped variants.
 *
 * A second migration rather than more work in the first, so versioning is real: a database already at
 * version 1 runs only this one, and `DbMigrator` advances the recorded version after each migration
 * individually. A failure here leaves the database recorded at 1, so a retry resumes rather than restarting.
 *
 * The `ForOrgAggregate` calls add a non-null `organization_id` column and lead every btree index with it,
 * which is what makes the unique `email` index unique *per studio* and what makes the filter `query` prepends
 * index-usable. The GIN index over `skills` cannot lead with that column, so the creator table also gets a
 * standalone `(organization_id)` index for the planner to combine with it.
 *
 * @class ExDbMigration_2
 */
@inject("Db", "Logger")
export class ExDbMigration_2 implements DbMigration
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
            await this._tableCreator.createEventStreamTableForOrgAggregate(Creator);

            await this._tableCreator.createSnapshotTableForOrgAggregate(
                Creator, SnapshotCreatorRepository.indexes);
        }
        catch (error)
        {
            await this._logger.logWarning("Creator table creation failed.");
            await this._logger.logError(error as any);
            throw error;
        }
    }
}
