import { AggregateRoot, OrgAggregateRoot, OrgAggregateState, OrgAggregateStateFactory, OrgDomainContext, OrgDomainEvent, OrgDomainEventData } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";

export abstract class OrgEventStreamBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> implements BaseRepository<T>
{
    private readonly _domainContext: OrgDomainContext;
    private readonly _db: Db;
    private readonly _unitOfWork: UnitOfWork;
    private readonly _logger: Logger;
    private readonly _aggregateType: ClassDefinition<T>;
    private readonly _aggregateStateFactory: OrgAggregateStateFactory<TState>;
    private readonly _table: string;

    protected get table(): string { return this._table; }
    
    
    public get domainContext(): OrgDomainContext { return this._domainContext; }
    public get db(): Db { return this._db; }
    public get unitOfWork(): UnitOfWork { return this._unitOfWork; }
    public get logger(): Logger { return this._logger; }
    public get aggregateType(): ClassDefinition<T> { return this._aggregateType; }
    public get aggregateStateFactory(): OrgAggregateStateFactory<TState> { return this._aggregateStateFactory; }
    
    
    protected constructor(domainContext: OrgDomainContext, db: Db, unitOfWork: UnitOfWork,
        logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: OrgAggregateStateFactory<TState>)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({
                userId: "string",
                organizationId: "string"
            });
        this._domainContext = domainContext;

        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;

        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        this._unitOfWork = unitOfWork;

        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;

        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        this._aggregateType = aggregateType;
        
        given(aggregateStateFactory, "aggregateStateFactory").ensureHasValue().ensureIsObject();
        this._aggregateStateFactory = aggregateStateFactory;

        this._table = DataHelper.createEventStreamTableName(this._aggregateType);
    }


    public async getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());

        if (ids.isNotEmpty)
            return this.query(
                `select data from ${this._table} where organization_id = ? and aggregate_id in (${ids.map(() => "?").join(",")});`,
                this._domainContext.organizationId, ...ids);

        return this.query(`select data from ${this._table} where organization_id = ?;`,
            this._domainContext.organizationId);
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const result = await this.query(`select data from ${this._table} where organization_id = ? and aggregate_id = ?;`,
            this._domainContext.organizationId, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._aggregateType, id);

        return result[0];
    }

    public async save(value: T, unitOfWork?: UnitOfWork): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType)
            .ensure(t => t.organizationId === this._domainContext.organizationId);
        given(unitOfWork, "unitOfWork").ensureIsObject();

        if (!value.isNew && !value.hasChanges)
            return;

        try
        {
            const events = (value.isNew ? value.events : value.currentEvents) as ReadonlyArray<TDomainEvent>;
            const values = new Array<string>();
            const params = new Array<any>();
            for (const event of events)
            {
                values.push("(?, ?, ?, ?, ?)");

                params.push(event.id, event.aggregateId, event.version, this._domainContext.organizationId,
                    event.serialize());
            }

            const sql = `insert into ${this._table} 
                            (id, aggregate_id, aggregate_version, organization_id, data) 
                            values ${values.join(",")};`;

            await this._db.executeCommandWithinUnitOfWork(unitOfWork ?? this._unitOfWork, sql, ...params);
            
            (unitOfWork ?? this._unitOfWork).onCommit(() => this.onSave(value, events));

            if (!unitOfWork)
                await this._unitOfWork.commit();
        }
        catch (error: any)
        {
            await this._logger.logError(error);

            if (!unitOfWork)
                await this._unitOfWork.rollback();

            throw error;
        }
    }

    protected async query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        given(sql, "sql").ensureHasValue().ensureIsString();
        sql = sql.trim();

        given(params, "params").ensureHasValue().ensureIsArray();

        const queryResult = await this._db.executeQuery<any>(sql, ...params);
        if (queryResult.rows.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as OrgDomainEventData)
            .groupBy(t => t.$aggregateId as string)
            .map(t => AggregateRoot.deserializeFromEvents(this._domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }
    
    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}