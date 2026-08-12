import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot } from "@nivinjoseph/n-domain";
import { serialize } from "@nivinjoseph/n-util";
import { StudioArchived } from "./events/studio-archived.js";
import { StudioCreatorCountChanged } from "./events/studio-creator-count-changed.js";
import { StudioEvent } from "./events/studio-event.js";
import { StudioPlanChanged } from "./events/studio-plan-changed.js";
import { StudioRenamed } from "./events/studio-renamed.js";
import { StudioTagged } from "./events/studio-tagged.js";
import { StudioSlugUnavailableException } from "./exceptions/studio-slug-unavailable-exception.js";
import { StudioRepository } from "./repositories/studio-repository.js";
import { StudioState } from "./studio-state.js";
import { StudioPlan } from "./value-objects/studio-plan.js";

/**
 * A studio - and, in this model, a tenant. A studio's id is the `organizationId` every `Creator` is
 * scoped by, which is why this is a plain `AggregateRoot` rather than an org-scoped one: the boundary
 * cannot itself sit inside a boundary.
 *
 * Note what is **not** here. There is no constructor: `AggregateFactory` constructs this as
 * `new Studio(domainContext, events, stateFactory)` and `deserializeFromSnapshot` as
 * `new Studio(domainContext, [], stateFactory, snapshot)`, so declaring a narrower one would silently
 * bind `stateFactory` to `state`. And the getters below carry no `@serialize` - the *state* is what
 * snapshots, and `AggregateRoot`'s own decorated getters supply the `$id`/`$version`/`$events` keys. The
 * class-level `@serialize` is still required, because that is what registers the type.
 *
 * @class Studio
 */
@serialize
export class Studio extends AggregateRoot<StudioState, StudioEvent>
{
    public get name(): string { return this.state.name; }
    public get slug(): string { return this.state.slug; }
    public get plan(): StudioPlan { return this.state.plan; }
    public get creatorCount(): number { return this.state.creatorCount; }
    public get isArchived(): boolean { return this.state.isArchived; }
    public get tags(): ReadonlyArray<string> { return [...this.state.tags]; }

    /**
     * Turns a display name into the slug form the natural key is stored in.
     *
     * Exposed and used by the factory too, so the value the uniqueness probe checks is the value that
     * will be stored. A unique index compares the extracted text exactly as written - nothing folded or
     * trimmed - so normalizing before the value reaches state is what makes the rule mean what it says.
     */
    public static toSlug(name: string): string
    {
        given(name, "name").ensureHasValue().ensureIsString();

        return name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
            .replaceAll(/^-+|-+$/g, "");
    }

    /**
     * Renames the studio, re-deriving the slug.
     *
     * The repository arrives as an **argument** rather than as a field, because the invariant is
     * asynchronous: uniqueness cannot be decided from this aggregate's own state. Keeping it out of state
     * is what stops a repository reference being snapshotted.
     */
    public async rename(name: string, studioRepository: StudioRepository): Promise<void>
    {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().length <= 128, "must not be longer than 128");
        given(studioRepository, "studioRepository").ensureHasValue().ensureIsObject();
        given(this, "this").ensure(t => !t.isArchived, "must not be archived");

        const normalizedName = name.trim();
        const slug = Studio.toSlug(normalizedName);

        given(slug, "slug").ensure(t => t.isNotEmptyOrWhiteSpace(), "must yield a non-empty slug");

        // compared after normalizing, or a rename differing only in whitespace would apply an event that
        // changes nothing
        if (normalizedName === this.state.name && slug === this.state.slug)
            return;

        if (slug !== this.state.slug)
        {
            const slugExists = await studioRepository.checkIfSlugExists(slug, this.id);
            if (slugExists)
                throw new StudioSlugUnavailableException(slug);
        }

        this.applyEvent(new StudioRenamed({ studioName: normalizedName, slug }));
    }

    public changePlan(plan: StudioPlan): void
    {
        given(plan, "plan").ensureHasValue().ensureIsType(StudioPlan);
        given(this, "this").ensure(t => !t.isArchived, "must not be archived");

        if (plan.equals(this.state.plan))
            return;

        this.applyEvent(new StudioPlanChanged({ plan }));
    }

    public addTag(tag: string): void
    {
        given(tag, "tag").ensureHasValue().ensureIsString();
        given(this, "this").ensure(t => !t.isArchived, "must not be archived");

        const normalizedTag = tag.trim().toLowerCase();

        given(normalizedTag, "tag").ensure(t => t.isNotEmptyOrWhiteSpace(), "must not be whitespace");

        if (this.state.tags.contains(normalizedTag))
            return;

        this.applyEvent(new StudioTagged({ tag: normalizedTag }));
    }

    /**
     * Records how many creators the studio has.
     *
     * The count is maintained by whoever adds creators rather than by the studio itself - a `Creator` is
     * a separate aggregate, so counting them inside this one's transaction would put two aggregates in
     * one consistency boundary. It is a cached projection, and the plan's seat limit is checked against
     * it on a best-effort basis.
     */
    public setCreatorCount(creatorCount: number): void
    {
        given(creatorCount, "creatorCount").ensureHasValue().ensureIsNumber()
            .ensure(t => Number.isInteger(t) && t >= 0, "must be a non-negative integer");
        given(this, "this").ensure(t => !t.isArchived, "must not be archived");

        if (creatorCount === this.state.creatorCount)
            return;

        this.applyEvent(new StudioCreatorCountChanged({ creatorCount }));
    }

    public archive(): void
    {
        given(this, "this").ensure(t => !t.isArchived, "must not be archived");

        this.applyEvent(new StudioArchived({}));
    }

    /**
     * Whether the plan still has room for another creator.
     *
     * A read over the cached count, deliberately not an invariant: the authority on the count is the
     * creator table, and enforcing it here would be enforcing it against possibly stale state.
     */
    public hasSeatAvailable(): boolean
    {
        return this.state.plan.isUnlimited || this.state.creatorCount < this.state.plan.seatLimit;
    }
}
