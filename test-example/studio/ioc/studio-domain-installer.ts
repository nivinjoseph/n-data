import { given } from "@nivinjoseph/n-defensive";
import { ComponentInstaller, Registry } from "@nivinjoseph/n-ject";
import { DefaultStudioFactory } from "../factories/default-studio-factory.js";
import { EventStreamStudioRepository } from "../repositories/event-stream-studio-repository.js";
import { SnapshotStudioRepository } from "../repositories/snapshot-studio-repository.js";

/**
 * Registers this aggregate's factory and repositories - and nothing else. Shared infrastructure comes
 * from `CommonInstaller`, installed once per process; a domain installer that installed it too would make
 * n-ject throw `Duplicate registration for key` the moment a second domain joined the process.
 *
 * Everything is `scoped`, so each scope resolves its own repository over its own unit of work.
 *
 * The registration shape is the load-bearing part. A repository registers under its **class name**, and
 * the **interface name is an alias** on whichever implementation is the canonical read path - here the
 * snapshot one. The event-stream registration keeps only its class name, because the snapshot repository
 * injects that one specifically in order to wrap it. n-ject throws on a duplicate alias, so putting
 * `"StudioRepository"` on both fails loudly at boot; the mistake to actually watch for is the quiet one -
 * adding the snapshot repository and forgetting to move the alias, which leaves every consumer on the
 * event-stream path and the indexed reads unreachable.
 *
 * @class StudioDomainInstaller
 */
export class StudioDomainInstaller implements ComponentInstaller
{
    public install(registry: Registry): Promise<void>
    {
        given(registry, "registry").ensureHasValue().ensureIsObject();

        registry
            .registerScoped("StudioFactory", DefaultStudioFactory)
            .registerScoped("EventStreamStudioRepository", EventStreamStudioRepository)
            .registerScoped("SnapshotStudioRepository", SnapshotStudioRepository, "StudioRepository");

        return Promise.resolve();
    }
}
