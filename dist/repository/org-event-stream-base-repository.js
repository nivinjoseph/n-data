import { AggregateRoot } from "@nivinjoseph/n-domain";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
export class OrgEventStreamBaseRepository {
    _domainContext;
    _db;
    _unitOfWork;
    _logger;
    _aggregateType;
    _aggregateStateFactory;
    _table;
    get table() { return this._table; }
    get domainContext() { return this._domainContext; }
    get db() { return this._db; }
    get unitOfWork() { return this._unitOfWork; }
    get logger() { return this._logger; }
    get aggregateType() { return this._aggregateType; }
    get aggregateStateFactory() { return this._aggregateStateFactory; }
    constructor(domainContext, db, unitOfWork, logger, aggregateType, aggregateStateFactory) {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({
            userId: "string",
            organizationId: "string"
        });
        this._domainContext = domainContext;
        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        this._unitOfWork = unitOfWork;
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        this._aggregateType = aggregateType;
        given(aggregateStateFactory, "aggregateStateFactory").ensureHasValue().ensureIsObject();
        this._aggregateStateFactory = aggregateStateFactory;
        this._table = DataHelper.createEventStreamTableName(this._aggregateType);
    }
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (ids.isNotEmpty)
            return this.query(`select data from ${this._table} where organization_id = ? and aggregate_id in (${ids.map(() => "?").join(",")});`, this._domainContext.organizationId, ...ids);
        return this.query(`select data from ${this._table} where organization_id = ?;`, this._domainContext.organizationId);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const result = await this.query(`select data from ${this._table} where organization_id = ? and aggregate_id = ?;`, this._domainContext.organizationId, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType)
            .ensure(t => t.organizationId === this._domainContext.organizationId);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            const events = (value.isNew ? value.events : value.currentEvents);
            const values = new Array();
            const params = new Array();
            for (const event of events) {
                values.push("(?, ?, ?, ?, ?)");
                params.push(event.id, event.aggregateId, event.version, this._domainContext.organizationId, event.serialize());
            }
            const sql = `insert into ${this._table} 
                            (id, aggregate_id, aggregate_version, organization_id, data) 
                            values ${values.join(",")};`;
            await this._db.executeCommandWithinUnitOfWork(unitOfWork ?? this._unitOfWork, sql, ...params);
            if (!unitOfWork)
                await this._unitOfWork.commit();
        }
        catch (error) {
            await this._logger.logError(error);
            if (!unitOfWork)
                await this._unitOfWork.rollback();
            throw error;
        }
    }
    async query(sql, ...params) {
        given(sql, "sql").ensureHasValue().ensureIsString();
        sql = sql.trim();
        given(params, "params").ensureHasValue().ensureIsArray();
        const queryResult = await this._db.executeQuery(sql, ...params);
        if (queryResult.rows.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .groupBy(t => t.$aggregateId)
            .map(t => AggregateRoot.deserializeFromEvents(this._domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }
}
//# sourceMappingURL=org-event-stream-base-repository.js.map