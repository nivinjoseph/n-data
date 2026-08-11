import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent, CreatorEventData } from "./creator-event.js";

/**
 * A skill was added to the creator.
 *
 * One skill per event rather than the whole list, so two concurrent additions do not overwrite each other
 * when the stream is replayed. The array in state is the fold.
 *
 * @class CreatorSkillAdded
 */
@serialize
export class CreatorSkillAdded extends CreatorEvent
{
    private readonly _skill: string;

    @serialize
    public get skill(): string { return this._skill; }

    public constructor(data: CreatorEventData & Pick<CreatorSkillAdded, "skill">)
    {
        super(data);

        const { skill } = data;

        given(skill, "skill").ensureHasValue().ensureIsString();
        this._skill = skill;
    }

    protected override applyEvent(state: CreatorState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        if (!state.skills.contains(this._skill))
            state.skills.push(this._skill);
    }
}
