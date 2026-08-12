import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent, CreatorEventData } from "./creator-event.js";

/**
 * The creator's role within the studio changed.
 *
 * @class CreatorRoleChanged
 */
@serialize
export class CreatorRoleChanged extends CreatorEvent
{
    private readonly _role: string;

    @serialize
    public get role(): string { return this._role; }

    public constructor(data: CreatorEventData & Pick<CreatorRoleChanged, "role">)
    {
        super(data);

        const { role } = data;

        given(role, "role").ensureHasValue().ensureIsString();
        this._role = role;
    }

    protected override applyEvent(state: CreatorState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.role = this._role;
    }
}
