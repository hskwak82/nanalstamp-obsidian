import { test } from "node:test";
import assert from "node:assert";
import { verNewer } from "./fmtutil";

test("verNewer: 숫자 비교 — 1.5.10 은 1.5.9 보다 새 버전(문자열 비교면 틀린다)", () => {
  assert.equal(verNewer("1.5.10", "1.5.9"), true);
  assert.equal(verNewer("1.5.9", "1.5.10"), false);
  assert.equal(verNewer("1.5.5", "1.5.5"), false);
  assert.equal(verNewer("2.0.0", "1.9.9"), true);
});

test("verNewer: v 접두·자릿수 차이 허용", () => {
  assert.equal(verNewer("v1.5.6", "1.5.5"), true);
  assert.equal(verNewer("1.6", "1.5.5"), true);
  assert.equal(verNewer("1.5", "1.5.0"), false);
  assert.equal(verNewer("", "1.5.5"), false);
});
