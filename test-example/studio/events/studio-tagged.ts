import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { StudioState } from "../studio-state.js";
import { StudioEvent, StudioEventData } from "./studio-event.js";

/**
 * A tag was added to the studio.
 *
 * The event carries the single tag rather than the whole list, so two concurrent tags do not overwrite
 * each other on replay. The array in state is the fold of every one of these.
 *
 * @class StudioTagged
 */
@serialize
export class StudioTagged extends StudioEvent
{
    private readonly _tag: string;

    @serialize
    public get tag(): string { return this._tag; }

    public constructor(data: StudioEventData & Pick<StudioTagged, "tag">)
    {
        super(data);

        const { tag } = data;

        given(tag, "tag").ensureHasValue().ensureIsString();
        this._tag = tag;
    }

    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        if (!state.tags.contains(this._tag))
            state.tags.push(this._tag);
    }
}
