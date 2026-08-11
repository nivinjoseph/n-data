import { given } from "@nivinjoseph/n-defensive";
import { DomainContext } from "@nivinjoseph/n-domain";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, EventStreamBaseRepository, UnitOfWork } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { StudioEvent } from "../events/studio-event.js";
import { Studio } from "../studio.js";
import { StudioState, StudioStateFactory } from "../studio-state.js";
import { StudioRepository } from "./studio-repository.js";

/**
 * The append-only stream of studio events, and the aggregate rebuilt by replaying it.
 *
 * It satisfies the same `StudioRepository` the snapshot variant does, and the contrast is the point.
 *
 * The base offers `get`, `getAll` and `save` and no query surface at all - that is its contract, not a gap.
 * So every domain question below is answered by loading the aggregates and filtering in memory. That is
 * correct, and it is the shape a slice starts in before it needs a snapshot table: this class alone is a
 * working repository. It stops being the right one when the table grows, or when a rule needs the database
 * to enforce it - `slug` uniqueness here - and that is exactly when the snapshot variant is introduced and
 * the interface alias moves to it.
 *
 * Kept registered under its class name only, because the snapshot repository injects this one
 * specifically - it wraps it.
 *
 * @class EventStreamStudioRepository
 */
@inject("DomainContext", "Db", "UnitOfWork", "Logger")
export class EventStreamStudioRepository
    extends EventStreamBaseRepository<Studio, StudioState, StudioEvent>
    implements StudioRepository
{
    private readonly _savedEvents = new Array<StudioEvent>();

    /**
     * The events this repository has seen committed.
     *
     * Stands in for the event bus a real application publishes to from `onSave`. Because the base
     * registers that callback with the unit of work rather than calling it inline, this list is the
     * observable proof that a rolled-back save publishes nothing.
     */
    public get savedEvents(): ReadonlyArray<StudioEvent> { return [...this._savedEvents]; }

    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
    {
        super(domainContext, db, unitOfWork, logger, Studio, new StudioStateFactory());
    }

    public async checkIfSlugExists(slug: string, excludeId?: string): Promise<boolean>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();
        // `ensure` short-circuits on null, so the prefix assertion is safe on an optional id
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));

        const studios = await this.getAll();

        return studios.some(t => t.slug === slug && t.id !== excludeId);
    }

    public async getBySlug(slug: string): Promise<Studio | null>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();

        const studios = await this.getAll();

        return studios.find(t => t.slug === slug) ?? null;
    }

    public async getByPlanTier(tier: string): Promise<Array<Studio>>
    {
        given(tier, "tier").ensureHasValue().ensureIsString();

        const studios = await this.getAll();

        return studios.where(t => t.plan.tier === tier);
    }

    public async getByTag(tag: string): Promise<Array<Studio>>
    {
        given(tag, "tag").ensureHasValue().ensureIsString();

        const studios = await this.getAll();

        return studios.where(t => t.tags.contains(tag));
    }

    public async getLargest(count: number): Promise<Array<Studio>>
    {
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        const studios = await this.getAll();

        return studios.orderByDesc(t => t.creatorCount).take(count);
    }

    protected override onSave(_value: Studio, events: ReadonlyArray<StudioEvent>): Promise<void>
    {
        this._savedEvents.push(...events);

        return Promise.resolve();
    }
}
