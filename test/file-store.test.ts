import * as Assert from "assert";
import { FileStore } from "../src/file-store/file-store";
import { S3FileStore } from "../src/file-store/s3-file-store";
import { ConfigurationManager } from "@nivinjoseph/n-config";
import * as Fs from "fs";
import * as Path from "path";
import { StoredFile } from "../src/file-store/stored-file";
import { Duration } from "@nivinjoseph/n-util";


suite("FileStore tests", () =>
{
    let fileStore: FileStore;
    let storedFile: StoredFile;
    const testFilePath = Path.join(__dirname, "test.pdf");

    suiteSetup(async () =>
    {
        if (Fs.existsSync(testFilePath))
            Fs.unlinkSync(testFilePath);
        
        fileStore = new S3FileStore({
            region: ConfigurationManager.requireConfig("awsRegion"),
            privateBucket: ConfigurationManager.requireConfig("privateBucket"),
            publicBucket: ConfigurationManager.requireConfig("publicBucket"),
            // idGenerator: (): string => DomainHelper.generateId("tst"),
            storedFileSignatureKey: ConfigurationManager.requireConfig("storedFileSignatureKey"),
            accessKeyId: ConfigurationManager.requireConfig("accessKeyId"),
            secretAccessKey: ConfigurationManager.requireConfig("secretAccessKey")
        });
    });

    suiteTeardown(async () =>
    {
        await fileStore.dispose();
    });


    suite("store", () =>
    {
        test("store pdf", async () =>
        {        
            const fileData = Fs.readFileSync(testFilePath.replace(".pdf", "-sample.pdf"));
            
            storedFile = await fileStore.store("test.pdf", fileData);
            
            // console.log(storedFile.serialize());
            
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            Assert.ok(storedFile != null);
            Assert.ok(storedFile.id.startsWith("bsf_"));
            Assert.strictEqual(storedFile.name, "test.pdf");
            Assert.strictEqual(storedFile.ext, "pdf");
            Assert.strictEqual(storedFile.size, fileData.byteLength);
            Assert.strictEqual(storedFile.mime, "application/pdf");
            Assert.ok(storedFile.privateUrl == null);
            Assert.ok(storedFile.publicUrl == null);
        });
    });

    suite("retrieve", () =>
    {
        test("retrieve pdf", async () =>
        { 
            const data = await fileStore.retrieve(storedFile);
            
            Fs.writeFileSync(testFilePath, data);
            
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            Assert.ok(data != null);
            Assert.strictEqual(data.byteLength, storedFile.size);
            Assert.strictEqual(StoredFile.createFileDataHash(data), storedFile.hash);
        });
    });

    suite("makePublic", () =>
    {
        test("make pdf public", async () =>
        {
            storedFile = await fileStore.makePublic(storedFile);
            
            console.log("Public url", storedFile.publicUrl);
            
            Assert.ok(storedFile.publicUrl != null);
        });
    });
    
    suite("createSignedUpload", () =>
    {
        test("create signed upload for pdf", async () =>
        {
            const myStoredFile = await fileStore.createSignedUpload("test.pdf", storedFile.size, storedFile.hash, Duration.fromSeconds(60));
            
            console.log("Upload url", myStoredFile.privateUrl);
            
            Assert.ok(myStoredFile.privateUrl != null);
        });
    });
    
    suite("createSignedDownload", () =>
    {
        test("create signed download for pdf", async () =>
        {
            const myStoredFile = await fileStore.createSignedDownload(storedFile, Duration.fromSeconds(60));

            console.log("Download Url", myStoredFile.privateUrl);

            Assert.ok(myStoredFile.privateUrl != null);
        });
    });
});