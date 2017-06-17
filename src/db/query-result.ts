import { given } from "n-defensive";
const Treeize = require("treeize");


// public
export class QueryResult
{
    private readonly _rows: Array<any>;
    
    
    public get rows(): ReadonlyArray<any> { return this._rows; }
    
    
    public constructor(rows: Array<any>)
    {
        given(rows, "rows").ensureHasValue();
        this._rows = rows;
    }
    
    
    public toObjectTree(): Object
    {
        let tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData();
    }
}