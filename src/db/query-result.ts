import { given } from "@nivinjoseph/n-defensive";
const Treeize = require("treeize");


// public
export class QueryResult<T>
{
    private readonly _rows: Array<T>;
    
    
    public get rows(): ReadonlyArray<T> { return this._rows; }
    
    
    public constructor(rows: Array<T>)
    {
        given(rows, "rows").ensureHasValue();
        this._rows = rows;
    }
    
    
    public toObjectTree<U>(): Array<U>
    {
        let tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}