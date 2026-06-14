import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
export class EventStreamBaseRepository extends BaseRepository {
    _aggregateType;
    _aggregateStateFactory;
    get aggregateType() { return this._aggregateType; }
    get aggregateStateFactory() { return this._aggregateStateFactory; }
    constructor(domainContext, db, unitOfWork, logger, aggregateType, aggregateStateFactory) {
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
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (ids.isNotEmpty)
            return this.query(`select data from ${this.table} where aggregate_id in (${ids.map(() => "?").join(",")});`, ...ids);
        return this.query(`select data from ${this.table};`);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const result = await this.query(`select data from ${this.table} where aggregate_id = ?;`, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            const events = (value.isNew ? value.events : value.currentEvents);
            const values = new Array();
            const params = new Array();
            for (const event of events) {
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
            .groupBy(t => t.$aggregateId)
            .map(t => AggregateRoot.deserializeFromEvents(this.domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }
}
//# sourceMappingURL=event-stream-base-repository.js.map