import { AggregateRoot } from "@nivinjoseph/n-domain";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
export class OrgSnapshotBaseRepository {
    _eventStreamRepository;
    _table;
    get table() { return this._table; }
    get eventStreamRepository() { return this._eventStreamRepository; }
    constructor(eventStreamRepository) {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(OrgEventStreamBaseRepository);
        this._eventStreamRepository = eventStreamRepository;
        this._table = DataHelper.createSnapshotTableName(this._eventStreamRepository.aggregateType);
    }
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        const sql = ids.isNotEmpty
            ? `select data from ${this._table} where organization_id = ? and id in (${ids.map(() => "?").join(",")});`
            : `select data from ${this._table} where organization_id = ?;`;
        return this.query(sql, this._eventStreamRepository.domainContext.organizationId, ...ids);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const sql = `select data from ${this._table} where organization_id = ? and id = ?;`;
        const result = await this.query(sql, this._eventStreamRepository.domainContext.organizationId, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType)
            .ensure(t => t.organizationId === this._eventStreamRepository.domainContext.organizationId);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            await this._eventStreamRepository.save(value, unitOfWork ?? this._eventStreamRepository.unitOfWork);
            let sql = "";
            const params = [];
            if (value.isNew) {
                sql = `insert into ${this._table} 
                            (id, organization_id, data)
                            values(?, ?, ?);`;
                params.push(value.id, this._eventStreamRepository.domainContext.organizationId, value.snapshot());
            }
            else {
                sql = `insert into ${this._table}
                            (id, organization_id, data)
                            values(?, ?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;
                params.push(value.id, this._eventStreamRepository.domainContext.organizationId, value.snapshot());
            }
            await this.eventStreamRepository.db.executeCommandWithinUnitOfWork(unitOfWork ?? this._eventStreamRepository.unitOfWork, sql, ...params);
            if (!unitOfWork)
                await this._eventStreamRepository.unitOfWork.commit();
        }
        catch (error) {
            await this._eventStreamRepository.logger.logError(error);
            if (!unitOfWork)
                await this._eventStreamRepository.unitOfWork.rollback();
            throw error;
        }
    }
    async query(sql, ...params) {
        given(sql, "sql").ensureHasValue().ensureIsString();
        sql = sql.trim();
        given(params, "params").ensureHasValue().ensureIsArray();
        const queryResult = await this._eventStreamRepository.db.executeQuery(sql, ...params);
        if (queryResult.rows.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .map(t => AggregateRoot.deserializeFromSnapshot(this._eventStreamRepository.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}
//# sourceMappingURL=org-snapshot-base-repository.js.map