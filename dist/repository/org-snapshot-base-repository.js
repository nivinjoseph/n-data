import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
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
    async query(sql, ...params) {
        const queryResult = await this.queryRaw(sql, ...params);
        if (queryResult.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}
//# sourceMappingURL=org-snapshot-base-repository.js.map