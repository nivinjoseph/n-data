import { given } from "@nivinjoseph/n-defensive";
import { AggregateFactory, DomainContext, DomainHelper } from "@nivinjoseph/n-domain";
import { inject } from "@nivinjoseph/n-ject";
import { IdPrefix } from "../../common/id-prefix.js";
import { StudioCreated } from "../events/studio-created.js";
import { StudioSlugUnavailableException } from "../exceptions/studio-slug-unavailable-exception.js";
import { StudioRepository } from "../repositories/studio-repository.js";
import { Studio } from "../studio.js";
import { StudioStateFactory } from "../studio-state.js";
import { StudioPlan } from "../value-objects/studio-plan.js";
import { StudioFactory } from "./studio-factory.js";

/**
 * Where a studio comes into existence.
 *
 * A factory rather than a static on the aggregate, because creation needs collaborators the aggregate
 * must not hold: the domain context that stamps who did it, and the repository that answers whether the
 * slug is free. An aggregate holding a repository would put it in state and snapshot it.
 *
 * The order of operations matters. Normalize first, so the value the uniqueness probe checks is the value
 * that will be stored - a unique index compares the extracted text exactly as written. Probe, and raise a
 * domain exception on collision, so the caller gets a precise error under normal conditions. Then mint,
 * build and save; the unique index remains the backstop that holds under a race the probe cannot see.
 *
 * @class DefaultStudioFactory
 */
@inject("DomainContext", "StudioRepository")
export class DefaultStudioFactory implements StudioFactory
{
    private readonly _domainContext: DomainContext;
    private readonly _studioRepository: StudioRepository;

    public constructor(domainContext: DomainContext, studioRepository: StudioRepository)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject();
        this._domainContext = domainContext;

        given(studioRepository, "studioRepository").ensureHasValue().ensureIsObject();
        this._studioRepository = studioRepository;
    }

    public async create(name: string, tier: string, seatLimit: number): Promise<string>
    {
        given(name, "name").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().length <= 128, "must not be longer than 128");

        // the same normal form `Studio.rename` applies, and for the same reason
        const normalizedName = name.trim();
        const slug = Studio.toSlug(normalizedName);

        given(slug, "slug").ensure(t => t.isNotEmptyOrWhiteSpace(), "name must yield a non-empty slug");

        const plan = new StudioPlan({ tier, seatLimit });

        const slugExists = await this._studioRepository.checkIfSlugExists(slug);
        if (slugExists)
            throw new StudioSlugUnavailableException(slug);

        const createdEvent = new StudioCreated({
            studioId: DomainHelper.generateId(IdPrefix.studio),
            studioName: normalizedName,
            slug,
            plan
        });

        // the state factory is constructed here rather than held: the framework wants it positionally at
        // construction, and it carries no state of its own
        const studio = new AggregateFactory(Studio, this._domainContext, new StudioStateFactory())
            .createFromEvents([createdEvent]);

        await this._studioRepository.save(studio);

        return studio.id;
    }
}
