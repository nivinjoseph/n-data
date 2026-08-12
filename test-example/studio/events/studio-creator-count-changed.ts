import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { StudioState } from "../studio-state.js";
import { StudioEvent, StudioEventData } from "./studio-event.js";

/**
 * The number of creators working in the studio changed.
 *
 * The absolute count travels rather than a delta, so replaying a prefix of the stream yields the count as
 * of that point rather than a partial sum that depends on where the replay stopped.
 *
 * @class StudioCreatorCountChanged
 */
@serialize
export class StudioCreatorCountChanged extends StudioEvent
{
    private readonly _creatorCount: number;

    @serialize
    public get creatorCount(): number { return this._creatorCount; }

    public constructor(data: StudioEventData & Pick<StudioCreatorCountChanged, "creatorCount">)
    {
        super(data);

        const { creatorCount } = data;

        given(creatorCount, "creatorCount").ensureHasValue().ensureIsNumber()
            .ensure(t => Number.isInteger(t) && t >= 0, "must be a non-negative integer");
        this._creatorCount = creatorCount;
    }

    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.creatorCount = this._creatorCount;
    }
}
