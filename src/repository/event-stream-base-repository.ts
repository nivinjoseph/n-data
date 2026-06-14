import { AggregateRoot, AggregateState, AggregateStateFactory, DomainContext, DomainEvent, DomainEventData } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";

export abstract class EventStreamBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> extends BaseRepository implements Repository<T>
{
    private readonly _aggregateType: ClassDefinition<T>;
    private readonly _aggregateStateFactory: AggregateStateFactory<TState>;

    public get aggregateType(): ClassDefinition<T> { return this._aggregateType; }
    public get aggregateStateFactory(): AggregateStateFactory<TState> { return this._aggregateStateFactory; }


    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork,
        logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: AggregateStateFactory<TState>)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({
                userId: "string"
            });

        super(domainContext, db, unitOfWork, logger, DataHelper.createEventStreamTableName(aggregateType));

        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        this._aggregateType = aggregateType;

        given(aggregateStateFactory, "aggregateStateFactory").ensureHasValue().ensureIsObject();
        this._aggregateStateFactory = aggregateStateFactory;
    }


    public async getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());

        if (ids.isNotEmpty)
            return this.query(
                `select data from ${this.table} where aggregate_id in (${ids.map(() => "?").join(",")});`,
                ...ids);

        return this.query(`select data from ${this.table};`);
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const result = await this.query(`select data from ${this.table} where aggregate_id = ?;`, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._aggregateType, id);

        return result[0];
    }

    public async save(value: T, unitOfWork?: UnitOfWork): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType);
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
                values.push("(?, ?, ?, ?)");

                params.push(event.id, event.aggregateId, event.version, event.serialize());
            }

            const sql = `insert into ${this.table}
                            (id, aggregate_id, aggregate_version, data)
                            values ${values.join(",")};`;

            await this.db.executeCommandWithinUnitOfWork(unitOfWork ?? this.unitOfWork, sql, ...params);

            (unitOfWork ?? this.unitOfWork).onCommit(() => this.onSave(value, events));

            if (!unitOfWork)
                await this.unitOfWork.commit();
        }
        catch (error: any)
        {
            await this.logger.logError(error);

            if (!unitOfWork)
                await this.unitOfWork.rollback();

            throw error;
        }
    }

    protected async query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        const queryResult = await this.queryRaw<any>(sql, ...params);
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as DomainEventData)
            .groupBy(t => t.$aggregateId as string)
            .map(t => AggregateRoot.deserializeFromEvents(this.domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }
    
    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}