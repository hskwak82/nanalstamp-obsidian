// sealscope 순수 판정 로직 테스트 — 실행: npm test (esbuild 번들 → node --test)
import { test } from "node:test";
import assert from "node:assert";
import { isSealableFile, isOverSizeLimit, isMarkdownPath, inSealScopePure, isRestoredCopy, RESTORED_PREFIXES, inFolderScopePure, scopeUnset, isKitSample, teamBlobScopePure, inTeamRootPure, apiKeyForPure } from "./sealscope";
import { restoredPath } from "./storagecore";

test("isRestoredCopy: 두 복원 접두(restored-vault/·restored/) 아래는 전부 복원 사본", () => {
  assert.strictEqual(isRestoredCopy("nanalStamp/restored-vault/2026-07-25/연구/a.md"), true);
  assert.strictEqual(isRestoredCopy("nanalStamp/restored/a.md"), true);
  assert.strictEqual(isRestoredCopy("nanalStamp/restored-vault/x.pdf"), true); // 첨부도 동일
});

test("isRestoredCopy: 접두가 아니면 false — 유사 이름·중간 등장·대소문자 차이 전부 제외", () => {
  assert.strictEqual(isRestoredCopy("나날랩스/연구노트/a.md"), false);
  assert.strictEqual(isRestoredCopy("nanalStamp/restoredX/a.md"), false);       // 폴더명 유사
  assert.strictEqual(isRestoredCopy("nanalStamp/restored-vault-old/a.md"), false);
  assert.strictEqual(isRestoredCopy("팀/nanalStamp/restored/a.md"), false);      // 중간 등장은 접두 아님
  assert.strictEqual(isRestoredCopy("NanalStamp/Restored/a.md"), false);        // 대소문자 구분(플러그인이 만드는 고정 이름)
  assert.strictEqual(isRestoredCopy("nanalStamp/restored-vault"), false);       // 폴더 자신은 파일이 아니다
  assert.strictEqual(isRestoredCopy(""), false);
});

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

// 크로스 모듈 계약(회귀 방어): 복원 사본을 **만드는** 쪽은 다른 모듈이다. 생성 접두가 판정 접두에서
// 벗어나면 만든 사본이 봉인 대상으로 되돌아와 재봉인·재구성 순환이 살아난다 — 그 조합은 어느 단위
// 테스트도 보지 않으므로 여기서 고정한다.
test("isRestoredCopy: 단건 복원 경로(storagecore.restoredPath) 산출물을 반드시 복원 사본으로 판정", () => {
  assert.strictEqual(isRestoredCopy(restoredPath("연구/실험 1", "abcdef1234567890", true)), true);
  assert.strictEqual(isRestoredCopy(restoredPath("첨부/그림.png", "abcdef1234567890", false)), true);
  assert.strictEqual(isRestoredCopy(restoredPath("확장자없음", "abcdef1234567890", false)), true);
});

test("isRestoredCopy: vault 재구성 루트 접두(RESTORED_PREFIXES[0] + 일시)도 동일 판정", () => {
  assert.strictEqual(isRestoredCopy(`${RESTORED_PREFIXES[0]}2026-07-25-15-23-28/나날랩스/a.md`), true);
});

test("inSealScopePure: 폴더 범위 안이면 통과(참조 여부 무관, 기존 동작)", () => {
  assert.strictEqual(inSealScopePure(false, false, true), true);
  assert.strictEqual(inSealScopePure(false, true, true), true);
});

test("inSealScopePure: 범위 내 노트가 참조하면 폴더 밖이어도 통과(Task 11 — 첨부 스코프 면제)", () => {
  assert.strictEqual(inSealScopePure(false, true, false), true);
});

test("inSealScopePure: 참조도 안 되고 폴더 밖이면 제외", () => {
  assert.strictEqual(inSealScopePure(false, false, false), false);
});

test("inSealScopePure: 복원 사본은 참조·폴더 범위와 무관하게 항상 제외(isRestored 우선)", () => {
  assert.strictEqual(inSealScopePure(true, true, true), false);
  assert.strictEqual(inSealScopePure(true, true, false), false);
  assert.strictEqual(inSealScopePure(true, false, true), false);
  assert.strictEqual(inSealScopePure(true, false, false), false);
});

