import { given } from "@nivinjoseph/n-defensive";
import { DomainEntity } from "@nivinjoseph/n-domain";
import * as Crypto from "crypto";
import { Schema, serialize } from "@nivinjoseph/n-util";


export class StoredFile extends DomainEntity<StoredFileSchema>
{
    private readonly _name: string;
    private readonly _ext: string;
    private readonly _size: number;
    private readonly _mime: string;
    private readonly _hash: string;
    private readonly _signature: string;
    private readonly _publicUrl: string | null;
    private readonly _privateUrl: string | null; // gets used for signed upload and download


    @serialize
    public get name(): string { return this._name; }

    @serialize
    public get ext(): string { return this._ext; }

    @serialize
    public get size(): number { return this._size; }

    @serialize
    public get mime(): string { return this._mime; }

    @serialize
    public get hash(): string { return this._hash; }

    @serialize
    public get signature(): string { return this._signature; }

    @serialize
    public get publicUrl(): string | null { return this._publicUrl; }

    @serialize
    public get privateUrl(): string | null { return this._privateUrl; } // gets used for signed upload and download


    public constructor(data: StoredFileSchema)
    {
        super(data);

        const { name, ext, size, mime, hash, signature, publicUrl, privateUrl } = data;

        given(name, "fileName").ensureHasValue().ensureIsString();
        this._name = name;

        given(ext, "fileExt").ensureHasValue().ensureIsString();
        this._ext = ext;

        given(size, "fileSize").ensureHasValue().ensureIsNumber().ensure(t => t >= 0);
        this._size = size;

        given(mime, "mimeType").ensureHasValue().ensureIsString();
        this._mime = mime;

        given(hash, "fileHash").ensureHasValue().ensureIsString();
        this._hash = hash;

        given(signature, "signature").ensureHasValue().ensureIsString();
        this._signature = signature;

        given(publicUrl as string, "publicUrl").ensureIsString();
        this._publicUrl = publicUrl || null;

        given(privateUrl as string, "privateUrl").ensureIsString();
        this._privateUrl = privateUrl || null;
    }


    public static createFileDataHash(fileData: Buffer): string
    {
        given(fileData, "fileData").ensureHasValue().ensureIsObject().ensureIsType(Buffer);

        return Crypto.createHash("md5").update(fileData).digest("base64");
    }


    public updatePublicUrl(url: string): StoredFile
    {
        given(url, "url").ensureHasValue().ensureIsString();

        return new StoredFile({
            id: this.id,
            name: this._name,
            ext: this._ext,
            size: this._size,
            mime: this._mime,
            hash: this._hash,
            signature: this._signature,
            publicUrl: url,
            privateUrl: this._privateUrl
        });
    }

    public updatePrivateUrl(url: string): StoredFile
    {
        given(url, "url").ensureHasValue().ensureIsString();

        return new StoredFile({
            id: this.id,
            name: this._name,
            ext: this._ext,
            size: this._size,
            mime: this._mime,
            hash: this._hash,
            signature: this._signature,
            publicUrl: this._publicUrl,
            privateUrl: url
        });
    }
}


export type StoredFileSchema = Schema<StoredFile,
    "id" | "name" | "ext" | "size" | "mime" | "hash" | "signature" | "publicUrl" | "privateUrl">;