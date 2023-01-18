import { given } from "@nivinjoseph/n-defensive";
import * as Path from "path";
import { ApplicationException, ArgumentException } from "@nivinjoseph/n-exception";
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as Mime from "mime-types";
import { FileStore } from "./file-store";
import { Hmac } from "@nivinjoseph/n-sec";
import { StoredFile } from "./stored-file";
import { S3FileStoreConfig } from "./s3-file-store-config";
import { Disposable, Duration } from "@nivinjoseph/n-util";
import { DomainHelper } from "@nivinjoseph/n-domain";


export class S3FileStore implements FileStore, Disposable
{
    private readonly _config: S3FileStoreConfig;
    
    private readonly _privateBucket: string;
    private readonly _publicBucket: string;
    private readonly _publicBucketHasDot: boolean;
    private readonly _connection: S3Client;

    // private readonly _supportedExts: ReadonlyArray<string>;
    private readonly _maxFileSize: number;
    
    private _isDisposed = false;


    public constructor(config: S3FileStoreConfig)
    {
        given(config, "config").ensureHasValue()
            .ensureHasStructure({
                region: "string",
                privateBucket: "string",
                publicBucket: "string",
                "idGenerator?": "function",
                storedFileSignatureKey: "string",
                "accessKeyId?": "string",
                "secretAccessKey?": "string"
            })
            .ensureWhen(config.accessKeyId == null || config.secretAccessKey == null, t => t.accessKeyId == t.secretAccessKey,
                "if provided then both accessKeyId and secretAccessKey must be provided");
        this._config = config;
        
        this._privateBucket = this._config.privateBucket;
        this._publicBucket = this._config.publicBucket;
        this._publicBucketHasDot = this._publicBucket.contains(".");
        
        this._config.idGenerator ??= (): string => DomainHelper.generateId("bsf");
        
        this._connection = new S3Client({
            // signatureVersion: "v4",
            region: this._config.region,
            credentials: this._config.accessKeyId != null
                ? {
                    accessKeyId: this._config.accessKeyId,
                    secretAccessKey: this._config.secretAccessKey!
                }
                : undefined
        });

        // this._supportedExts = ["png", "jpeg", "jpg", "tiff", "tif", "pdf"];
        this._maxFileSize = 1000000 * 1000;
    }


    public async store(fileName: string, fileData: Buffer): Promise<StoredFile>
    {
        given(fileName, "fileName").ensureHasValue().ensureIsString();
        given(fileData, "fileData").ensureHasValue().ensureIsType(Buffer).ensure(t => t.byteLength > 0);

        const id = this._config.idGenerator!();
        fileName = fileName.replaceAll(":", "-").trim();
        const fileSize = fileData.byteLength;
        if (fileSize > this._maxFileSize)
            throw new ArgumentException("fileData", "MAX file size of 1 GB exceeded");
        const fileMime = this._getContentType(fileName);
        const fileHash = StoredFile.createFileDataHash(fileData);

        const command = new PutObjectCommand({
            Bucket: this._privateBucket,
            Key: id,
            Body: fileData,
            ContentType: fileMime,
            ContentMD5: fileHash
        });
        
        await this._connection.send(command);

        return new StoredFile({
            id,
            name: fileName,
            ext: this._getFileExt(fileName),
            size: fileSize,
            mime: fileMime,
            hash: fileHash,
            signature: Hmac.create(this._config.storedFileSignatureKey, id),
            publicUrl: null,
            privateUrl: null
        });
    }

    public async retrieve(file: StoredFile): Promise<Buffer>
    {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);

        this._verifyStoredFileIntegrity(file);

        const command = new GetObjectCommand({
            Bucket: this._privateBucket,
            Key: file.id
        });
        
        const retrieveResponse = await this._connection.send(command);

        const fileData = Buffer.from(await retrieveResponse.Body!.transformToByteArray());
        const hash = StoredFile.createFileDataHash(fileData);
        if (hash !== file.hash)
            throw new ApplicationException("Stored file has mismatch");

