import { ReadModelRepository } from "../../../src/index.js";
import { CreatorActivity } from "./creator-activity.js";

/**
 * What the application asks of the creator activity projection.
 *
 * Every method here reads across studios unless it names one - the opposite of `CreatorRepository`,
 * whose every method is implicitly scoped to the current studio. That is not an accident of the
 * implementation: a read model is where a platform-wide question is cheap to ask, and a method that
 * wants one studio says so with an argument.
 */
export interface CreatorActivityRepository extends ReadModelRepository<CreatorActivity>
{
    getByStudio(studioId: string): Promise<Array<CreatorActivity>>;

    getRoleInStudio(studioId: string, role: string): Promise<Array<CreatorActivity>>;

    /**
     * Whoever has this skill, in any studio.
     */
    getBySkillAcrossStudios(skill: string): Promise<Array<CreatorActivity>>;

    /**
     * Everyone who joined at or after `since` (epoch milliseconds), newest first, in any studio.
     */
    getJoinedSince(since: number): Promise<Array<CreatorActivity>>;

    /**
     * How many creators hold each role, platform-wide.
     */
    countByRole(): Promise<ReadonlyArray<{ role: string; count: number; }>>;
}
