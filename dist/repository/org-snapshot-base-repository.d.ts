import { OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
export declare abstract class OrgSnapshotBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> implements BaseRepository<T> {
    private readonly _eventStreamRepository;
    private readonly _table;
    protected get table(): string;
    get eventStreamRepository(): OrgEventStreamBaseRepository<T, TState, TDomainEvent>;
    protected constructor(eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>);
    getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
    protected query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
}
//# sourceMappingURL=org-snapshot-base-repository.d.ts.map