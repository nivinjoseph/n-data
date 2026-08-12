import { given } from "@nivinjoseph/n-defensive";
import { ComponentInstaller, Registry } from "@nivinjoseph/n-ject";
import { DefaultCreatorFactory } from "../factories/default-creator-factory.js";
import { EventStreamCreatorRepository } from "../repositories/event-stream-creator-repository.js";
import { SnapshotCreatorRepository } from "../repositories/snapshot-creator-repository.js";

/**
 * Registers the creator aggregate's factory and repositories - the same shape as
 * `StudioDomainInstaller`, which is the point: an organization-scoped slice costs no extra wiring.
 *
 * Two domain installers in one process is exactly the case that forces shared infrastructure into
 * `CommonInstaller`: if either installed it, the second would make n-ject throw on a duplicate key.
 *
 * @class CreatorDomainInstaller
 */
export class CreatorDomainInstaller implements ComponentInstaller
{
    public install(registry: Registry): Promise<void>
    {
        given(registry, "registry").ensureHasValue().ensureIsObject();

        registry
            .registerScoped("CreatorFactory", DefaultCreatorFactory)
            .registerScoped("EventStreamCreatorRepository", EventStreamCreatorRepository)
            .registerScoped("SnapshotCreatorRepository", SnapshotCreatorRepository, "CreatorRepository");

        return Promise.resolve();
    }
}
