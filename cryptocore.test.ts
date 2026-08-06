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

// "name" 도메인 — 노트명(경로) 암호화. plainHash 자리는 path_hash(경로해시):
// path_hash가 경로를 유일 결정하므로 같은 (키,nonce)에 다른 평문이 들어갈 수 없다(수렴 계약의 경로판).
test("name 도메인: 라운드트립 + blob과 분리", async () => {
  const pathHash = "c".repeat(64);
  const name = new TextEncoder().encode("10-Records/2026-07-15-01.md");
  const enc = await encryptBlob(DEK, pathHash, "name", name);
  assert.ok(isEncrypted(enc));
  const dec = await decryptBlob(DEK, pathHash, "name", enc);
  assert.equal(new TextDecoder().decode(dec), "10-Records/2026-07-15-01.md");
  // 같은 입력의 blob 도메인 암호문과 달라야 한다(도메인 분리)
  const encBlob = await encryptBlob(DEK, pathHash, "blob", name);
  assert.notDeepEqual(enc, encBlob);
});

test("name 도메인: 다른 path_hash 키로는 복호 실패", async () => {
  const enc = await encryptBlob(DEK, "c".repeat(64), "name", new TextEncoder().encode("a.md"));
  await assert.rejects(() => decryptBlob(DEK, "d".repeat(64), "name", enc));
  await assert.rejects(() => decryptBlob(DEK2, "c".repeat(64), "name", enc));
});

// "vault" 도메인 — vault 이름 암호화. plainHash 자리는 vault 이름 자체의 해시(경로해시와 동일 원리):
// vault_hash가 이름을 유일 결정하므로 같은 (키,nonce)에 다른 평문이 들어갈 수 없다.
test("vault 도메인: 라운드트립 + name 도메인과 분리", async () => {
  const vaultHash = "e".repeat(64);
  const name = new TextEncoder().encode("nanalStampTest");
  const enc = await encryptBlob(DEK, vaultHash, "vault", name);
  const dec = await decryptBlob(DEK, vaultHash, "vault", enc);
  assert.equal(new TextDecoder().decode(dec), "nanalStampTest");
  const encName = await encryptBlob(DEK, vaultHash, "name", name);
  assert.notDeepEqual(enc, encName); // 도메인 분리(결정적 파생이라 바이트 비교가 유효)
  await assert.rejects(() => decryptBlob(DEK, "f".repeat(64), "vault", enc));
});
