import { Repository } from "../../../src/index.js";
import { Creator } from "../creator.js";

/**
 * What the domain asks of storage for creators.
 *
 * Every method here is implicitly scoped to the current studio - the organization comes from the domain
 * context, not from an argument, so a caller cannot ask for another tenant's creators by passing a
 * different id. That is the whole point of the org-scoped base: the scope is ambient and not negotiable.
 */
export interface CreatorRepository extends Repository<Creator>
{
    /**
     * @param email - The email to check, already normalized.
     * @param excludeId - The creator permitted to hold it, when checking on behalf of a change.
     */
    checkIfEmailExists(email: string, excludeId?: string): Promise<boolean>;

    getByEmail(email: string): Promise<Creator | null>;

    getByRole(role: string): Promise<Array<Creator>>;

    getBySkill(skill: string): Promise<Array<Creator>>;

    getActiveInRoles(roles: ReadonlyArray<string>): Promise<Array<Creator>>;

    getRecentlyJoined(since: number, count: number): Promise<Array<Creator>>;

    /**
     * How many creators in this studio are still active - what the studio's seat limit is checked against.
     */
    countActive(): Promise<number>;

    countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>;
}
