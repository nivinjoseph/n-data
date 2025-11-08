import { DomainEntity } from "@nivinjoseph/n-domain";
import { Schema } from "@nivinjoseph/n-util";
export declare class StoredFile extends DomainEntity<StoredFileSchema> {
    private readonly _name;
    private readonly _ext;
    private readonly _size;
    private readonly _mime;
    private readonly _hash;
    private readonly _signature;
    private readonly _publicUrl;
    private readonly _privateUrl;
    get name(): string;
    get ext(): string;
    get size(): number;
    get mime(): string;
    get hash(): string;
    get signature(): string;
    get publicUrl(): string | null;
    get privateUrl(): string | null;
    constructor(data: StoredFileSchema);
    static createFileDataHash(fileData: Buffer): string;
    updatePublicUrl(url: string): StoredFile;
    updatePrivateUrl(url: string): StoredFile;
}
export type StoredFileSchema = Schema<StoredFile, "id" | "name" | "ext" | "size" | "mime" | "hash" | "signature" | "publicUrl" | "privateUrl">;
//# sourceMappingURL=stored-file.d.ts.map