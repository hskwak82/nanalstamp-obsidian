import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBlob, decryptBlob, isEncrypted, ENC_MAGIC } from "./cryptocore";

const DEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const DEK2 = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
const HASH = "a".repeat(64);
const data = new TextEncoder().encode("hello sealed note");

test("convergent: 같은 (DEK, 해시, 평문) = 같은 암호문", async () => {
  const a = await encryptBlob(DEK, HASH, "blob", data);
  const b = await encryptBlob(DEK, HASH, "blob", data);
  assert.deepEqual(a, b);
  assert.ok(isEncrypted(a));
  assert.deepEqual(Array.from(a.slice(0, 4)), Array.from(ENC_MAGIC));
});

test("도메인 분리: blob과 manifest는 다른 암호문", async () => {
  const a = await encryptBlob(DEK, HASH, "blob", data);
  const b = await encryptBlob(DEK, HASH, "manifest", data);
  assert.notDeepEqual(a, b);
});

test("라운드트립 + 다른 DEK는 복호 실패", async () => {
  const ct = await encryptBlob(DEK, HASH, "blob", data);
  assert.deepEqual(await decryptBlob(DEK, HASH, "blob", ct), data);
  await assert.rejects(() => decryptBlob(DEK2, HASH, "blob", ct));
});

test("평문 판별: 일반 텍스트·짧은 입력은 not encrypted", () => {
  assert.equal(isEncrypted(new TextEncoder().encode("# plain markdown")), false);
  assert.equal(isEncrypted(new Uint8Array([0x4e, 0x53, 0x45, 0x31])), false); // 매직만 있고 본문 없음
});

test("DEK 길이 가드: 32B가 아니면 reject", async () => {
  const shortDek = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");
  await assert.rejects(() => encryptBlob(shortDek, HASH, "blob", data), /32 bytes/);
});

test("경계: 빈 평문도 NSE1 프레임(매직4+태그16=20B)으로 라운드트립된다", async () => {
  const empty = new Uint8Array(0);
  const ct = await encryptBlob(DEK, HASH, "blob", empty);
  assert.equal(ct.length, 4 + 16);
  assert.ok(isEncrypted(ct));
  assert.deepEqual(await decryptBlob(DEK, HASH, "blob", ct), empty);
});
