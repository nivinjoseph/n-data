/// <reference types="node" />
import { Disposable, Duration } from "@nivinjoseph/n-util";
import { StoredFile } from "./stored-file";
export interface FileStore extends Disposable {
    store(fileName: string, fileData: Buffer): Promise<StoredFile>;
    retrieve(file: StoredFile): Promise<Buffer>;
    makePublic(file: StoredFile): Promise<StoredFile>;
    /**
     *
     * @param fileName
     * @param fileSize
     * @param fileHash
     * @param expiry default and max duration is 7 days
     */
    createSignedUpload(fileName: string, fileSize: number, fileHash: string, expiry?: Duration): Promise<StoredFile>;
    /**
     *
     * @param file
     * @param expiry default and max duration is 7 days
     */
    createSignedDownload(file: StoredFile, expiry?: Duration): Promise<StoredFile>;
}
