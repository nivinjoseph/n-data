import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { StudioState } from "../studio-state.js";
import { StudioPlan } from "../value-objects/studio-plan.js";
import { StudioEvent, StudioEventData } from "./studio-event.js";

/**
 * The studio moved to a different plan.
 *
 * The payload is the value object itself. It round-trips because `StudioPlan` is `@serialize`-decorated:
 * `Serializable.serialize` walks nested `Serializable` values, and `Deserializer` revives anything
 * carrying a `$typename` - so the plan comes back as a `StudioPlan`, not as a bare object, and
 * `ensureIsType` below still holds after a replay.
 *
 * @class StudioPlanChanged
 */
@serialize
export class StudioPlanChanged extends StudioEvent
{
    private readonly _plan: StudioPlan;

    @serialize
    public get plan(): StudioPlan { return this._plan; }

    public constructor(data: StudioEventData & Pick<StudioPlanChanged, "plan">)
    {
        super(data);

        const { plan } = data;

        given(plan, "plan").ensureHasValue().ensureIsType(StudioPlan);
        this._plan = plan;
    }

    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.plan = this._plan;
    }
}
