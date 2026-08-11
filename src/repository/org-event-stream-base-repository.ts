import { AggregateRoot, OrgAggregateRoot, OrgAggregateState, OrgAggregateStateFactory, OrgDomainContext, OrgDomainEvent, OrgDomainEventData } from "@nivinjoseph/n-domain";
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
 * The organization-scoped counterpart to `EventStreamBaseRepository`: the append-only event stream for one
 * tenant's aggregates.
 *
 * **It reads by aggregate id, or in full, and deliberately nothing else** - and every read is scoped to
 * `this.domainContext.organizationId` without a caller saying so. {@link get} loads one, {@link getAll} loads
 * them all or a named set, {@link save} appends. There is no query surface, and no way out of the tenant
 * scope, because neither is wanted here:
 *
 * - **There is nothing to query by.** The table carries one index, the unique
 *   `(organization_id, aggregate_id, aggregate_version)`.
 * - **A partial match produces a wrong aggregate.** Rows are grouped by aggregate id and replayed, and
 *   `AggregateRoot` requires exactly one created event among them - so a content-based predicate either
 *   throws `no created event passed` or silently rebuilds the aggregate at an earlier version.
 *
 * Anything else is what `OrgSnapshotBaseRepository` is for: it reads a materialized table whose indexes are
 * declared with a `SnapshotQuerySet`, prepends the organization filter to every predicate, and offers
 * `queryAcrossOrganizations` for the rare read that is genuinely meant to span tenants. For a projection over
 * the raw event rows use {@link BaseRepository.queryRaw} - which gets no organization filter, so such a
 * statement must constrain `organization_id` itself.
 *
 * @class OrgEventStreamBaseRepository
 */
export abstract class OrgEventStreamBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T>
{
    private readonly _aggregateType: ClassDefinition<T>;
    private readonly _aggregateStateFactory: OrgAggregateStateFactory<TState>;


    public override get domainContext(): OrgDomainContext { return super.domainContext as OrgDomainContext; }
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
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);
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

                params.push(event.id, event.aggregateId, event.version, this.domainContext.organizationId,
                    event.serialize());
            }

            const sql = `insert into ${this.table}
                            (id, aggregate_id, aggregate_version, organization_id, data)
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
     * The organization filter is still prepended by the builder, and prepended *first*, which is why this
     * goes through it rather than writing two fixed statements by hand: the column has to lead both the
     * predicate and the parameter list, and getting that wrong is a tenant leak rather than a syntax error.
     */
    private async _load(ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        const built = ids.isNotEmpty
            ? RepositoryQueryBuilder.build(this.table,
                `aggregate_id in (${ids.map(() => "?").join(",")})`, ids, this.domainContext.organizationId)
            : RepositoryQueryBuilder.build(this.table, {}, [], this.domainContext.organizationId);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
    }

    private _deserialize(queryResult: QueryResult<any>): Array<T>
    {
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as OrgDomainEventData)
            .groupBy(t => t.$aggregateId as string)
            .map(t => AggregateRoot.deserializeFromEvents(this.domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }

    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}