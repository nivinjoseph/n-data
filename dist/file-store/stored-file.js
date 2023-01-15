"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoredFile = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_domain_1 = require("@nivinjoseph/n-domain");
const Crypto = require("crypto");
const n_util_1 = require("@nivinjoseph/n-util");
class StoredFile extends n_domain_1.DomainEntity {
    constructor(data) {
        super(data);
        const { name, ext, size, mime, hash, signature, publicUrl, privateUrl } = data;
        (0, n_defensive_1.given)(name, "fileName").ensureHasValue().ensureIsString();
        this._name = name;
        (0, n_defensive_1.given)(ext, "fileExt").ensureHasValue().ensureIsString();
        this._ext = ext;
        (0, n_defensive_1.given)(size, "fileSize").ensureHasValue().ensureIsNumber().ensure(t => t >= 0);
        this._size = size;
        (0, n_defensive_1.given)(mime, "mimeType").ensureHasValue().ensureIsString();
        this._mime = mime;
        (0, n_defensive_1.given)(hash, "fileHash").ensureHasValue().ensureIsString();
        this._hash = hash;
        (0, n_defensive_1.given)(signature, "signature").ensureHasValue().ensureIsString();
        this._signature = signature;
        (0, n_defensive_1.given)(publicUrl, "publicUrl").ensureIsString();
        this._publicUrl = publicUrl || null;
        (0, n_defensive_1.given)(privateUrl, "privateUrl").ensureIsString();
        this._privateUrl = privateUrl || null;
    }
    get name() { return this._name; }
    get ext() { return this._ext; }
    get size() { return this._size; }
    get mime() { return this._mime; }
    get hash() { return this._hash; }
    get signature() { return this._signature; }
    get publicUrl() { return this._publicUrl; }
    get privateUrl() { return this._privateUrl; } // gets used for signed upload and download
    static createFileDataHash(fileData) {
        (0, n_defensive_1.given)(fileData, "fileData").ensureHasValue().ensureIsObject().ensureIsType(Buffer);
        return Crypto.createHash("md5").update(fileData).digest("base64");
    }
    updatePublicUrl(url) {
        (0, n_defensive_1.given)(url, "url").ensureHasValue().ensureIsString();
        return new StoredFile({
            id: this.id,
            name: this._name,
            ext: this._ext,
            size: this._size,
            mime: this._mime,
            hash: this._hash,
            signature: this._signature,
            publicUrl: url,
            privateUrl: this._privateUrl
        });
    }
    updatePrivateUrl(url) {
        (0, n_defensive_1.given)(url, "url").ensureHasValue().ensureIsString();
        return new StoredFile({
            id: this.id,
            name: this._name,
            ext: this._ext,
            size: this._size,
            mime: this._mime,
            hash: this._hash,
            signature: this._signature,
            publicUrl: this._publicUrl,
            privateUrl: url
        });
    }
}
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", String),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "name", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", String),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "ext", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", Number),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "size", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", String),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "mime", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", String),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "hash", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", String),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "signature", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", Object),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "publicUrl", null);
tslib_1.__decorate([
    n_util_1.serialize,
    tslib_1.__metadata("design:type", Object),
    tslib_1.__metadata("design:paramtypes", [])
], StoredFile.prototype, "privateUrl", null);
exports.StoredFile = StoredFile;
//# sourceMappingURL=stored-file.js.map