import { AggregateState, AggregateStateFactory } from "@nivinjoseph/n-domain";
import { StudioPlan } from "./value-objects/studio-plan.js";

/**
 * A studio's state. This is what the snapshot table's `data` column holds, so it is also what every
 * index path is declared against.
 */
export interface StudioState extends AggregateState
{
    name: string;
    /**
     * The studio's natural key - unique across the whole table, enforced by a unique index. Compared as
     * **stored**, so the domain normalizes it before it ever reaches here.
     */
    slug: string;
    plan: StudioPlan;
    creatorCount: number;
    isArchived: boolean;
    tags: Array<string>;
}

/**
 * Produces the default state a studio starts from, and the base every replay layers events onto.
 *
 * `create()` must be **deterministic** - the same output on every call. Two things depend on it: the
 * `AggregateRoot` constructor freezes this output into the created event as `$frozenDefaultState`, so a
 * field no event ever writes is sourced from the stream rather than from a future version of this
 * method; and `AggregateStateHelper.fingerprintState` pins it in a test, so changing a default is a
 * deliberate act rather than a silent rewrite of history.
 *
 * @class StudioStateFactory
 */
export class StudioStateFactory extends AggregateStateFactory<StudioState>
{
    public create(): StudioState
    {
        return {
            ...this.createDefaultAggregateState(),

            name: null as unknown as string,
            slug: null as unknown as string,
            plan: StudioPlan.createFree(),
            creatorCount: 0,
            isArchived: false,
            tags: []
        };
    }
}
