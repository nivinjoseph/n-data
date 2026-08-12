import { DomainEvent, DomainEventData } from "@nivinjoseph/n-domain";
import { StudioState } from "../studio-state.js";

/**
 * The base every studio event extends.
 *
 * `refType` is a **string literal on purpose**. Returning `Studio.getTypeName()` would mean importing
 * the aggregate here, and the aggregate imports its events - a circular dependency that resolves to
 * `undefined` at runtime rather than failing at compile time.
 *
 * @class StudioEvent
 */
export abstract class StudioEvent extends DomainEvent<StudioState>
{
    public override get refType(): string { return "Studio"; }
}

export type StudioEventData = DomainEventData;
