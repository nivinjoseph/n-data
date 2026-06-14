import { AggregateRoot, AggregateState, OrgAggregateRoot, OrgAggregateState, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";

export abstract class OrgSnapshotBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T>
{
    private readonly _eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>;

    public override get domainContext(): OrgDomainContext { return super.domainContext as OrgDomainContext; }
    public get eventStreamRepository(): OrgEventStreamBaseRepository<T, TState, TDomainEvent> { return this._eventStreamRepository; }

    protected constructor(eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>)
    {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(OrgEventStreamBaseRepository);

        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork,
            eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));

        this._eventStreamRepository = eventStreamRepository;
    }


    public async getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());

        const sql = ids.isNotEmpty
            ? `select data from ${this.table} where organization_id = ? and id in (${ids.map(() => "?").join(",")});`
            : `select data from ${this.table} where organization_id = ?;`;

        return this.query(sql, this.domainContext.organizationId, ...ids);
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const sql = `select data from ${this.table} where organization_id = ? and id = ?;`;
        const result = await this.query(sql, this.domainContext.organizationId, id);

        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);

        return result[0];
    }

    public async save(value: T, unitOfWork?: UnitOfWork): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);

        given(unitOfWork, "unitOfWork").ensureIsObject();

        if (!value.isNew && !value.hasChanges)
            return;

        try
        {
            await this._eventStreamRepository.save(value, unitOfWork ?? this.unitOfWork);

            let sql = "";
            const params = [];

            if (value.isNew)
            {
                sql = `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?);`;

                params.push(value.id, this.domainContext.organizationId, value.snapshot());
            }
            else
            {
                sql = `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;

                params.push(value.id, this.domainContext.organizationId, value.snapshot());
            }

            await this.db.executeCommandWithinUnitOfWork(unitOfWork ?? this.unitOfWork, sql, ...params);

            if (!unitOfWork)
                await this.unitOfWork.commit();
        }
        catch (error)
        {
            await this.logger.logError(error as any);

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

        return queryResult.rows.map(t => t.data as AggregateState)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}