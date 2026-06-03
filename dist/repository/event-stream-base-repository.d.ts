import { AggregateRoot, AggregateState, AggregateStateFactory, DomainContext, DomainEvent } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
export declare abstract class EventStreamBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> implements BaseRepository<T> {
    private readonly _domainContext;
    private readonly _db;
    private readonly _unitOfWork;
    private readonly _logger;
    private readonly _aggregateType;
    private readonly _aggregateStateFactory;
    private readonly _table;
    protected get table(): string;
    get domainContext(): DomainContext;
    get db(): Db;
    get unitOfWork(): UnitOfWork;
    get logger(): Logger;
    get aggregateType(): ClassDefinition<T>;
    get aggregateStateFactory(): AggregateStateFactory<TState>;
    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: AggregateStateFactory<TState>);
    getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
    protected query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
}
//# sourceMappingURL=event-stream-base-repository.d.ts.map