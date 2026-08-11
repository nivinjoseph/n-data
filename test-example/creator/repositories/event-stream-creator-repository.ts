import { given } from "@nivinjoseph/n-defensive";
import { OrgDomainContext } from "@nivinjoseph/n-domain";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { Db, OrgEventStreamBaseRepository, UnitOfWork } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { Creator } from "../creator.js";
import { CreatorState, CreatorStateFactory } from "../creator-state.js";
import { CreatorEvent } from "../events/creator-event.js";
import { CreatorRepository } from "./creator-repository.js";

/**
 * The append-only stream of creator events, scoped to the current studio.
 *
 * The organization filter is applied by the base on `get` and `getAll` and by `query` itself, so the naive
 * implementations below are tenant-safe without saying so. What they are not is efficient - an event stream
 * table indexes only `(organization_id, aggregate_id, aggregate_version)`, so answering a question about
 * event *content* means replaying every aggregate in the studio.
 *
 * Note the state factory: it needs the domain context, so it can only be built after `super` would have
 * needed it. It is constructed inline in the `super` call, which is the only place both are in scope.
 *
 * @class EventStreamCreatorRepository
 */
@inject("DomainContext", "Db", "UnitOfWork", "Logger")
export class EventStreamCreatorRepository
    extends OrgEventStreamBaseRepository<Creator, CreatorState, CreatorEvent>
    implements CreatorRepository
{
    private readonly _savedEvents = new Array<CreatorEvent>();

    /**
     * The events this repository has seen committed - the stand-in for an event bus, and the proof that a
     * rolled-back save publishes nothing.
     */
    public get savedEvents(): ReadonlyArray<CreatorEvent> { return [...this._savedEvents]; }

    public constructor(domainContext: OrgDomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
    {
        super(domainContext, db, unitOfWork, logger, Creator, new CreatorStateFactory(domainContext));
    }

    public async checkIfEmailExists(email: string, excludeId?: string): Promise<boolean>
    {
        given(email, "email").ensureHasValue().ensureIsString();
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.creator));

        const creators = await this.getAll();

        return creators.some(t => t.email === email && t.id !== excludeId);
    }

    public async getByEmail(email: string): Promise<Creator | null>
    {
        given(email, "email").ensureHasValue().ensureIsString();

        const creators = await this.getAll();

        return creators.find(t => t.email === email) ?? null;
    }

    public async getByRole(role: string): Promise<Array<Creator>>
    {
        given(role, "role").ensureHasValue().ensureIsString();

        const creators = await this.getAll();

        return creators.where(t => t.role === role);
    }

    public async getBySkill(skill: string): Promise<Array<Creator>>
    {
        given(skill, "skill").ensureHasValue().ensureIsString();

        const creators = await this.getAll();

        return creators.where(t => t.skills.contains(skill));
    }

    public async getActiveInRoles(roles: ReadonlyArray<string>): Promise<Array<Creator>>
    {
        given(roles, "roles").ensureHasValue().ensureIsArray().ensureIsNotEmpty();

        const creators = await this.getAll();

        return creators.where(t => !t.isDeactivated && roles.contains(t.role));
    }

    public async getRecentlyJoined(since: number, count: number): Promise<Array<Creator>>
    {
        given(since, "since").ensureHasValue().ensureIsNumber();
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        const creators = await this.getAll();

        return creators.where(t => t.joinedAt >= since).orderByDesc(t => t.joinedAt).take(count);
    }

    public async countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>
    {
        const creators = await this.getAll();

        return creators.groupBy(t => t.role)
            .map(t => ({ role: t.key, count: t.values.length }))
            .orderByDesc(t => t.count);
    }

    protected override onSave(_value: Creator, events: ReadonlyArray<CreatorEvent>): Promise<void>
    {
        this._savedEvents.push(...events);

        return Promise.resolve();
    }
}
