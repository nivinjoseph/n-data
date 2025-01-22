import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException, ArgumentException } from "@nivinjoseph/n-exception";
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Mime from "mime-types";
import { Hmac } from "@nivinjoseph/n-sec";
import { StoredFile } from "./stored-file.js";
import { Duration } from "@nivinjoseph/n-util";
import { DomainHelper } from "@nivinjoseph/n-domain";
import { extname } from "node:path";
export class S3FileStore {
    constructor(config) {
        var _a;
        var _b;
        this._isDisposed = false;
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
            .ensureWhen(config.accessKeyId == null || config.secretAccessKey == null, t => t.accessKeyId == t.secretAccessKey, "if provided then both accessKeyId and secretAccessKey must be provided");
        this._config = config;
        this._privateBucket = this._config.privateBucket;
        this._publicBucket = this._config.publicBucket;
        this._publicBucketHasDot = this._publicBucket.contains(".");
        (_a = (_b = this._config).idGenerator) !== null && _a !== void 0 ? _a : (_b.idGenerator = () => DomainHelper.generateId("bsf"));
        this._connection = new S3Client({
            // signatureVersion: "v4",
            region: this._config.region,
            credentials: this._config.accessKeyId != null
                ? {
                    accessKeyId: this._config.accessKeyId,
                    secretAccessKey: this._config.secretAccessKey
                }
                : undefined
        });
        // this._supportedExts = ["png", "jpeg", "jpg", "tiff", "tif", "pdf"];
        this._maxFileSize = 1000000 * 1000;
    }
    async store(fileName, fileData) {
        given(fileName, "fileName").ensureHasValue().ensureIsString();
        given(fileData, "fileData").ensureHasValue().ensureIsType(Buffer).ensure(t => t.byteLength > 0);
        const id = this._config.idGenerator();
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
    async retrieve(file) {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);
        this._verifyStoredFileIntegrity(file);
        const command = new GetObjectCommand({
            Bucket: this._privateBucket,
            Key: file.id
        });
        const retrieveResponse = await this._connection.send(command);
        const fileData = Buffer.from(await retrieveResponse.Body.transformToByteArray());
        const hash = StoredFile.createFileDataHash(fileData);
        if (hash !== file.hash)
            throw new ApplicationException("Stored file has mismatch");
        return fileData;
    }
    async makePublic(file) {
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
    async createSignedUpload(fileName, fileSize, fileHash, expiry = Duration.fromDays(7)) {
        given(fileName, "fileName").ensureHasValue().ensureIsString();
        given(fileSize, "fileSize").ensureHasValue().ensureIsNumber();
        given(fileHash, "fileHash").ensureHasValue().ensureIsString();
        given(expiry, "expiry").ensureHasValue().ensureIsObject();
        const id = this._config.idGenerator();
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
    async createSignedDownload(file, expiry = Duration.fromDays(7)) {
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
    dispose() {
        if (!this._isDisposed) {
            this._connection.destroy();
            this._isDisposed = true;
        }
        return Promise.resolve();
    }
    _getFileExt(fileName) {
        let fileExt = extname(fileName);
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
    _getContentType(fileExt) {
        return Mime.lookup(fileExt) || "application/octet-stream";
    }
    _verifyStoredFileIntegrity(file) {
        given(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(StoredFile);
        const signature = Hmac.create(this._config.storedFileSignatureKey, file.id);
        if (signature !== file.signature)
            throw new ApplicationException(`Stored file object integrity violation 'id: ${file.id}'`);
    }
}
//# sourceMappingURL=s3-file-store.js.map