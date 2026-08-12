import { given } from "@nivinjoseph/n-defensive";
import { AggregateFactory, DomainHelper, OrgDomainContext } from "@nivinjoseph/n-domain";
import { inject } from "@nivinjoseph/n-ject";
import { IdPrefix } from "../../common/id-prefix.js";
import { Creator } from "../creator.js";
import { CreatorStateFactory } from "../creator-state.js";
import { CreatorInvited } from "../events/creator-invited.js";
import { CreatorEmailUnavailableException } from "../exceptions/creator-email-unavailable-exception.js";
import { CreatorRepository } from "../repositories/creator-repository.js";
import { CreatorFactory } from "./creator-factory.js";

/**
 * Where a creator joins a studio.
 *
 * The organization-scoped counterpart of `DefaultStudioFactory`, and structurally the same: normalize, probe
 * uniqueness through the repository, raise a domain exception, mint, build, save, return the id.
 *
 * Two things differ, both because of the organization. The context is typed `OrgDomainContext`, since
 * `CreatorStateFactory` needs the organization to stamp into default state - and it is that state factory,
 * not this class, that decides which studio the creator lands in. And the uniqueness probe is implicitly
 * per-studio: `checkIfEmailExists` scopes itself, so the same address can be invited into a second studio
 * without collision, which is the behavior a tenant-scoped natural key should have.
 *
 * `joinedAt` is read from the clock **here** and carried on the event, rather than being read inside
 * `applyEvent`. An event must produce the same state every time it is replayed, and a clock read would not.
 *
 * @class DefaultCreatorFactory
 */
@inject("DomainContext", "CreatorRepository")
export class DefaultCreatorFactory implements CreatorFactory
{
    private readonly _domainContext: OrgDomainContext;
    private readonly _creatorRepository: CreatorRepository;

    public constructor(domainContext: OrgDomainContext, creatorRepository: CreatorRepository)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({ userId: "string", organizationId: "string" });
        this._domainContext = domainContext;

        given(creatorRepository, "creatorRepository").ensureHasValue().ensureIsObject();
        this._creatorRepository = creatorRepository;
    }

    public async invite(email: string, displayName: string, role: string): Promise<string>
    {
        given(email, "email").ensureHasValue().ensureIsString();
        given(displayName, "displayName").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().length <= 128, "must not be longer than 128");
        given(role, "role").ensureHasValue().ensureIsString()
            .ensure(t => Creator.roles.contains(t), `must be one of ${Creator.roles.join(", ")}`);

        // the same normal form the aggregate applies, so the value probed is the value stored
        const normalizedEmail = Creator.toEmail(email);
        const normalizedDisplayName = displayName.trim();

        const emailExists = await this._creatorRepository.checkIfEmailExists(normalizedEmail);
        if (emailExists)
            throw new CreatorEmailUnavailableException(normalizedEmail);

        const invitedEvent = new CreatorInvited({
            creatorId: DomainHelper.generateId(IdPrefix.creator),
            email: normalizedEmail,
            displayName: normalizedDisplayName,
            joinedAt: DomainHelper.now
        });

        // the state factory carries the organization, so it can only be built with the context in hand
        const creator = new AggregateFactory(
            Creator, this._domainContext, new CreatorStateFactory(this._domainContext))
            .createFromEvents([invitedEvent]);

        if (role !== creator.role)
            creator.changeRole(role);

        await this._creatorRepository.save(creator);

        return creator.id;
    }
}
