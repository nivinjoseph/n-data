import { OrgAggregateRoot, OrgAggregateState, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
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
export declare abstract class OrgSnapshotBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _eventStreamRepository;
    get domainContext(): OrgDomainContext;
    get eventStreamRepository(): OrgEventStreamBaseRepository<T, TState, TDomainEvent>;
    protected constructor(eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>);
    getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
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
    protected query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
}
//# sourceMappingURL=org-snapshot-base-repository.d.ts.map