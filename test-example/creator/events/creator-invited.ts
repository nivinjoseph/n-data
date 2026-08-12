import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { IdPrefix } from "../../common/id-prefix.js";
import { CreatorState } from "../creator-state.js";
import { CreatorEvent, CreatorEventData } from "./creator-event.js";

/**
 * A creator was invited into a studio.
 *
 * The created event. It never carries the organization id: `OrgAggregateStateFactory` has already stamped
 * that into default state from the domain context, and `OrgDomainEvent.apply` cross-checks the two. Passing
 * it here as well would be a second source of truth for the same fact.
 *
 * @class CreatorInvited
 */
@serialize
export class CreatorInvited extends CreatorEvent
{
    private readonly _creatorId: string;
    private readonly _email: string;
    private readonly _displayName: string;
    private readonly _joinedAt: number;

    @serialize
    public get creatorId(): string { return this._creatorId; }

    @serialize
    public get email(): string { return this._email; }

    @serialize
    public get displayName(): string { return this._displayName; }

    @serialize
    public get joinedAt(): number { return this._joinedAt; }

    public constructor(data: CreatorEventData & Pick<CreatorInvited, "creatorId" | "email" | "displayName" | "joinedAt">)
    {
        given(data, "data").ensureHasValue().ensureIsObject();
        data.$isCreatedEvent = true;

        super(data);

        const { creatorId, email, displayName, joinedAt } = data;

        given(creatorId, "creatorId").ensureHasValue().ensureIsString()
            .ensure(t => t.startsWith(IdPrefix.creator));
        this._creatorId = creatorId;

        given(email, "email").ensureHasValue().ensureIsString();
        this._email = email;

        given(displayName, "displayName").ensureHasValue().ensureIsString();
        this._displayName = displayName;

        // carried on the event rather than read from a clock in applyEvent - replaying must produce the
        // same state it produced the first time, and a clock read would not
        given(joinedAt, "joinedAt").ensureHasValue().ensureIsNumber().ensure(t => t > 0);
        this._joinedAt = joinedAt;
    }

    protected override applyEvent(state: CreatorState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.id = this._creatorId;
        state.email = this._email;
        state.displayName = this._displayName;
        state.joinedAt = this._joinedAt;
    }
}
