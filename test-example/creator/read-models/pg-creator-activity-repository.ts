import { given } from "@nivinjoseph/n-defensive";
import { DomainContext } from "@nivinjoseph/n-domain";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { ColumnType, Db, ReadModelBaseRepository, ReadModelSchema, UnitOfWork } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { CreatorActivity } from "./creator-activity.js";
import { CreatorActivityRepository } from "./creator-activity-repository.js";

/**
 * The Postgres implementation of the projection: `creator_activity_read_model`, one real typed
 * column per property.
 *
 * **The declaration below is the only declaration.** `ExDbMigration_5` creates the table from this
 * same `schema` object, every predicate in this class is built by it, and `example.test.ts` hands it
 * to `verifyReadModelTable` to assert no drift - the same single-source rule the snapshot
 * repositories follow with their `SnapshotQuerySet`, with one simplification: `ReadModelSchema<T>` is
 * fully determined by the model, so there is no `querySet`-style getter to override and nothing to
 * widen. The base holds the schema at its concrete type, and `this.schema.eq("studioId", ...)` is
 * checked against the declaration at every call site.
 *
 * Nothing here mentions `organization_id`, and nothing filters by it: a read model is
 * cross-organization by design, and `studioId` is a column that the methods wanting one studio
 * constrain explicitly.
 *
 * @class PgCreatorActivityRepository
 */
@inject("DomainContext", "Db", "UnitOfWork", "Logger")
export class PgCreatorActivityRepository extends ReadModelBaseRepository<CreatorActivity> implements CreatorActivityRepository
{
    /**
     * Declared once; consumed by the migration and by every query below.
     *
     * `joinedAt` is a `timestamptz` - a real timestamp in the table, written from and read back as
     * epoch milliseconds - so the analytical door can `date_trunc` it. `skills` takes a GIN index, so
     * containment is an index lookup across every studio. The composite serves `getRoleInStudio`, and
     * its leading column serves `getByStudio` on its own.
     */
    public static readonly schema = ReadModelSchema.for(CreatorActivity, {
        studioId: { type: ColumnType.text },
        email: { type: ColumnType.text, index: true },
        displayName: { type: ColumnType.text },
        role: { type: ColumnType.text, index: true },
        joinedAt: { type: ColumnType.timestamptz, index: true },
        isDeactivated: { type: ColumnType.boolean },
        skills: { type: ColumnType.textArray, index: true },
        skillCount: { type: ColumnType.integer }
    }).withIndex(["studioId", "role"]);

    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
    {
        super(domainContext, db, unitOfWork, logger, PgCreatorActivityRepository.schema);
    }

    public getByStudio(studioId: string): Promise<Array<CreatorActivity>>
    {
        given(studioId, "studioId").ensureHasValue().ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));

        // the leading column of the (studio_id, role) composite serves this on its own
        return this.query(this.schema.eq("studioId", studioId));
    }

    public getRoleInStudio(studioId: string, role: string): Promise<Array<CreatorActivity>>
    {
        given(studioId, "studioId").ensureHasValue().ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));
        given(role, "role").ensureHasValue().ensureIsString();

        return this.query(this.schema.and(
            this.schema.eq("studioId", studioId),
            this.schema.eq("role", role)));
    }

    public getBySkillAcrossStudios(skill: string): Promise<Array<CreatorActivity>>
    {
        given(skill, "skill").ensureHasValue().ensureIsString();

        return this.query(this.schema.contains("skills", skill.trim().toLowerCase()));
    }

    public getJoinedSince(since: number): Promise<Array<CreatorActivity>>
    {
        given(since, "since").ensureHasValue().ensureIsNumber();

        // a number on both sides of the API; the schema converts it on the parameter side of the
        // comparison, so the timestamptz btree still serves it
        return this.query({
            where: this.schema.gte("joinedAt", since),
            orderBy: this.schema.orderBy("joinedAt", "desc")
        });
    }

    /**
     * A projection over the projection - a group-by has no read model to be, so it goes through the
     * raw door. The column names come from the declaration, and the count is cast because pg hands a
     * `bigint` back as a string.
     */
    public async countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>
    {
        const result = await this.queryRaw<{ role: string; count: number; }>(
            `select ${this.schema.columnFor("role")} as role, cast(count(*) as int) as count
             from ${this.table} group by 1 order by 1;`);

        return result.rows;
    }
}
