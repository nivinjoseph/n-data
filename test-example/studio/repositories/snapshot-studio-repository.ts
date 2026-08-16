import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { JsonValueType, SnapshotBaseRepository, SnapshotQuerySet } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { StudioEvent } from "../events/studio-event.js";
import { Studio } from "../studio.js";
import { StudioState } from "../studio-state.js";
import { EventStreamStudioRepository } from "./event-stream-studio-repository.js";
import { StudioRepository } from "./studio-repository.js";

/**
 * The canonical read path for `Studio` - reads `studio_snaps` and writes both it and the underlying
 * event stream on save.
 *
 * **The declaration below is the only declaration.** `ExDbMigration_1` creates the table from this same
 * `indexes` object, and every predicate in this class is built by it, so an index that is queried is
 * necessarily one that was created. That closes the gap the older pattern left open, where a
 * `SnapshotIndex` could be declared, queried through `expressionForPath`, and left out of the array the
 * migration consumed - a silent sequential scan with nothing failing at startup.
 *
 * It also makes the paths and values checkable. `this.querySet.eq("slug", …)` accepts only a path
 * declared here - not merely one that exists on `StudioState` - and only a value of that leaf's type.
 * `gt("creatorCount", 5)` compiles because a numeric cast was declared; without one it would not,
 * because an uncast extraction compares as text and `'9' > '100'`.
 *
 * The `querySet` override is what carries that narrow type to the call sites: the base declares the
 * property at the declaration-only `DeclaredSnapshotQuerySet`, since it cannot know which paths a
 * subclass chose - so copying the base's type by mistake yields an object with no query methods at
 * all, rather than one that silently accepts any path. The override returns the `indexes` static
 * unchanged - one object, named on each side for the job that side does with it.
 *
 * @class SnapshotStudioRepository
 */
@inject("EventStreamStudioRepository")
export class SnapshotStudioRepository
    extends SnapshotBaseRepository<Studio, StudioState, StudioEvent>
    implements StudioRepository
{
    /**
     * Declared once; consumed by the migration and by every query below.
     *
     * `slug` is unique across the whole table - the only absolute uniqueness available over aggregate
     * state, and the reason this variant exists at all rather than the event-stream one. `seatLimit` and
     * `creatorCount` declare numeric casts because they are numbers, and `plan.tier` reaches a key inside
     * the plan value object, which exists in `data` because `StudioPlan` declares it `@serialize`.
     */
    public static readonly indexes = SnapshotQuerySet.for<StudioState>()
        .withPath("slug", { unique: true })
        .withPath("name")
        .withPath("plan.tier")
        .withPath("plan.seatLimit", { type: JsonValueType.integer })
        .withPath("creatorCount", { type: JsonValueType.integer })
        .withPath("isArchived")
        .withArrayPath("tags")
        // an array that lives INSIDE the plan value object's serialized record, not beside it: the
        // path walk reaches it through DomainObjectSerialized, and the DDL is the same #> GIN index
        // a top-level array gets. Writable only as of n-domain 4.0.3 - see StudioPlan.
        .withArrayPath("plan.features");

    protected override get querySet(): typeof SnapshotStudioRepository.indexes
    {
        return SnapshotStudioRepository.indexes;
    }

    public constructor(eventStreamRepository: EventStreamStudioRepository)
    {
        super(eventStreamRepository);
    }

    public checkIfSlugExists(slug: string, excludeId?: string): Promise<boolean>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));

        // `exists` rather than `query`: the answer is yes or no, so there is no aggregate to deserialize.
        // `excludeId` is what makes this usable from a rename - the studio is allowed to keep its own slug.
        return this.exists(this.querySet.eq("slug", slug), excludeId);
    }

    public async getBySlug(slug: string): Promise<Studio | null>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();

        const result = await this.query(this.querySet.eq("slug", slug));

        // at most one, because the index is unique
        return result.isEmpty ? null : result[0];
    }

    public getByPlanTier(tier: string): Promise<Array<Studio>>
    {
        given(tier, "tier").ensureHasValue().ensureIsString();

        // the archived exclusion composes with the tier match rather than being a second query, and the
        // combinator parenthesizes both sides so neither can escape the other
        return this.query(this.querySet.and(
            this.querySet.eq("plan.tier", tier),
            this.querySet.eq("isArchived", false)));
    }

    public getByTag(tag: string): Promise<Array<Studio>>
    {
        given(tag, "tag").ensureHasValue().ensureIsString();

        return this.query(this.querySet.contains("tags", tag));
    }

    /**
     * Containment against an array nested inside a value object. Like `getCountByPlanTier`, this is
     * declared on the concrete repository rather than on `StudioRepository` - it only means anything
     * where there is a snapshot table to index, so the in-memory implementation owes nothing.
     */
    public getByPlanFeature(feature: string): Promise<Array<Studio>>
    {
        given(feature, "feature").ensureHasValue().ensureIsString();

        return this.query(this.querySet.contains("plan.features", feature));
    }

    public getLargest(count: number): Promise<Array<Studio>>
    {
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        return this.query({
            where: this.querySet.eq("isArchived", false),
            orderBy: this.querySet.orderBy("creatorCount", "desc"),
            limit: count
        });
    }

    /**
     * Studios whose plan is one of `tiers` and that are over `minCreatorCount`.
     *
     * Here for the range comparison: `creatorCount` declared an integer cast, so a number is accepted.
     * Had it been declared without one, this would not compile - which is the `'9' > '100'` hazard turned
     * into a compile error.
     */
    public getBusyOnTiers(tiers: ReadonlyArray<string>, minCreatorCount: number): Promise<Array<Studio>>
    {
        given(tiers, "tiers").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        given(minCreatorCount, "minCreatorCount").ensureHasValue().ensureIsNumber();

        return this.query({
            where: this.querySet.and(
                this.querySet.in("plan.tier", tiers),
                this.querySet.gt("creatorCount", minCreatorCount)),
            orderBy: this.querySet.orderBy("creatorCount", "desc")
        });
    }

    /**
     * How many studios sit on each plan tier.
     *
     * A projection, so it goes through `queryRaw` - `query` deserializes each row into an aggregate and a
     * group-by has no aggregate to be. The grouping expression comes from the declaration, so it is the
     * same expression the index was built on.
     */
    public async getCountByPlanTier(): Promise<ReadonlyArray<{ tier: string; count: number; }>>
    {
        const expression = this.querySet.expressionFor("plan.tier");

        const result = await this.queryRaw<{ tier: string; count: number; }>(
            `select ${expression} as tier, cast(count(*) as int) as count
             from ${this.table} group by 1 order by 2 desc;`);

        return result.rows;
    }

    /**
     * The slugs of every studio, as a flat list.
     *
     * Uses `queryStatement` - the escape hatch - because `distinct` is not something the statement
     * `query` builds can express. Everything `query` guarantees becomes this caller's responsibility: the
     * select list must be `data`, since that is the column each row is deserialized from.
     */
    public queryDistinctByTier(tier: string): Promise<Array<Studio>>
    {
        given(tier, "tier").ensureHasValue().ensureIsString();

        return this.queryStatement(
            `select distinct on (${this.querySet.expressionFor("slug")}) data
             from ${this.table}
             where ${this.querySet.expressionFor("plan.tier")} = ?
             order by ${this.querySet.expressionFor("slug")};`,
            tier);
    }
}
