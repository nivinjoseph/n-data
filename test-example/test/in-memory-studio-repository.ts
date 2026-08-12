import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { UnitOfWork } from "../../src/index.js";
import { IdPrefix } from "../common/id-prefix.js";
import { StudioRepository } from "../studio/repositories/studio-repository.js";
import { Studio } from "../studio/studio.js";

/**
 * A map-backed `StudioRepository` for the tests that do not want a database.
 *
 * It lives under `test/` on purpose. The factory tests need *a* repository, because a factory saves, and the
 * aggregate tests need one because `rename` takes it as an argument - but neither is testing storage. Using
 * the real one would make every domain test require Postgres and a migration.
 *
 * Its `get` asserts the id prefix, which is what catches an aggregate minting ids with the wrong one.
 *
 * @class InMemoryStudioRepository
 */
export class InMemoryStudioRepository implements StudioRepository
{
    private readonly _studios = new Map<string, Studio>();

    public get(id: string): Promise<Studio>
    {
        given(id, "id").ensureHasValue().ensureIsString()
            .ensure(t => t.startsWith(IdPrefix.studio));

        const studio = this._studios.get(id);

        if (studio == null)
            // rejected rather than thrown, so this behaves like the real repository, whose `get` is async
            return Promise.reject(new ApplicationException(`Studio with id '${id}' not found.`));

        return Promise.resolve(studio);
    }

    // the two reads are kept as distinct here as they are on the real repository. A double that
    // folded them back together - or that disagreed about what an empty id list means - is how a
    // test passes on behavior production does not have
    public getByIds(ids: ReadonlyArray<string>): Promise<Array<Studio>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();

        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return Promise.resolve([]);

        return Promise.resolve([...this._studios.values()].where(t => trimmed.contains(t.id)));
    }

    public getAll(): Promise<Array<Studio>>
    {
        return Promise.resolve([...this._studios.values()]);
    }

    public checkIfSlugExists(slug: string, excludeId?: string): Promise<boolean>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();
        given(excludeId, "excludeId").ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));

        const exists = [...this._studios.values()].some(t => t.slug === slug && t.id !== excludeId);

        return Promise.resolve(exists);
    }

    public getBySlug(slug: string): Promise<Studio | null>
    {
        given(slug, "slug").ensureHasValue().ensureIsString();

        return Promise.resolve([...this._studios.values()].find(t => t.slug === slug) ?? null);
    }

    public getByPlanTier(tier: string): Promise<Array<Studio>>
    {
        given(tier, "tier").ensureHasValue().ensureIsString();

        return Promise.resolve([...this._studios.values()].where(t => t.plan.tier === tier));
    }

    public getByTag(tag: string): Promise<Array<Studio>>
    {
        given(tag, "tag").ensureHasValue().ensureIsString();

        return Promise.resolve([...this._studios.values()].where(t => t.tags.contains(tag)));
    }

    public getLargest(count: number): Promise<Array<Studio>>
    {
        given(count, "count").ensureHasValue().ensureIsNumber().ensure(t => t > 0);

        return Promise.resolve([...this._studios.values()].orderByDesc(t => t.creatorCount).take(count));
    }

    public save(value: Studio): Promise<void>
    {
        return this._save(value);
    }

    /**
     * There is no transaction to join, so this is `save` - the map takes the write either way.
     *
     * The distinction the two doors draw is about who commits, and a map commits nothing. What the
     * double cannot reproduce is the *atomicity* the real `saveWithin` buys, so a test that depends
     * on several writes landing together needs the real repository.
     */
    public saveWithin(value: Studio, _unitOfWork: UnitOfWork): Promise<void>
    {
        return this._save(value);
    }

    private _save(value: Studio): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsType(Studio);

        this._studios.set(value.id, value);

        return Promise.resolve();
    }
}
