import { given } from "@nivinjoseph/n-defensive";
export class DbInfo {
    get version() { return this._version; }
    get date() { return this._date; }
    constructor(version, date) {
        given(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t >= 0);
        this._version = version;
        given(date, "date").ensureHasValue().ensureIsString();
        this._date = date;
    }
    static deserialize(data) {
        given(data, "data").ensureHasValue().ensureIsObject();
        return new DbInfo(data.version, data.date);
    }
    serialize() {
        return {
            version: this._version,
            date: this._date
        };
    }
}
//# sourceMappingURL=db-info.js.map