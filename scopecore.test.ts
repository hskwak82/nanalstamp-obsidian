// 봉인 범위 스냅샷 문서 테스트 — 실행: npm test
import { test } from "node:test";
import assert from "node:assert";
import { normFolders, scopeBody, scopeDocument, scopeChanged, SCOPE_ZERO } from "./scopecore";

const base = {
  vault: "연구", include: "A\nB", exclude: "", teamRoot: null,
  wholeVault: false, sealAttachments: true, autoBackfill: true, sealSince: 0, plugin: "0.1.0",
};

test("normFolders: 공백·끝슬래시·중복을 없애고 정렬한다", () => {
  assert.deepStrictEqual(normFolders(" B/ , A ,\nB\n"), ["A", "B"]);
  assert.deepStrictEqual(normFolders(""), []);
  assert.deepStrictEqual(normFolders(undefined), []);
  assert.deepStrictEqual(normFolders("연구노트/실험//"), ["연구노트/실험"]);
});

test("적는 순서만 다르면 같은 범위다 — 이력에 노이즈를 만들지 않는다", () => {
  assert.strictEqual(scopeBody({ ...base, include: "A\nB" }), scopeBody({ ...base, include: "B, A" }));
});

test("범위가 실제로 달라지면 본문도 달라진다", () => {
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, include: "A" }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, exclude: "C" }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, teamRoot: "나날랩스" }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, sealAttachments: false }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, autoBackfill: false }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, wholeVault: true }));
  assert.notStrictEqual(scopeBody(base), scopeBody({ ...base, vault: "다른vault" }));
});

test("봉인 시작 시점이 문서에 남는다 — 감사에서 '그 전 것은 왜 없냐'에 답한다", () => {
  const a = scopeBody({ ...base, sealSince: 0 });
  const b = scopeBody({ ...base, sealSince: 1785000000000 });
  assert.notStrictEqual(a, b);
  assert.ok(a.includes('"봉인_시작_시점": null'));      // 소급 켬 = 제한 없음
  assert.ok(b.includes("2026-"));                       // 시작 시점이 사람이 읽는 형태로
});

test("본문은 사람이 읽을 수 있어야 한다 — 감사관이 열어 보는 증거다", () => {
  const b = scopeBody({ ...base, include: "연구노트" });
  assert.ok(b.includes("포함_폴더"));
  assert.ok(b.includes("연구노트"));
  assert.ok(b.includes("nanalStamp"));   // 이 문서가 무엇인지 스스로 밝힌다
});

test("문서는 직전 문서 해시를 품는다 — A→B→A 되돌림이 사라지지 않게", () => {
  const body = scopeBody(base);
  const d1 = scopeDocument(body, SCOPE_ZERO, "h0");
  const d2 = scopeDocument(body, "aaaa", "h0");
  assert.notStrictEqual(d1, d2);            // 같은 범위라도 이어진 자리가 다르면 다른 문서
  assert.ok(d1.includes(SCOPE_ZERO));
  assert.ok(JSON.parse(d1)["본문"]["포함_폴더"].length === 2);
});

test("prev 를 안 주면 첫 문서로 본다", () => {
  assert.ok(scopeDocument(scopeBody(base), "", "h").includes(SCOPE_ZERO));
});

test("scopeChanged: 서버가 본문 해시를 모르면 바뀐 것으로 본다", () => {
  assert.strictEqual(scopeChanged("h1", "h1"), false);
  assert.strictEqual(scopeChanged("h1", "h2"), true);
  assert.strictEqual(scopeChanged(null, "h1"), true);      // 옛 기록 — 한 번 더 남는 편이 낫다
  assert.strictEqual(scopeChanged(undefined, "h1"), true);
});
