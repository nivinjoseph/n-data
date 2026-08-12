import { given } from "@nivinjoseph/n-defensive";
import { OrgDomainContext } from "@nivinjoseph/n-domain";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { UnitOfWork } from "../../src/index.js";
import { IdPrefix } from "../common/id-prefix.js";
import { Creator } from "../creator/creator.js";
import { CreatorRepository } from "../creator/repositories/creator-repository.js";

/**
 * A map-backed `CreatorRepository`.
 *
 * The organization-scoped double has to do by hand what the real one gets from the base: every read filters
 * on the current organization. Writing that filter in seven places here is a fair illustration of what
 * `OrgSnapshotBaseRepository` is actually buying - and of how easy it is for a double to be *less* isolated
 * than the thing it stands in for, which would make a leak invisible in the unit tests.
 *
 * @class InMemoryCreatorRepository
 */
export class InMemoryCreatorRepository implements CreatorRepository
{
    private readonly _creators = new Map<string, Creator>();
    private readonly _domainContext: OrgDomainContext;

    public constructor(domainContext: OrgDomainContext)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject();
        this._domainContext = domainContext;
    }

    public get(id: string): Promise<Creator>
    {
        given(id, "id").ensureHasValue().ensureIsString()
            .ensure(t => t.startsWith(IdPrefix.creator));

        const creator = this._creators.get(id);

        if (creator == null || creator.organizationId !== this._domainContext.organizationId)
            // rejected rather than thrown, so this behaves like the real repository, whose `get` is async
            return Promise.reject(new ApplicationException(`Creator with id '${id}' not found.`));

        return Promise.resolve(creator);
    }

    public getAll(...ids: Array<string>): Promise<Array<Creator>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();

        const creators = this._scoped();

        return Promise.resolve(ids.isEmpty ? creators : creators.where(t => ids.contains(t.id)));
    }

    public checkIfEmailExists(email: string, excludeId?: string): Promise<boolean>
    {
        given(email, "email").ensureHasValue().ensureIsString();
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.creator));

        return Promise.resolve(this._scoped().some(t => t.email === email && t.id !== excludeId));
    }

    public getByEmail(email: string): Promise<Creator | null>
    {
        given(email, "email").ensureHasValue().ensureIsString();

        return Promise.resolve(this._scoped().find(t => t.email === email) ?? null);
    }

    public getByRole(role: string): Promise<Array<Creator>>
    {
        given(role, "role").ensureHasValue().ensureIsString();

        return Promise.resolve(this._scoped().where(t => t.role === role));
    }

    public getBySkill(skill: string): Promise<Array<Creator>>
    {
        given(skill, "skill").ensureHasValue().ensureIsString();

        return Promise.resolve(this._scoped().where(t => t.skills.contains(skill)));
    }

    public getActiveInRoles(roles: ReadonlyArray<string>): Promise<Array<Creator>>
    {
        given(roles, "roles").ensureHasValue().ensureIsArray().ensureIsNotEmpty();

        return Promise.resolve(this._scoped().where(t => !t.isDeactivated && roles.contains(t.role)));
    }

    public getRecentlyJoined(since: number, count: number): Promise<Array<Creator>>
    {
        given(since, "since").ensureHasValue().ensureIsNumber();
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        return Promise.resolve(
            this._scoped().where(t => t.joinedAt >= since).orderByDesc(t => t.joinedAt).take(count));
    }

    public countActive(): Promise<number>
    {
        return Promise.resolve(this._scoped().count(t => !t.isDeactivated));
    }

    public countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>
    {
        const counts = this._scoped().groupBy(t => t.role)
            .map(t => ({ role: t.key, count: t.values.length }))
            .orderByDesc(t => t.count);

        return Promise.resolve(counts);
    }

    public save(value: Creator, _unitOfWork?: UnitOfWork): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsType(Creator)
            .ensure(t => t.organizationId === this._domainContext.organizationId,
                "must belong to the current organization");

        this._creators.set(value.id, value);

        return Promise.resolve();
    }

    private _scoped(): Array<Creator>
    {
        return [...this._creators.values()]
            .where(t => t.organizationId === this._domainContext.organizationId);
    }
}
