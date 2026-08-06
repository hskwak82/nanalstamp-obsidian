import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistoryResponse, parseNotesResponse, parseVaultsResponse, rowDisplay } from "./notebrowsercore";

const H = (c: string) => c.repeat(64);

test("parseNotesResponse: 정상 행 파싱 + 불량 행 스킵", () => {
  const j = {
    rows: [
      { path_hash: H("a"), enc_name: "bkE=", seq: 5, received_at: 1753142400, file_hash: H("1"), block: 900000 },
      { path_hash: H("b"), enc_name: null, seq: 3, received_at: 1753142000, file_hash: H("2"), block: null },
      { path_hash: "short", enc_name: null, seq: 1, received_at: 1, file_hash: H("3"), block: null }, // 불량: path_hash
      { path_hash: H("c"), enc_name: null, seq: "x", received_at: 1, file_hash: H("4"), block: null }, // 불량: seq 타입
    ],
    has_more: true,
  };
  const r = parseNotesResponse(j);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].pathHash, H("a"));
  assert.equal(r.rows[0].encName, "bkE=");
  assert.equal(r.rows[0].block, 900000);
  assert.equal(r.rows[1].encName, null);
  assert.equal(r.rows[1].block, null);
  assert.equal(r.hasMore, true);
});

test("parseNotesResponse: 비정상 응답은 빈 결과", () => {
  assert.deepEqual(parseNotesResponse(null), { rows: [], hasMore: false });
  assert.deepEqual(parseNotesResponse({ rows: "nope" }), { rows: [], hasMore: false });
});

test("rowDisplay: 이름 있음 — 폴더/파일 분리·md 판정·열람 가능", () => {
  const row = { pathHash: H("a"), encName: "x", seq: 1, receivedAt: 1, fileHash: H("1"), block: null };
  const d = rowDisplay(row, "10-Records/메모.md");
  assert.deepEqual(d, { folder: "10-Records", file: "메모.md", canOpen: true, isMd: true });
  const d2 = rowDisplay(row, "사진.png");
  assert.deepEqual(d2, { folder: "", file: "사진.png", canOpen: true, isMd: false });
});

test("rowDisplay: 이름 없음 — 해시 8자·열람 불가", () => {
  const row = { pathHash: H("a"), encName: null, seq: 1, receivedAt: 1, fileHash: H("1"), block: null };
  const d = rowDisplay(row, null);
  assert.equal(d.file, H("a").slice(0, 8));
  assert.equal(d.canOpen, false);
  assert.equal(rowDisplay(row, "").canOpen, false); // 빈 이름도 폴백(falsy 분기 의도 증명)
});

test("vault 필드 파싱 + vaults 응답", () => {
  const j = { rows: [ { path_hash: H("a"), enc_name: "bkE=", seq: 1, received_at: 1, file_hash: H("1"), block: null, vault_hash: H("e"), enc_vault: "dkE=" } ], has_more: false };
  const r = parseNotesResponse(j);
  assert.equal(r.rows[0].vaultHash, H("e"));
  assert.equal(r.rows[0].encVault, "dkE=");
  const vs = parseVaultsResponse({ vaults: [
    { vault_hash: H("e"), enc_vault: "dkE=" },
    { vault_hash: "bad", enc_vault: "x" },   // 스킵
    { vault_hash: H("f"), enc_vault: "" },   // 스킵
  ] });
  assert.deepEqual(vs, [{ vaultHash: H("e"), encVault: "dkE=" }]);
  assert.deepEqual(parseVaultsResponse(null), []);
});

test("history 응답 파싱 — 정상·불량 스킵·has_more", () => {
  const r = parseHistoryResponse({ rows: [
    { seq: 9, received_at: 1784688360, file_hash: H("1"), block: 900001 },
    { seq: 8, received_at: 1784688000, file_hash: H("2"), block: null },
    { seq: "x", received_at: 1, file_hash: H("3"), block: null }, // 불량
  ], has_more: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].block, 900001);
  assert.equal(r.rows[1].block, null);
  assert.equal(r.hasMore, true);
  assert.deepEqual(parseHistoryResponse(null), { rows: [], hasMore: false });
});
