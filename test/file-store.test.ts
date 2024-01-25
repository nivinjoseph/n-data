import { ConfigurationManager } from "@nivinjoseph/n-config";
import { Duration } from "@nivinjoseph/n-util";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { test, after, before, describe } from "node:test";
import { FileStore, S3FileStore, StoredFile } from "../src/index.js";
import assert from "node:assert";
import { fileURLToPath } from "node:url";


await describe("FileStore tests", async () =>
{
    let fileStore: FileStore;
    let storedFile: StoredFile;
    const testFilePath = new URL("./test.pdf", import.meta.url);

    before(async () =>
    {
        if (existsSync(testFilePath))
            unlinkSync(testFilePath);

        fileStore = new S3FileStore({
            region: ConfigurationManager.requireStringConfig("awsRegion"),
            privateBucket: ConfigurationManager.requireStringConfig("privateBucket"),
            publicBucket: ConfigurationManager.requireStringConfig("publicBucket"),
            // idGenerator: (): string => DomainHelper.generateId("tst"),
            storedFileSignatureKey: ConfigurationManager.requireStringConfig("storedFileSignatureKey"),
            accessKeyId: ConfigurationManager.requireStringConfig("accessKeyId"),
            secretAccessKey: ConfigurationManager.requireStringConfig("secretAccessKey")
        });
    });

    after(async () =>
    {
        await fileStore.dispose();
    });


    await describe("store", async () =>
    {
        await test("store pdf", async () =>
        {
            // const fileData = readFileSync(testFilePath.replace(".pdf", "-sample.pdf"));
            const file = new URL("./test-sample.pdf", testFilePath);
            console.log(fileURLToPath(file));
            const fileData = readFileSync(file);

            storedFile = await fileStore.store("test.pdf", fileData);

            // console.log(storedFile.serialize());

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            assert.ok(storedFile != null);
            assert.ok(storedFile.id.startsWith("bsf_"));
            assert.strictEqual(storedFile.name, "test.pdf");
            assert.strictEqual(storedFile.ext, "pdf");
            assert.strictEqual(storedFile.size, fileData.byteLength);
            assert.strictEqual(storedFile.mime, "application/pdf");
            assert.ok(storedFile.privateUrl == null);
            assert.ok(storedFile.publicUrl == null);
        });
    });

    await describe("retrieve", async () =>
    {
        await test("retrieve pdf", async () =>
        {
            const data = await fileStore.retrieve(storedFile);

            writeFileSync(testFilePath, data);

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            assert.ok(data != null);
            assert.strictEqual(data.byteLength, storedFile.size);
            assert.strictEqual(StoredFile.createFileDataHash(data), storedFile.hash);
        });
    });

    await describe("makePublic", async () =>
    {
        await test("make pdf public", async () =>
        {
            storedFile = await fileStore.makePublic(storedFile);

            console.log("Public url", storedFile.publicUrl);

            assert.ok(storedFile.publicUrl != null);
        });
    });

    await describe("createSignedUpload", async () =>
    {
        await test("create signed upload for pdf", async () =>
        {
            const myStoredFile = await fileStore.createSignedUpload("test.pdf", storedFile.size, storedFile.hash, Duration.fromSeconds(60));

            console.log("Upload url", myStoredFile.privateUrl);

            assert.ok(myStoredFile.privateUrl != null);
        });
    });

    await describe("createSignedDownload", async () =>
    {
        await test("create signed download for pdf", async () =>
        {
            const myStoredFile = await fileStore.createSignedDownload(storedFile, Duration.fromSeconds(60));

            console.log("Download Url", myStoredFile.privateUrl);

            assert.ok(myStoredFile.privateUrl != null);
        });
    });
});