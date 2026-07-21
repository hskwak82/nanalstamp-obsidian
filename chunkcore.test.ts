import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cdcChunks, buildManifest, parseManifest,
  CHUNK_MIN, CHUNK_MAX, CHUNK_THRESHOLD,
} from "./chunkcore";

/** 결정적 의사난수 데이터(xorshift32) — 테스트 재현성 보장. */
function pseudoData(len: number, seed = 42): Uint8Array {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

test("cdcChunks: 결정성 — 같은 입력은 같은 조각", () => {
  const data = pseudoData(8 * 1024 * 1024);
  const a = cdcChunks(data);
  const b = cdcChunks(data);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.deepEqual(a[i], b[i]);
});

test("cdcChunks: 조각 크기 min/max 준수, 이어붙이면 원본", () => {
  const data = pseudoData(8 * 1024 * 1024);
  const parts = cdcChunks(data);
  assert.ok(parts.length >= 2);
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    total += parts[i].byteLength;
    assert.ok(parts[i].byteLength <= CHUNK_MAX);
    if (i < parts.length - 1) assert.ok(parts[i].byteLength >= CHUNK_MIN); // 마지막 조각만 min 미만 허용
  }
  assert.equal(total, data.byteLength);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { joined.set(p, off); off += p.byteLength; }
  assert.deepEqual(joined, data);
});

test("cdcChunks: 중간 삽입 후에도 뒤 조각들이 재사용됨(경계 재동기화)", () => {
  // 시그니처는 조각 전체 해시여야 한다 — prefix 비교는 내용이 바뀐 조각을 공유로 오판한다
  const sig = (p: Uint8Array) => createHash("sha256").update(p).digest("hex");
  const data = pseudoData(8 * 1024 * 1024);
  const before = cdcChunks(data).map(sig);
  // 1MB 지점에 100바이트 삽입
  const edited = new Uint8Array(data.byteLength + 100);
  edited.set(data.subarray(0, 1024 * 1024), 0);
  edited.set(pseudoData(100, 7), 1024 * 1024);
  edited.set(data.subarray(1024 * 1024), 1024 * 1024 + 100);
  const after = cdcChunks(edited).map(sig);
  const shared = after.filter((s) => before.includes(s)).length;
  // 삽입 지점을 포함한 조각(들)만 바뀌고 나머지는 재사용돼야 슬리밍이 성립한다
  assert.ok(shared >= Math.floor(before.length / 2),
    `공유 조각 ${shared}/${before.length} — 절반 미만이면 CDC 재동기화 실패`);
  assert.ok(shared < after.length,
    `공유 ${shared}/${after.length} — 삽입된 조각까지 공유로 집계되면 시그니처가 잘못된 것`);
});

test("cdcChunks: 작은 입력은 통짜 1조각", () => {
  const small = pseudoData(1000);
  const parts = cdcChunks(small);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].byteLength, 1000);
});

test("manifest: 직렬화·파싱 라운드트립 + 불량 입력 거부", () => {
  const chunks = [
    { hash: "a".repeat(64), size: 1048576 },
    { hash: "b".repeat(64), size: 524288 },
  ];
  const raw = buildManifest(chunks, 1572864);
  const m = parseManifest(raw);
  assert.ok(m);
  assert.equal(m!.totalSize, 1572864);
  assert.deepEqual(m!.chunks, chunks);
  assert.equal(parseManifest("not json"), null);
  assert.equal(parseManifest(JSON.stringify({ version: 9, chunks: [] })), null);
  assert.equal(parseManifest(JSON.stringify({ version: 1, total_size: 1, chunks: [{ hash: "zz", size: 1 }] })), null);
  assert.equal(parseManifest(JSON.stringify({ version: 1, total_size: 1, chunks: [{ hash: "a".repeat(64), size: 0 }] })), null);
  assert.equal(parseManifest(JSON.stringify({ version: 1, total_size: 1.5, chunks: [{ hash: "a".repeat(64), size: 1 }] })), null);
});

test("manifest v2(enc): chash·csize 왕복 + v1 하위호환", () => {
  const v2 = buildManifest(
    [{ hash: "a".repeat(64), size: 10, chash: "b".repeat(64), csize: 30 }], 10, true);
  const p = parseManifest(v2)!;
  assert.equal(p.enc, true);
  assert.equal(p.chunks[0].chash, "b".repeat(64));
  assert.equal(p.chunks[0].csize, 30);
  // v1(평문) manifest — enc 필드 없음 → enc=false, chash 없음
  const v1 = buildManifest([{ hash: "a".repeat(64), size: 10 }], 10);
  const p1 = parseManifest(v1)!;
  assert.equal(p1.enc, false);
  assert.equal(p1.chunks[0].chash, undefined);
});

test("manifest v1 골든 바이트 — HEAD dedup이 의존하는 직렬화 고정", () => {
  assert.equal(
    buildManifest([{ hash: "a".repeat(64), size: 10 }], 10),
    `{"version":1,"total_size":10,"chunks":[{"hash":"${"a".repeat(64)}","size":10}]}`);
  // enc=false면 호출자가 chash/csize를 넣어도 직렬화에 섞이지 않는다(필드 투영)
  assert.equal(
    buildManifest([{ hash: "a".repeat(64), size: 10, chash: "b".repeat(64), csize: 30 }], 10),
    `{"version":1,"total_size":10,"chunks":[{"hash":"${"a".repeat(64)}","size":10}]}`);
});

test("manifest v2 부정 경로 — 비hex chash·csize 불량·enc=1 chash 누락은 null", () => {
  const h = "a".repeat(64);
  const c = "b".repeat(64);
  // 비hex chash
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, enc: 1, chunks: [{ hash: h, size: 10, chash: "z".repeat(64), csize: 30 }] })), null);
  // csize 0 / 1.5
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, enc: 1, chunks: [{ hash: h, size: 10, chash: c, csize: 0 }] })), null);
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, enc: 1, chunks: [{ hash: h, size: 10, chash: c, csize: 1.5 }] })), null);
  // enc=1인데 chash/csize 누락 → 교차 불변식 위반
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, enc: 1, chunks: [{ hash: h, size: 10 }] })), null);
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, enc: 1, chunks: [{ hash: h, size: 10, chash: c }] })), null);
  // enc 없음(v1)인데 청크에 chash가 있으면 — 있으면 형식은 검증된다(불량 chash는 null)
  assert.equal(parseManifest(JSON.stringify(
    { version: 1, total_size: 10, chunks: [{ hash: h, size: 10, chash: "zz", csize: 30 }] })), null);
});

test("상수: 임계값·경계 관계", () => {
  assert.equal(CHUNK_THRESHOLD, 512 * 1024);
  assert.ok(CHUNK_MIN >= 128 * 1024); // Glacier 전환 임계(128KB) 상회
  assert.ok(CHUNK_MIN < CHUNK_MAX);
});
