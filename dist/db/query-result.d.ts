export declare class QueryResult<T> {
    private readonly _rows;
    readonly rows: ReadonlyArray<T>;
    constructor(rows: Array<T>);
    toObjectTree<U>(): Array<U>;
}
