import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { IdPrefix } from "../../common/id-prefix.js";
import { StudioState } from "../studio-state.js";
import { StudioPlan } from "../value-objects/studio-plan.js";
import { StudioEvent, StudioEventData } from "./studio-event.js";

/**
 * A studio came into existence.
 *
 * Two things are specific to a created event. `$isCreatedEvent` is set **before** `super(data)`, because
 * the base reads it out of `data` in its own constructor. And `applyEvent` must set `state.id` - the
 * framework throws "Created event did not set the id of the aggregate" otherwise, since the aggregate's
 * identity comes from state, not from a constructor argument.
 *
 * @class StudioCreated
 */
@serialize
export class StudioCreated extends StudioEvent
{
    private readonly _studioId: string;
    private readonly _studioName: string;
    private readonly _slug: string;
    private readonly _plan: StudioPlan;

    @serialize
    public get studioId(): string { return this._studioId; }

    @serialize
    public get studioName(): string { return this._studioName; }

    @serialize
    public get slug(): string { return this._slug; }

    @serialize
    public get plan(): StudioPlan { return this._plan; }

    public constructor(data: StudioEventData & Pick<StudioCreated, "studioId" | "studioName" | "slug" | "plan">)
    {
        given(data, "data").ensureHasValue().ensureIsObject();
        data.$isCreatedEvent = true;

        super(data);

        const { studioId, studioName, slug, plan } = data;

        // ids are opaque strings, so the prefix assertion is the only thing stopping another
        // aggregate's id being recorded here and replayed forever
        given(studioId, "studioId").ensureHasValue().ensureIsString()
            .ensure(t => t.startsWith(IdPrefix.studio));
        this._studioId = studioId;

        given(studioName, "studioName").ensureHasValue().ensureIsString();
        this._studioName = studioName;

        given(slug, "slug").ensureHasValue().ensureIsString();
        this._slug = slug;

        given(plan, "plan").ensureHasValue().ensureIsType(StudioPlan);
        this._plan = plan;
    }

    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.id = this._studioId;
        state.name = this._studioName;
        state.slug = this._slug;
        state.plan = this._plan;
    }
}
