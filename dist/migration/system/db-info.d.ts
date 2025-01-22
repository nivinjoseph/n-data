export declare class DbInfo {
    private readonly _version;
    private readonly _date;
    get version(): number;
    get date(): string;
    constructor(version: number, date: string);
    static deserialize(data: Serialized): DbInfo;
    serialize(): Serialized;
}
interface Serialized {
    version: number;
    date: string;
}
export {};
