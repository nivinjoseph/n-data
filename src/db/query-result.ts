/* eslint-disable @typescript-eslint/no-unsafe-call */
import { given } from "@nivinjoseph/n-defensive";
// @ts-expect-error: no types
import Treeize from "treeize";


// public
export class QueryResult<T>
{
    private readonly _rows: Array<T>;


    public get rows(): ReadonlyArray<T> { return this._rows; }


    public constructor(rows: Array<T>)
    {
        given(rows, "rows").ensureHasValue().ensureIsArray();
        this._rows = rows;
    }


    public toObjectTree<U>(): Array<U>
    {
        const tree = new Treeize();
        tree.grow(this._rows);
        return tree.getData() as Array<U>;
    }
}