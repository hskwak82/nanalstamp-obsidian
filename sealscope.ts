// sealscope.ts — 봉인 대상 판정의 순수 로직(Obsidian/Node 비의존, node:test로 검증).
// main.ts가 TFile.extension / TFile.stat.size / 설정을 넘겨 판정만 위임한다.

// 봉인 대상 파일인가. .md는 항상 대상. 첨부는 확장자와 무관하게 "범위 내 노트가 참조하는가"로 판정한다
// (증명 제품에서 노트만 봉인되고 참조 첨부가 형식 때문에 빠지면 원본이 불완전 — 반대로 참조 없는 잡파일은
//  원장 노이즈라 제외). isReferenced 계산은 호출자(main.ts referencedAttachments) 책임.
export function isSealableFile(ext: string, sealAttachments: boolean, isReferenced: boolean): boolean {
  if ((ext || "").toLowerCase() === "md") return true;
  return sealAttachments && isReferenced;
}

// 복원 사본 폴더 접두 — 그날로(단건 복원)와 vault 일괄 재구성이 쓰는 두 위치. **판정** 쪽 정본이다
// (리터럴이 흩어져 있으면 한쪽만 고쳐도 신호가 없다). 생성 쪽은 별 모듈에 있다:
// storagecore.restoredPath(단건)·main.ts 재구성 rootDir. 그 둘이 여기서 벗어나면 만든 사본이
// 판정에서 빠져 재봉인 순환으로 돌아오므로, sealscope.test.ts가 두 접두의 일치를 고정한다.
export const RESTORED_PREFIXES = ["nanalStamp/restored-vault/", "nanalStamp/restored/"] as const;

// 복원 사본인가 — 재봉인은 무의미하고 재구성이 순환한다(2026-07-22 실증). inScope·inSealScope·
// 재구성 스킵이 모두 이 술어를 공유한다. 대소문자를 구분하는 것이 옳다: 이 폴더들은 사용자가
// 입력하는 이름이 아니라 플러그인이 만드는 고정 이름이고, 느슨하게 하면 사용자가 만든
// `Restored/` 연구 폴더를 조용히 봉인 대상에서 빼버릴 수 있다.
export function isRestoredCopy(path: string): boolean {
  return RESTORED_PREFIXES.some((pre) => path.startsWith(pre));
}

// 봉인 스코프 판정(첨부 스코프 면제 포함)의 순수 형태 — 호출자가 복원 사본 여부·참조 여부·폴더
// 범위 판정을 넘긴다(2026-07-25 Task 11). 범위 내 노트가 참조하는 첨부는 **폴더 위치와 무관하게**
// 통과시킨다 — 증명 제품에서 노트는 봉인되고 참조 원본이 빠지면 증빙이 불완전해진다(전역 첨부 폴더를
// 쓰는 팀원이 팀 루트 밖이라는 이유로 첨부를 통째로 잃는 문제). isRestored가 우선한다 — 복원 사본은
// 참조 여부·폴더 범위와 무관하게 항상 제외(재봉인 무의미 + 재구성 순환, 2026-07-22 실증). "참조됨"으로
// 이미 범위가 밑혀 있다는 점에 주의: isReferenced는 호출자(main.ts referencedAttachments)가 "범위 내
// .md가 참조하는 비-md"만 모아 계산하므로, 첨부 폴더의 무관한 잡파일까지 열리지 않는다.
export function inSealScopePure(
  isRestored: boolean, isReferenced: boolean, inFolderScope: boolean, isKitSample = false,
): boolean {
  // 킷 샘플은 복원 사본과 같은 자리에서 걸러진다(2026-07-27). **참조 여부보다 앞선다** —
  // 샘플 노트가 샘플 이미지를 참조하면 "참조됨"으로 통과해 버리는데, 둘 다 허구다.
  // 하지도 않은 실험 기록이 원장에 박히면 append-only라 되돌릴 수 없다.
  if (isRestored || isKitSample) return false;
  return isReferenced || inFolderScope;
}

/// vault 경로가 킷 샘플인가 — `_samples/` 세그먼트. 서버 `is_sample`·taskcore `isKitSamplePath`와
/// **같은 규칙**이어야 한다. 셋이 갈리면 한쪽이 샘플이라 부른 파일을 다른 쪽이 봉인한다.
export function isKitSample(path: string): boolean {
  return path.split("/").some((seg) => seg === "_samples");
}

// 경로가 마크다운 노트(.md)인가. beaconDirty처럼 TFile 없이 경로 문자열만 있을 때 쓴다.
// 첨부는 바이트 해시가 필요해 텍스트 경로(utf8)로 처리하면 해시가 손상되므로 .md만 걸러낸다.
export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

// 크기 상한 초과 여부(상한은 MiB). 0 이하 = 무제한(항상 통과). 경계값은 통과(초과만 스킵).
export function isOverSizeLimit(sizeBytes: number, maxMB: number): boolean {
  if (!(maxMB > 0)) return false;
  return sizeBytes > maxMB * 1024 * 1024;
}

