import { Disposable, Duration } from "@nivinjoseph/n-util";
import { StoredFile } from "./stored-file";


export interface FileStore extends Disposable
{
    store(fileName: string, fileData: Buffer): Promise<StoredFile>;
    retrieve(file: StoredFile): Promise<Buffer>;
    makePublic(file: StoredFile): Promise<StoredFile>;
    createSignedUpload(fileName: string, fileSize: number, fileHash: string, expiry: Duration): Promise<StoredFile>;
    createSignedDownload(file: StoredFile, expiry: Duration): Promise<StoredFile>;
}