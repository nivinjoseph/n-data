import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { StudioState } from "../studio-state.js";
import { StudioEvent } from "./studio-event.js";

/**
 * The studio was archived.
 *
 * No payload, so no constructor - it inherits the base's `(data: DomainEventData)` and is built as
 * `new StudioArchived({})`.
 *
 * @class StudioArchived
 */
@serialize
export class StudioArchived extends StudioEvent
{
    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.isArchived = true;
    }
}
