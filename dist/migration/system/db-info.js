"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbInfo = void 0;
const n_defensive_1 = require("@nivinjoseph/n-defensive");
class DbInfo {
    constructor(version, date) {
        (0, n_defensive_1.given)(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t > 0);
        this._version = version;
        (0, n_defensive_1.given)(date, "date").ensureHasValue().ensureIsString();
        this._date = date;
    }
    get version() { return this._version; }
    get date() { return this._date; }
    static deserialize(data) {
        (0, n_defensive_1.given)(data, "data").ensureHasValue().ensureIsObject();
        return new DbInfo(data.version, data.date);
    }
    serialize() {
        return {
            version: this._version,
            date: this._date
        };
    }
}
exports.DbInfo = DbInfo;
//# sourceMappingURL=db-info.js.map