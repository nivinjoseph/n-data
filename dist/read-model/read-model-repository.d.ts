import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
/**
 * What a read model repository promises its callers: reads by id, and explicit writes.
 *
 * Deliberately not `Repository<T>`: that interface promises a save that is a no-op for an unchanged
 * aggregate, which a read model cannot keep (it carries no change tracking - every save is an
 * upsert), and it has no delete, which a projection needs when its source goes away.
 */
export interface ReadModelRepository<T> {
    /**
     * The read model with this id.
     *
     * @throws {ReadModelNotFoundException} If no row carries the id.
     */
    get(id: string): Promise<T>;
    /**
     * The read models with these ids, in whatever order the table returns them. Ids that are blank
     * once trimmed are dropped, and if that leaves none the result is empty.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every row in the table. Unbounded, and takes no arguments so that it can only be called on
     * purpose.
     */
    getAll(): Promise<Array<T>>;
    /**
     * Writes the read model - inserting it, or replacing the row that carries its id - in a
     * transaction this repository owns, and commits it. If anything else was queued on that same
     * unit of work, **this commits that too**.
     */
    save(model: T): Promise<void>;
    /**
     * Writes the read model into a transaction the caller owns, and **does not commit**. How a
     * projection lands atomically with the aggregate save it was derived from.
     */
    saveWithin(model: T, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Removes the row with this id, in a transaction this repository owns, and commits it. A no-op
     * when no row carries the id.
     */
    delete(id: string): Promise<void>;
    /**
     * Removes the row with this id into a transaction the caller owns, and **does not commit**.
     */
    deleteWithin(id: string, unitOfWork: UnitOfWork): Promise<void>;
}
//# sourceMappingURL=read-model-repository.d.ts.map