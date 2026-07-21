// sealscope 순수 판정 로직 테스트 — 실행: npm test (esbuild 번들 → node --test)
import { test } from "node:test";
import assert from "node:assert";
import { isSealableFile, isOverSizeLimit, isMarkdownPath } from "./sealscope";

test("isSealableFile: .md는 첨부 설정·참조 여부와 무관하게 항상 대상", () => {
  assert.strictEqual(isSealableFile("md", true, true), true);
  assert.strictEqual(isSealableFile("md", true, false), true);
  assert.strictEqual(isSealableFile("md", false, false), true);
  assert.strictEqual(isSealableFile("MD", false, false), true); // 대소문자 무관
});

test("isSealableFile: 첨부 켜짐 + 노트가 참조하면 형식 무관 대상(확장자 필터 없음)", () => {
  assert.strictEqual(isSealableFile("png", true, true), true);
  assert.strictEqual(isSealableFile("pdf", true, true), true);
  assert.strictEqual(isSealableFile("exe", true, true), true); // 화이트리스트 밖이던 형식도 참조되면 봉인
  assert.strictEqual(isSealableFile("zip", true, true), true);
  assert.strictEqual(isSealableFile("", true, true), true); // 확장자 없는 파일도 참조되면 봉인
});

test("isSealableFile: 참조되지 않은 첨부는 첨부 켜져 있어도 제외(원장 노이즈 방지)", () => {
  assert.strictEqual(isSealableFile("png", true, false), false);
  assert.strictEqual(isSealableFile("csv", true, false), false);
  assert.strictEqual(isSealableFile("", true, false), false);
});

test("isSealableFile: 첨부 꺼짐이면 참조돼도 .md 외 전부 제외", () => {
  assert.strictEqual(isSealableFile("png", false, true), false);
  assert.strictEqual(isSealableFile("pdf", false, true), false);
  assert.strictEqual(isSealableFile("csv", false, false), false);
});

test("isOverSizeLimit: 상한(MiB) 초과만 true, 경계는 포함(스킵 안 함)", () => {
  const mb = 1024 * 1024;
  assert.strictEqual(isOverSizeLimit(25 * mb, 25), false); // 정확히 상한 = 통과
  assert.strictEqual(isOverSizeLimit(25 * mb + 1, 25), true); // 1바이트 초과 = 스킵
  assert.strictEqual(isOverSizeLimit(0, 25), false);
});

test("isOverSizeLimit: 상한 0 또는 음수는 무제한(항상 통과)", () => {
  assert.strictEqual(isOverSizeLimit(999 * 1024 * 1024, 0), false);
  assert.strictEqual(isOverSizeLimit(999 * 1024 * 1024, -1), false);
});

test("isMarkdownPath: .md만 true(대소문자 무관), 첨부·확장자 없음은 false", () => {
  assert.strictEqual(isMarkdownPath("notes/a.md"), true);
  assert.strictEqual(isMarkdownPath("A.MD"), true);
  assert.strictEqual(isMarkdownPath("assets/img.png"), false);
  assert.strictEqual(isMarkdownPath("data.csv"), false);
  assert.strictEqual(isMarkdownPath("board.canvas"), false);
  assert.strictEqual(isMarkdownPath("README"), false);
});