// ── 폴더 범위: 팀 루트 ∪ 개인 폴더(2026-07-27) ──────────────────────────────
// 회귀 방지 대상: 팀 합류가 개인 봉인 폴더를 덮어쓰던 동작. 봉인은 소급되지 않으므로
// 이 판정이 틀리면 그 기간의 기록 공백은 되돌릴 수 없다.
test("inFolderScopePure: 팀 루트와 개인 폴더가 합집합으로 동작", () => {
  const inc = ["내연구"], exc: string[] = [];
  // 팀원이면서 개인 폴더도 쓰는 사람 — 둘 다 봉인된다
  assert.equal(inFolderScopePure("나날랩스/연구노트/a.md", "나날랩스", inc, exc), true, "팀 루트 아래");
  assert.equal(inFolderScopePure("내연구/b.md", "나날랩스", inc, exc), true, "개인 폴더 — 합류해도 유지");
  assert.equal(inFolderScopePure("잡동사니/c.md", "나날랩스", inc, exc), false, "둘 다 아님");
});

test("inFolderScopePure: 제외가 팀 루트보다 우선", () => {
  // 사용자가 명시적으로 뺀 폴더는 팀 루트 아래여도 제외한다
  assert.equal(inFolderScopePure("나날랩스/임시/x.md", "나날랩스", [], ["나날랩스/임시"]), false);
  assert.equal(inFolderScopePure("나날랩스/연구노트/x.md", "나날랩스", [], ["나날랩스/임시"]), true);
});

test("inFolderScopePure: 포함 폴더가 비었을 때의 의미는 팀 여부로 갈린다", () => {
  // 비팀 — 기존 기본값(vault 전체)
  assert.equal(inFolderScopePure("아무곳/a.md", null, [], []), false, "비팀 + 포함 비움 = **아무것도 아님**(2026-07-28 게이트)");
  assert.equal(inFolderScopePure("아무곳/a.md", null, [], [], true), true, "전체 봉인을 명시적으로 켰을 때만 전체");
  // 팀 — 팀 루트만. 합류했다고 vault 전체가 갑자기 대상이 되면 안 된다
  assert.equal(inFolderScopePure("아무곳/a.md", "나날랩스", [], []), false, "팀 + 포함 비움 = 팀 루트만");
  assert.equal(inFolderScopePure("나날랩스/a.md", "나날랩스", [], []), true);
});

test("inFolderScopePure: 폴더 경계는 세그먼트 단위", () => {
  // "나날랩스2"가 "나날랩스" 접두로 잘못 걸리면 안 된다
  assert.equal(inFolderScopePure("나날랩스2/a.md", "나날랩스", [], []), false);
  assert.equal(inFolderScopePure("나날랩스", "나날랩스", [], []), true, "폴더 자신");
});

// ── 킷 샘플 봉인 제외(2026-07-27) ──────────────────────────────────────────
// 샘플은 하지도 않은 실험·수업 기록이다. 봉인되면 append-only라 되돌릴 수 없다.
test("inSealScopePure: 샘플은 범위 안이어도 봉인하지 않는다", () => {
  // 범위 안 + 참조됨이어도 샘플이면 제외 — 샘플 노트가 샘플 이미지를 참조하는 경우가 실제로 있다
  assert.equal(inSealScopePure(false, true, true, true), false, "샘플이 참조로 새어 나갔다");
  assert.equal(inSealScopePure(false, false, true, true), false);
  // 팀이 "샘플도 봉인"을 켜면 호출자가 isKitSample=false 로 넘긴다 → 평소 규칙
  assert.equal(inSealScopePure(false, false, true, false), true);
  // 복원 사본 게이트는 그대로
  assert.equal(inSealScopePure(true, true, true, false), false);
  // 기본 인자 생략 시 기존 동작 유지(하위 호환)
  assert.equal(inSealScopePure(false, false, true), true);
});

