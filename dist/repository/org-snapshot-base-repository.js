import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
/**
 * The organization-scoped counterpart to {@link SnapshotBaseRepository}.
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
 * As with the plain variant, declare the keys to index when the table is created, and build
 * the predicate with {@link DataHelper.createJsonPathExpression} rather than by hand -
 * Postgres only uses an expression index when the query expression matches the indexed one
 * textually, so a near-miss silently becomes a sequential scan.
 *
 * ```typescript
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, [{ path: "status" }]);
 * // -> create index ... on invoice_snaps(organization_id, (data->>'status'));
 * ```
 *
 * @example
 * ```typescript
 * @inject("InvoiceEventStreamRepository")
 * export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
 * {
 *     private static readonly _statusExpression = DataHelper.createJsonPathExpression("status");
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
 * ```
 *
 * @class OrgSnapshotBaseRepository
 */
export class OrgSnapshotBaseRepository extends BaseRepository {
    _eventStreamRepository;
    get domainContext() { return super.domainContext; }
    get eventStreamRepository() { return this._eventStreamRepository; }
    constructor(eventStreamRepository) {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(OrgEventStreamBaseRepository);
        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork, eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));
        this._eventStreamRepository = eventStreamRepository;
    }
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        const sql = ids.isNotEmpty
            ? `select data from ${this.table} where organization_id = ? and id in (${ids.map(() => "?").join(",")});`
            : `select data from ${this.table} where organization_id = ?;`;
        return this.query(sql, this.domainContext.organizationId, ...ids);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const sql = `select data from ${this.table} where organization_id = ? and id = ?;`;
        const result = await this.query(sql, this.domainContext.organizationId, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            await this._eventStreamRepository.save(value, unitOfWork ?? this.unitOfWork);
            let sql = "";
            const params = [];
            if (value.isNew) {
                sql = `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?);`;
                params.push(value.id, this.domainContext.organizationId, value.snapshot());
            }
            else {
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
        catch (error) {
            await this.logger.logError(error);
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
    async query(sql, ...params) {
        const queryResult = await this.queryRaw(sql, ...params);
        if (queryResult.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}
//# sourceMappingURL=org-snapshot-base-repository.js.map