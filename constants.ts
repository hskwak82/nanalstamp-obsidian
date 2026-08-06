// constants.ts — 여러 모듈이 공유하는 상수. main.ts에서 순수 이동(2026-07-26).
// 뷰 타입 문자열이 여기 있는 이유: 뷰(views.ts)와 모달(modals.ts) 양쪽이 쓰는데
// 뷰 쪽에 두면 modals → views 참조가 생겨 views → modals와 값 순환이 된다.

// 아이콘 정본은 플러그인 폴더의 icon.png(=branding/nanal.png) 단 하나 — SVG 대체물 금지(브랜드 원칙).
// 로고 교체 시 icon.png만 바꾸면 된다. 로드 실패 시엔 빈 아이콘(임의 글리프로 대신 그리지 않는다).
export const ICON_ID = "nanalstamp-seal";
// ── GitHub OAuth Device Flow ────────────────────────────────────────────────
// 오너가 등록한 OAuth App의 Client ID(공개값 — 배포 빌드에 포함해도 안전). 비어 있으면
// "GitHub 연결" 모달이 "관리자 미설정" 안내 후 닫힌다. 설정법: docs/2026-07-04-github-oauth-setup.html
export const GITHUB_OAUTH_CLIENT_ID = "Ov23li0iVNifj2mknRee";
export const GITHUB_DEFAULT_REPO = "nanalstamp-vault";
export const ARCHIVE_SOURCE_VIEW_TYPE = "nanalstamp-archive-source";
export const NOTE_BROWSER_VIEW_TYPE = "nanalstamp-note-browser";
export const DASHBOARD_VIEW_TYPE = "nanalstamp-dashboard";
export const DASH_HASH_CAP = 2000;   // 1회 렌더당 해시 계산 상한(대용량 vault 보호 — 초과분은 표기)
export const DASH_GAP_ROWS = 8;      // 보호 공백 표시 행 수
export const DASH_TL_ROWS = 6;       // 타임라인 표시 폴더 수
export const TASK_INBOX_VIEW_TYPE = "nanalstamp-task-inbox";
export const TASK_POLL_MS = 5 * 60 * 1000; // §7b: 5분 폴링 — SSE 도입 후에도 안전망으로 유지
export const TASK_SSE_RETRY_MIN_MS = 2000;   // SSE 재연결 백오프 시작(2s)
export const TASK_SSE_RETRY_MAX_MS = 30000;  // SSE 재연결 백오프 상한(30s)

// 청크 병렬 업로드 동시성 — storagelayer·main 양쪽이 쓴다.
// 이 크기를 넘는 첨부는 git 이력에 직접 넣지 않고 아카이브의 내용주소 저장소(blobs/<sha256>)에 복사하고,
// 이력에는 포인터(.nanalref)만 커밋한다. isomorphic-git 의 add 는 blob 을 만들 때 파일을 통째로 힙에
// 올리기 때문이다 — 실측: 625MB 첨부 하나에 RSS 1,993MB(2026-07-30). 복사는 메모리를 경유하지 않는다.
// 8MiB: 이 아래는 git 이 잘 다루고 이력에 내용이 그대로 남는 편이 낫다(되돌리기·비교).
export const ARCHIVE_INLINE_MAX = 8 * 1024 * 1024;
export const ARCHIVE_REF_EXT = ".nanalref";
export const UPLOAD_CONCURRENCY = 3;       // 청크 병렬 업로드 동시성 — 대역폭 독점 방지·모바일 고려(과한 병렬은 체감 역효과)

// 아카이브 전체 로그 캐시 TTL — archivelayer·main 공용.
export const REWIND_LOG_TTL_MS = 60_000; // 아카이브 전체 로그 캐시 TTL — 새 커밋이 생기면 즉시 무효(archiveVersion)