        return fileData;
    }

    public async makePublic(file: StoredFile): Promise<StoredFile>
    {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);

        this._verifyStoredFileIntegrity(file);

        const command = new CopyObjectCommand({
            Bucket: this._publicBucket,
            CopySource: `/${this._privateBucket}/${file.id}`,
            ACL: "public-read",
            Key: file.id
            // ContentDisposition: "inline"
        });
        
        await this._connection.send(command);

        const url = this._publicBucketHasDot
            ? `https://s3.${this._config.region}.amazonaws.com/${this._publicBucket}/${file.id}`
            : `https://${this._publicBucket}.s3.${this._config.region}.amazonaws.com/${file.id}`;
        
        return file.updatePublicUrl(url);
    }

    /**
     * 
     * @param fileName 
     * @param fileSize 
     * @param fileHash 
     * @param expiry default and max duration is 7 days
     * @returns 
     */
    public async createSignedUpload(fileName: string, fileSize: number, fileHash: string, expiry = Duration.fromDays(7)): Promise<StoredFile>
    {
        given(fileName, "fileName").ensureHasValue().ensureIsString();
        given(fileSize, "fileSize").ensureHasValue().ensureIsNumber();
        given(fileHash, "fileHash").ensureHasValue().ensureIsString();
        given(expiry, "expiry").ensureHasValue().ensureIsObject();

        const id = this._config.idGenerator!();

        fileName = fileName.replaceAll(":", "-").trim();

        if (fileSize > this._maxFileSize)
            throw new ArgumentException("fileData", "MAX file size of 1 GB exceeded");

        const fileMime = this._getContentType(fileName);

        const command = new PutObjectCommand({
            Bucket: this._privateBucket,
            Key: id,
            ContentType: fileMime,
            ContentMD5: fileHash
        });

        const url = await getSignedUrl(this._connection, command, { expiresIn: expiry.toSeconds() });
        
        return new StoredFile({
            id,
            name: fileName,
            ext: this._getFileExt(fileName),
            size: fileSize,
            mime: fileMime,
            hash: fileHash,
            signature: Hmac.create(this._config.storedFileSignatureKey, id),
            publicUrl: null,
            privateUrl: url
        });
    }

    /**
     * 
     * @param file 
     * @param expiry default and max duration is 7 days
     * @returns 
     */
    public async createSignedDownload(file: StoredFile, expiry = Duration.fromDays(7)): Promise<StoredFile>
    {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);
        given(expiry, "expiry").ensureHasValue().ensureIsObject();

        this._verifyStoredFileIntegrity(file);

        const command = new GetObjectCommand({
            Bucket: this._privateBucket,
            Key: file.id
        });
        
        const url = await getSignedUrl(this._connection, command, { expiresIn: expiry.toSeconds() });
        
        return file.updatePrivateUrl(url);
    }
    
    public dispose(): Promise<void>
    {
        if (!this._isDisposed)
        {
            this._connection.destroy();
            this._isDisposed = true;
        }
        
        return Promise.resolve();
    }

    private _getFileExt(fileName: string): string
    {
        let fileExt = Path.extname(fileName);
        fileExt = fileExt.isEmptyOrWhiteSpace() ? "UNKNOWN" : fileExt.trim().replace(".", "").toLowerCase();
        // if (this._supportedExts.every(t => t !== fileExt))
        //     throw new ArgumentException("fileName", "unsupported format");
        return fileExt;
    }

    // private getFileSize(fileData: Buffer): number
    // {
    //     const fileSize = fileData.byteLength;
    //     if (fileSize > this._maxFileSize)
    //         throw new ArgumentException("fileData", "MAX file size of 1 GB exceeded");
    //     return fileSize;
    // }

    private _getContentType(fileExt: string): string
    {
        return Mime.lookup(fileExt) || "application/octet-stream";
    }

    private _verifyStoredFileIntegrity(file: StoredFile): void
    {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);

        const signature = Hmac.create(this._config.storedFileSignatureKey, file.id);
        if (signature !== file.signature)
            throw new ApplicationException(`Stored file object integrity violation 'id: ${file.id}'`);
    }
}