import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, DbMigration, DbTableCreator } from "../../../src/index.js";
import { SnapshotStudioRepository } from "../../studio/repositories/snapshot-studio-repository.js";
import { Studio } from "../../studio/studio.js";

/**
 * Adds the `plan.featureCount` index to `studio_snaps`.
 *
 * **A path added to a query set needs a migration of its own.** `ExDbMigration_1` created the studio
 * tables from the same `SnapshotStudioRepository.indexes` object, but a migration is versioned by its
 * class name and never re-runs - so a database already recorded at 2 would never see the new path. It
 * would compile, it would produce a predicate, and it would sequential-scan forever while looking
 * indexed. Editing `_1` is not the fix either: version 1 is a historical fact wherever it has run.
 *
 * So this re-calls the create with the *current* declaration. Nothing is duplicated: the DDL is
 * `if not exists` matched on the derived name, so the six indexes `_1` already built are skipped and
 * only `idx_studio_snaps_plan_featurecount` is created. The event stream table is untouched - the new
 * path indexes snapshot state, and the stream has no state to index.
 *
 * What this idiom does *not* cover, and the reason `example.test.ts` asserts
 * `verifySnapshotTableForAggregate` empty right after: name matching cannot see a changed
 * `JsonValueType`, so re-calling create would silently keep an old uncast index rather than replace
 * it. Adding a path is safe here precisely because the name is new.
 *
 * @class ExDbMigration_3
 */
@inject("Db", "Logger")
export class ExDbMigration_3 implements DbMigration
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
            await this._tableCreator.createSnapshotTableForAggregate(
                Studio, SnapshotStudioRepository.indexes);
        }
        catch (error)
        {
            await this._logger.logWarning("Studio snapshot index creation failed.");
            await this._logger.logError(error as any);
            throw error;
        }
    }
}
