import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent } from "./creator-event.js";

/**
 * The creator no longer works in the studio.
 *
 * Deactivation rather than deletion: the event stream is append-only, so the way something stops being true
 * is a new event saying so.
 *
 * @class CreatorDeactivated
 */
@serialize
export class CreatorDeactivated extends CreatorEvent
{
    protected override applyEvent(state: CreatorState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.isDeactivated = true;
    }
}
