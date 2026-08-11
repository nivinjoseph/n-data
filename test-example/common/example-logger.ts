import { Logger } from "@nivinjoseph/n-log";
import { Exception } from "@nivinjoseph/n-exception";

/**
 * A logger that records instead of printing.
 *
 * The example runs under `node --test`, and `DbMigrator` narrates every migration through the logger it
 * was given, so a console logger would bury the test output. Recording keeps that output clean and lets
 * a test assert on what was logged - which is how the migration blocks check that a second run reports
 * nothing to do rather than silently re-running.
 *
 * @class ExampleLogger
 */
export class ExampleLogger implements Logger
{
    private readonly _entries = new Array<string>();

    public get entries(): ReadonlyArray<string> { return [...this._entries]; }

    public logDebug(debug: string): Promise<void>
    {
        this._entries.push(`DEBUG: ${debug}`);

        return Promise.resolve();
    }

    public logInfo(info: string): Promise<void>
    {
        this._entries.push(`INFO: ${info}`);

        return Promise.resolve();
    }

    public logWarning(warning: string | Exception): Promise<void>
    {
        this._entries.push(`WARNING: ${this._describe(warning)}`);

        return Promise.resolve();
    }

    public logError(error: string | Exception): Promise<void>
    {
        this._entries.push(`ERROR: ${this._describe(error)}`);

        return Promise.resolve();
    }

    public clear(): void
    {
        this._entries.clear();
    }

    private _describe(value: string | Exception): string
    {
        return typeof value === "string" ? value : value.toString();
    }
}
