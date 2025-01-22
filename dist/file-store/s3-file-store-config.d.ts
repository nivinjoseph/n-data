export interface S3FileStoreConfig {
    region: string;
    privateBucket: string;
    publicBucket: string;
    idGenerator?: () => string;
    storedFileSignatureKey: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}
//# sourceMappingURL=s3-file-store-config.d.ts.map