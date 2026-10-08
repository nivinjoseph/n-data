import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, DbMigration, ReadModelTableCreator } from "../../../src/index.js";
import { PgCreatorActivityRepository } from "../../creator/read-models/pg-creator-activity-repository.js";

/**
 * Creates `creator_activity_read_model` from the repository's declaration.
 *
 * A read model table is created by `ReadModelTableCreator`, a sibling of `DbTableCreator` rather
 * than a part of it, because its posture differs: every declared column is `add column if not
 * exists` on every run, so a property added to `CreatorActivity` later needs nothing more than a
 * migration that re-calls this create - the same idiom as `ExDbMigration_3` and `_4`, and nothing is
 * duplicated, since every statement is `if not exists`. No column is ever `not null`, which is what
 * makes a column added on day 2 identical to one created on day 1.
 *
 * @class ExDbMigration_5
 */
@inject("Db", "Logger")
export class ExDbMigration_5 implements DbMigration
{
    private readonly _logger: Logger;
    private readonly _tableCreator: ReadModelTableCreator;

    public constructor(db: Db, logger: Logger)
    {
        given(db, "db").ensureHasValue().ensureIsObject();
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;

        this._tableCreator = new ReadModelTableCreator(db, logger);
    }

    public async execute(): Promise<void>
    {
        try
        {
            await this._tableCreator.createReadModelTable(PgCreatorActivityRepository.schema);
        }
        catch (error)
        {
            await this._logger.logWarning("Creator activity read model table creation failed.");
            await this._logger.logError(error as any);
            throw error;
        }
    }
}
