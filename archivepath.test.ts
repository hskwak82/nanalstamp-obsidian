// 아카이브 기본 경로 — vault 별로 갈라야 한다. 실행: npm test
import { test } from "node:test";
import assert from "node:assert";
import { archiveDirNameForVault } from "./archivepath";

// 기본값이 기기당 하나(~/nanalStamp-archive)면, 한 기기에서 vault 를 둘 쓰는 사람은
// 손대지 않는 한 두 vault 가 같은 repo 를 쓴다. 원문이 섞이지는 않았지만(경로 충돌 0건)
// 다른 vault 의 폴더·파일명이 대시보드에 그대로 보인다 — 기밀 제품에서 그 자체로 문제다.
test("archiveDirNameForVault: vault 이름이 폴더명에 들어간다", () => {
  assert.equal(archiveDirNameForVault("연구노트"), "nanalStamp-archive-연구노트");
  assert.equal(archiveDirNameForVault("nanalT3"), "nanalStamp-archive-nanalT3");
});

// 경로 구분자·상위 이동이 vault 이름으로 들어오면 아카이브가 엉뚱한 곳에 생긴다.
test("archiveDirNameForVault: 경로 문자는 지운다", () => {
  assert.equal(archiveDirNameForVault("a/b"), "nanalStamp-archive-a-b");
  assert.equal(archiveDirNameForVault("../etc"), "nanalStamp-archive-etc");
  assert.equal(archiveDirNameForVault("a\\b"), "nanalStamp-archive-a-b");
  assert.equal(archiveDirNameForVault(":*?\"<>|"), "nanalStamp-archive");
});

// 이름을 못 얻으면(빈 문자열) 옛 기본값 그대로 — 새 폴더를 만들지 않는다.
test("archiveDirNameForVault: 이름이 없으면 옛 기본값", () => {
  assert.equal(archiveDirNameForVault(""), "nanalStamp-archive");
  assert.equal(archiveDirNameForVault("   "), "nanalStamp-archive");
});

// 아주 긴 이름은 파일시스템 상한에 걸린다 — 잘라 쓴다.
test("archiveDirNameForVault: 긴 이름은 자른다", () => {
  const long = "가".repeat(200);
  const got = archiveDirNameForVault(long);
  assert.ok(got.length <= 80, `너무 길다: ${got.length}`);
  assert.ok(got.startsWith("nanalStamp-archive-"));
});
