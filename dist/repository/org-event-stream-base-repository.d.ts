import { OrgAggregateRoot, OrgAggregateState, OrgAggregateStateFactory, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
export declare abstract class OrgEventStreamBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> implements BaseRepository<T> {
    private readonly _domainContext;
    private readonly _db;
    private readonly _unitOfWork;
    private readonly _logger;
    private readonly _aggregateType;
    private readonly _aggregateStateFactory;
    private readonly _table;
    protected get table(): string;
    get domainContext(): OrgDomainContext;
    get db(): Db;
    get unitOfWork(): UnitOfWork;
    get logger(): Logger;
    get aggregateType(): ClassDefinition<T>;
    get aggregateStateFactory(): OrgAggregateStateFactory<TState>;
    protected constructor(domainContext: OrgDomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: OrgAggregateStateFactory<TState>);
    getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
    protected query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
}
//# sourceMappingURL=org-event-stream-base-repository.d.ts.map