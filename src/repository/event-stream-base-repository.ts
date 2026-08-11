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
import { RepositoryQueryBuilder } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";

/**
 * The append-only event stream for an aggregate: every event ever applied to it, and the aggregate rebuilt by
 * replaying them.
 *
 * **It reads by aggregate id, or in full, and deliberately nothing else.** {@link get} loads one,
 * {@link getAll} loads them all or a named set, {@link save} appends. There is no query surface, and that is
 * the design rather than an omission - two reasons, both of which make a content-based read a mistake:
 *
 * - **There is nothing to query by.** The table carries exactly one index, the unique
 *   `(aggregate_id, aggregate_version)`. A predicate over what is inside `data` sequentially scans, always.
 * - **A partial match produces a wrong aggregate, not fewer aggregates.** Rows are grouped by aggregate id
 *   and each group replayed, and `AggregateRoot` requires exactly one created event among them. So a
 *   predicate that misses the creation row throws `no created event passed`, and one that happens to include
 *   it but excludes later events silently reconstructs the aggregate as it was at an *earlier version* -
 *   a query for `$name = 'SomethingCreated'` returns a table of version-1 aggregates and reports no error.
 *
 * Anything beyond loading by id is what the snapshot repositories are for: `SnapshotBaseRepository` reads a
 * materialized table whose indexes are declared with a `SnapshotQuerySet`, and writes through to this one on
 * save. For a projection over the raw event rows - a count, an audit listing - use
 * {@link BaseRepository.queryRaw}, which performs no deserialization and so cannot produce a half-replayed
 * aggregate. Loading a large set in batches is the same pattern: project the ids with `queryRaw`, then hand
 * them to {@link getAll}.
 *
 * @class EventStreamBaseRepository
 */
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

        return this._load(ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace()));
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();

        const result = await this._load([id.trim()]);
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
     * The only read this class performs: load the aggregates with these ids, or all of them when none are
     * given - the same contract {@link getAll} offers, which is the whole of what this class reads.
     *
     * There is deliberately no way to pass a predicate, not even from in here. See the class documentation
     * for why a query over event content is a mistake rather than a missing feature.
     *
     * It goes through the builder rather than writing two fixed statements by hand so that the statement
     * shape lives in one place for all four repositories.
     */
    private async _load(ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        const built = ids.isNotEmpty
            ? RepositoryQueryBuilder.build(this.table,
                `aggregate_id in (${ids.map(() => "?").join(",")})`, ids)
            : RepositoryQueryBuilder.build(this.table, {}, []);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
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