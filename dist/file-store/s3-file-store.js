"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3FileStore = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const Path = require("path");
const n_exception_1 = require("@nivinjoseph/n-exception");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const Mime = require("mime-types");
const n_sec_1 = require("@nivinjoseph/n-sec");
const stored_file_1 = require("./stored-file");
const n_domain_1 = require("@nivinjoseph/n-domain");
class S3FileStore {
    constructor(config) {
        var _a;
        var _b;
        this._isDisposed = false;
        (0, n_defensive_1.given)(config, "config").ensureHasValue()
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
        (_a = (_b = this._config).idGenerator) !== null && _a !== void 0 ? _a : (_b.idGenerator = () => n_domain_1.DomainHelper.generateId("bsf"));
        this._connection = new client_s3_1.S3Client({
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
    store(fileName, fileData) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(fileName, "fileName").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(fileData, "fileData").ensureHasValue().ensureIsType(Buffer).ensure(t => t.byteLength > 0);
            const id = this._config.idGenerator();
            fileName = fileName.replaceAll(":", "-").trim();
            const fileSize = fileData.byteLength;
            if (fileSize > this._maxFileSize)
                throw new n_exception_1.ArgumentException("fileData", "MAX file size of 1 GB exceeded");
            const fileMime = this._getContentType(fileName);
            const fileHash = stored_file_1.StoredFile.createFileDataHash(fileData);
            const command = new client_s3_1.PutObjectCommand({
                Bucket: this._privateBucket,
                Key: id,
                Body: fileData,
                ContentType: fileMime,
                ContentMD5: fileHash
            });
            yield this._connection.send(command);
            return new stored_file_1.StoredFile({
                id,
                name: fileName,
                ext: this._getFileExt(fileName),
                size: fileSize,
                mime: fileMime,
                hash: fileHash,
                signature: n_sec_1.Hmac.create(this._config.storedFileSignatureKey, id),
                publicUrl: null,
                privateUrl: null
            });
        });
    }
    retrieve(file) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(stored_file_1.StoredFile);
            this._verifyStoredFileIntegrity(file);
            const command = new client_s3_1.GetObjectCommand({
                Bucket: this._privateBucket,
                Key: file.id
            });
            const retrieveResponse = yield this._connection.send(command);
            const fileData = Buffer.from(yield retrieveResponse.Body.transformToByteArray());
            const hash = stored_file_1.StoredFile.createFileDataHash(fileData);
            if (hash !== file.hash)
                throw new n_exception_1.ApplicationException("Stored file has mismatch");
            return fileData;
        });
    }
    makePublic(file) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(stored_file_1.StoredFile);
            this._verifyStoredFileIntegrity(file);
            const command = new client_s3_1.CopyObjectCommand({
                Bucket: this._publicBucket,
                CopySource: `/${this._privateBucket}/${file.id}`,
                ACL: "public-read",
                Key: file.id
                // ContentDisposition: "inline"
            });
            yield this._connection.send(command);
            const url = this._publicBucketHasDot
                ? `https://s3.${this._config.region}.amazonaws.com/${this._publicBucket}/${file.id}`
                : `https://${this._publicBucket}.s3.${this._config.region}.amazonaws.com/${file.id}`;
            return file.updatePublicUrl(url);
        });
    }
    createSignedUpload(fileName, fileSize, fileHash, expiry) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(fileName, "fileName").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(fileSize, "fileSize").ensureHasValue().ensureIsNumber();
            (0, n_defensive_1.given)(fileHash, "fileHash").ensureHasValue().ensureIsString();
            (0, n_defensive_1.given)(expiry, "expiry").ensureHasValue().ensureIsObject();
            const id = this._config.idGenerator();
            fileName = fileName.replaceAll(":", "-").trim();
            if (fileSize > this._maxFileSize)
                throw new n_exception_1.ArgumentException("fileData", "MAX file size of 1 GB exceeded");
            const fileMime = this._getContentType(fileName);
            const command = new client_s3_1.PutObjectCommand({
                Bucket: this._privateBucket,
                Key: id,
                ContentType: fileMime,
                ContentMD5: fileHash
            });
            const url = yield (0, s3_request_presigner_1.getSignedUrl)(this._connection, command, { expiresIn: expiry.toSeconds() });
            return new stored_file_1.StoredFile({
                id,
                name: fileName,
                ext: this._getFileExt(fileName),
                size: fileSize,
                mime: fileMime,
                hash: fileHash,
                signature: n_sec_1.Hmac.create(this._config.storedFileSignatureKey, id),
                publicUrl: null,
                privateUrl: url
            });
        });
    }
    createSignedDownload(file, expiry) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(stored_file_1.StoredFile);
            (0, n_defensive_1.given)(expiry, "expiry").ensureHasValue().ensureIsObject();
            this._verifyStoredFileIntegrity(file);
            const command = new client_s3_1.GetObjectCommand({
                Bucket: this._privateBucket,
                Key: file.id
            });
            const url = yield (0, s3_request_presigner_1.getSignedUrl)(this._connection, command, { expiresIn: expiry.toSeconds() });
            return file.updatePrivateUrl(url);
        });
    }
    dispose() {
        if (!this._isDisposed) {
            this._connection.destroy();
            this._isDisposed = true;
        }
        return Promise.resolve();
    }
    _getFileExt(fileName) {
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
    _getContentType(fileExt) {
        return Mime.lookup(fileExt) || "application/octet-stream";
    }
    _verifyStoredFileIntegrity(file) {
        (0, n_defensive_1.given)(file, "file").ensureHasValue().ensureIsObject().ensureIsInstanceOf(stored_file_1.StoredFile);
        const signature = n_sec_1.Hmac.create(this._config.storedFileSignatureKey, file.id);
        if (signature !== file.signature)
            throw new n_exception_1.ApplicationException(`Stored file object integrity violation 'id: ${file.id}'`);
    }
}
exports.S3FileStore = S3FileStore;
//# sourceMappingURL=s3-file-store.js.map