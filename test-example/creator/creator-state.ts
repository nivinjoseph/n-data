import { OrgAggregateState, OrgAggregateStateFactory, OrgDomainContext } from "@nivinjoseph/n-domain";
import { given } from "@nivinjoseph/n-defensive";

/**
 * A creator's state. `organizationId` arrives from `OrgAggregateState` and is the studio the creator
 * belongs to.
 *
 * Note there is no `organizationId` among the indexable paths later: on an org-scoped snapshot table it is
 * a real column, and every btree index leads with it, so constraining the column both isolates the tenant
 * and uses the index. The copy inside `data` is not what any index covers, which is why the query set
 * refuses to index or query that path.
 */
export interface CreatorState extends OrgAggregateState
{
    /**
     * Unique **within the studio** - the same address may appear once per tenant, which is what a
     * tenant-scoped natural key means.
     */
    email: string;
    displayName: string;
    role: string;
    /**
     * Epoch milliseconds. Stored as a number rather than an ISO string because a timestamp type cannot be
     * used in a Postgres index expression - it parses through a non-immutable function - so the documented
     * way to index a moment in time is epoch millis with a `bigint` cast.
     */
    joinedAt: number;
    isDeactivated: boolean;
    skills: Array<string>;
}

/**
 * Produces a creator's default state.
 *
 * Unlike the plain variant, this one **takes the domain context**: `createDefaultAggregateState` stamps
 * `organizationId` from it. That makes the factory per-context and impossible to share as a singleton -
 * every construction site has to have the context in hand first.
 *
 * @class CreatorStateFactory
 */
export class CreatorStateFactory extends OrgAggregateStateFactory<CreatorState>
{
    public constructor(orgDomainContext: OrgDomainContext)
    {
        given(orgDomainContext, "orgDomainContext").ensureHasValue().ensureIsObject();

        super(orgDomainContext);
    }

    public override create(): CreatorState
    {
        return {
            ...this.createDefaultAggregateState(),

            email: null as unknown as string,
            displayName: null as unknown as string,
            role: "member",
            joinedAt: 0,
            isDeactivated: false,
            skills: []
        };
    }
}
