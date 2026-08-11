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
import { RepositoryQuery, RepositoryQueryBuilder } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";

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
            return this.query(`aggregate_id in (${ids.map(() => "?").join(",")})`, ...ids);
        
        return this.query({});
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const result = await this.query("aggregate_id = ?", id);
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

    /**
     * Runs a query over the event stream and deserializes each aggregate from the events that came
     * back.
     *
     * This owns the statement: `select data from <this.table> where (<your predicate>)`. So what you
     * supply is the predicate, without the `where` keyword. Parameters bind with `?` placeholders and
     * are passed positionally; never interpolate a value into the predicate.
     *
     * Rows are grouped by aggregate id and each group replayed, so a predicate that matches only
     * *some* of an aggregate's events reconstructs it from those events alone - which is rarely what is
     * wanted. Constrain by `aggregate_id`, not by event content, unless replaying a prefix is the
     * point.
     *
     * Pass a {@link RepositoryQuery} instead of a string to add `order by`, `limit` or `offset`, or to
     * run with no predicate at all (`{}`). For a read the built statement cannot express - a join, a
     * union, a CTE - use {@link queryStatement}.
     *
     * @param {string} where - The `where` predicate, without the `where` keyword.
     * @param {...ReadonlyArray<any>} params - Values bound to the predicate's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected query(where: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    /**
     * @param {RepositoryQuery} query - The predicate and the clauses that follow it.
     * @param {...ReadonlyArray<any>} params - Values bound to the predicate's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected query(query: RepositoryQuery, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    protected async query(whereOrQuery: string | RepositoryQuery, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        const built = RepositoryQueryBuilder.build(this.table, whereOrQuery, params);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
    }

    /**
     * Runs a whole statement over the event stream and deserializes each aggregate from the events that
     * came back.
     *
     * The escape hatch from {@link query}, for the joins, unions, CTEs and set operations the statement
     * it builds cannot express. The select list must be `data`, since that is the column each event is
     * deserialized from. Prefer {@link query} unless it cannot express the read.
     *
     * @param {string} sql - The statement to run. Must select the `data` column.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected async queryStatement(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        return this._deserialize(await this.queryRaw<any>(sql, ...params));
    }

    private _deserialize(queryResult: QueryResult<any>): Array<T>
    {
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as DomainEventData)
            .groupBy(t => t.$aggregateId as string)
            .map(t => AggregateRoot.deserializeFromEvents(this.domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }

    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}