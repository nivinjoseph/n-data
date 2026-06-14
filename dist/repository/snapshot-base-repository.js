import { AggregateRoot } from "@nivinjoseph/n-domain";
import { EventStreamBaseRepository } from "./event-stream-base-repository.js";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
export class SnapshotBaseRepository extends BaseRepository {
    _eventStreamRepository;
    get eventStreamRepository() { return this._eventStreamRepository; }
    constructor(eventStreamRepository) {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(EventStreamBaseRepository);
        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork, eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));
        this._eventStreamRepository = eventStreamRepository;
    }
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        const sql = ids.isNotEmpty
            ? `select data from ${this.table} where id in (${ids.map(() => "?").join(",")});`
            : `select data from ${this.table};`;
        return this.query(sql, ...ids);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const sql = `select data from ${this.table} where id = ?;`;
        const result = await this.query(sql, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            await this._eventStreamRepository.save(value, unitOfWork ?? this.unitOfWork);
            let sql = "";
            const params = [];
            if (value.isNew) {
                sql = `insert into ${this.table}
                            (id, data)
                            values(?, ?);`;
                params.push(value.id, value.snapshot());
            }
            else {
                sql = `insert into ${this.table}
                            (id, data)
                            values(?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;
                params.push(value.id, value.snapshot());
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
//# sourceMappingURL=snapshot-base-repository.js.map