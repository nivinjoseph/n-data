import { UnitOfWork } from "../unit-of-work/unit-of-work.js";

export interface Repository<T>
{
    get(id: string): Promise<T>;

    /**
     * The aggregates with these ids.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates.
     *
     * **Takes an array rather than a rest parameter, and that is the whole of why this method
     * exists.** As `getAll(...ids)` it shared a signature with {@link getAll}: "called with no
     * arguments" and "spread an empty list" are the same call, so the empty case had to mean either
     * *everything* or *nothing*, and either choice was a trap for the callers expecting the other.
     * An explicit array cannot be confused with no argument at all, so the two meanings can each have
     * their own method and neither has to guess.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;

    /**
     * Every aggregate this repository can see - on an organization-scoped one, every aggregate in the
     * current organization.
     *
     * **Unbounded, and takes no arguments so that it can only be called on purpose.** There is no
     * predicate, no limit and no paging; on an event stream repository it also replays every
     * aggregate from its events, which is the most expensive read in this library. Reach for it when
     * the whole set is genuinely what you want, and use a repository's own query methods when it is
     * not.
     */
    getAll(): Promise<Array<T>>;

    /**
     * Saves the aggregate in a transaction this repository owns, and commits it - or rolls it back
     * and rethrows if anything fails.
     *
     * The transaction is the repository's own `unitOfWork`. If anything else was queued on that same
     * instance - another repository sharing it, an earlier write of your own - **this commits that
     * too**, because a unit of work commits as a whole. When more than one write has to land
     * together, or land nowhere, that is what {@link saveWithin} is for.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     */
    save(value: T): Promise<void>;

    /**
     * Saves the aggregate into a transaction the caller owns, and **does not commit**.
     *
     * The write lands when the caller commits their unit of work, and is discarded if they roll it
     * back - which is how several repositories' writes are made atomic with one another.
     *
     * Kept apart from {@link save} rather than folded into an optional parameter, because the two
     * differ in who commits and that is not a detail to infer from whether an argument is present.
     * Passing a repository's *own* `unitOfWork` used to reach this behavior while reading as though
     * it changed nothing.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     */
    saveWithin(value: T, unitOfWork: UnitOfWork): Promise<void>;
}
