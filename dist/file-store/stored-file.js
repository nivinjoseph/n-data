import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { DomainEntity } from "@nivinjoseph/n-domain";
import { serialize } from "@nivinjoseph/n-util";
import { createHash } from "node:crypto";
let StoredFile = (() => {
    let _classDecorators = [serialize];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = DomainEntity;
    let _instanceExtraInitializers = [];
    let _get_name_decorators;
    let _get_ext_decorators;
    let _get_size_decorators;
    let _get_mime_decorators;
    let _get_hash_decorators;
    let _get_signature_decorators;
    let _get_publicUrl_decorators;
    let _get_privateUrl_decorators;
    var StoredFile = _classThis = class extends _classSuper {
        get name() { return this._name; }
        get ext() { return this._ext; }
        get size() { return this._size; }
        get mime() { return this._mime; }
        get hash() { return this._hash; }
        get signature() { return this._signature; }
        get publicUrl() { return this._publicUrl; }
        get privateUrl() { return this._privateUrl; } // gets used for signed upload and download
        constructor(data) {
            super(data);
            this._name = (__runInitializers(this, _instanceExtraInitializers), void 0);
            const { name, ext, size, mime, hash, signature, publicUrl, privateUrl } = data;
            given(name, "fileName").ensureHasValue().ensureIsString();
            this._name = name;
            given(ext, "fileExt").ensureHasValue().ensureIsString();
            this._ext = ext;
            given(size, "fileSize").ensureHasValue().ensureIsNumber().ensure(t => t >= 0);
            this._size = size;
            given(mime, "mimeType").ensureHasValue().ensureIsString();
            this._mime = mime;
            given(hash, "fileHash").ensureHasValue().ensureIsString();
            this._hash = hash;
            given(signature, "signature").ensureHasValue().ensureIsString();
            this._signature = signature;
            given(publicUrl, "publicUrl").ensureIsString();
            this._publicUrl = publicUrl || null;
            given(privateUrl, "privateUrl").ensureIsString();
            this._privateUrl = privateUrl || null;
        }
        static createFileDataHash(fileData) {
            given(fileData, "fileData").ensureHasValue().ensureIsObject().ensureIsType(Buffer);
            return createHash("md5").update(fileData).digest("base64");
        }
        updatePublicUrl(url) {
            given(url, "url").ensureHasValue().ensureIsString();
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
            given(url, "url").ensureHasValue().ensureIsString();
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
    };
    __setFunctionName(_classThis, "StoredFile");
    (() => {
        var _a;
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create((_a = _classSuper[Symbol.metadata]) !== null && _a !== void 0 ? _a : null) : void 0;
        _get_name_decorators = [serialize];
        _get_ext_decorators = [serialize];
        _get_size_decorators = [serialize];
        _get_mime_decorators = [serialize];
        _get_hash_decorators = [serialize];
        _get_signature_decorators = [serialize];
        _get_publicUrl_decorators = [serialize];
        _get_privateUrl_decorators = [serialize];
        __esDecorate(_classThis, null, _get_name_decorators, { kind: "getter", name: "name", static: false, private: false, access: { has: obj => "name" in obj, get: obj => obj.name }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_ext_decorators, { kind: "getter", name: "ext", static: false, private: false, access: { has: obj => "ext" in obj, get: obj => obj.ext }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_size_decorators, { kind: "getter", name: "size", static: false, private: false, access: { has: obj => "size" in obj, get: obj => obj.size }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_mime_decorators, { kind: "getter", name: "mime", static: false, private: false, access: { has: obj => "mime" in obj, get: obj => obj.mime }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_hash_decorators, { kind: "getter", name: "hash", static: false, private: false, access: { has: obj => "hash" in obj, get: obj => obj.hash }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_signature_decorators, { kind: "getter", name: "signature", static: false, private: false, access: { has: obj => "signature" in obj, get: obj => obj.signature }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_publicUrl_decorators, { kind: "getter", name: "publicUrl", static: false, private: false, access: { has: obj => "publicUrl" in obj, get: obj => obj.publicUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(_classThis, null, _get_privateUrl_decorators, { kind: "getter", name: "privateUrl", static: false, private: false, access: { has: obj => "privateUrl" in obj, get: obj => obj.privateUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        StoredFile = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return StoredFile = _classThis;
})();
export { StoredFile };
//# sourceMappingURL=stored-file.js.map