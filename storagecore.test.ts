import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToBase64, blobExt, blobContentType, restoredPath, PROOF_EXT, bodyByteSize, fmtBytes, storageEndpoint } from "./storagecore";

test("hexToBase64: sha256 hex → digest 바이트의 base64", () => {
  // sha256("")의 알려진 값
  assert.equal(
    hexToBase64("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  assert.throws(() => hexToBase64("zz"));
  assert.throws(() => hexToBase64("e3b0")); // 길이 미달
});

test("blobExt: 경로 → 소문자 영숫자 확장자(1~12자), 규격 밖은 bin", () => {
  assert.equal(blobExt("a/b/note.md"), "md");
  assert.equal(blobExt("img.PNG"), "png");
  assert.equal(blobExt("d.excalidraw"), "excalidraw");
  assert.equal(blobExt("noext"), "bin");
  assert.equal(blobExt("weird.averyverylongext"), "bin"); // 12자 초과
});

test("PROOF_EXT는 서버 blob_key 규격(영숫자 12자 이내)", () => {
  assert.match(PROOF_EXT, /^[a-z0-9]{1,12}$/);
});

test("blobContentType: 대표 확장자 매핑 + 기본값", () => {
  assert.equal(blobContentType("n.md"), "text/markdown");
  assert.equal(blobContentType("i.png"), "image/png");
  assert.equal(blobContentType("i.jpeg"), "image/jpeg");
  assert.equal(blobContentType("d.pdf"), "application/pdf");
  assert.equal(blobContentType("d.excalidraw"), "application/json");
  assert.equal(blobContentType("x.unknownx"), "application/octet-stream");
});

test("restoredPath: 해시 앞 8자를 태그로, md/첨부 구분", () => {
  const h = "a1b2c3d4" + "0".repeat(56);
  assert.equal(restoredPath("folder__note", h, true), "nanalStamp/restored/folder__note.a1b2c3d4.md");
  assert.equal(restoredPath("img.png", h, false), "nanalStamp/restored/img.a1b2c3d4.png");
  assert.equal(restoredPath("noext", h, false), "nanalStamp/restored/noext.a1b2c3d4");
});

test("bodyByteSize: 문자열은 UTF-8 바이트, ArrayBuffer는 byteLength", () => {
  assert.equal(bodyByteSize("abc"), 3);
  assert.equal(bodyByteSize("한글"), 6); // UTF-8 3바이트 × 2
  assert.equal(bodyByteSize(new ArrayBuffer(10)), 10);
});

test("fmtBytes: 단위 표기", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(12_300_000), "11.7 MB");
  assert.equal(fmtBytes(10_737_418_240), "10.00 GB");
});

test("storageEndpoint: C2 팀 custody면 /storage/team/*, 아니면 /storage/*", () => {
  assert.equal(storageEndpoint("https://api.nanalstamp.com", false, "presign"), "https://api.nanalstamp.com/storage/presign");
  assert.equal(storageEndpoint("https://api.nanalstamp.com", true, "presign"), "https://api.nanalstamp.com/storage/team/presign");
  assert.equal(storageEndpoint("https://api.nanalstamp.com", true, "usage"), "https://api.nanalstamp.com/storage/team/usage");
});
