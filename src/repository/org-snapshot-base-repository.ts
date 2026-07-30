import { AggregateRoot, AggregateState, OrgAggregateRoot, OrgAggregateState, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";

/**
 * The organization-scoped counterpart to `SnapshotBaseRepository`.
 *
 * The snapshot table holds `id` (the primary key), `organization_id`, and `data` (the
 * serialized state as jsonb). {@link get} and {@link getAll} cover lookup by id and scope
 * themselves to the current organization automatically.
 *
 * **Every custom query on a subclass must filter `organization_id` itself.** {@link query}
 * does not add that filter, so omitting it returns other organizations' aggregates - and it
 * also misses the index, because every index on an org snapshot table leads with
 * `organization_id`. One omission, both a tenant-isolation bug and a performance bug. The
 * organization is available as `this.domainContext.organizationId`.
 *
 * As with the plain variant, declare each index with `SnapshotIndex` on this repository and build
 * predicates from the same declaration via its `expressionForPath`, never by hand - Postgres only
 * uses an expression index when the query expression matches the indexed one textually, so a
 * near-miss silently becomes a sequential scan.
 *
 * ```typescript
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, [
 *     SnapshotIndex.forPath<InvoiceState>("status"),
 *     SnapshotIndex.forPath<InvoiceState>("series").andPath("invoiceNumber").asUnique()
 * ]);
 * // -> create index ... on invoice_snaps(organization_id, (data->>'status'));
 * //    create unique index ... on invoice_snaps(organization_id, (data->>'series'), (data->>'invoiceNumber'));
 * ```
 *
 * `organizationId` is deliberately not an indexable path, even though the state declares it. It is a
 * real column here and it leads every index, so constraining the column both isolates the tenant and
 * uses the index; the copy inside `data` is not what any index covers, so both indexing and querying
 * that path are always wrong. Constrain the column.
 *
 * Because every index leads with `organization_id`, one marked `asUnique` is unique **within an
 * organization** rather than globally - the same natural key, or tuple of them, can exist once
 * per tenant, which is normally what a tenant-scoped natural key means. Rows whose `data` omits
 * an indexed key are unconstrained; for a composite that means a row missing any member never
 * collides. A collision raises out of {@link save} as a DbException and rolls the unit of work
 * back, rather than surfacing as a domain error.
 *
 * That leading column is also why no expression here is independently searchable: btree serves only a
 * leading prefix, so a predicate must constrain `organization_id` before any indexed expression can
 * be used - which the mandatory org filter already does. `info.indexes` reports it as `leadingColumn`.
 *
 * @example
 * ```typescript
 * @inject("InvoiceEventStreamRepository")
 * export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
 * {
 *     // declared once: the migration creates these, this class queries them
 *     public static readonly statusIndex = SnapshotIndex.forPath<InvoiceState>("status");
 *
 *     public static readonly snapshotIndexes: ReadonlyArray<SnapshotIndex<InvoiceState>> =
 *         [InvoiceRepository.statusIndex];
 *
 *     private static readonly _statusExpression = InvoiceRepository.statusIndex.expressionForPath("status");
 *
 *     public constructor(eventStreamRepository: InvoiceEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         // organization_id first - for isolation, and because the index leads with it
 *         return this.query(
 *             `select data from ${this.table} where organization_id = ? and ${InvoiceRepository._statusExpression} = ?;`,
 *             this.domainContext.organizationId, status);
 *     }
 * }
 *
 * // in the migration
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, InvoiceRepository.snapshotIndexes);
 * ```
 *
 * @class OrgSnapshotBaseRepository
 */
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

    /**
     * Runs a query and deserializes each row into an aggregate.
     *
     * The select list must be `data` - each row is deserialized from that column, so a query
     * selecting anything else fails. Parameters bind with `?` placeholders; never interpolate
     * values into the SQL.
     *
     * This does **not** scope the query to the current organization. The caller's SQL must
     * include `organization_id = ?` and pass `this.domainContext.organizationId`; see the
     * class documentation for why omitting it is both an isolation and a performance bug.
     *
     * For reads whose shape does not map onto the aggregate - counts, group-bys, projections -
     * use {@link BaseRepository.queryRaw} instead, which performs no deserialization.
     *
     * @param {string} sql - The query to run. Must select the `data` column and filter `organization_id`.
     * @param {...ReadonlyArray<any>} params - Values bound to the query's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected async query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        const queryResult = await this.queryRaw<any>(sql, ...params);
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as AggregateState)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}