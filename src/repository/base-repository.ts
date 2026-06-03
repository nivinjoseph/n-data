import { UnitOfWork } from "../unit-of-work/unit-of-work.js";

export interface BaseRepository<T>
{
    getAll(...ids: Array<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
}