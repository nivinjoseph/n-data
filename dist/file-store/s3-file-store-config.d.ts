export interface S3FileStoreConfig {
    region: string;
    privateBucket: string;
    publicBucket: string;
    idGenerator?: () => string;
    storedFileSignatureKey: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}
