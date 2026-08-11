import { Repository } from "../../../src/index.js";
import { Studio } from "../studio.js";

/**
 * What the domain asks of storage for studios.
 *
 * The domain depends on this, never on `SnapshotBaseRepository` - so the aggregate, its factory and its
 * behavior methods know nothing about tables, indexes or SQL. Both implementations satisfy it, which is
 * what makes swapping the canonical read path a one-line change in the installer.
 *
 * The extra methods are the *domain's* questions, phrased in the domain's terms. `checkIfSlugExists`
 * exists because slug uniqueness is a rule the domain enforces; how it is answered - a full scan or an
 * indexed probe - is the implementation's business.
 */
export interface StudioRepository extends Repository<Studio>
{
    /**
     * @param slug - The slug to check, already normalized.
     * @param excludeId - The studio permitted to hold it, when checking on behalf of a rename.
     */
    checkIfSlugExists(slug: string, excludeId?: string): Promise<boolean>;

    getBySlug(slug: string): Promise<Studio | null>;

    getByPlanTier(tier: string): Promise<Array<Studio>>;

    getByTag(tag: string): Promise<Array<Studio>>;

    getLargest(count: number): Promise<Array<Studio>>;
}
