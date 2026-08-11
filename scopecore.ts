// 봉인 범위 스냅샷 문서 — 순수, node --test 로 검증.
//
// 왜 있나: "왜 이 노트는 봉인이 안 됐냐"에 답할 근거가 지금까지 없었다. 범위는 설정일 뿐이라
// 언제 무엇이었는지 아무 데도 남지 않는다. 이 저장소만 해도 sealedIndex 키가 시점에 따라
// 두 규약(`노트.md` ↔ `폴더/하위폴더/노트.md`)으로 섞여 있는데 그 전환 기록이 없다.
//
// 그래서 범위 자체를 봉인한다. 이 문서를 해시해 체인에 넣고 다음 앵커가 비트코인에 고정하면,
// "그때 이 폴더는 범위 밖이었다"가 주장이 아니라 증거가 된다.
//
// 문서는 **사람이 읽는 증거**다. 감사관이 열어 보고 바로 이해해야 하므로 한글 키를 쓴다.
// 동시에 기계가 해시해야 하므로 **결정적**이어야 한다 — 키 순서 고정, 폴더 목록은 정규화·정렬.

export const SCOPE_ZERO = "0".repeat(64);

export interface ScopeBodyInput {
  vault: string;               // vault 이름(경로가 아니라 이름 — 기기가 바뀌어도 같다)
  include: string;             // 설정에 적힌 그대로(줄바꿈·쉼표 구분)
  exclude: string;
  teamRoot: string | null;     // 팀 최상위 루트(있으면 그 아래는 항상 범위 안)
  wholeVault: boolean;         // 폴더를 안 고르면 vault 전체인가
  sealAttachments: boolean;    // 범위 안 노트가 참조하는 첨부도 봉인하는가
  autoBackfill: boolean;       // 기존 노트를 소급 봉인하는가
  sealSince: number;           // 이 계정이 봉인을 시작한 시각(ms, 0=제한 없음)
  plugin: string;              // 플러그인 판(무엇이 이 범위를 집행했는지)
}

/// 폴더 목록 정규화 — 줄바꿈·쉼표로 나누고, 공백·끝 슬래시를 떼고, 중복을 없애고 정렬한다.
///
/// 정렬하는 이유: 같은 범위를 적는 순서만 다르게 저장했다고 "범위가 바뀌었다"고 기록하면
/// 이력이 노이즈로 가득 차 정작 진짜 변경이 묻힌다. 순서는 범위의 뜻을 바꾸지 않는다.
export function normFolders(raw: string | undefined | null): string[] {
  return Array.from(new Set((raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0)))
    .sort();
}

/// 범위 **본문** — prev 를 담지 않는다.
///
/// prev 를 뺀 이유: 문서에는 직전 문서 해시가 들어가야 A→B→A 를 되돌렸을 때 세 문서가 모두
/// 달라진다(체인이 (사용자, 내용해시)로 중복제거하므로 그러지 않으면 세 번째 변경이 사라진다).
/// 그런데 그 때문에 **같은 범위라도 문서 해시가 매번 달라져** "바뀌었는가"를 판정할 수 없다.
/// 그래서 판정은 이 본문의 해시로 하고, 사슬에 박는 것은 prev 를 품은 전체 문서로 한다.
export function scopeBody(i: ScopeBodyInput): string {
  return JSON.stringify({
    "이_문서는": "nanalStamp 가 이 시점의 봉인 범위를 그대로 적어 둔 것입니다. 내용을 해시해 사슬에 넣고 비트코인에 고정합니다.",
    "vault": i.vault,
    "포함_폴더": normFolders(i.include),
    "제외_폴더": normFolders(i.exclude),
    "팀_최상위_폴더": i.teamRoot || null,
    "폴더_미지정이면_vault_전체": !!i.wholeVault,
    "참조된_첨부도_봉인": !!i.sealAttachments,
    "기존_노트_소급_봉인": !!i.autoBackfill,
    // "언제부터 봉인했는가" — 감사에서 "그 전 것은 왜 없냐"에 답하는 값이다.
    // 소급을 켰으면 제한이 없다는 뜻으로 null.
    "봉인_시작_시점": i.sealSince > 0 ? new Date(i.sealSince).toISOString() : null,
    "플러그인": i.plugin,
  }, null, 2);
}

/// 사슬에 박을 전체 문서 = 직전 문서 해시 + 본문.
/// 본문 해시를 함께 적어 둔다 — 감사관이 "이 두 스냅샷은 범위가 같고 순서만 이어진 것"임을
/// 문서만 보고 확인할 수 있어야 한다.
export function scopeDocument(body: string, prev: string, bodyHash: string): string {
  return JSON.stringify({
    "형식": "nanalstamp-scope-v1",
    "직전_범위_문서_해시": prev || SCOPE_ZERO,
    "본문_해시": bodyHash,
    "본문": JSON.parse(body) as unknown,
  }, null, 2);
}

/// 범위가 실제로 바뀌었는가. 서버가 알려준 마지막 본문 해시와 견준다.
/// 서버가 본문 해시를 모르면(옛 기록) 바뀐 것으로 본다 — 한 번 더 남는 편이 안 남는 것보다 낫다.
export function scopeChanged(serverBodyHash: string | null | undefined, bodyHash: string): boolean {
  return serverBodyHash !== bodyHash;
}
