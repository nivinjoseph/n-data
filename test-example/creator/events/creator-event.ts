import { OrgDomainEvent, OrgDomainEventData } from "@nivinjoseph/n-domain";
import { CreatorState } from "../creator-state.js";

/**
 * The base every creator event extends.
 *
 * `OrgDomainEvent` rather than `DomainEvent`, which brings two things: the event carries its own
 * `organizationId`, and its `apply` throws if that disagrees with the state's. So an event from one studio
 * cannot be replayed onto another's aggregate even if the ids somehow lined up.
 *
 * `refType` is a string literal for the same reason as on the studio side - importing the aggregate would
 * be a runtime circular dependency.
 *
 * @class CreatorEvent
 */
export abstract class CreatorEvent extends OrgDomainEvent<CreatorState>
{
    public override get refType(): string { return "Creator"; }
}

export type CreatorEventData = OrgDomainEventData;
