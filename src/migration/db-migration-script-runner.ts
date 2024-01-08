import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
import { exec } from "child_process";
import { isAbsolute } from "node:path";


@inject("Logger")
export class DbMigrationScriptRunner
{
    private readonly _logger: Logger;


    public constructor(logger: Logger)
    {
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }


    public async runMigrations(migrationScriptPath: string): Promise<void>
    {
        given(migrationScriptPath, "migrationScriptPath").ensureHasValue().ensureIsString()
            .ensure(t => isAbsolute(t.trim()), "path must be absolute");
        migrationScriptPath = migrationScriptPath.trim();

        const promise = new Promise<void>((resolve, reject) =>
        {
            const child = exec(`node ${migrationScriptPath}`,
                // @ts-expect-error: cuz of unused params
                (error, stdout, stderr) =>
                {
                    // if (error)
                    // {
                    //     console.log(error.stack);
                    //     console.log("Error code: " + error.code);
                    //     console.log("Signal received: " + error.signal);
                    // }
                    // console.log("Child Process STDOUT: " + stdout);
                    // console.log("Child Process STDERR: " + stderr);
                });

            child.on("error", (err) =>
            {
                console.error(err);
                reject(err);
            });

            child.stdout?.setEncoding("utf-8");
            child.stdout?.on("data", (data) =>
            {
                console.log(data);
            });

            child.stderr?.setEncoding("utf-8");
            child.stderr?.on("data", (data) =>
            {
                console.log(data);
            });

            child.on("exit", (code) =>
            {
                if (code !== 0)
                {
                    reject(`Migration exited with non zero code ${code}`);
                    return;
                }

                resolve();
            });
        });

        try
        {
            await promise;
        }
        catch (error: any)
        {
            await this._logger.logError(error);
            throw error;
        }
    }
}