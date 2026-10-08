import { given } from "@nivinjoseph/n-defensive";
import { DomainHelper } from "@nivinjoseph/n-domain";
export class DataHelper {
    /**
     * @static
     */
    constructor() { }
    static createEventStreamTableName(aggregateType) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_events";
        return tableName;
    }
    static createSnapshotTableName(aggregateType) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_snaps";
        return tableName;
    }
    /**
     * The table a read model class is stored in: the class name in snake_case and the `_read_model`
     * suffix - `OrderSummary` is `order_summary_read_model`. The suffix keeps the name clear of the
     * `_events`/`_snaps` tables and of every reserved word. One class, one table: there is no prefix,
     * because `ReadModelSchema` derives the table from the class alone.
     *
     * @param {ReadModelClass} modelType - The read model class.
     * @returns {string} The table name.
     * @throws {ArgumentNullException} If modelType is null or undefined.
     * @throws {ArgumentException} If modelType is not a function.
     */
    static createReadModelTableName(modelType) {
        given(modelType, "modelType").ensureHasValue().ensureIsFunction();
        return DomainHelper.aggregateTypeToSnakeCase(modelType) + "_read_model";
    }
}
//# sourceMappingURL=data-helper.js.map