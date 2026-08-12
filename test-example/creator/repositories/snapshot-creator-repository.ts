import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { JsonValueType, OrgSnapshotBaseRepository, SnapshotQuerySet } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { Creator } from "../creator.js";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent } from "../events/creator-event.js";
import { EventStreamCreatorRepository } from "./event-stream-creator-repository.js";
import { CreatorRepository } from "./creator-repository.js";

/**
 * The canonical read path for `Creator` - reads `creator_snaps`, scoped to the current studio.
 *
 * Nothing below mentions `organization_id`, and that is the point. `query` prepends it to every predicate
 * from `this.domainContext.organizationId`, which is both the tenant isolation and the leading column every
 * btree index on this table starts with - so a query is scoped and index-usable for the same reason. The
 * only way past it is `queryAcrossOrganizations`, named for its consequence.
 *
 * The uniqueness that follows from that is worth noting: `email` is declared unique, but because the index
 * leads with `organization_id` it is unique **per studio**. The same address can appear once in each, which
 * is what a tenant-scoped natural key means. It also means the bucket is whatever the domain context
 * resolves to at write time - a hard-coded or sentinel organization would collapse every write into one
 * bucket, making a constraint that reads as per-tenant behave globally.
 *
 * @class SnapshotCreatorRepository
 */
@inject("EventStreamCreatorRepository")
export class SnapshotCreatorRepository
    extends OrgSnapshotBaseRepository<Creator, CreatorState, CreatorEvent>
    implements CreatorRepository
{
    /**
     * Declared once; `ExDbMigration_2` creates the table from this same object.
     *
     * `organizationId` is absent deliberately - it is a real column here, and the query set refuses to index
     * or query the copy inside `data`, because that copy is not what any index covers.
     */
    public static readonly indexes = SnapshotQuerySet.for<CreatorState>()
        .withPath("email", { unique: true })
        .withPath("joinedAt", { type: JsonValueType.bigint })
        .withPath("isDeactivated")
        // `role` is not declared on its own, and does not need to be: btree serves a leading prefix, so this
        // composite answers a query on `role` alone as well as one on both. Declaring it twice is not merely
        // redundant, it is rejected - a path may belong to exactly one index in a set.
        .withComposite(["role", "displayName"])
        .withArrayPath("skills");

    protected override get querySet(): typeof SnapshotCreatorRepository.indexes
    {
        return SnapshotCreatorRepository.indexes;
    }

    public constructor(eventStreamRepository: EventStreamCreatorRepository)
    {
        super(eventStreamRepository);
    }

    public checkIfEmailExists(email: string, excludeId?: string): Promise<boolean>
    {
        given(email, "email").ensureHasValue().ensureIsString();
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.creator));

        // `exists` scopes to the current studio the same way `query` does, so this reads as the per-studio
        // question it is. `queryRaw` would not - that door gets no organization filter, which is why the two
        // statements further down have to constrain the column by hand.
        return this.exists(this.querySet.eq("email", email), excludeId);
    }

    public countActive(): Promise<number>
    {
        // what the studio's seat limit is checked against; scoped to this studio, like every read here
        return this.count(this.querySet.eq("isDeactivated", false));
    }

    public async getByEmail(email: string): Promise<Creator | null>
    {
        given(email, "email").ensureHasValue().ensureIsString();

        const result = await this.query(this.querySet.eq("email", email));

        // at most one within this studio, because the unique index leads with the organization
        return result.isEmpty ? null : result[0];
    }

    public getByRole(role: string): Promise<Array<Creator>>
    {
        given(role, "role").ensureHasValue().ensureIsString();

        return this.query(this.querySet.eq("role", role));
    }

    public getBySkill(skill: string): Promise<Array<Creator>>
    {
        given(skill, "skill").ensureHasValue().ensureIsString();

        return this.query(this.querySet.contains("skills", skill));
    }

    public getActiveInRoles(roles: ReadonlyArray<string>): Promise<Array<Creator>>
    {
        given(roles, "roles").ensureHasValue().ensureIsArray().ensureIsNotEmpty();

        // the `in` sits inside an `and`, and both are parenthesized - without that the organization filter
        // `query` prepends could be escaped by a top-level `or`
        return this.query({
            where: this.querySet.and(
                this.querySet.in("role", roles),
                this.querySet.eq("isDeactivated", false)),
            orderBy: [this.querySet.orderBy("role"), this.querySet.orderBy("displayName")]
        });
    }

    public getRecentlyJoined(since: number, count: number): Promise<Array<Creator>>
    {
        given(since, "since").ensureHasValue().ensureIsNumber();
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        // a number, because `joinedAt` declared a bigint cast. Without one this would not compile - epoch
        // millis compared as text would order lexicographically
        return this.query({
            where: this.querySet.gte("joinedAt", since),
            orderBy: this.querySet.orderBy("joinedAt", "desc"),
            limit: count
        });
    }

    public async countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>
    {
        const expression = this.querySet.expressionFor("role");

        const result = await this.queryRaw<{ role: string; count: number; }>(
            `select ${expression} as role, cast(count(*) as int) as count
             from ${this.table} where organization_id = ? group by 1 order by 2 desc;`,
            this.domainContext.organizationId);

        return result.rows;
    }

    /**
     * Every creator holding this email, in every studio.
     *
     * The deliberate exception, and the only method here that leaves the tenant boundary - which is why it
     * is named for that rather than for what it selects. A platform-wide question ("is this person in more
     * than one studio?") is legitimate; it just has to be visible at the call site.
     */
    public queryAcrossStudiosByEmail(email: string): Promise<Array<Creator>>
    {
        given(email, "email").ensureHasValue().ensureIsString();

        return this.queryAcrossOrganizations(
            `select data from ${this.table} where ${this.querySet.expressionFor("email")} = ?;`,
            email);
    }
}
