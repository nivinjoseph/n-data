import { Disposable, Duration } from "@nivinjoseph/n-util";
import { StoredFile } from "./stored-file.js";
/**
 * Interface representing a file storage service that provides methods for storing,
 * retrieving, and managing files with support for public access and signed URLs.
 *
 * @interface FileStore
 * @extends Disposable
 */
export interface FileStore extends Disposable {
    /**
     * Stores a file in the file store.
     *
     * @param {string} fileName - The name to give the stored file
     * @param {Buffer} fileData - The file data to store
     * @returns {Promise<StoredFile>} A promise that resolves to the stored file metadata
     * @throws {Error} If the storage operation fails
     */
    store(fileName: string, fileData: Buffer): Promise<StoredFile>;
    /**
     * Retrieves a file from the file store.
     *
     * @param {StoredFile} file - The stored file metadata
     * @returns {Promise<Buffer>} A promise that resolves to the file data
     * @throws {Error} If the retrieval operation fails
     */
    retrieve(file: StoredFile): Promise<Buffer>;
    /**
     * Makes a stored file publicly accessible.
     *
     * @param {StoredFile} file - The stored file metadata
     * @returns {Promise<StoredFile>} A promise that resolves to the updated file metadata with public access
     * @throws {Error} If the operation fails
     */
    makePublic(file: StoredFile): Promise<StoredFile>;
    /**
     * Creates a signed URL for uploading a file.
     *
     * @param {string} fileName - The name to give the file
     * @param {number} fileSize - The size of the file in bytes
     * @param {string} fileHash - A hash of the file content for verification
     * @param {Duration} [expiry] - Optional duration for which the signed URL is valid (default and max is 7 days)
     * @returns {Promise<StoredFile>} A promise that resolves to the file metadata with signed upload URL
     * @throws {Error} If the operation fails
     */
    createSignedUpload(fileName: string, fileSize: number, fileHash: string, expiry?: Duration): Promise<StoredFile>;
    /**
     * Creates a signed URL for downloading a file.
     *
     * @param {StoredFile} file - The stored file metadata
     * @param {Duration} [expiry] - Optional duration for which the signed URL is valid (default and max is 7 days)
     * @returns {Promise<StoredFile>} A promise that resolves to the file metadata with signed download URL
     * @throws {Error} If the operation fails
     */
    createSignedDownload(file: StoredFile, expiry?: Duration): Promise<StoredFile>;
}
//# sourceMappingURL=file-store.d.ts.map