// 폴더 범위 판정(2026-07-27) — 팀 루트와 개인 포함 폴더의 **합집합**.
//
// 왜 합집합인가: 개인으로 쓰다가 팀에 합류하는 순서가 정상이다. 그때 봉인 폴더가 늘어나야지
// 사라지면 안 된다 — 합류 이후 개인 노트가 조용히 대상에서 빠지면 그 기간의 기록에 공백이
// 생기고, **봉인은 소급되지 않으므로 되돌릴 수 없다**. 예전에는 팀 루트가 있으면 거기서
// 조기 반환해 개인 설정을 통째로 덮었다.
//
// 판정 순서:
//  1) 제외 폴더가 최우선 — 사용자가 명시적으로 뺀 것이라 팀 루트보다 강하다
//  2) 팀 루트 아래면 포함(참여 과제도 루트 아래라 별도 처리 불필요)
//  3) 개인 포함 폴더 아래면 포함
//  4) 개인 포함 폴더가 **비었을 때**: 팀 루트가 있으면 팀 루트만.
//     팀 루트도 없으면 — `wholeVault`가 켜졌을 때만 전체다. **기본은 아무것도 봉인하지 않는다.**
//
// 왜 기본이 "아무것도 아님"인가(2026-07-28 사용자 결정): 예전 기본값은 "포함 폴더가 비면 vault 전체"
// 였다. 그래서 개인 vault에 플러그인을 깔고 **로그인만 해도** 범위를 정하기 전에 일기·업무 메모가
// 봉인됐다(실측: 로그인 직후 seq 0 자동 생성). 봉인은 원장에 남고 **되돌릴 수 없다** — 되돌릴 수 없는
// 일이 사용자가 범위를 고르기도 전에 벌어지면 안 된다. 전체 봉인을 원하는 사용자는 시작 모달·설정에서
// 명시적으로 켠다(그 선택이 `wholeVault`로 저장된다).
export function inFolderScopePure(
  path: string, teamRoot: string | null, include: string[], exclude: string[],
  wholeVault = false,
): boolean {
  const under = (folder: string) => path === folder || path.startsWith(folder + "/");
  if (exclude.some(under)) return false;
  if (teamRoot && under(teamRoot)) return true;
  if (include.length > 0) return include.some(under);
  return !teamRoot && wholeVault;
}

/// 봉인 범위가 **하나도 정해지지 않은** 상태인가(= 봉인을 시작하면 안 되는 상태).
/// 상태바·봉인 게이트가 같은 술어를 쓴다 — 화면이 "범위 없음"이라고 말하는데 뒤에서 봉인되면 거짓말이다.
export function scopeUnset(teamRoot: string | null, include: string[], wholeVault: boolean): boolean {
  return !teamRoot && include.length === 0 && !wholeVault;
}

/// 이 경로가 팀 최상위 루트 아래인가. 팀 미소속이면 false.
/// 폴더 경계는 세그먼트 단위다 — "나날랩스2"가 "나날랩스"에 걸리면 안 된다.
export function inTeamRootPure(p: string, teamRoot: string | null): boolean {
  if (!teamRoot) return false;
  return p === teamRoot || p.startsWith(teamRoot + "/");
}

/// 이 노트의 **원문·이름**을 팀 저장소에 둘 것인가.
///
/// 봉인 범위(`inFolderScopePure`)와 다르다. 개인 폴더 노트도 **봉인은 된다** — 여기서 가르는
/// 것은 "원문을 어디에 두고 누구 키로 잠그나"뿐이다.
///
/// 팀 custody 라는 것만 보고 가르면 개인 폴더 노트까지 조직 저장소로 간다. 그러면 관리자가
/// 대리 열람할 수 있고 WORM 이라 지울 수도 없다 — 2026-07-31 에 실제로 그 상태였다.
export function teamBlobScopePure(p: string, teamRoot: string | null, teamNanal: boolean): boolean {
  return teamNanal && inTeamRootPure(p, teamRoot);
}

/// 이 요청에 쓸 API 키를 고른다.
///
/// 회사 메일과 개인 메일이 다른 사람이 있다. 그때 팀 폴더의 기록은 회사 계정으로 가야
/// 소유·회수·과금이 갈린다. **팀 키가 비어 있으면 개인 키가 양쪽에 쓰인다** — 개인과 팀이
/// 같은 계정인 사람은 아무것도 설정하지 않아도 되고, 그게 대부분이다.
export function apiKeyForPure(team: boolean, soloKey: string, teamKey: string): string {
  const tk = (teamKey || "").trim();
  return team && tk ? tk : soloKey;
}

/// `apiKeyForPure` 와 **짝**이다 — 그 함수가 팀 키를 고르는 입력에서는 이 함수도 팀 플래그를
/// 봐야 한다. 트림 규칙까지 같아야 하는 것이 핵심이다: 공백뿐인 팀 키는 키 선택에서 개인 키로
/// 떨어지므로, 거부 판정도 개인 플래그를 봐야 한다. 둘이 어긋나면 **멀쩡한 키로 보내면서 다른
/// 키의 거부 상태를 보고 멈추거나**(또는 그 반대로 거부된 키로 계속 밀거나) 한다.
/// 짝이 유지되는지는 sealscope.test.ts 가 두 함수를 같은 입력으로 돌려 고정한다.
export function authFailedForPure(
  team: boolean, teamKey: string, soloFailed: boolean, teamFailed: boolean,
): boolean {
  const tk = (teamKey || "").trim();
  return team && tk ? teamFailed : soloFailed;
}
