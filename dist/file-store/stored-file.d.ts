import { DomainEntity, DomainObjectData } from "@nivinjoseph/n-domain";
export declare class StoredFile extends DomainEntity<StoredFile, "name" | "ext" | "size" | "mime" | "hash" | "signature" | "publicUrl" | "privateUrl"> {
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
    constructor(data: DomainObjectData<StoredFile>);
    static createFileDataHash(fileData: Buffer): string;
    updatePublicUrl(url: string): StoredFile;
    updatePrivateUrl(url: string): StoredFile;
}
//# sourceMappingURL=stored-file.d.ts.map