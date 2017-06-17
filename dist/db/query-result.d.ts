export declare class QueryResult {
    private readonly _rows;
    readonly rows: ReadonlyArray<any>;
    constructor(rows: Array<any>);
    toObjectTree(): Object;
}
