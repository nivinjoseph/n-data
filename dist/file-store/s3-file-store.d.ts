/// <reference types="node" />
import { FileStore } from "./file-store";
import { StoredFile } from "./stored-file";
import { S3FileStoreConfig } from "./s3-file-store-config";
import { Disposable, Duration } from "@nivinjoseph/n-util";
export declare class S3FileStore implements FileStore, Disposable {
    private readonly _config;
    private readonly _privateBucket;
    private readonly _publicBucket;
    private readonly _publicBucketHasDot;
    private readonly _connection;
    private readonly _maxFileSize;
    private _isDisposed;
    constructor(config: S3FileStoreConfig);
    store(fileName: string, fileData: Buffer): Promise<StoredFile>;
    retrieve(file: StoredFile): Promise<Buffer>;
    makePublic(file: StoredFile): Promise<StoredFile>;
    /**
     *
     * @param fileName
     * @param fileSize
     * @param fileHash
     * @param expiry default and max duration is 7 days
     * @returns
     */
    createSignedUpload(fileName: string, fileSize: number, fileHash: string, expiry?: Duration): Promise<StoredFile>;
    /**
     *
     * @param file
     * @param expiry default and max duration is 7 days
     * @returns
     */
    createSignedDownload(file: StoredFile, expiry?: Duration): Promise<StoredFile>;
    dispose(): Promise<void>;
    private _getFileExt;
    private _getContentType;
    private _verifyStoredFileIntegrity;
}
