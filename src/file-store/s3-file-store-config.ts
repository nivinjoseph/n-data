export interface S3FileStoreConfig
{
    region: string;
    privateBucket: string;
    publicBucket: string;
    // eslint-disable-next-line @typescript-eslint/method-signature-style
    idGenerator?: () => string;
    storedFileSignatureKey: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}