test("isKitSample: 세그먼트 일치만 — 과잉 차단은 실제 기록을 봉인에서 뺀다", () => {
  assert.equal(isKitSample("나날랩스/과제1/_samples/20-Lessons/LS-1.md"), true);
  assert.equal(isKitSample("_samples/홈.md"), true);
  assert.equal(isKitSample("나날랩스/_samples2/a.md"), false);
  assert.equal(isKitSample("나날랩스/my_samples/a.md"), false);
  assert.equal(isKitSample("나날랩스/과제1/20-Lessons/LS-1.md"), false);
});

// 범위 게이트(2026-07-28) — 봉인은 되돌릴 수 없으므로 범위를 고르기 전에는 시작하지 않는다.
test("scopeUnset: 팀 루트·포함 폴더·전체 선택이 모두 없을 때만 참", () => {
  assert.equal(scopeUnset(null, [], false), true, "아무것도 안 고른 새 설치");
  assert.equal(scopeUnset(null, [], true), false, "vault 전체를 명시적으로 선택");
  assert.equal(scopeUnset(null, ["내연구"], false), false, "포함 폴더 있음");
  assert.equal(scopeUnset("나날랩스", [], false), false, "팀 루트가 범위를 준다");
});

test("inFolderScopePure: 게이트가 켜져도 팀 루트·포함 폴더는 그대로 동작", () => {
  assert.equal(inFolderScopePure("나날랩스/a.md", "나날랩스", [], [], false), true, "팀원은 설정 없이도 팀 루트가 범위");
  assert.equal(inFolderScopePure("내연구/a.md", null, ["내연구"], [], false), true, "고른 폴더는 전체 선택과 무관");
  assert.equal(inFolderScopePure("잡동사니/a.md", null, ["내연구"], [], true), false, "고른 폴더가 있으면 전체 플래그는 무시된다");
});

test("teamBlobScopePure: 팀 custody 라도 팀 루트 아래만 조직 저장소로", () => {
  const R = "나날랩스";
  // 팀 폴더 — 조직 저장소·팀 키
  assert.equal(teamBlobScopePure("나날랩스/과제/전극/a.md", R, true), true);
  assert.equal(teamBlobScopePure("나날랩스", R, true), true, "루트 자신");
  // ★ 개인 폴더 — 팀에 속해 있어도 **개인 저장소**로 가야 한다.
  //   이걸 true 로 돌려주면 팀 관리자가 팀원의 개인 노트를 대리 열람할 수 있고,
  //   WORM 이라 되돌릴 수도 없다(2026-07-31 실측 사고).
  assert.equal(teamBlobScopePure("개인메모/사적기록.md", R, true), false, "개인 폴더는 조직에 가지 않는다");
  assert.equal(teamBlobScopePure("나날랩스2/a.md", R, true), false, "폴더 경계는 세그먼트 단위");
  // 팀 custody 가 아니면 전부 개인
  assert.equal(teamBlobScopePure("나날랩스/과제/전극/a.md", R, false), false);
  // 팀 미소속
  assert.equal(teamBlobScopePure("아무개/a.md", null, true), false);
});

test("inTeamRootPure: 경계 판정", () => {
  assert.equal(inTeamRootPure("팀/a.md", "팀"), true);
  assert.equal(inTeamRootPure("팀중앙/a.md", "팀"), false);
  assert.equal(inTeamRootPure("a.md", null), false);
});

test("apiKeyForPure: 팀 키가 없으면 개인 키가 양쪽에 쓰인다", () => {
  // 같은 계정인 사람 — 설정하지 않아도 지금까지와 똑같아야 한다(대부분이 이 경우다).
  assert.equal(apiKeyForPure(true, "solo", ""), "solo");
  assert.equal(apiKeyForPure(false, "solo", ""), "solo");
  assert.equal(apiKeyForPure(true, "solo", "   "), "solo", "공백만 있으면 없는 것과 같다");
  // 계정을 나눠 쓰는 사람 — 팀 폴더만 회사 계정으로.
  assert.equal(apiKeyForPure(true, "solo", "team"), "team");
  assert.equal(apiKeyForPure(false, "solo", "team"), "solo", "개인 폴더는 절대 팀 계정으로 가지 않는다");
});
