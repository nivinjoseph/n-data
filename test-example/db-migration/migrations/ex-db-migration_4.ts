import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, DbMigration, DbTableCreator } from "../../../src/index.js";
import { Creator } from "../../creator/creator.js";
import { SnapshotCreatorRepository } from "../../creator/repositories/snapshot-creator-repository.js";

/**
 * Adds the cross-studio twin of the `email` index to `creator_snaps`.
 *
 * **Flagging a path `acrossOrganizations` needs a migration of its own, exactly as adding a path does.**
 * The flag is a second index - `idx_creator_snaps_email_xorg`, the same expression with no
 * `organization_id` prefix - and `ExDbMigration_2` created the creator tables before it was declared. A
 * migration never re-runs, so a database already recorded at 3 would never see the twin: the typed
 * cross-studio read would compile, run, and scan while looking indexed, which is the drift
 * `verifySnapshotTableForOrgAggregate` reports as a fatal `index-missing` for the twin.
 *
 * So this re-calls the create with the *current* declaration. Nothing is duplicated: the DDL is
 * `if not exists` matched on the derived name, so the indexes `_2` already built are skipped and only the
 * twin is created. The org-leading `email` index - and the per-studio uniqueness it enforces - is untouched;
 * the twin is never unique.
 *
 * @class ExDbMigration_4
 */
@inject("Db", "Logger")
export class ExDbMigration_4 implements DbMigration
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
            await this._tableCreator.createSnapshotTableForOrgAggregate(
                Creator, SnapshotCreatorRepository.indexes);
        }
        catch (error)
        {
            await this._logger.logWarning("Creator snapshot index creation failed.");
            await this._logger.logError(error as any);
            throw error;
        }
    }
}
