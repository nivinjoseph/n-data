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
    static createReadModelTableName(aggregateType, prefix) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(prefix, "prefix").ensureIsString();
        prefix = prefix?.trim().toLowerCase();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType)
            + `${prefix ? "_" + prefix : ""}` + "_read_model";
        return tableName;
    }
}
//# sourceMappingURL=data-helper.js.map