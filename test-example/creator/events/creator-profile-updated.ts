import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent, CreatorEventData } from "./creator-event.js";

/**
 * The creator's display name changed.
 *
 * @class CreatorProfileUpdated
 */
@serialize
export class CreatorProfileUpdated extends CreatorEvent
{
    private readonly _displayName: string;

    @serialize
    public get displayName(): string { return this._displayName; }

    public constructor(data: CreatorEventData & Pick<CreatorProfileUpdated, "displayName">)
    {
        super(data);

        const { displayName } = data;

        given(displayName, "displayName").ensureHasValue().ensureIsString();
        this._displayName = displayName;
    }

    protected override applyEvent(state: CreatorState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.displayName = this._displayName;
    }
}
