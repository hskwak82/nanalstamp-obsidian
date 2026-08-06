// archivemsg 순수 조립·파싱 로직 테스트 — 실행: npm test (esbuild 번들 → node --test)
import { test } from "node:test";
import assert from "node:assert";
import { buildArchiveMsg, parseArchiveMsg, archiveNotePath } from "./archivemsg";

test("buildArchiveMsg: 확정(block 있음)", () => {
  assert.equal(buildArchiveMsg("연구노트/a.md", 1075, 957952),
    "nanalStamp: 연구노트/a.md · seq 1075 · ₿#957952");
});
test("buildArchiveMsg: 봉인 시점(block 없음) → ₿# 없음", () => {
  assert.equal(buildArchiveMsg("연구노트/a.md", 1075, undefined),
    "nanalStamp: 연구노트/a.md · seq 1075");
});
test("parseArchiveMsg: 확정 커밋", () => {
  assert.deepEqual(parseArchiveMsg("nanalStamp: x · seq 1075 · ₿#957952"),
    { seq: "1075", block: "957952" });
});
test("parseArchiveMsg: 봉인(미확정) 커밋 → block null", () => {
  assert.deepEqual(parseArchiveMsg("nanalStamp: x · seq 1075"),
    { seq: "1075", block: null });
});
test("parseArchiveMsg: 형식 아님 → null", () => {
  assert.equal(parseArchiveMsg("random commit"), null);
});
test("parseArchiveMsg: nanalStamp 접두 없으면 → null(우리 커밋만 파싱)", () => {
  assert.equal(parseArchiveMsg("other: x · seq 5"), null);
});
test("parseArchiveMsg: 경로에 `· seq`가 들어가도 마지막(진짜) seq 채택", () => {
  assert.deepEqual(parseArchiveMsg("nanalStamp: notes/a · seq b.md · seq 42 · ₿#100"),
    { seq: "42", block: "100" });
});
test("buildArchiveMsg: block 0 도 확정으로 취급(₿#0 포함)", () => {
  assert.equal(buildArchiveMsg("a.md", 5, 0), "nanalStamp: a.md · seq 5 · ₿#0");
});
test("parseArchiveMsg: block 0 → \"0\"(null 아님)", () => {
  assert.deepEqual(parseArchiveMsg("nanalStamp: a.md · seq 5 · ₿#0"),
    { seq: "5", block: "0" });
});

test("archiveNotePath: 봉인 시점 커밋에서 경로", () => {
  assert.equal(archiveNotePath("nanalStamp: 연구노트/a.md · seq 1075"), "연구노트/a.md");
});
test("archiveNotePath: 확정 커밋(₿# 포함)에서도 경로", () => {
  assert.equal(archiveNotePath("nanalStamp: 연구노트/a.md · seq 1075 · ₿#957952"), "연구노트/a.md");
});
test("archiveNotePath: 경로에 '· seq' 가 들어가도 마지막이 구분자", () => {
  assert.equal(archiveNotePath("nanalStamp: 노트/x · seq 9 메모.md · seq 12"), "노트/x · seq 9 메모.md");
});
test("archiveNotePath: 첨부 경로(확장자 유지)", () => {
  assert.equal(archiveNotePath("nanalStamp: Attachments/그림.png · seq 3"), "Attachments/그림.png");
});
test("archiveNotePath: 우리 커밋이 아니면 null", () => {
  assert.equal(archiveNotePath("Initial commit"), null);
  assert.equal(archiveNotePath("nanalStamp: 경로만 있고 seq 없음"), null);
});
