import { given } from "@nivinjoseph/n-defensive";


export class DbInfo
{
    private readonly _version: number;
    private readonly _date: string;


    public get version(): number { return this._version; }
    public get date(): string { return this._date; }


    public constructor(version: number, date: string)
    {
        given(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t >= 0);
        this._version = version;

        given(date, "date").ensureHasValue().ensureIsString();
        this._date = date;
    }


    public static deserialize(data: Serialized): DbInfo
    {
        given(data, "data").ensureHasValue().ensureIsObject();

        return new DbInfo(data.version, data.date);
    }


    public serialize(): Serialized
    {
        return {
            version: this._version,
            date: this._date
        };
    }
}


interface Serialized
{
    version: number;
    date: string;
}