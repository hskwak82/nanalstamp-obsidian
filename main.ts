import { addIcon, arrayBufferToBase64, FileSystemAdapter, MarkdownView, Menu, Notice, Platform, RequestUrlResponse, TFile, TFolder, requestUrl } from "obsidian";
import * as git from "isomorphic-git";
import { PitVerify, pitVerifyReadme, pitCertificateHtml } from "./certgen";
import * as QRCode from "qrcode";
import { computeDigestStats, previousPeriod, periodLabel } from "./dashcore";
import { isSealableFile, isOverSizeLimit, isMarkdownPath, inSealScopePure, inFolderScopePure, scopeUnset, isRestoredCopy, isKitSample, RESTORED_PREFIXES, inTeamRootPure, teamBlobScopePure, apiKeyForPure } from "./sealscope";
import { scopeBody, scopeDocument, scopeChanged, SCOPE_ZERO } from "./scopecore";
import { verifySealAck } from "./chaincore";
import { chunk, pendingFrom, rotationSlice, reconcileStale, toAsk, HAVE_CHUNK, ScannedFile } from "./reconcilecore";
import { sealHold, effectiveLimit, planThatFits, HoldReason, MB } from "./holdcore";
import { parseArchiveMsg } from "./archivemsg";
import { blobExt, fmtBytes, storageEndpoint } from "./storagecore";
import { parseManifest } from "./chunkcore";
import { encryptBlob, decryptBlob } from "./cryptocore";
import { RewindEntry, deletedEntries } from "./rewindcore";
import { parseHistoryResponse, parseNotesResponse, parseVaultsResponse, HistRow, NoteRow, VaultRow } from "./notebrowsercore";
import { TaskItem, TaskReply, RosterMember, personDisplay, parseTasksResponse, parseRepliesResponse, parseRosterResponse, badgeCount, unionTasks, snapshotOf, diffSnapshot, TaskSnapshot, TaskEvent, sseInitialState, sseFeed, parsePatterns, matchesPatterns, unreported, KitManifest, parseTeamStructure, parseKitManifest, manifestPaths, nfcPath, nfcPaths, creationPlan, isBinaryPath, projectPrefix, commonPrefix, scopedPatterns, TeamStructure, folderStatus, FolderTarget, detectFolderConflicts, detectFolderRenames, FolderNameSnapshot, FolderRename, SortKey, templateForFolder, isUntitledName, nextNoteName, kitRuleFor, teamFolderSegment, digestFolderFor, capFolderReport } from "./taskcore";
import { runAction } from "./taskview";
import type { TaskViewPrefs } from "./taskview";
// 번역 사전은 i18n.ts 소유 — `t`/`tpl`은 setLang()이 재대입하는 live binding이다(재대입은 i18n.ts에서만).
import { t, tpl, pickLang, setLang } from "./i18n";
import { fmtDate, fmtDateTime } from "./fmtutil";
import { ICON_ID, ARCHIVE_SOURCE_VIEW_TYPE, NOTE_BROWSER_VIEW_TYPE, DASHBOARD_VIEW_TYPE, TASK_INBOX_VIEW_TYPE, TASK_POLL_MS, TASK_SSE_RETRY_MIN_MS, TASK_SSE_RETRY_MAX_MS, ARCHIVE_INLINE_MAX } from "./constants";
import { defaultArchivePath, parseFolders, sha256Hex, sha256HexBytes, PATH_HASH_PREFIX, hashVaultName, hashPath, toBase64, basenameOf, safeName } from "./pathutil";
import { NanalStampSettingTab, FolderTreeModal } from "./settingtab";
import { AccountResumeModal, ProofModal, OnboardingScopeModal, DeletedNoteSuggestModal, RestoreVaultModal, PasswordResetModal } from "./modals";
import { ArchiveSourceView, NoteBrowserView, DashboardView, TaskInboxView } from "./views";
import type { ArchiveSourceState } from "./views";
import { FolderRenameModal, FolderCreateModal, FolderConflictModal } from "./taskmodals";
import type { Lang } from "./i18n";
import { RecoveryLayer } from "./recoverylayer";
import { SubmissionPackageModal } from "./packagemodal";
import { ReviewResultModal, ReviewRequestModal } from "./reviewmodal";
import { StorageRecoveryModal } from "./recoverymodal";


// ── Node 접근(데스크탑 Electron 전용) ────────────────────────────────────────
// 아카이브는 vault 밖 절대경로라 Obsidian vault API가 아니라 Node fs로 다룬다.


// ── 봉인 Notice 아이콘: 나날 씰 ────────────────────────────────────────────
// 브랜드 로고 정본은 server/portal/nanal.png(512×512) 단 하나(SVG·대체 아이콘 금지 원칙) —
// 이 상수는 그 실물을 40×40 PNG로 축소해 base64로 내장한 것뿐, 별도 이미지가 아니다.
// (재생성: `sips -Z 40 server/portal/nanal.png --out nanal-40.png`)
const NANAL_SEAL_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAKAAAAAB65masAAAIw0lEQVRYCe1YW2wc1Rn+Z2bvF1/iG9gJceNaDl5bCSIKCm3EpQKah4q8+AmBRASUh4iLWpDoC5Yg8MADIERUBRWBUBDB8AIiIgihREQRDwSaxGsS6mxcJ7Frx3Z83fvO6fed3RnvJo5psdO+8Eszc+b85/z/d/7bOTMiv9DKLGAsN/3bW28NBdPpKiufN3Ner+XN5UJpw1Bhny85l0xmoiKz7YODmQ9FrPbW1mjI5wsns9mFW4aGppeT+9/wlgR4uqPjV8rj2WMrtVWJ1OIyMdCEYD/agnZGKZVBe8owjBn2i1L1YpoRQ6k5ZRgn8DyHcZPgDVum+W1BqQQWatimeQOuDei/CTJSEPqPVDp9eksiQTlX0VUAodQ61dl5qMqyfpeybQFId5LTciaZhkGwmmzcoVAAWDxok0finLRt5/AYwcXORo9hBLzgk5eBDsswzhVE/poOBF7dcvw4x7rkyHc74rHYb02ljmCC6QBymT+zQSUOYC64XC55ACgBXPNK7e2Kx3ejzx1Ct7mEXhOu+AsmrBo4Cqc2yNWXq7mkle958BZoSZE//j0W21Ri6UcFwP6NG3f6DGMHAqx8zP+kTY3QbQHk78sVVgAUy9pFc/+/iO5HeG0r1+8CROZGEeSbctfBeiqfFzudFoEblyNaEVdj+RgXIOpcN7KvuTxrywf+3LbK5SRy223S0tsrZiSyLEgChP8CH/b0wNNFcgHCtK1I/ZUnxxVWovVq7r9f6h58UKrvu0/sbNbRveQTNlY9fX3EqskFmLftRFYpe0URiPCwamoc2VBV1OOpr9d9RiCAdEYB4yKWCCWCQR2dBQY3FlyAhsdzBr1jTr1a1LJEC8LtTKbCXQqWiWzbJm0ffSSexkZx4q7h0UclcvvtRSEAZ4bD2tWGzyd0v47NSrCu9TiJRV9TdnIy46+pSf6kBSkMxaBp926ZOXhQMsPDoouDaUr9I4+IFY2KPTurLdX4+ONywzPP0CxaR9MTT0j9ww/r+QpJkz1/XmYOHZKZzz8XhQVjixRskSFo4AwN1AUYjURCqH9Vrm0pEq6gJbhah7hiWqXpySdl+tNPNRAFywS7uyWMZJh87z0xQyFpefllqb733uJ8D9RgYSbAW7W1jijxt7VJ9M47tRWnP/lE7GCQqCIDsZhX4nEdrC7AgmUhRwyvOxvgrLo68a9fL8nvvy+tCXut36+DnqsvzM2Jt7lZshcvaoAGrOhbt07aPv5YvHBz8rvvJD85KVX33CNcxDAWxRi0qqvFqqrSsrIXLsj80aNiQm6JKpzoAsykUikrGExCSQ1Xy2xrhkvW9PRI4qGHZOGbb7Q16nftkmBnpwbX9sEH4mlokMzZs/qdCqruvlvroeVHX3lFotu3a4CUmUkkJDUwIIj3xSTBokx6iO7lTKVy442NriPdJCmYusJov9O1HmQjg54Tg11dYieT2oVNTz2lATDW/Bs26Jjjk24tzCyemOaPHZO5r76SLGKUVJie1tY04UYT2ayfbNNyjDiQVm4YQf/goOtJ14J6BIbqgXADXUX3kQiGblm7Z49u607ckidOyNT778vc119LfmJConfdJQ2PPabdN/baa1K7c6d+1+ORWIzJy3D/tUgDRJJkPB76O8VxLsCI17smaxg1PNPpgMbqdHZiUKC9XZqefloHdeqHHzRI39q1MtLbKwvHj4uF0mF4vdpijCfOJ9ibXn+96E4qWrNGWl58UWcurVueeATikmEUvH4/imWRFl1sWRtxmghp5yMuCgsLOrA5LHrHHTpzWetGX3hB8lNTejbrGF2Fk7R+10oZvygZ1Tt2uOA0E7fcyIhOKGe80+88S/vb8G/OnJl3+lyAALYeJ13dT8tlh4Yk/eOPxfdSmRl74w3tzgIyUyFOdbEuzXEEMp4Y9KMvvSTjb74pY7Di3OHDmp2/fFkCHR1XAXfm8iQFBAO4irkAhgsQbhnjoVITBlL5xeeek7kjR7Qbzz/7rFzat0+75jJr1vy8sNg6Ae4o0U9YlOVl4u23dWyGNm/W3cFYTNYDdHjrVqE36AEW6OWoaDKM4IdSzrJOAnHEyXEKoDtY31h23FqFd8ZlZnDQDYMKJVwoSsmvDxyQwM03V7BoxbMoXSxN4S1bxNvSomOXZckLuTjuncB2uzVWKtSuBecjkQtAO1y+FzPwnURxwVEdsjzV3780OPLpdiicRJ2c/fJLmS/VULIu7d0r+fFxnTBtfX1S98ADbgzz6A/qQC6sY4PkAuTXFNizbkeRX7xTYTkxVgB+WcKYqf37ZQj7M4s8vZA6dUoX+/bPPtPAxgGWfO3mkg5UEZXKZkuxVlZmqAwwrkCyLISfZsLNvhtvFO4+DBWWpubnn9e7zhAOErNffFEMG/BITBIgG8lEo/9yhFcYjOBXFyFWjIx2woQHBcbaBZxwZnGCKS9RGiBvSp2FN5NLAkTsjPPDe7WIbmXNzGObI3HbG8YxjXHJc+GVRN04ck2U97s7ie40jLDeScpHrKQNhTYK/uQ734gX7p146y3Jjo7qvXgZsYtnOwyqAAhw2N9Wz4IEwWSaePddnfFs86BwLWK84duo4tdHRQzCxKevx3exA8yJxaUAchdDDZxWlrWvnF8BENbbj585K/twKpf+H7YJAt6bwr70h+7+/sPl0yoAgnkMu8jeMIK7glE+4zq0Q9j7sc0e2ByP4yhUSRUxSNaAYfwpptQlAPwzvgGi+BTVxdFxPSPU2W2YUHm8u3s4ebicsay2TsUt/yFAdzoHEwwR/OYb9ij1N7avpGtmRLyz8xbE5Kv4ytoOEDPwQQLveSjMYNIlPHmgbMAVA+C1XCm3KvRP4BrmK8bVoGyEMdfCVY35QfRxx4qDfxTHqwnbMP6Zt6yDm06eHEffVXRNgByJX8De6lSqK22aE139/dyrIbuSTnZ311qFQhesVssaBksl+uLx8V58E55rbQ3gb6o/HQxahm3XYWYdFrxgW9YZ5zBQKe2Xt9W3wL8BvpO23g0ULw8AAAAASUVORK5CYII=";

// 봉인 성공 Notice 공용 헬퍼 — 🔏 이모지 대신 나날 씰 이미지(16px)를 아이콘으로 표시.
// DocumentFragment로 img+텍스트를 구성해 Obsidian Notice(문자열|Fragment 둘 다 지원)에 전달.
function sealNotice(text: string, timeout?: number): Notice {
  const frag = document.createDocumentFragment();
  const img = document.createElement("img");
  img.src = NANAL_SEAL_DATA_URI;
  img.width = 16;
  img.height = 16;
  img.addClass("nanalstamp-notice-seal");
  frag.appendChild(img);
  frag.appendChild(document.createTextNode(text));
  return new Notice(frag, timeout);
}

// 상태바 인장도 동일 아이콘(ICON_ID)을 setIcon으로 렌더.

// 연속 봉인일(streak): 실제로 봉인이 성공한 날짜(로컬 YYYY-MM-DD)들로부터 계산.
// 오늘(또는 어제까지)로 끝나는 연속 구간의 길이. 하루라도 비면 0으로 끊김.
function computeStreak(days: string[]): number {
  if (!days.length) return 0;
  const set = new Set(days);
  const d = new Date();
  if (!set.has(fmtDate(d))) {
    d.setDate(d.getDate() - 1);
    if (!set.has(fmtDate(d))) return 0; // 어제까지 비었으면 연속 끊김
  }
  let streak = 0;
  while (set.has(fmtDate(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
// 증빙-인지 마커: #nanal/<cat> 태그(검색·후속 증명서 집계용)
function entryBlock(catKey: string): string {
  const c = tpl.cats[catKey];
  const fields = c.fields.map((f) => `- **${f}:** `).join("\n");
  return `\n### ${c.emoji} ${c.label} · ${fmtDateTime(new Date())}  #nanal/${catKey}\n${fields}\n`;
}

/// 한 계정에서 쓰던 봉인 설정 — 떠날 때 담아 두고 돌아오면 되살린다.
interface AccountScopeProfile {
  includeFolders: string;
  excludeFolders: string;
  sealWholeVault: boolean;
  sealAttachments: boolean;
  autoBackfill: boolean;
  nanalBackfill: boolean;
  nanalSince: number;
  sealSince: number;
  savedAt: number;
  email?: string;      // 물어볼 때 사람이 알아볼 수 있게
}

export interface AttestSettings {
  lang: "auto" | "en" | "ko";
  serverUrl: string;
  apiKey: string;
  /// 팀 계정의 API 키(선택). 회사 메일과 개인 메일이 다를 때만 채운다 —
  /// 비어 있으면 팀 쪽 요청도 개인 키로 나간다(같은 계정인 사람의 기본값).
  teamApiKey: string;
  /// 팀 계정의 이메일(표시용). 키는 보여주지 않는다.
  teamAccountEmail: string;
  /// 팀 계정의 사용자 ID. **봉인 응답의 고리를 다시 계산할 때 쓴다**(entry_hash 의 첫 칸).
  /// 이것이 없으면 팀 봉인마다 검증이 어긋나 봉인이 실패 처리된다(2026-08-01 실측).
  teamClaimAccount: string;
  /// 원문 보관이 보류된 경로와 사유. 성공하면 지운다 — 남아 있으면 **아직 안 올라간 것**이다.
  uploadStall: Record<string, { why: string; at: number }>;
  accountEmail: string;        // 설정 2차: 로그인한 이메일(계정 카드 표시용) — 로그아웃 시 함께 비움
  enabled: boolean;            // UI 제거됨 — loadSettings에서 항상 true 강제. 내부 게이트는 향후 원격 비활성화 훅 대비로 잔존
  lastSeenMtime: number;
  includeFolders: string;
  excludeFolders: string;
  templatesEnabled: boolean;
  noteFolder: string;
  digestFolder: string;        // 5.2: 월간 digest 노트가 저장·인식되는 폴더(미러 시 digests/로 라우팅)
  onboarded: boolean;          // 첫 활성화 온보딩(설정 안내) 1회 완료 여부
  failedPaths: string[];       // 전송 실패 큐(재시작 후에도 재시도)
  /// 봉인 시점 업로드가 실패해 재시도해야 하는 경로. **메모리에만 두면 Obsidian 을 끄는
  /// 순간 사라져 그 버전 원문이 영구 유실된다**(2026-07-29 실측: 260건 누락의 한 갈래).
  /// failedPaths 와 같은 방식으로 남긴다.
  sealRetryPaths: string[];
  /// 마지막 점검에서 **원문이 보관되지 않은 채 남은** 건수. 0이 아니면 상태바가 알린다 —
  /// 구독의 핵심이 원문 보관이라, 빠진 것이 있는데 조용한 상태가 가장 위험하다.
  storageGapSeen: number;              // 자동으로 더 시도할 수 있는 남은 누락(되살릴 수 없다고 확정된 것 제외)
  unrecoverableHashes: string[];       // 어디에도 원본이 없어 되살릴 수 없다고 확정된 해시 — 자동 재시도에서 제외
  storageLostNoticed: number;
  unrecoverableReported: string;       // 서버에 마지막으로 맞춘 확정 목록의 지문 — 같은 목록을 반복 전송하지 않는다          // 그 사실을 알린 시점의 건수(같은 수를 두 번 알리지 않는다)
  /// 마지막 점검 시각(epoch ms). 간격은 **실제 경과 시간** 기준이어야 한다 —
  /// 인터벌만 쓰면 Obsidian 을 껐다 켤 때마다 점검이 돌고(낭비), 며칠 안 켜면 그동안은
  /// 아무도 모른다. 이 값으로 "마지막 점검 이후 6시간"을 지킨다.
  storageGapCheckedAt: number;
  sealDays: string[];          // 봉인 성공한 로컬 날짜(YYYY-MM-DD) — 연속일 계산용
  sealDayCounts: Record<string, number>; // 일별 봉인 횟수 — 히트맵 농도(GitHub 잔디)용
  lifetimeCount: number;       // 누적 봉인 횟수(세션 간 유지)
  ledgerFolder: string;        // P1: 저장 폴더(기본 nanalStamp/proofs)
  ledgerIndex: Record<string, string>; // 노트경로 → 원장에 저장된 확정 해시(재요청·재기록 방지)
  githubMirror: boolean;       // P2: PRO GitHub 미러 on/off
  githubPat: string;           // P2: fine-grained PAT(contents write) 또는 OAuth Device Flow 토큰
  githubUser: string;          // P2: 연결된 GitHub 로그인명(상태 표시용)
  githubRepo: string;          // P2: 대상 owner/repo
  githubReadmeRepo: string;    // README를 push한 repo(1회 보장용)
  mirrorIndex: Record<string, string>; // 노트경로 → GitHub에 성공적으로 미러된 확정 해시(로컬 원장과 별도 추적)
  ledgerMtime: Record<string, number>; // 노트경로 → 마지막으로 '안정' 판정한 파일 mtime(변경·pending 아니면 재검사 스킵)
  autoBackfill: boolean;       // 초기 백필: 봉인 이력 없는 기존 노트를 백그라운드에서 천천히 봉인
  sealedIndex: Record<string, string>; // 노트경로 → 서버 전송 성공한 마지막 해시(확정 전 "대기" 표시·백필 중복 방지, 재시작 생존)
  sealedAt: Record<string, number>;    // 노트경로 → 마지막 봉인 전송 시각(ms) — 확정 지연 판정(SLA: 다음 자정+3h)
  // 이 로컬 봉인 기록들이 **어느 계정 것인가**. 계정이 바뀌면 옛 주장은 무효다(checkAccountSwitch).
  claimAccount?: string;
  /// 이 vault 의 "되살릴 수 없음" 판정 주체 id. 판정 근거가 **이 기기의 디스크**라
  /// (이 vault + 이 기기의 로컬 아카이브) 판정 주체도 vault 단위여야 한다.
  /// 서버는 활동 중인 모든 보고자가 동의할 때만 알람에서 뺀다.
  reporterId?: string;
  /// 마지막 차집합 대조 시각(ms). 오래되면 "빠졌는지 모른다"를 사람에게 말한다.
  reconcileAt?: number;
  /// mtime 캐시를 건너뛰고 다시 읽을 차례(회전 커서) — 캐시가 거짓말하는 경우를 며칠 안에 닫는다.
  reconcileCursor?: number;
  /// 서버에 물어볼 몫의 회전 커서(대규모 vault 에서만 쓰인다 — RECONCILE_FULL_MAX 참조).
  reconcileAskCursor?: number;
  /// 개명 계보 판정 캐시(`옛경로|커밋oid` → 후계 경로 또는 ""). **메모리에만 두면 재시작마다 다시 계산한다** —
  /// 실측 108초였고 그동안 화면은 조용했다(오픈 전 검수 UX-52). 판정은 커밋 oid 로 고정돼 있어
  /// 한 번 나온 답이 뒤집히지 않으므로 저장해도 안전하다.
  lineageCacheMap: Record<string, string>;
  renameMap: Record<string, string>;   // 개명 계보(옛 경로 → 새 경로, 체인은 기록 시 압축) — 표시 전용(원장·체인 불변), 삭제 오인·이력 단절 방지
  archivePath: string;         // P1.5: 아카이브 절대경로(빈 값 → 로드 시 defaultArchivePath로 채움)
  archiveIndex: Record<string, string>; // 노트경로 → 로컬 git 아카이브에 커밋된 확정 해시
  sealAttachments: boolean;    // 0.2: 첨부도 봉인 대상에 포함(끄면 .md만). 대상 = 범위 내 노트가 참조하는 첨부(형식 무관)
  sealKitSamples: boolean;     // 킷 샘플(_samples/)도 봉인할지(2026-07-27). 기본 false — 허구 기록을 원장에 넣지 않는다. 팀 프로파일이 덮어쓴다.
  // digest 주기(2026-08-02) — 팀 프로파일이 배포한다. "" = 아직 못 받음(monthly 로 본다).
  teamDigestCadence: string;
  // 마지막으로 서버에 보고한 digest 기간 — 같은 글을 폴링마다 다시 보고하지 않기 위한 것.
  digestReported: Record<string, string>;
  teamAttachmentMaxMB: number | null; // 3.2: 팀 프로파일이 배포한 첨부 상한(MiB, 0=무제한) — 업로드 유효 상한 = uploadLimitMB() 참조(개인 설정 UI 없음)
  quotaWarnedAt: number;               // 보관 용량 경고를 낸 단계(0·80·95) — 같은 단계 반복 알림 방지
  attachmentMaxMb: number;             // 요금제가 정한 첨부 크기 상한(MiB, 0=무제한) — /attest/pricing 에서 수신
  // kind 는 noteSealHold 가 HoldReason 에서 그대로 옮겨 적는 두 값뿐이다 — 리터럴로 좁혀
  // 표시부(holdDetailLine)가 임의 문자열을 받지 않게 한다.
  sealHolds: Record<string, { kind: "attach" | "quota"; path: string; size: number; limitMB: number; byTeam?: boolean; at: number }>;
                                       // 봉인 보류 목록(경로 → 사유). 조용한 실패를 막기 위해 영속한다.
  attachSkipped: string[];     // 클라우드 보관(업로드)에서 제외된 첨부 경로 — 팀 정책 또는 5GB 하드캡 초과(봉인·해시 증명은 항상 됨). 침묵 누락 방지로 설정탭에 노출
  teamProfileEnabled: boolean; // 3.2: 팀 프로파일 자동 적용(폴더 필터·첨부 설정을 팀 정책이 관리). 끄면 로컬 값 유지
  teamTemplates: { name: string; body: string }[]; // 3.2: 팀 프로파일에서 수신한 조직 템플릿 캐시(삽입 명령으로 노출)
  teamProfileUpdatedAt: number; // 3.2: 마지막으로 팀 프로파일을 수신·적용한 로컬 시각(ms) — 설정탭 표시용
  teamRole: string;            // 팀에서의 역할('owner'|'member', 미소속 '') — 관리자 전용 진입점 표시용
  knownFolderNames: string;    // 2026-07-26: 마지막으로 vault에 반영된 것으로 아는 팀 폴더 이름(FolderNameSnapshot
                               // JSON, "" = 아직 없음). 서버는 "지금 이름"만 주므로 옛 이름은 우리가 기억해야
                               // 무엇을 어디로 옮길지 알 수 있다(detectFolderRenames).
  /// 마지막으로 팝업을 띄운 충돌 집합의 지문 — 같은 충돌에 5분(폴링)마다 팝업이 뜨면 협박이
  /// 된다. 집합이 바뀌면(새 충돌) 다시 뜨고, 다 풀리면 ""로 되돌려 다음 충돌에 다시 뜬다.
  folderConflictSig: string;
  teamStructure: string;       // 이원화(2026-07-24): 팀 표준 폴더 구조(KitManifest JSON 직렬화, "" = 미설정).
                               // 있으면 스코프 = 구조 최상위 ∪ 참여 과제 패턴(로컬 include/exclude 무시)
  teamCustody: { org: string; repo: string } | null; // 4.3: 조직 GitHub App custody. 서버 mirror/info로 수신·캐시. 있으면 개인 GitHub 대신 서버 프록시로 미러. null이면 기존 개인 미러 동작
  teamStorage: "nanal" | null; // C2: 팀 custody nanal — mirror/info로 수신·캐시. 'nanal'이면 개인 storageBackend와 무관하게 팀 스토리지 강제(팀 설정이 우선)
  storageBackend: "off" | "nanal"; // C1: nanal 택일(권장 기본). 기존 "github" 선택은 로드 시 githubExport로 이관
  githubExport: boolean;           // C1: 고급 — GitHub 내보내기(탈출구, nanal과 병행 가능). 기존 미러 코드 경로 재사용
  nanalIndex: Record<string, string>;         // 노트경로 → nanal 스토리지 업로드 완료된 봉인 해시(mirrorIndex와 동형)
  scopeChosen: boolean;         // 시작 범위 모달 완료 여부 — 로그인 직후·업데이트 후 첫 로드에 1회 트리거, 선택 후 다시 안 뜸
  /** vault 전체 봉인을 **명시적으로** 선택했는가(2026-07-28). 포함 폴더가 비고 팀 루트도 없을 때만 의미가 있다.
   *  기본 false = 범위를 고르기 전에는 아무것도 봉인하지 않는다(sealscope.inFolderScopePure 주석 참조). */
  sealWholeVault: boolean;
  nanalBackfill: boolean;       // 원문 소급 보관 여부: 꺼짐이면 nanalSince 이후 봉인분만 스토리지 업로드 대상(ledgerSweep이 필터)
  nanalSince: number;           // nanalBackfill을 끈 시각(ms) — 이 이후 mtime 노트만 소급 보관 대상(끄는 순간 기록)
  /// **이 계정이 봉인을 시작한 시각**(ms). 0 이면 제한 없음(소급 봉인).
  ///
  /// 왜 필요한가: 계정이 바뀌면 이전 계정과 연결고리가 없다. 새 계정은 "지금부터" 시작하는 것이고,
  /// 그 이전 파일은 **봉인이 빠진 것이 아니라 애초에 대상이 아니다.** 처음 설치한 것과 같다.
  /// 이 값이 없으면 대조가 옛 노트를 전부 "봉인 안 됨"으로 잡아, 사용자가 "지금부터만"을
  /// 골랐는데도 계속 경고하고 봉인을 권한다(2026-07-31 지적).
  sealSince: number;
  /// 계정별 봉인 설정 보관함(계정 id → 그 계정에서 쓰던 설정).
  ///
  /// 왜: 계정을 떠날 때 그 설정을 버리면, 다시 돌아왔을 때 처음부터 다시 정해야 한다.
  /// 특히 **시작 시점이 오늘로 잡혀** 자리를 비운 사이 고쳐진 노트가 영영 대상에서 빠진다.
  /// 보관해 두면 "이전 설정으로 이어서"를 고를 수 있다 — 그게 "이어서 동작"의 실질이다.
  /// 로컬 인덱스는 담지 않는다: 크고, 자리를 비운 사이 낡아서 화면이 거짓말한다
  /// (표시는 복귀 후 대조가 서버 답으로 되살린다).
  accountProfiles: Record<string, AccountScopeProfile>;
  mobileEntitled: boolean;     // D2: 모바일 봉인 자격(스토리지 플랜) 캐시 — 오프라인 기동 대비. usage 조회가 갱신.
  taskInboxEnabled: boolean;   // §7b: 업무 요청함 사용(기본 ON) — 끄면 폴링·패널·리본 비활성
  taskSystemNotify: boolean;   // §7b: 창 비활성 시 OS 알림(기본 ON, 데스크톱 전용) — 모바일은 배지·패널만
  /** 과제별 서버 보고 완료 path_hash 캐시(append-only — 전송 실패분은 다음 트리거에 재시도). */
  projectReported: Record<string, string[]>;
  taskViewPrefs: TaskViewPrefs; // 업무함 뷰 상태(뷰 모드·정렬·그룹·완료 숨김·필터) — 패널 재열림에도 지속(§Task 6~)
}

const DEFAULTS: AttestSettings = {
  lang: "auto",
  serverUrl: "https://api.nanalstamp.com",
  apiKey: "",
  teamApiKey: "",
  teamAccountEmail: "",
  teamClaimAccount: "",
  uploadStall: {},
  accountEmail: "",
  enabled: true,
  lastSeenMtime: 0,
  includeFolders: "",
  excludeFolders: "",
  templatesEnabled: true,
  noteFolder: "",
  digestFolder: "digests",
  onboarded: false,
  failedPaths: [],
  sealRetryPaths: [],
  storageGapSeen: 0,
  unrecoverableHashes: [],
  storageLostNoticed: 0,
  unrecoverableReported: "",
  storageGapCheckedAt: 0,
  sealDays: [],
  sealDayCounts: {},
  lifetimeCount: 0,
  ledgerFolder: "nanalStamp/proofs",
  ledgerIndex: {},
  githubMirror: false,
  githubPat: "",
  githubUser: "",
  githubRepo: "",
  githubReadmeRepo: "",
  mirrorIndex: {},
  ledgerMtime: {},
  autoBackfill: true,
  sealedIndex: {},
  sealedAt: {},
  renameMap: {},
  archivePath: "",
  archiveIndex: {},
  sealAttachments: true,
  sealKitSamples: false,
  teamDigestCadence: "",
  digestReported: {},
  teamAttachmentMaxMB: null,
  quotaWarnedAt: 0,
  attachmentMaxMb: 0,
  sealHolds: {},
  attachSkipped: [],
  teamProfileEnabled: true,
  teamTemplates: [],
  teamProfileUpdatedAt: 0,
  teamRole: "",
  folderConflictSig: "",
  teamStructure: "",
  knownFolderNames: "",
  teamCustody: null,
  teamStorage: null,
  storageBackend: "nanal", // 기본 on — Pro 구독 즉시 클라우드 보관 동작(free는 isPro 게이트가 차단)
  githubExport: false,
  nanalIndex: {},
  scopeChosen: false,
  sealWholeVault: false,
  nanalBackfill: true,
  nanalSince: 0,
  sealSince: 0,
  lineageCacheMap: {},
  accountProfiles: {},
  mobileEntitled: false,
  taskInboxEnabled: true,
  taskSystemNotify: true,
  projectReported: {},
  taskViewPrefs: { view: "table", sorts: [], groupBy: "status", hideDone: false, filters: {}, colWidths: {} },
};

// ── 연구과제(§3) — GET /attest/team/projects?status=active 항목(플러그인이 쓰는 필드만) ──
interface TeamProject {
  id: string;
  name: string;
  code: string;               // 과제 코드(표시용, 없으면 "")
  folder_patterns: string;    // 줄바꿈 구분 폴더 접두 목록(taskcore.parsePatterns 계약)
  kit_id: string | null;      // 연결된 킷(없으면 null → 폴더 만들기 비노출)
}

// ── 내부 파라미터(상수) — 사용자가 조정할 값이 아니라서 설정 UI에서 제거하고 고정(2026-07 설정 재구성) ──
const SETTLE_MS = 5000;          // 정착 디바운스: 입력이 이 시간 멈추면 '멈춤'으로 간주
const MIN_INTERVAL_MS = 300000;  // 노트당 최소 봉인 간격(5분) — 그 사이 수정은 합침
const RETRY_MS = 30000;          // 전송 실패 노트 재시도 주기
const LARGE_UPLOAD_NOTICE_MB = 100; // 이 크기 이상 업로드는 진행하되 1회 정보성 알림 — 쿼터 소모 인지용(차단 아님)

interface FileState {
  timer?: number;
  lastAttestAt: number;   // 마지막 봉인 성공 시각(정보용)
  dirtyAt: number;        // 이번 '봉인 대기'가 시작된 시각(첫 수정) — 5분 카운트의 기준점. clean이면 0
  lastHash: string;
  dirty: boolean;
}

// verify 결과 캐시 유효기간(ms). 내용/해시가 바뀌면 키가 달라져 자연 무효화되고,
// 봉인·앵커 성공 시 명시 무효화한다. TTL은 서버측 앵커 확정(₿ 블록고) 반영 지연 상한.
const VERIFY_CACHE_TTL_MS = 60_000;
// 노트 빠른 전환 디바운스(ms) — 연타 전환 시 마지막 전환만 verify 조회.
const STATUS_DEBOUNCE_MS = 200;
// 원장 sweep 1회당 처리(원장 기록+미러 push) 상한 — GitHub 레이트 고려한 배치.
const LEDGER_SWEEP_BATCH = 20;
const SWEEP_EXAMINE_CAP = 60;   // sweep당 read+hash+verify 검사 상한(대용량 vault 과부하 방지)

export default class NanalStampPlugin extends RecoveryLayer {
  private states = new Map<string, FileState>();
  private failed = new Set<string>(); // 전송 실패 → 재시도 대기
  pricingPlans: Array<{ code: string; name: string; attachment_max_mb: number; amount_krw: number }> = [];
  private sealArchiveRetry = new Set<string>(); // 봉인 시점 아카이브·미러 일시 실패 → 재시도(설정에 영속)

  /// 재시도 큐 변경을 **한 곳에서** 설정에 반영한다. 흩어져 있으면 한 군데가 빠지고,
  /// 그러면 그 경로만 조용히 유실된다.
  private markRetry(path: string, need: boolean): void {
    const changed = need ? !this.sealArchiveRetry.has(path) : this.sealArchiveRetry.has(path);
    if (!changed) return;
    if (need) this.sealArchiveRetry.add(path); else this.sealArchiveRetry.delete(path);
    this.settings.sealRetryPaths = Array.from(this.sealArchiveRetry);
  }
  lastUsage: { used: number; quota: number } | null = null; // C1: 설정탭 사용량 바 캐시
  private usageFetchedAt = 0;
  private dekGoneNotified = false; // Phase D: 410(파기 — 종결 상태) Notice는 세션당 1회
  private activeFile: TFile | null = null;
  private openNotePaths = new Set<string>(); // 열린 마크다운 노트 경로 집합 — layout-change 닫힘 감지의 직전 스냅샷
  private statusEl!: HTMLElement;
  private retryTimer?: number;        // 재시도 인터벌 id(설정 변경 시 재등록)
  private backfillTimer?: number;     // 1회성 백필 티커 id(백로그 소진 시 스스로 종료)
  // 이번 세션에서 봉인을 넘기지 못한 후보. **한 건에 갇혀 나머지가 멈추는 것**을 막는다(backfillTick 참조).
  // 세션마다 비우는 이유: 원인이 일시적(네트워크·자격)일 수 있고, 다시 열면 다시 시도하는 편이 맞다.
  private backfillStuck = new Set<string>();
  private backfillStuckNotified = false;
  private countdownTimer?: number;    // 봉인 대기 카운트다운(활성 노트가 dirty일 때만 1초 틱, 텍스트만 갱신)
  private backoffUntil = 0;           // 429 백오프 종료 시각(ms)
  private lastApiKey = "";            // 키 변경 감지(authFailed 리셋용)
  private pastDueNotified = false;
  private expiredNotified = false;
  /// 만료 임박 안내를 보낸 만료일(초). 같은 만료일로 두 번 띄우지 않는다 —
  /// 켤 때마다 뜨면 사람이 무시하기 시작한다.
  private expiringNotifiedFor: number | null = null;
  private teamExpiredNotified = false;    // past_due 알림 세션당 1회 가드
  entitlement: { tier: string; cert_credits: number; is_pro: boolean; status?: string; user_id?: string; paid_until?: number | null } | null = null;
  // 해시별 verify 결과 캐시 + 노트 전환 디바운스 타이머(같은 해시 재조회/연타 전환 시 서버 호출 절감)
  private verifyCache = new Map<string, { result: any; ts: number }>();
  private statusDebounceTimer?: number;
  // 활성 노트가 '앵커 중'(anchored지만 ₿ 미확정)이면 true → 주기 재검증으로 확정 자동 반영.
  // 노트를 열어둔 채 앵커가 확정되면 상태바가 전환 없이도 따라오게 한다.
  private activeAnchorPending = false;
  private ledgerSweeping = false;     // 원장 sweep 중복 실행 방지
  // sweep 순회 커서(세션 내 메모리만, 영속 불필요) — 매번 파일 목록 처음부터 훑으면 확정 대기(pending)
  // 노트가 examine 예산(SWEEP_EXAMINE_CAP)을 계속 선점해 뒤쪽 파일이 영원히 미도달하는 기아가 발생했다
  // (2026-07-21 실측: 확정 대기 541건 > 상한 60 → 소급 업로드 0건). 다음 sweep은 이 지점부터 이어 훑는다.
  private sweepCursor = 0;
  // 참조 기반 첨부 판정: 범위 내 .md 노트가 임베드/링크하는 비-md 파일의 vault 경로 집합.
  // resolvedLinks(metadataCache) 스냅샷 — "resolved" 이벤트(디바운스) + 각 스윕 진입 시 재계산.
  private referencedAttachments = new Set<string>();
  private refSetTimer?: number;       // resolved 이벤트 디바운스(SETTLE_MS 트레일링 — 대량 인덱싱 중 과호출 방지)
  private largeUploadNotified = new Set<string>(); // 대형 파일 업로드 정보성 알림의 세션 내 1회 가드(경로 기준)
  // 청크 업로드 진행률(상태바 표시용) — nanalPutChunked가 세팅·해제. null이면 진행 중 아님.
  // P1.5: git 연산 직렬화 락 — sweep과 활성노트가 동시에 아카이브를 만지면 repo가 손상될 수
  // 있으므로 모든 git(init/add/commit) 연산을 이 Promise 체인에 태워 겹치지 않게 한다.

  private iconUrl = "";
  scopeModalOpen = false; // 시작 범위 모달 중복 오픈 가드(부팅·로그인 두 트리거 겹침 방지) — 모달이 set/reset

  // ── 업무 요청함(§7b Work Inbox) — 폴링·배지·알림 상태(전부 세션 메모리) ──
  private taskSnapshot: TaskSnapshot | null = null; // 폴링 diff 기준 — 첫 폴링은 기준 수립만(시작 시 알림 폭주 방지)
  taskInboxBadge = 0;      // 리본 배지 = 읽지 않음 ∪ (inbox 접수 대기·마감 초과)(taskcore.badgeCount)
  // 마지막 배지 계산 재료 — read 보고 시 로컬에서 myReadAt만 고쳐 배지를 즉시 재계산한다
  // (서버 응답·다음 폴링을 기다리면 빨간 숫자가 몇 분씩 남는다). 완료 첫 페이지 포함.
  private taskBadgeInbox: TaskItem[] = [];
  private taskBadgeMine: TaskItem[] = [];
  /// 내 점검 요청 중 **반려된** 건수. 요청자는 점검함에 들어갈 수 없어, 이 배지가 없으면
  /// 반려 사실을 알 길이 메일뿐이다(2026-07-29). 고쳐야 할 일이 있다는 신호다.
  reviewRejected = 0;
  reviewRejectedItems: Array<{ seq: number; comment: string; title: string }> = [];
  taskNotMember = false;   // 404(팀 미소속) → 폴링 조용히 중단(§7b). 수동 새로고침·키 변경이 리셋
  taskLastSyncAt = 0;      // 패널 푸터 "마지막 동기화" 표시용(ms)
  private taskRibbonEl: HTMLElement | null = null;
  private taskBadgeEl: HTMLElement | null = null;
  private taskRosterCache: { members: RosterMember[]; at: number } | null = null; // 수신자 선택용(5분 캐시)
  // 인터벌·패널 열기·수동 ↻이 겹치면 같은 in-flight를 공유(중복 fetch 방지 + 늦게 온 쪽이
  // null을 받아 오류로 오인하지 않게 — busy 불리언이던 초기 구현의 경합 수정).
  /// 업무 증적 요약(2026-07-29) — 업무함 탭 상태바가 "지금 무엇이 증적으로 남고 있는지"를
  /// 말할 수 있게 한다. 폴링 때 함께 갱신하고, 회신·수정 직후에도 다시 부른다.
  taskSealSummary: { sealed: number; pending: number } | null = null;
  private taskPollInflight: Promise<{ inbox: TaskItem[]; mine: TaskItem[] } | null> | null = null;
  // SSE 준실시간(데스크톱 전용) — changed 수신 시 pollTasks 즉시 실행. 5분 폴링은 안전망으로 유지.
  private taskSseActive = false;                       // 구독 루프 가동 중(중복 시작 방지)
  private taskSseAbort: AbortController | null = null; // 언로드·토글 OFF 시 스트림 즉시 절단
  private taskSseBackoffMs = TASK_SSE_RETRY_MIN_MS;    // 재연결 지수 백오프(2s→30s, 성공 시 리셋)

  // ── 연구과제(§3) — active 목록·참여 판정 캐시(전부 세션 메모리, 저장 안 함) ──
  teamProjects: TeamProject[] = [];         // active 과제 목록(refreshProjects가 갱신)
  myProjectIds: Set<string> = new Set();    // 내가 참여자인 과제 id(= notes POST가 403이 아니었던 과제)
  private projectSyncSkip = new Set<string>(); // notes POST 403(비참여) → 이번 세션 동기화 스킵
  private projectMemberCounts = new Map<string, number>(); // 직전 fetch의 member_count — 변동 시 403 스킵 무효화(중도 합류 재시도)
  private projectSyncBusy = false;          // syncProjectNotes 중복 실행 방지(트리거 겹침)
  private teamRootCache: { src: string; root: string | null } | null = null; // teamRoot 메모이즈 — inScope 핫패스에서 매번 JSON.parse 방지

  async onload() {
    await this.loadSettings();
    this.failed = new Set(this.settings.failedPaths); // 실패 큐 복원(재시작 후에도 재시도)
    // 업로드 재시도 큐도 복원한다 — 끄고 켠 사이에 잊히면 그 버전 원문이 영구 유실된다.
    this.sealArchiveRetry = new Set(this.settings.sealRetryPaths ?? []);
    this.lastApiKey = this.settings.apiKey;
    setLang(this.settings.lang); // 설정/감지에 맞춰 언어 적용(명령·UI 이름 등록 전에)
    if (!Platform.isDesktopApp) void this.fetchStorageUsage(); // D2 자격 캐시 조기 갱신(실패 시 캐시값 유지)
    // 로고는 icon.png(평면 이미지) — 필터 없이 어디서나 동일하게 표시. 교체 시 icon.png만 바꾸면 됨.
    // Store review note: adapter.readBinary is required here — the Vault API does not
    // reach files under configDir (the plugin's own folder). Works on mobile too.
    try {
      const buf = await this.app.vault.adapter.readBinary(`${this.app.vault.configDir}/plugins/${this.manifest.id}/icon.png`);
      this.iconUrl = "data:image/png;base64," + arrayBufferToBase64(buf);
    } catch (e) { this.iconUrl = ""; }
    // 탭·메뉴·상태바 아이콘도 정본 nanal.png(iconUrl)를 <image>로 그대로 그린다(필터·재해석 없음).
    // 로드 실패 시 빈 아이콘 — SVG 글리프 등 임의 대체물 금지(브랜드 원칙: 이미지 하나만).
    addIcon(ICON_ID, this.iconUrl ? `<image href="${this.iconUrl}" x="0" y="0" width="100" height="100"/>` : "");
    // 리본 클릭 → 액션 메뉴(항상 시각 피드백). 좌클릭 즉시 봉인 대신 메뉴로 기능 노출.
    // 구성은 buildRibbonMenu가 소유한다 — 리본 클릭 없이도 메뉴를 만들어 검사할 수 있게 분리했다.
    const ribbonEl = this.addRibbonIcon(ICON_ID, "nanalStamp", (evt: MouseEvent) => {
      const menu = new Menu();
      this.buildRibbonMenu(menu);
      menu.showAtMouseEvent(evt);
    });
    // 리본은 Obsidian이 아이콘을 단색으로 강제 렌더 → 브랜드 씰(PNG data URL)을 직접 넣어 컬러 유지.
    ribbonEl.empty();
    ribbonEl.createEl("img", { cls: "nanalstamp-ribbon-icon", attr: { src: this.iconUrl, width: 18, height: 18, alt: "nanalStamp" } });
    // 업무함 배지를 이 리본에 붙인다(2026-07-26 리본 통합). empty() **뒤에** 만들어야 지워지지 않는다.
    ribbonEl.addClass("nanalstamp-task-ribbon"); // position:relative — 배지 absolute의 기준점
    this.taskRibbonEl = ribbonEl;
    this.taskBadgeEl = ribbonEl.createSpan({ cls: "nanalstamp-task-ribbon-badge" });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable"); // 호버 어포던스(Obsidian 상태바 클릭 스타일)
    this.registerDomEvent(this.statusEl, "click", () => {
      // 클릭은 **표시와 같은 판정**을 따른다(P-07) — updateActiveStatus 의 분기 순서와 같게 둔다.
      // 미로그인 상태의 유일한 단서가 이 상태바다. 같은 Notice 를 반복하지 말고 로그인 폼을 연다.
      // 배지가 "팀 키 거부됨"인 동안에도 목적지는 설정이다(연동 카드의 재연결 폼) — 표시가
      // 회복을 가리키는데 클릭이 증명 모달을 열면 그게 P-07 이 말하는 어긋남이다.
      // enabled 꺼짐·대조 미상·업로드 중은 **일부러** 막지 않는다: 눌러서 갈 만한 곳이 없다.
      if (!this.settings.apiKey || this.authFailed || this.teamKeyRejected()) { this.openOwnSettings(); return; }
      // 툴팁이 "눌러서 폴더를 고르세요"라고 말한다 — 클릭이 실제로 그 일을 해야 한다.
      if (this.scopeUnset()) { new OnboardingScopeModal(this.app, this).open(); return; }
      // 파일 탭이 아닌 상태에서 showProof 를 열면 getActiveFile()이 '최근 파일'을 돌려주어
      // **엉뚱한 노트의 증명**이 뜬다. 판정은 표시와 같은 술어를 쓴다(overviewViewActive).
      const f = this.app.workspace.getActiveFile();
      if (this.overviewViewActive() || !f || !this.isSealable(f)) { void this.openDashboard(); return; }
      this.showProof(); // 파일 상태일 때만 — 원래 동작
    });
    void this.updateActiveStatus();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isSealable(file)) this.onModify(file);
      })
    );
    // 참조 첨부 집합: 링크 인덱스가 갱신될 때마다(초기 인덱싱 완료 포함) 디바운스 재계산.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefRebuild()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
    // 노트의 마지막 탭/뷰가 닫히는 순간 감지 → dirty면 즉시 봉인(전환·포커스 이탈 즉시 봉인은 폐지)
    this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));
    // 파일 이동/삭제 시 states·failed 키를 이관/정리(무한 증식 방지)
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) void this.onRename(file, oldPath); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file instanceof TFile) void this.onDelete(file); }));
    this.activeFile = this.app.workspace.getActiveFile();
    this.openNotePaths = this.collectOpenNotePaths(); // 닫힘 감지의 초기 스냅샷
    // 앱 종료(X) 직전: 비동기 전송은 못 끝나므로 sendBeacon으로 확실히 보냄
    this.registerDomEvent(window, "beforeunload", () => this.beaconDirty());
    this.registerDomEvent(window, "pagehide", () => this.beaconDirty());

    // 전송 실패 큐 재시도(주기) — 설정 변경 시 재등록되도록 id 추적
    this.restartRetryInterval();
    // 자격(요금제·크레딧) 주기 갱신(1시간) — 결제/구독 변동 반영
    this.registerInterval(window.setInterval(() => void this.refreshEntitlement(), 60 * 60 * 1000));
    // 내 점검 결과 — 반려는 급하지만 자주 바뀌지 않는다(점검은 사람이 하는 일이다).
    // 시작 직후 한 번, 그 뒤 30분마다. 배지가 늦게 뜨면 놓치고, 너무 자주 물으면 낭비다.
    void this.refreshMyReviews();
    this.registerInterval(window.setInterval(() => void this.refreshMyReviews(), 30 * 60 * 1000));
    // 원문 보관 누락 감시 — 구독의 핵심이 원문 보관이라 "사람이 눌러야 발견되는" 구조로
    // 두면 안 된다(2026-07-30 실측: 260건이 그렇게 쌓였다).
    //
    // 간격은 **마지막 점검 이후 경과 시간**으로 판정한다(watchStorageGaps 안에서).
    // 인터벌만 쓰면 껐다 켤 때마다 돌고, 며칠 안 켜면 그동안 아무 점검도 없다.
    // 시작 2분 뒤에 한 번 재는 이유: 오래 안 켠 사용자를 그 자리에서 따라잡기 위해서다.
    // 시작 직후 한 번 — **고칠 것이 남아 있으면 경과 시간을 따지지 않는다.** 앱을 켠 것은
    // "지금 확인해도 좋다"는 신호이고, 누락이 있는 상태에서 한 시간을 더 기다릴 이유가 없다.
    // 누락이 없으면 평소 간격을 따른다(켤 때마다 S3 목록을 훑지 않게).
    window.setTimeout(() => void this.watchStorageGaps(this.settings.storageGapSeen > 0), 2 * 60 * 1000);
    // 확정 목록 보고는 점검과 별개다 — 목록이 이미 있는데 다음 점검까지 서버가 모르면
    // 그동안 고칠 수 없는 건수로 알람이 계속 온다. 바뀐 게 없으면 전송도 없다.
    window.setTimeout(() => void this.reportUnrecoverable(), 20 * 1000);
    this.registerInterval(window.setInterval(() => void this.watchStorageGaps(), 30 * 60 * 1000));
    // '앵커 중' 활성 노트만 주기 재검증(10분) — 비트코인 확정이 나면 전환 없이 상태바가 따라온다.
    // 확정은 몇 시간짜리이고 서버 확정표시도 hourly 워커라, 서버 상태는 잘해야 1h에 한 번 바뀐다.
    // → 클라이언트를 자주 두드릴 이유가 없어 10분으로. verify 캐시 TTL(60s) < 주기라 자동 재조회됨.
    this.registerInterval(window.setInterval(() => {
      if (this.activeAnchorPending) void this.updateActiveStatus();
    }, 600_000));
    // P1: 증명 원장 sweep — 하루 1회(확정된 새 앵커를 로컬 원장/미러에 반영). 로드 직후 1회는 onLayoutReady에서.
    this.registerInterval(window.setInterval(() => void this.ledgerSweep(), 24 * 60 * 60 * 1000));
    // 범위가 바뀌었는지 5분마다 본다(로컬 해시 한 번 — 달라졌을 때만 서버를 부른다).
    this.registerInterval(window.setInterval(() => void this.syncScopeSnapshot(), 5 * 60 * 1000));
    // 6시간마다 대조. mtime 캐시 덕에 변경분만 다시 읽으므로 반복 비용은 거의 없다.
    // 주기에도 지터를 준다 — 고정 주기면 한 번 몰린 무리가 계속 같이 몰린다.
    this.registerInterval(window.setInterval(
      () => window.setTimeout(() => void this.reconcile(), Math.floor(Math.random() * 300_000)),
      6 * 60 * 60 * 1000));

    this.addCommand({
      id: "seal-current-note",
      name: t.sealCmd,
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (f) this.flush(f, "manual");
        else new Notice(t.noNote);
      },
    });
    this.addCommand({ id: "proof-timeline", name: t.proofCmd, callback: () => this.showProof() });
    // 점검 요청 — 활성 파일이 봉인 대상이고 API 키가 있을 때만 노출(checkCallback).
    this.addCommand({
      id: "request-review",
      name: t.reviewReqCmd,
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!f && this.isSealable(f) && !!this.settings.apiKey;
        if (checking) return ok;
        if (f) void this.requestReview(f);
        return true;
      },
    });
    this.addCommand({ id: "anchor-now", name: t.anchorCmd, callback: () => this.anchorNow() });
    this.addCommand({ id: "submission-package", name: t.pkgCmd, callback: () => this.openSubmissionPackage() });
    this.addCommand({ id: "storage-recovery", name: t.recCmd, callback: () => {
      if (!this.settings.apiKey) return void new Notice(t.apiKeyMissing);
      new StorageRecoveryModal(this.app, this).open();
    } });
    this.addCommand({
      id: "nanal-storage-restore",
      name: t.nanalRestoreCmd,
      callback: () => void this.restoreFromNanal(),
    });
    // 건당 증명서(`issue-certificate`·`point-in-time-cert`)는 접었다(2026-08-05).
    // 제출 패키지가 그 일을 흡수했다 — zip 안에 '증명서(요약).pdf' 가 들어가고 그 PDF 자체가
    // 봉인돼 검증기가 노트와 같은 방식으로 대조한다. 서버의 `/attest/certificate` 도 사라진다.
    // 버전별 열람·검증 화면(ArchiveVersionModal)은 그대로 있다 — 노트 브라우저·'그날로'에서 연다.
    this.addCommand({
      id: "rewind-find-deleted",
      name: t.rewindFindCmd,
      checkCallback: (checking) => {
        if (!Platform.isDesktopApp) return false; // 로컬 git 아카이브 기반 — 모바일 숨김(스펙 C-2)
        if (!checking) void this.findDeletedNotes();
        return true;
      },
    });
    this.addCommand({
      id: "note-browser",
      name: t.browserCmd,
      callback: () => void this.openNoteBrowser(),
    });
    this.addCommand({ id: "restore-vault", name: t.restoreVaultCmd, callback: () => new RestoreVaultModal(this.app, this).open() });
    this.addCommand({ id: "public-link", name: t.publicCmd, callback: () => this.makePublicLink() });
    this.addCommand({ id: "view-pricing", name: t.pricingCmd, callback: () => this.openExternal("/pricing") });
    this.addCommand({ id: "my-account", name: t.accountCmd, callback: () => this.openExternal("/account") });
    this.addCommand({ id: "buy-pro", name: t.subscribeCmd, callback: () => this.openExternal("/pricing") }); // id는 기존 핫키 보존을 위해 유지, 동작은 직접 결제 → /pricing 열기로 변경
    this.addCommand({ id: "buy-credit", name: t.buyCreditCmd, callback: () => this.startCheckout("cert_single") });
    this.addCommand({ id: "password-reset", name: t.resetCmd, callback: () => new PasswordResetModal(this.app, this).open() });

    // 개발노트 템플릿(선택적 편의) 명령
    this.addCommand({ id: "new-dev-note", name: t.tplNewCmd, callback: () => this.newDevNote() });
    for (const key of ["bug", "decision", "trap", "cont"]) {
      this.addCommand({
        id: `insert-${key}`,
        name: t.tplInsCmd(`${tpl.cats[key].emoji} ${tpl.cats[key].label}`),
        callback: () => this.insertEntry(key),
      });
    }
    // 3.2: 조직(팀) 템플릿 — 수신·캐시된 것을 하드코딩 템플릿과 나란히 삽입 명령으로 노출("팀:" 접두).
    // 강제 없이 본문 삽입만. 캐시가 0개면 이 루프는 아무것도 등록하지 않아 기존 동작과 동일.
    // 명령은 onload 시점 캐시로 고정되므로, 프로파일이 갱신된 팀 템플릿은 다음 재시작부터 명령에 반영된다.
    this.settings.teamTemplates.forEach((tt, i) => {
      const body = tt.body;
      this.addCommand({
        id: `insert-team-${i}`,
        name: t.tplInsCmd(`${t.teamTplPrefix}${tt.name}`),
        editorCallback: (ed) => {
          if (!this.settings.templatesEnabled) { new Notice(t.tplOff); return; }
          ed.replaceSelection(body);
        },
      });
    });

    // 증빙 상태 대시보드(PRO — FREE는 티저)
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.registerView(ARCHIVE_SOURCE_VIEW_TYPE, (leaf) => new ArchiveSourceView(leaf, this));
    this.registerView(NOTE_BROWSER_VIEW_TYPE, (leaf) => new NoteBrowserView(leaf, this));
    this.addCommand({ id: "open-dashboard", name: t.dashCmd, callback: () => void this.openDashboard() });
    this.addCommand({ id: "create-monthly-digest", name: t.digestCmd, callback: () => void this.createDigest() });

    // §7b 업무 요청함 — 우측 사이드바 패널 + 리본 배지 + 5분 폴링(팀 미소속이면 pollTasks가 스스로 침묵).
    this.registerView(TASK_INBOX_VIEW_TYPE, (leaf) => new TaskInboxView(leaf, this));
    this.addCommand({ id: "open-task-inbox", name: t.taskInboxCmd, callback: () => void this.openTaskInboxDefault() });
    // §3 폴더 만들기 — 통합 모달(팀 표준 + 참여 과제 목록·상태·체크 생성). 구 명령 id는 하위호환 위해 유지(둘 다 같은 모달).
    this.addCommand({ id: "create-project-kit", name: t.projKitCmd, callback: () => new FolderCreateModal(this.app, this).open() });
    this.addCommand({ id: "create-team-folders", name: t.teamKitCmd, callback: () => new FolderCreateModal(this.app, this).open() });
    // 자동 제안을 "나중에"로 미뤘거나 놓쳤을 때의 상시 진입점(2026-07-26).
    this.addCommand({ id: "sync-team-folder-names", name: t.folderSyncCmd, callback: () => void this.syncFolderNames(true) });
    this.updateTaskRibbon();
    this.registerInterval(window.setInterval(() => void this.pollTasks(), TASK_POLL_MS));
    // SSE 준실시간(데스크톱 전용·모바일은 배터리 고려로 기존 폴링만) — 실패해도 폴링이 안전망.
    this.register(() => this.stopTaskSse());
    this.startTaskSse();

    this.addSettingTab(new NanalStampSettingTab(this.app, this));
    // 온보딩 내용 자체는 설정 화면 상단 소개 섹션이 담당한다(환영 모달은 폐지).
    // 첫 활성화 1회만 그 설정 화면으로 데려다준다 — onload 말미의 onboarded 블록 참조.
    void this.refreshEntitlement();
    // 재시작 따라잡기: 워크스페이스 준비 후, 마지막 실행 이후 수정된 노트를 봉인(강제종료 복구)
    this.app.workspace.onLayoutReady(() => {
      this.openNotePaths = this.collectOpenNotePaths(); // 워크스페이스 복원 완료 시점의 실제 열림 집합으로 재스냅샷
      void this.ensureArchive(); // P1.5: 아카이브 폴더 보장 + .git init(데스크탑만)
      // Task 12(2026-08-05): 팀 소속 흔적이 있는데 자동 적용이 꺼져 있으면 되돌린다(1회 교정).
      // 흔적이 없으면(개인 사용자) 아무 일도 하지 않는다 — settingtab.ts의 teamLocked와 같은 판정.
      // 설정 탭을 한 번도 안 여는 팀원도 여기서 잡힌다 — 잠금을 탭 진입에만 걸면 그 사람은
      // 계속 꺼진 채로 남는다.
      if (!this.settings.teamProfileEnabled && (this.settings.teamApiKey || this.settings.teamRole !== "")) {
        this.settings.teamProfileEnabled = true;
        void this.saveSettings();
      }
      // 3.2: 로드 시 키가 있고 자동 적용이 켜져 있으면 팀 프로파일 1회 수신(비동기·실패 무시).
      if (this.settings.teamProfileEnabled && this.settings.apiKey) void this.fetchTeamProfile();
      // 4.3: custody 미러 정보도 같은 타이밍에 1회 수신(팀 프로파일 토글과 무관 — custody는 별개 정책).
      if (this.settings.apiKey) void this.fetchTeamMirrorInfo();
      void this.catchUp();
      void this.pollTasks(); // §7b: 로드 직후 1회 — 배지·스냅샷 기준 수립(팀 미소속이면 조용히 무시)
      void this.refreshProjects(); // §3: active 과제 목록 + 귀속 동기화(팀 미소속·실패는 침묵)
      void this.ledgerSweep(); // P1: 로드 직후 1회 — 확정된 증명을 로컬 원장/미러에 반영
      // 범위 스냅샷: 로드 직후 1회. 변경 지점(설정탭·시작범위 모달·팀 합류)이 여러 곳이라
      // 각 지점에 심는 대신 한 곳에서 **현재 범위**를 보고 판단한다 — 심는 자리를 빠뜨리면
      // 그 경로로 바뀐 범위만 조용히 기록되지 않는다.
      void this.syncScopeSnapshot();
      // 차집합 대조 — 로드 직후 1회. 로컬이 무엇을 기억하든 서버에 물어 봉인 대상을 다시 정한다.
      // **지터**: 곧바로 부르지 않는다. 아침에 다들 Obsidian 을 켜면 로드 직후 대조가 한꺼번에
      // 몰린다 — 총량은 가볍지만(인덱스 조회 2.5ms) 스파이크는 다른 문제다. 0~90초로 흩는다.
      window.setTimeout(() => void this.reconcile(), Math.floor(Math.random() * 90_000));
      this.startBackfill(); // 초기 백필: 기존 미봉인 노트를 백그라운드에서 천천히(3초 1건) 봉인
      void this.syncLineageFile(); // 아카이브 lineage.json ↔ renameMap 병합(기기 이전·데이터 초기화 복원)
      // 시작 범위 모달: 이미 로그인된 기존 사용자가 이 기능이 추가된 뒤 처음 로드하는 경우(1회).
      // 신규 로그인 직후 트리거는 설정탭 로그인 버튼 onClick에 별도로 있다(그 시점엔 아직 워크스페이스가 안 열려 있을 수 있음).
      if (this.settings.enabled && this.settings.apiKey && !this.settings.scopeChosen && !this.scopeModalOpen) {
        new OnboardingScopeModal(this.app, this).open();
      }
      // create 이벤트는 layout-ready 이후에 등록한다.
      // (Obsidian은 초기 vault 로드 시 기존 모든 파일에도 create를 발생시키므로,
      //  여기서 등록해야 "이후 새로 생기는 .md"(외부 AI·도구 포함)만 봉인 대상이 된다.)
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!(file instanceof TFile)) return;
          void this.applyFolderTemplate(file);
          if (this.isSealable(file)) this.onModify(file);
        })
      );
    });

    // 첫 활성화 1회 — 설치 직후 아무 안내가 없으면 시작점을 찾지 못한다(2026-08-08 퍼널 검토).
    // onLayoutReady 이후에 연다: 로드 중 설정 모달이 뜨면 vault 초기화와 겹쳐 어색하다.
    if (!this.settings.onboarded) {
      this.app.workspace.onLayoutReady(() => {
        this.settings.onboarded = true;
        void this.saveSettings();
        if (!this.settings.apiKey) {
          new Notice(t.onboardNotice, 8000);
          this.openOwnSettings();
        }
      });
    }
  }

  /** 이 플러그인의 설정 탭을 연다. setting API는 공개 타입에 없어 any 캐스팅(커뮤니티 관례). */
  openOwnSettings(): void {
    const s = (this.app as any).setting;
    if (!s?.open) return; // 비공식 API — 없는 환경에서 던지면 클릭이 무반응이 된다(고치려던 증상과 같은 모양).
    s.open();
    s.openTabById?.(this.manifest.id);
  }

  onunload() {
    this.stopTaskSse(); // SSE 스트림·재연결 루프 절단 — 플러그인 비활성 후 잔존 연결 방지(스토어 심사 요건)
    if (this.statusDebounceTimer !== undefined) window.clearTimeout(this.statusDebounceTimer);
    if (this.refSetTimer !== undefined) window.clearTimeout(this.refSetTimer);
    for (const [path, s] of this.states) {
      if (s.timer) window.clearTimeout(s.timer);
      if (s.dirty) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) this.flush(f, "unload");
      }
    }
    this.states.clear();
    this.verifyCache.clear();
  }

  /// 팀 폴더에서 만든 **빈** 새 노트에 팀 서식을 넣는다(2026-08-02).
  ///
  /// 서식을 배포해도 새 노트가 빈 채로 생기면 아무도 안 쓴다. 관리자가 한 번 정하면
  /// 팀원은 그냥 노트를 만들기만 하면 되게 한다.
  ///
  /// **비어 있을 때만** 쓴다. 이미 내용이 있는 파일(외부 도구·동기화·복원으로 생긴 것)에
  /// 서식을 덮으면 남의 기록을 지우는 것이다 — 되돌릴 수 없다.
  /// 커서는 첫 빈 칸으로 보내지 않는다(Templater 가 설치돼 있으면 서로 다툰다).
  private async applyFolderTemplate(file: TFile): Promise<void> {
    if (!this.settings.teamProfileEnabled) return;
    if (file.extension !== "md") return;
    let st: TeamStructure | null = null;
    try { st = parseTeamStructure(JSON.parse(this.settings.teamStructure)); } catch { return; }
    if (!st) return;
    const seg = teamFolderSegment(st, file.path);
    if (!seg) return;
    // 관리자가 팀 설정에서 이어 준 규칙이 먼저. 없으면 이름 규약(번호 뗀 폴더 이름).
    const rules = st.folderRules ?? {};
    const rule = kitRuleFor(rules, seg.folder);
    const folder = rule.prefix;
    try {
      // create 직후라 아직 안 쓰였을 수 있다 — 한 틱 기다렸다가 **빈지 확인하고** 쓴다.
      await new Promise((r) => window.setTimeout(r, 50));
      const cur = await this.app.vault.read(file);
      if (cur.trim().length > 0) return;

      // 서식은 **vault 를 먼저** 본다. 이유가 둘이다:
      //   1) 과제 폴더의 서식은 서버 구조(st.templates)에 없다 — 과제 킷이 vault 에 깔아 둔다.
      //   2) 팀원이 눈앞의 서식 파일을 고쳤으면 그게 반영돼야 한다. 서버 사본을 우선하면
      //      "파일을 고쳤는데 왜 옛날 것이 나오지"가 된다.
      // vault 에 없으면 서버 구조의 서식으로 떨어진다(관리자가 막 배포하고 아직 안 만든 경우).
      // 규칙이 서식을 콕 집었으면 그 파일을 읽는다(킷 뿌리 기준 상대 경로).
      let body: string | null = null;
      if (rule.template) {
        const f = this.app.vault.getAbstractFileByPath(`${seg.kitRoot}/${rule.template}`);
        if (f instanceof TFile) { try { body = await this.app.vault.read(f); } catch { body = null; } }
      }
      if (body === null) body = (await this.templateBodyFromVault(file, folder)) ?? templateForFolder(st, file.path);
      if (body) await this.app.vault.modify(file, body);

      // 제목이 「무제」로 남으면 목록에서 무엇이 무엇인지 알 수 없다. 폴더가 이미 성격을
      // 말하고 있으니 그걸 쓴다 — `연구노트-2026-08-02`. **사람이 지은 이름은 건드리지 않는다.**
      if (!isUntitledName(file.basename)) return;
      const dir = file.parent ? file.parent.path : "";
      const date = new Date();
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const name = nextNoteName(folder, iso,
        (n) => this.app.vault.getAbstractFileByPath(`${dir}/${n}.md`) !== null);
      // renameFile 을 쓴다(vault.rename 이 아니라) — 다른 노트가 건 링크를 함께 고쳐 준다.
      await this.app.fileManager.renameFile(file, `${dir}/${name}.md`);
    } catch (e) {
      console.warn("[nanalstamp] 폴더 서식 적용 실패", file.path, e);
    }
  }

  /// 이 노트가 속한 묶음(공통 또는 과제)의 `9N-…` 폴더에서 서식 파일을 찾는다.
  /// 짝짓는 규칙은 서버 구조와 같다 — **번호를 뗀 폴더 이름이 서식 파일명에 들어 있으면 그것**.
  private async templateBodyFromVault(file: TFile, folder: string): Promise<string | null> {
    // 묶음 뿌리 = 이 파일이 놓인 폴더의 부모들 중 `9N-…`을 가진 곳.
    let dir = file.parent;
    for (let up = 0; up < 4 && dir; up++, dir = dir.parent) {
      const parent = dir.parent;
      if (!parent) break;
      const tplDir = parent.children.find(
        (c) => c instanceof TFolder && /^9\d-/.test(c.name));
      if (!(tplDir instanceof TFolder)) continue;
      let best: TFile | null = null;
      for (const c of tplDir.children) {
        if (!(c instanceof TFile) || c.extension !== "md") continue;
        if (!c.basename.includes(folder)) continue;
        if (!best || c.basename.length < best.basename.length) best = c;
      }
      if (best) { try { return await this.app.vault.read(best); } catch { return null; } }
    }
    return null;
  }

  // M2: 봉인 범위 — 팀 루트와 개인 폴더의 **합집합**(2026-07-27).
  //
  // 예전에는 팀 루트가 있으면 거기서 조기 반환해 개인 설정을 통째로 덮었다. 그런데 개인으로
  // 쓰다가 팀에 합류하는 순서가 정상이고, 그때 **봉인 폴더가 늘어나야지 사라지면 안 된다** —
  // 합류 이후 개인 노트가 조용히 봉인 대상에서 빠지면 그 기간의 기록에 공백이 생기고,
  // 봉인은 소급되지 않으므로 되돌릴 수 없다.
  //
  // 판정 순서:
  //  1) 제외 폴더에 걸리면 무조건 제외(팀 루트보다 우선 — 사용자가 명시적으로 뺀 것이다)
  //  2) 팀 루트 아래면 포함(참여 과제도 루트 아래라 별도 처리 불필요)
  //  3) 개인 포함 폴더에 들어가면 포함
  //  4) 개인 포함 폴더가 **비어 있을 때**의 의미는 팀 여부로 갈린다:
  //     - 팀 루트 없음 → "전체"(기존 동작 유지, 비팀 사용자의 기본값)
  //     - 팀 루트 있음 → 팀 루트만(합류했는데 vault 전체가 갑자기 대상이 되면 안 된다)
  /// 제출 패키지 모달이 폴더 목록을 만들 때 쓰는 판정 — inScope 와 **같은 술어**다.
  /// 화면이 고를 수 있다고 한 폴더에서 아무것도 안 담기면 그건 화면이 거짓말한 것이다.
  inPackageScope(p: string): boolean { return this.inScope(p); }

  private inScope(p: string): boolean {
    // 복원 사본은 봉인 대상이 아니다 — 재봉인 무의미 + 재구성 순환(2026-07-22 실증).
    if (isRestoredCopy(p)) return false;
    return inFolderScopePure(p, this.teamRoot(),
      parseFolders(this.settings.includeFolders), parseFolders(this.settings.excludeFolders),
      this.settings.sealWholeVault);
  }


  /// 봉인 스코프 판정(첨부 포함) — 범위 내 노트가 참조하는 첨부는 **폴더 위치와 무관하게** 통과시킨다
  /// (2026-07-25 사용자 확정, Task 11). 근거: 증명 제품에서 노트만 봉인되고 참조 첨부가 빠지면 원본이
  /// 불완전해진다. 전역 첨부 폴더(vault 최상위 attachments/ 등)를 쓰는 팀원이 팀 루트 밖이라는 이유로
  /// 첨부를 통째로 잃는 것을 막는다. 범위는 "참조됨"으로 이미 밑혀 있다 — referencedAttachments는
  /// rebuildReferencedSet이 **범위 내 .md가 참조하는** 비-md만 모으므로(inScope(src) 필터) 첨부 폴더의
  /// 잡파일은 여전히 제외된다. 판정 자체는 순수 함수(inSealScopePure, inFolderScopePure, sealscope.ts)에 위임.
  /// 순서 의존성: referencedAttachments는 resolved 이벤트 디바운스로 rebuildReferencedSet이 채운다 —
  /// 플러그인 로드 직후엔 비어 있을 수 있어 그 시점 첨부는 면제를 못 받고 스킵된다(새로 만드는 문제는
  /// 아니다 — scheduleRefRebuild 주석대로 "재계산 직후 새로 참조된 첨부를 즉시 큐잉하진 않는다 — 다음
  /// 스윕이 자연 포착").
  private inSealScope(path: string): boolean {
    const isRestored = isRestoredCopy(path);
    // 팀이 "샘플도 봉인"을 켰으면 샘플 게이트를 끈다(기본은 꺼짐 = 샘플 봉인 안 함).
    const sample = !this.settings.sealKitSamples && isKitSample(path);
    return inSealScopePure(isRestored, this.referencedAttachments.has(path), this.inScope(path), sample);
  }

  /// 팀 표준 구조가 스코프를 지배 중이면 최상위 루트 폴더 이름, 아니면 null(로컬 설정 경로).
  /// 설정 탭 안내·폴더 만들기 모달·과제 귀속이 모두 이 값을 쓴다(경로 프리픽스의 단일 출처).
  /// 의도된 행동 변화(스펙 §4b): 팀 루트 아래 *미참여* 과제 폴더도 봉인 대상이 된다 — 관리자가
  /// 정한 팀 표준 영역 전체가 기록 영역이라는 취지에 맞고, 스코프가 "폴더 하나"로 예측 가능해진다.
  /// 이 경로가 팀 최상위 루트 아래인가. 팀 미소속이면 false.
  ///
  /// 서버는 경로를 해시로만 알아 이 판정을 스스로 할 수 없다(0017). 잘못 가르면 팀 관리자에게
  /// 팀원의 개인 노트가 보인다 — 2026-07-31 에 실제로 그랬다. 규약은 한 곳에만 둔다.
  inTeamRoot(p: string): boolean {
    return inTeamRootPure(p, this.teamRoot());
  }

  teamRoot(): string | null {
    if (!this.settings.teamProfileEnabled || !this.settings.teamStructure) return null;
    // 메모이즈: inScope가 vault 스윕에서 노트마다 호출 — teamStructure(템플릿 body 포함, 최대 ~1.6MB)를
    // 매번 JSON.parse하지 않는다. teamStructure는 applyTeamProfile에서만 재작성되므로 문자열 동일성으로 안전.
    if (this.teamRootCache && this.teamRootCache.src === this.settings.teamStructure) return this.teamRootCache.root;
    let root: string | null = null;
    try {
      const s: TeamStructure | null = parseTeamStructure(JSON.parse(this.settings.teamStructure));
      root = s ? s.root : null;
    } catch { root = null; }
    this.teamRootCache = { src: this.settings.teamStructure, root };
    return root;
  }

  // 봉인 대상인가 — .md는 항상, 첨부는 범위 내 노트가 참조할 때만(형식 무관, 확장자 필터 없음).
  // 폴더 범위(inScope)와는 별개(첨부 자체의 경로가 아니라 "참조하는 노트"의 범위가 기준).
  private isSealable(file: TFile): boolean {
    return isSealableFile(file.extension, this.settings.sealAttachments, this.referencedAttachments.has(file.path));
  }
  // 경로 기준 봉인 대상 판정(대시보드 등 외부용) — 첨부는 "지금도 참조되는가"까지 본다.
  // 참조가 끊긴 첨부는 스윕·백필이 영원히 안 보므로(isSealable=false) 동기화 우주에서도 빼야 한다.
  sealablePath(path: string): boolean {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && this.isSealable(f);
  }

  // 참조 첨부 집합 재계산: resolvedLinks(해석 완료 링크 인덱스, 순수 메모리)를 순회해
  // "범위 내 .md 노트가 참조하는 비-md 경로"를 수집한다. 파일 I/O 없음 — 대형 vault(수만 링크)에서도 ms 단위.
  /// 보관 용량이 차 가면 미리 알린다. 같은 단계에서 두 번 알리지 않는다(내려가면 다시 알릴 수 있게 초기화).
  private async warnQuotaNearFull(): Promise<void> {
    const u = this.lastUsage;
    if (!u || !(u.quota > 0)) { if (this.settings.quotaWarnedAt) { this.settings.quotaWarnedAt = 0; await this.saveSettings(); } return; }
    const pct = Math.floor((u.used / u.quota) * 100);
    const step = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
    if (step === this.settings.quotaWarnedAt) return;
    this.settings.quotaWarnedAt = step;
    await this.saveSettings();
    if (step === 0) return;
    new Notice(t.quotaNear(step, Math.max(0, u.quota - u.used)), 12000);
  }

  /// 이 파일을 봉인하면 안 되는 사유(없으면 null). 판정 규칙은 holdcore(순수 모듈)에 있다.
  private sealHoldOf(file: TFile): HoldReason | null {
    const { limitMB, byTeam } = effectiveLimit(this.settings.attachmentMaxMb, this.settings.teamAttachmentMaxMB);
    const own = { path: file.path, size: file.stat.size, isNote: isMarkdownPath(file.path) };
    // 이 노트가 참조하는 첨부. 노트가 아니면 자기 자신만 본다(holdcore 가 처리).
    const atts: Array<{ path: string; size: number }> = [];
    if (own.isNote) {
      const links = this.app.metadataCache.resolvedLinks[file.path] ?? {};
      for (const target in links) {
        if (isMarkdownPath(target)) continue;
        const f = this.app.vault.getAbstractFileByPath(target);
        if (f instanceof TFile) atts.push({ path: f.path, size: f.stat.size });
      }
    }
    // 쿼터는 **스토리지를 쓰는 경우만**. FREE 는 로컬 아카이브뿐이라 봉인을 막지 않는다.
    const storage = this.nanalActive() && this.lastUsage ? this.lastUsage : null;
    return sealHold(own, atts, limitMB, byTeam, storage);
  }

  /// 보류를 기록하고 알린다. **파일당 한 번만** 알린다 — 자동 봉인이 매 틱 재시도하므로
  /// 그때마다 띄우면 소음이 되고, 정작 중요한 첫 알림이 묻힌다. 대신 목록으로 상시 노출한다.
  private async noteSealHold(path: string, h: HoldReason, interactive: boolean): Promise<void> {
    const known = this.settings.sealHolds[path];
    this.settings.sealHolds[path] = h.kind === "attach"
      ? { kind: "attach", path: h.path, size: h.size, limitMB: h.limitMB, byTeam: h.byTeam, at: Date.now() }
      : { kind: "quota", path: "", size: h.need, limitMB: 0, at: Date.now() };
    await this.persist();
    void this.updateActiveStatus();
    this.updateTaskRibbon();
    if (known && !interactive) return;   // 이미 알린 건은 조용히(사람이 직접 누른 경우만 다시 알린다)
    // 팀 정책 때문에 막힌 것이면 **요금제를 올려도 소용없다** — 팀 정책이 더 엄격하면
    // 그쪽이 이긴다. 그런데도 "Max 로 올리면 담을 수 있습니다"라고 안내하면 돈을 더 내도
    // 안 되는 길을 가리키는 것이다(2026-07-30 e2e 에서 실제로 그렇게 나왔다).
    const byTeam = h.kind === "attach" && h.byTeam;
    const up = byTeam ? null
      : planThatFits(this.pricingPlans, h.kind === "attach" ? h.size : 0, this.settings.attachmentMaxMb);
    if (h.kind === "attach") {
      new Notice(t.holdAttach(basenameOf(h.path), Math.ceil(h.size / MB), h.limitMB, h.byTeam,
        up ? `${up.name}(${up.attachment_max_mb}MB)` : null), 15000);
    } else {
      new Notice(t.holdQuota(h.used, h.quota), 15000);
    }
  }

  /// 보류 목록을 다시 본다 — **원인이 사라진 항목을 남겨 두면 안 된다.**
  /// 파일을 지웠거나, 첨부 링크를 뺐거나, 첨부를 줄였거나, 요금제를 올렸으면 스스로 풀린다.
  /// (삭제 이벤트만으로는 부족하다: 링크를 빼서 더 이상 봉인 대상이 아니게 된 경우가 안 잡힌다.)
  private async reviewSealHolds(): Promise<void> {
    for (const notePath of Object.keys(this.settings.sealHolds)) {
      const f = this.app.vault.getAbstractFileByPath(notePath);
      if (!(f instanceof TFile)) { await this.clearSealHold(notePath); continue; }
      if (!this.inSealScope(notePath)) { await this.clearSealHold(notePath); continue; }
      if (!this.sealHoldOf(f)) {
        // 원인이 풀렸으면 **여기서 바로 봉인한다.** 목록에서 빼기만 하면 아무 일도 일어나지 않는다 —
        // 첨부를 줄여도 노트 자체는 바뀌지 않아 봉인 트리거(dirty)가 서지 않기 때문이다.
        // 실제로 e2e 에서 "보류는 풀렸는데 영영 봉인되지 않는" 상태가 잡혔다(2026-07-30).
        await this.clearSealHold(notePath);
        this.flush(f, "retry");
      }
    }
  }

  /// 조건이 풀렸을 때(첨부를 줄였거나 요금제를 올렸을 때) 목록에서 뺀다.
  private async clearSealHold(path: string): Promise<void> {
    delete this.settings.sealHolds[path];
    await this.persist();
    void this.updateActiveStatus();
    this.updateTaskRibbon();
  }

  rebuildReferencedSet() {
    const next = new Set<string>();
    const links = this.app.metadataCache.resolvedLinks;
    for (const src in links) {
      if (!isMarkdownPath(src) || !this.inScope(src)) continue;
      for (const target in links[src]) {
        if (!isMarkdownPath(target)) next.add(target);
      }
    }
    this.referencedAttachments = next;
  }
  // resolved 이벤트는 초기 인덱싱·대량 변경 시 연발 → SETTLE_MS 트레일링 디바운스로 1회만 재계산.
  // 재계산 직후 새로 참조된 첨부를 즉시 큐잉하진 않는다 — 다음 스윕(backfill·ledgerSweep·catchUp)이 자연 포착.
  private scheduleRefRebuild() {
    if (this.refSetTimer !== undefined) window.clearTimeout(this.refSetTimer);
    this.refSetTimer = window.setTimeout(() => {
      this.refSetTimer = undefined;
      this.rebuildReferencedSet();
    }, SETTLE_MS);
  }
  // 0.2: .md만 텍스트(read/cachedRead)로, 그 외 첨부는 바이트(readBinary)로 다룬다 — 해시·아카이브·미러 공통.
  protected isBinary(file: TFile): boolean {
    return file.extension.toLowerCase() !== "md";
  }
  // 업로드(클라우드 보관) 유효 상한(MiB) — 쿼터가 유일한 비용 경계, 파일당은 팀 거버넌스와 서버 하드캡뿐.
  // 팀 정책(teamAttachmentMaxMB, 0=무제한)이 있으면 그것(단, 서버 하드캡 5GB를 넘을 순 없음), 없으면 5GB.
  // 봉인(해시)에는 상한이 없다 — 이 값은 원본 클라우드 보관에만 적용된다.
  /// 첨부 업로드 상한(MiB). **0 = 무제한.**
  ///
  /// 서버의 5GB 는 presign **한 건**의 크기 상한(S3 단일 PUT 한도)이지 파일 크기 상한이 아니다.
  /// 512KiB 를 넘는 원본은 CDC 로 잘게 쪼개 조각마다 presign 하므로 그 검사에 걸릴 수가 없다 —
  /// 그런데도 이 값을 파일 전체 크기에 적용해 막고 있었다(서버 제약을 잘못 옮긴 것, 2026-07-30).
  /// 스트리밍 업로드로 메모리도 파일 크기와 무관해졌으므로, 남는 제한은 **팀 정책뿐**이다.
  uploadLimitMB(): number {
    const team = this.settings.teamAttachmentMaxMB;
    return team != null && team > 0 ? team : 0;   // 0 = 무제한(isOverSizeLimit 이 false)
  }
  // 이 첨부가 클라우드 보관(업로드) 대상에서 제외되는가(.md는 상한 없음). 봉인 여부와는 무관.
  protected overUploadLimit(file: TFile): boolean {
    return this.isBinary(file) && isOverSizeLimit(file.stat.size, this.uploadLimitMB());
  }
  // 업로드 스킵 사유가 팀 정책인가(안내 문구 분기) — 팀 상한이 하드캡보다 좁을 때만 팀 정책이 원인.
  uploadSkipByTeam(): boolean {
    return this.uploadLimitMB() > 0;   // 이제 상한은 팀 정책일 때만 존재한다
  }
  // 업로드 정책 스킵 기록: attachSkipped(설정탭 노출) + 최초 1회 Notice(사유: 팀 정책 vs 5GB 하드캡).
  // 봉인은 이미 유효하므로 문구도 "보관 제외"로만 말한다.
  protected async noteUploadSkip(file: TFile): Promise<void> {
    if (this.settings.attachSkipped.includes(file.path)) return;
    this.settings.attachSkipped.push(file.path);
    await this.persist();
    new Notice(this.uploadSkipByTeam() ? t.uploadSkipTeam(file.name, this.uploadLimitMB()) : t.uploadSkipHardCap(file.name));
  }
  // 한도 이내로 돌아왔거나 정책이 완화됐으면 스킵 기록 해제(업로드 경로에서 게이트 통과 시 호출).
  protected async clearUploadSkip(path: string): Promise<void> {
    if (!this.settings.attachSkipped.includes(path)) return;
    this.settings.attachSkipped = this.settings.attachSkipped.filter((p) => p !== path);
    await this.persist();
  }
  // 대형 파일(LARGE_UPLOAD_NOTICE_MB 이상) 업로드는 진행하되 1회 정보성 알림 — 쿼터 소모를 인지시킨다(차단 아님).
  protected maybeNoticeLargeUpload(file: TFile): void {
    if (file.stat.size < LARGE_UPLOAD_NOTICE_MB * 1024 * 1024) return;
    if (this.largeUploadNotified.has(file.path)) return; // 세션 내 같은 파일 반복 알림 방지
    this.largeUploadNotified.add(file.path);
    const pct = this.lastUsage && this.lastUsage.quota > 0 ? Math.round((file.stat.size / this.lastUsage.quota) * 100) : null;
    new Notice(t.largeUploadNotice(file.name, fmtBytes(file.stat.size), pct));
  }
  // 청크 업로드 진행률 세팅+상태바 즉시 반영(1초 틱에 의존하지 않음 — 조각 완료마다 텍스트만 갱신, 서버 호출 없음).
  // null이면 진행 종료 → 정식 상태 갱신으로 복원.
  protected setUploadProgress(p: { path: string; done: number; total: number } | null): void {
    this.uploadProgress = p;
    if (p) this.setStatus(t.uploadProgress(p.done, p.total), p.path, "faded");
    else void this.updateActiveStatus();
  }
  // 0.2: 봉인용 해시 — .md는 UTF-8 텍스트, 첨부는 원바이트. 봉인·검증·백필이 모두 이걸 써 커밋먼트가 일치한다.
  protected async hashOf(file: TFile, cached = false): Promise<string> {
    // 캐시 읽기는 .md 에서만 의미가 있다(첨부는 바이트가 필요). 나머지는 아래 한 곳으로 모은다 —
    // 해시 규칙이 두 벌이 되면 한쪽만 고쳐도 신호가 없고, 그때 커밋먼트가 갈린다.
    if (cached && !this.isBinary(file)) return sha256Hex(await this.app.vault.cachedRead(file));
    return (await this.hashWithContent(file)).hash;
  }

  /// 봉인용 해시 + **그때 읽은 바로 그 내용**.
  ///
  /// 왜 함께 내나(2026-07-30): 예전에는 flush 가 해시만 계산하고, 원문 보관(recordSealProof)이
  /// 파일을 **다시 읽었다.** 그 사이에는 서버 왕복이 한 번 들어가므로, 사용자가 계속 타이핑하면
  /// 내용이 달라진다. 그러면 해시가 안 맞아 그 버전은 조용히 포기됐다 —
  /// **사슬에는 기록이 남고 원본만 영원히 없어진다.** 알림도 없었다.
  /// 봉인 순간이 그 버전 원문의 유일한 포착 지점이므로, 그때 읽은 바이트를 그대로 넘긴다.
  ///
  /// 대형 첨부(ARCHIVE_INLINE_MAX 초과)만 예외다 — 힙에 올리면 파일 크기의 몇 배를 문다
  /// (실측: 625MB 첨부 하나가 읽기만으로 +631MB, git.add 까지 가면 RSS 2GB).
  /// 그쪽은 content=null 로 두고 예전처럼 파일에서 흘려 읽는다.
  protected async hashWithContent(file: TFile): Promise<{ hash: string; content: string | ArrayBuffer | null }> {
    if (this.isBinary(file)) {
      if (file.stat.size > ARCHIVE_INLINE_MAX) {
        const abs = this.absPathOf(file);
        if (abs) return { hash: await this.hashFileStream(abs), content: null };
      }
      const buf = await this.app.vault.readBinary(file);
      return { hash: await sha256HexBytes(buf), content: buf };
    }
    const content = await this.app.vault.read(file);
    return { hash: await sha256Hex(content), content };
  }

  private stateOf(path: string): FileState {
    let s = this.states.get(path);
    if (!s) {
      s = { lastAttestAt: 0, dirtyAt: 0, lastHash: "", dirty: false };
      this.states.set(path, s);
    }
    return s;
  }

  private onModify(file: TFile) {
    if (!this.settings.enabled || !this.inSealScope(file.path)) return;
    const s = this.stateOf(file.path);
    const wasDirty = s.dirty;
    s.dirty = true;
    // 5분 카운트는 '봉인 대기 시작(clean→dirty 전환)'부터 — 마지막 봉인 시각 기준이 아니다.
    if (!wasDirty) s.dirtyAt = Date.now();
    if (s.timer) window.clearTimeout(s.timer);
    s.timer = window.setTimeout(() => this.onSettle(file), SETTLE_MS);
    if (!wasDirty) void this.updateActiveStatus();
  }

  // 입력이 멈춘 순간: 최소 간격이 지났을 때만 봉인(타이핑 중 경계 봉인 방지)
  private onSettle(file: TFile) {
    const s = this.stateOf(file.path);
    s.timer = undefined;
    if (!this.settings.enabled || !s.dirty) return;
    if (Date.now() - s.dirtyAt >= MIN_INTERVAL_MS) this.flush(file, "settle");
  }

  // 활성 노트 전환: 추적·상태바 갱신만 — 전환 즉시 봉인은 폐지(닫힘·시간 규칙이 봉인을 담당).
  private onLeafChange() {
    this.activeFile = this.app.workspace.getActiveFile();
    this.scheduleStatusUpdate(); // 빠른 연속 전환 시 마지막 것만 verify 조회
  }

  // 현재 열려 있는 마크다운 노트의 경로 집합(같은 노트가 여러 탭이어도 경로는 1개).
  // 첨부는 마크다운 뷰가 아니므로 대상 아님 — 첨부 봉인은 기존 시간 규칙(settle/sweep)이 처리.
  private collectOpenNotePaths(): Set<string> {
    const paths = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as MarkdownView).file;
      if (file) paths.add(file.path);
    }
    return paths;
  }

  // 노트의 마지막 탭/뷰가 닫히는 순간 → dirty면 즉시 봉인(5분 무시).
  // layout-change마다 열림 집합을 직전 스냅샷과 비교 — 있었는데 없어진 경로 = 닫힘.
  // 같은 노트가 여러 탭에 열려 있으면 마지막 뷰가 닫힐 때만 집합에서 사라지므로 자연히 1회만 발동.
  // layout-change는 빈발하지만 이 비교는 경로 Set 연산뿐이라 디바운스 불필요.
  private onLayoutChange() {
    const next = this.collectOpenNotePaths();
    const prev = this.openNotePaths;
    this.openNotePaths = next; // 선교체 — flush 중 재진입해도 같은 닫힘을 두 번 처리하지 않음
    if (!this.settings.enabled) return;
    for (const path of prev) {
      if (next.has(path)) continue;
      const s = this.states.get(path);
      if (!s?.dirty) continue;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile && this.inSealScope(path)) void this.flush(f, "close");
    }
  }

  // 실패 큐 재시도
  private retryFailed() {
    if (!this.settings.enabled || this.authFailed || this.failed.size === 0) return;
    if (this.backoffUntil > Date.now()) return; // 429 백오프 중이면 건너뜀
    let pruned = false;
    for (const p of Array.from(this.failed)) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) this.flush(f, "retry");
      else { this.failed.delete(p); pruned = true; }
    }
    if (pruned) void this.persistFailed();
  }

  // 재시도 인터벌 (재)등록 — 주기는 RETRY_MS 상수(사용자 설정 아님).
  private restartRetryInterval() {
    if (this.retryTimer !== undefined) window.clearInterval(this.retryTimer);
    this.retryTimer = window.setInterval(() => { this.retryFailed(); this.retrySealArchive(); this.sweepSeals(); void this.reviewSealHolds(); }, RETRY_MS);
    this.registerInterval(this.retryTimer); // unload 시 정리 보장
  }

  // 재시작 따라잡기: 마지막 실행 이후 수정된 노트를 봉인(강제종료로 놓친 것 복구).
  // 서버가 같은 (user, file_hash)는 멱등 처리하므로 이미 봉인된 내용 재전송도 안전.
  private async catchUp() {
    if (!this.settings.enabled || !this.settings.apiKey) return;
    if (!this.sealingAllowed()) return; // D2 모바일 FREE: 전부 게이트에 막혀 0건인데 "N개 봉인" 알림·워터마크 전진만 남음 → 진입 자체를 회피
    const since = this.settings.lastSeenMtime || 0;
    this.rebuildReferencedSet(); // 스윕 진입 시 최신화(디바운스 대기 중이어도 지금 상태로 판정)
    const files = this.app.vault.getFiles().filter((f) => this.isSealable(f));
    let maxMtime = since;
    let targets: TFile[] = [];
    for (const f of files) {
      if (f.stat.mtime > maxMtime) maxMtime = f.stat.mtime;
      // 첫 실행(since=0)이면 과거 전체를 봉인하지 않고 워터마크만 기록
      if (since > 0 && f.stat.mtime > since && this.inSealScope(f.path)) targets.push(f);
    }
    targets.sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (targets.length > 200) targets = targets.slice(0, 200); // 폭주 방지(최근 200개)
    let n = 0;
    for (const f of targets) {
      await this.flush(f, "catchup");
      n++;
    }
    this.settings.lastSeenMtime = maxMtime;
    await this.saveSettings();
    if (n > 0) sealNotice(t.catchupNotice(n));
  }

  // 계정이 바뀌면 옛 계정의 "봉인했다"는 로컬 주장은 무효다.
  //
  // 왜 필요한가(2026-07-30 실사용 vault 105건 실측): 이 vault 는 예전에 다른 계정에 연결돼
  // 봉인됐고, 계정을 바꾼 뒤에도 sealedIndex·ledgerIndex 에 옛 주장이 그대로 남았다.
  // 그 주장 때문에 백필은 "이미 봉인됨"으로 건너뛰고, 스윕은 로컬 인덱스끼리 아귀가 맞는 것을
  // 보고 "안정"으로 표시해 서버에 물어보지도 않았다 —
  // **범위 안 노트 105건이 새 계정에서 영원히 봉인되지 않았고, 아무 신호도 없었다.**
  //
  // 치유 코드는 있었지만(스윕의 고아 주장 철회) 그 mtime 빠른 경로에 가려 닿지 않았다.
  // 그래서 원인 쪽을 막는다: 로컬 기록이 어느 계정 것인지 적어 두고, 달라지면 주장을 버린다.
  //
  // 무엇을 지우고 무엇을 남기나
  //   지운다: sealedIndex·sealedAt·ledgerIndex·ledgerMtime — 전부 "그 계정 서버가 안다"는 주장이다.
  //   지운다: nanalIndex — 옛 계정의 스토리지 경로에 올린 것이라 새 계정에서는 없는 것과 같다.
  //   남긴다: archiveIndex — 내 기기의 git 에 실제로 있는 **과거 사실**이다. 계정과 무관하다.
  private checkAccountSwitch(): void {
    const uid = this.entitlement?.user_id;
    if (!uid) return;                                  // 서버가 알려주지 않으면(구서버) 아무것도 하지 않는다
    const prev = this.settings.claimAccount;
    if (prev === uid) return;
    this.settings.claimAccount = uid;
    if (!prev) { void this.persist(); return; }        // 처음 기록 — 지울 주장이 없다
    // 다른 계정은 **다른 사람**이다. 처음 설치하고 로그인한 것과 똑같이 만든다 —
    // 이전 계정을 언급하지도, 이전 계정 몫을 대신 봉인하지도 않는다.
    // (이전 계정의 봉인은 그 계정 사슬에 원래 날짜로 그대로 있다. 잃는 것이 없다.)
    // ★ **먼저 담고, 그다음에 비운다.** 순서를 뒤집으면 비운 값(시작 시점 0 등)이 보관돼
    //   나중에 "이어서 쓰기"를 골라도 되살릴 것이 없다(실기기 시험이 잡았다).
    if (prev) this.saveAccountProfile(prev);
    const n = Object.keys(this.settings.sealedIndex).length + Object.keys(this.settings.ledgerIndex).length;
    this.settings.sealedIndex = {};
    this.settings.sealedAt = {};
    this.settings.ledgerIndex = {};
    this.settings.ledgerMtime = {};
    this.settings.nanalIndex = {};      // 옛 계정 스토리지 경로 — 이 계정에는 없는 것과 같다
    this.settings.reconcileAt = undefined;   // 이 계정 기준으로 다시 대조해야 한다
    this.reconcilePending = [];
    this.states.clear();                     // s.lastHash 잔존 시 flush 가 no-op 이 된다
    // 봉인 범위와 시작 시점은 **이 계정으로 로그인한 사람이 정한다.** 처음 로그인과 같은 물음이다.
    // 예전에는 여기서 곧바로 백필을 돌려 옛 노트를 **오늘 날짜로** 다시 봉인했다 —
    // 그건 우리가 정할 일이 아니었다(2026-07-31 지적).
    this.settings.scopeChosen = false;
    this.settings.sealSince = 0;        // 모달에서 이 계정의 시작 시점을 다시 정한다
    void this.persist();
    console.warn("[nanalstamp] 계정이 바뀌어 로컬 봉인 기록을 비웁니다 —", n, "건");
    void this.updateActiveStatus();
    this.updateTaskRibbon();
    if (this.scopeModalOpen) return;
    // 이 계정으로 쓰던 설정이 남아 있으면 **이어서 쓸지 먼저 묻는다.**
    // 없으면 처음 로그인과 같이 시작 범위를 묻는다.
    if (this.savedProfileFor(uid)) new AccountResumeModal(this.app, this, uid).open();
    else { new Notice(t.accountSwitched, 12000); new OnboardingScopeModal(this.app, this).open(); }
  }

  // ── 차집합 대조 ───────────────────────────────────────────────────────────
  //
  // 봉인 대상 = { 범위 안 파일의 현재 해시 } − { 서버 사슬에 있는 해시 }
  //
  // **로컬 인덱스는 이 계산에 들어가지 않는다.** sealedIndex 가 "했다"고 해도 서버가
  // 모른다고 하면 봉인 대상이다. 그래야 계정 전환·DB 복원·유령 주장·경로 이동·인덱스 손상이
  // 전부 무관해진다 — 세 번 다 "로컬이 했다고 말했고 아무도 서버에 물어보지 않아서" 났다.
  private reconciling = false;
  reconcilePending: ScannedFile[] = [];   // 이번 대조가 찾아낸 봉인 대상(백필이 여기서 꺼낸다)

  async reconcile(): Promise<{ scanned: number; pending: number } | null> {
    if (!this.settings.enabled || !this.settings.apiKey || this.authFailed) return null;
    if (!this.sealingAllowed()) return null;
    if (this.reconciling) return null;
    this.reconciling = true;
    try {
      this.rebuildReferencedSet();
      const targets = this.app.vault.getFiles()
        .filter((f) => this.isSealable(f) && this.inSealScope(f.path) && this.sealTarget(f));
      // 회전 재해시: mtime 이 같으면 내용도 같다는 **로컬 사실**을 믿되, 백업 복원·동기화 도구가
      // mtime 을 보존한 채 내용을 바꾸는 경우가 있어 매번 일부를 무조건 다시 읽는다.
      const rot = rotationSlice(targets, this.settings.reconcileCursor ?? 0, 0.05);
      const forced = new Set(rot.slice.map((f) => f.path));
      const files: Array<ScannedFile & { changed: boolean }> = [];
      for (const f of targets) {
        if (forced.has(f.path)) this.dashHashCache.delete(f.path);
        // mtime 이 바뀌었으면 방금 편집된 것이다 — 규모가 커도 이건 매번 확인한다.
        const cached = this.dashHashCache.get(f.path);
        const changed = !cached || cached.mtime !== f.stat.mtime;
        const h = await this.currentHashCached(f);
        if (h) files.push({ path: f.path, hash: h, changed });
      }
      // 서버에 "이 중 무엇이 사슬에 있나" 물어본다. 한 조각이라도 실패하면 **판정하지 않는다** —
      // 못 받은 답을 "없다"로 치면 멀쩡한 노트를 다시 봉인하고, "있다"로 치면 빠진 것을 놓친다.
      // ★ 매번 **전부** 묻는다. 캐시하지 않는다(2026-07-30).
      //
      // 한때 "서버가 있다고 답한 것은 다시 묻지 않는다"로 줄였다. 사슬이 append-only 라
      // 그 답이 뒤집히지 않는다는 논거였는데 **틀렸다.** data.json 은 평범한 파일이라
      // 동기화 충돌·백업 복원·버그로 오염될 수 있고, 오염되는 순간 그것은 다시 '주장'이 된다.
      // 실기기 시험에서 그 캐시를 손으로 오염시키자 대조가 그대로 속았다 —
      // 오늘 하루 고친 문제를 이름만 바꿔 되살린 것이었다.
      //
      // 비용은 문제가 아니다: 실 vault 1,230건 대조에 **0.2초**(실측). 노트가 작고 Obsidian 이
      // 내용을 캐시하며 왕복은 400개씩 몇 번뿐이다. 10만 건 규모가 실제로 문제가 되면
      // 그때는 경로별 캐시가 아니라 **사슬 전체의 요약값 하나**를 비교하는 쪽으로 가야 한다
      // (요약이 같으면 물을 것도 없고, 다르면 전부 묻는다 — 신뢰를 로컬에 두지 않는 방식).
      // 규모가 작으면 전부, 크면 (편집분 + 회전 몫)만 묻는다 — 어느 쪽이든 로컬 주장은 안 쓴다.
      const sel = toAsk(files, this.settings.reconcileAskCursor ?? 0);
      const present = new Set<string>();
      for (const part of chunk(sel.ask.map((f) => f.hash), HAVE_CHUNK)) {
        const r = await requestUrl({
          url: `${this.settings.serverUrl.replace(/\/$/, "")}/attest/have`,
          method: "POST", contentType: "application/json",
          headers: { "x-nanal-api-key": this.settings.apiKey },
          body: JSON.stringify({ hashes: part }), throw: false,
        });
        if (r.status !== 200 || !Array.isArray(r.json?.present)) {
          console.warn("[nanalstamp] 대조 실패 — 판정을 미룬다", r.status, r.json?.error);
          return null;                       // reconcileAt 을 갱신하지 않아 '오래됨'으로 잡힌다
        }
        for (const h of r.json.present as string[]) present.add(h);
      }
      // 이번에 묻지 않은 것은 **판정 대상이 아니다.** 안 물어본 것을 "없다"고 하면
      // 멀쩡한 노트를 다시 봉인하게 된다(회전 방식에서 특히 위험하다).
      this.reconcilePending = pendingFrom(sel.ask, present);

      // 서버가 "있다"고 답한 것은 이 계정 사슬에 **실제로 있다.** 화면이 그렇게 말해야 한다.
      // 계정을 오갔다 돌아오면 로컬 기록이 비어 있어 대시보드·상태바가 "미봉인"이라고
      // 거짓말한다 — 봉인은 멀쩡한데 표시만 틀린 것이다.
      //
      // **판정에는 쓰지 않는다.** 봉인 대상은 매번 대조가 새로 정하고(backfillTick 은
      // reconcilePending 을 본다), 이 값은 표시용이다. 어제 이 구분을 흐려 캐시로 썼다가
      // 대조가 오염된 기록에 속는 것을 시험에서 봤다 — 같은 실수를 반복하지 않는다.
      //
      // ledgerIndex 가 아니라 sealedIndex 에 넣는 이유: 사슬에 있다는 것은 "봉인됨"이지
      // "앵커 확정됨"이 아니다. ledgerIndex 는 확정분을 뜻하므로 넣으면 과장이 된다.
      for (const f of sel.ask) {
        if (present.has(f.hash)) this.settings.sealedIndex[f.path] = f.hash;
      }
      this.settings.reconcileAskCursor = sel.next;
      this.settings.reconcileAt = Date.now();
      this.settings.reconcileCursor = rot.next;
      await this.persist();
      // 팀 범위에서 사라진 것을 보고한다 — 대조가 이미 vault 를 훑었으니 비용이 거의 없다.
      void this.reportMissingPaths();
      this.updateTaskRibbon();   // 리본에 건수를 반영(0이면 조용해진다)
      if (this.reconcilePending.length) {
        console.debug("[nanalstamp] 대조:", files.length, "건 중 봉인 대상", this.reconcilePending.length, "건");
        this.startBackfill();
      }
      return { scanned: files.length, pending: this.reconcilePending.length };
    } catch (e) {
      console.warn("[nanalstamp] 대조 오류", e);
      return null;
    } finally {
      this.reconciling = false;
    }
  }

  /// 범위 변경 이력 — 설정 화면이 표로 보여준다. 문서는 이 기기의 DEK 로만 열린다
  /// (서버는 암호문만 갖고 있다). 복호에 실패하면 해시와 시각만이라도 보여준다 —
  /// **"그때 범위가 바뀌었다"는 사실 자체가 사슬에 남아 있다는 것**이 핵심이기 때문이다.
  async scopeHistory(): Promise<Array<{ n: number; seq: number; at: number; block: number | null; doc: any | null; docHash: string }>> {
    const base = this.settings.serverUrl.replace(/\/$/, "");
    const r = await requestUrl({ url: `${base}/attest/scope/history`,
      headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false });
    if (r.status !== 200 || !Array.isArray(r.json?.rows)) return [];
    const dek = await this.nanalDek(false).catch(() => null);   // 범위 문서는 개인 키(위 참조)
    const out = [];
    for (const row of r.json.rows) {
      let doc: any = null;
      if (dek && row.enc_doc) {
        try {
          const raw = await decryptBlob(dek, row.doc_hash, "scope", Uint8Array.from(atob(row.enc_doc), (c) => c.charCodeAt(0)));
          doc = JSON.parse(new TextDecoder().decode(raw));
        } catch (e) { console.warn("[nanalstamp] 범위 문서 복호 실패", row.n, e); }
      }
      out.push({ n: row.n, seq: row.seq, at: row.received_at, block: row.block ?? null,
                 doc, docHash: row.doc_hash });
    }
    return out;
  }

  /// 지금 계정의 봉인 설정을 보관함에 담는다(계정을 떠나기 직전에 부른다).
  private saveAccountProfile(uid: string): void {
    if (!uid) return;
    const s = this.settings;
    s.accountProfiles = s.accountProfiles || {};
    s.accountProfiles[uid] = {
      includeFolders: s.includeFolders, excludeFolders: s.excludeFolders,
      sealWholeVault: !!s.sealWholeVault, sealAttachments: !!s.sealAttachments,
      autoBackfill: !!s.autoBackfill, nanalBackfill: !!s.nanalBackfill,
      nanalSince: s.nanalSince || 0, sealSince: s.sealSince || 0,
      savedAt: Date.now(), email: s.accountEmail || undefined,
    };
  }

  /// 보관해 둔 설정으로 되돌린다. **시작 시점도 그대로** — 그게 "이어서"의 실질이다.
  /// (오늘로 다시 잡으면 자리를 비운 사이 고쳐진 노트가 영영 대상에서 빠진다.)
  applyAccountProfile(uid: string): boolean {
    const p = this.settings.accountProfiles?.[uid];
    if (!p) return false;
    Object.assign(this.settings, {
      includeFolders: p.includeFolders, excludeFolders: p.excludeFolders,
      sealWholeVault: p.sealWholeVault, sealAttachments: p.sealAttachments,
      autoBackfill: p.autoBackfill, nanalBackfill: p.nanalBackfill,
      nanalSince: p.nanalSince, sealSince: p.sealSince,
      scopeChosen: true,                      // 이미 정한 설정이므로 다시 묻지 않는다
    });
    void this.persist();
    void this.updateActiveStatus();
    this.updateTaskRibbon();
    void this.reconcile();                    // 판정은 언제나 서버와 다시 맞춘다
    return true;
  }

  /// 이 계정으로 쓰던 설정이 보관돼 있나(있으면 "이어서 쓸까요"를 물을 수 있다).
  savedProfileFor(uid: string): AccountScopeProfile | null {
    return this.settings.accountProfiles?.[uid] ?? null;
  }

  /// 이 계정의 **자동 봉인 대상**인가 — 시작 시각 이전 파일은 대상이 아니다.
  ///
  /// "봉인이 빠졌다"와 "봉인 대상이 아니다"는 다르다. 계정이 바뀌거나 처음 설치했을 때
  /// 사용자가 "지금부터만"을 고르면, 그 이전 파일은 이 계정과 아무 관계가 없다.
  /// 그것을 미봉인으로 세면 화면이 거짓말을 하고(873건 미봉인), 사용자가 안 하기로 한 것을
  /// 시스템이 계속 권하게 된다.
  ///
  /// **수동 봉인은 막지 않는다** — 사람이 직접 고른 것은 명시적 의사다.
  sealTarget(file: TFile): boolean {
    const since = this.settings.sealSince || 0;
    return since <= 0 || file.stat.mtime >= since;
  }

  /// 대조가 오래 못 돌고 있으면 **그 사실 자체**를 말한다.  /// 대조가 오래 못 돌고 있으면 **그 사실 자체**를 말한다.
  /// "빠진 것이 없다"와 "빠졌는지 모른다"는 다르다 — 후자를 침묵하면 전자로 읽힌다.
  private loadedAt = Date.now();
  reconcileUnknown(): boolean {
    // 한 번도 못 한 경우도 "모른다"가 맞다. 다만 방금 켠 직후에는 로드 시 대조가 아직 도는
    // 중이라 그때 경고를 띄우면 거짓 경보가 된다 — 10분을 준다.
    // (10분 뒤에도 못 했다면 그건 진짜로 모르는 상태다. 조용히 두면 "빠진 것 없음"으로 읽힌다.)
    if (!this.settings.reconcileAt && Date.now() - this.loadedAt < 10 * 60 * 1000) return false;
    return reconcileStale(this.settings.reconcileAt, Date.now(), 24 * 60 * 60 * 1000);
  }

  /// 사람이 눌러 "지금 빠진 봉인이 있나"를 확인한다.
  ///
  /// 자동 대조가 이미 주기적으로 돌지만, **확인할 수 있다는 것 자체**가 필요하다.
  /// 자동만 있으면 "지금 괜찮은가"를 물을 방법이 없고, 그러면 결국 믿을 수 없다.
  async checkMissingNow(): Promise<void> {
    const notice = new Notice(t.checkMissingRunning, 0);
    const r = await this.reconcile();
    notice.hide();
    if (!r) { new Notice(t.checkMissingFail, 12000); return; }   // 모르면 모른다고 말한다
    if (r.pending === 0) { new Notice(t.checkMissingClean(r.scanned), 8000); return; }
    // 찾았으면 목록을 보여주고 그 자리에서 봉인한다 — 알리기만 하고 끝내면 사람이 할 일이 없다.
    const list = this.reconcilePending.slice(0, 20).map((x) => x.path);
    new Notice(t.checkMissingSealing(r.pending, list.join("\n")), 15000);
    this.startBackfill();
  }

  // ── 봉인 범위 스냅샷 ──────────────────────────────────────────────────────
  //
  // 범위가 바뀌면 그 시점의 범위 문서를 체인에 봉인한다. 다음 앵커가 비트코인에 고정하므로
  // "그때 이 폴더는 범위 밖이었다"가 주장이 아니라 증거가 된다 —
  // 지금까지는 이 질문에 답할 근거가 "기억"뿐이었다.
  //
  // 서버는 문서 평문을 보지 않는다: 폴더 이름이 곧 연구 내용이다(`실리콘브릿지_문서/01-AICC_응대`).
  // 사용자의 DEK 로 암호화해 보내고 서버는 해시만 사슬에 박는다. 제3자 검증은 사용자가 평문을
  // 내놓으면 성립한다 — 해시해서 사슬에 있는지 보면 된다.
  //
  // 실패해도 봉인 흐름은 건드리지 않는다. 이것은 증적이지 봉인 자체가 아니다.
  private scopeSyncing = false;
  async syncScopeSnapshot(): Promise<void> {
    if (!this.settings.enabled || !this.settings.apiKey || this.authFailed) return;
    if (this.scopeSyncing) return;
    this.scopeSyncing = true;
    try {
      const base = this.settings.serverUrl.replace(/\/$/, "");
      const head = await requestUrl({ url: `${base}/attest/scope`, method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false });
      if (head.status !== 200) return;
      const latest = head.json?.latest ?? null;
      const body = scopeBody({
        vault: this.app.vault.getName(),
        include: this.settings.includeFolders,
        exclude: this.settings.excludeFolders,
        teamRoot: this.teamRoot(),
        wholeVault: !!this.settings.sealWholeVault,
        sealAttachments: !!this.settings.sealAttachments,
        autoBackfill: !!this.settings.autoBackfill,
        sealSince: this.settings.sealSince || 0,
        plugin: this.manifest.version,
      });
      const bodyHash = await sha256Hex(body);
      // 판정은 **본문** 해시로 한다 — 문서 해시는 직전 문서를 품고 있어 같은 범위라도 매번 달라진다.
      if (!scopeChanged(latest?.body_hash, bodyHash)) return;
      const doc = scopeDocument(body, latest?.doc_hash ?? SCOPE_ZERO, bodyHash);
      const hash = await sha256Hex(doc);
      let encDoc: string | undefined;
      try {
        // 범위 문서에는 **개인 포함·제외 폴더 경로가 그대로** 들어간다 — 팀 키로 잠그면
        // 관리자가 팀원의 개인 폴더 구조를 읽는다. 계정 것이므로 개인 키로 잠근다.
        const dek = await this.nanalDek(false);
        if (dek) {
          const enc = await encryptBlob(dek, hash, "scope", new TextEncoder().encode(doc));
          encDoc = arrayBufferToBase64(enc.buffer as ArrayBuffer);
        }
      } catch (e) { console.warn("[nanalstamp] scope enc skip", e); } // 이름 암호화와 같은 정책
      const r = await requestUrl({ url: `${base}/attest/scope`, method: "POST",
        contentType: "application/json",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ hash, body_hash: bodyHash, ...(encDoc ? { enc_doc: encDoc } : {}) }),
        throw: false });
      if (r.status === 200 && !r.json?.unchanged) {
        console.debug("[nanalstamp] 봉인 범위 스냅샷 봉인됨 —", r.json?.n, "번째");
      }
    } catch (e) {
      console.warn("[nanalstamp] scope snapshot skip", e);
    } finally {
      this.scopeSyncing = false;
    }
  }

  // 앱 종료(X) 직전: 비동기 요청은 못 끝나므로 동기 해시 + sendBeacon으로 봉인.
  // (force-quit/kill은 어떤 앱도 못 막음 — 그건 불가)
  private beaconDirty() {
    try {
      if (!this.settings.enabled || !this.settings.apiKey) return;
      const nreq = (window as unknown as { require?: (mod: string) => any }).require;
      if (!nreq) return; // 데스크탑(Electron)만
      const nodeCrypto = nreq("crypto");
      const fs = nreq("fs");
      const adapter = this.app.vault.adapter;
      const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
      const active = this.app.workspace.getActiveFile();
      const editor = this.app.workspace.activeEditor?.editor;
      const url = `${this.settings.serverUrl.replace(/\/$/, "")}/attest/beacon`;
      for (const [path, s] of this.states) {
        // inScope 그대로 유지 — 아래에서 곧 .md만 남기므로(첨부는 catchUp/ledgerSweep이 처리) 여기서
        // inSealScope로 바꿔도 참조 첨부 경로는 이 루프에 애초에 남지 않아 동작 차이가 없다.
        if (!s.dirty || !this.inScope(path)) continue;
        // 첨부는 utf8 읽기로 해시하면 바이트 손상 위험 → beacon은 .md만. 첨부는 다음 실행의
        // catchUp/ledgerSweep이 올바른 readBinary 해시로 봉인(안전한 degrade).
        if (!isMarkdownPath(path)) continue;
        let content: string | null = null;
        if (active && active.path === path && editor) content = editor.getValue(); // 편집 중 노트는 에디터 내용
        else if (base) { try { content = fs.readFileSync(`${base}/${path}`, "utf8"); } catch { content = null; } }
        if (content == null) continue;
        const hash = nodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
        if (hash === s.lastHash) continue;
        const pathHash = nodeCrypto.createHash("sha256").update(PATH_HASH_PREFIX + path, "utf8").digest("hex");
        const payload = JSON.stringify({ api_key: this.settings.apiKey, hash, path: pathHash });
        // Store review note: sendBeacon is used ONLY here, to flush the last pending seal when the
        // app is closing. It is not analytics/telemetry — the payload is this user's own note hash
        // going to their own account on the same host as every other request. requestUrl (and any
        // async call) is not guaranteed to complete during unload, which would silently lose the
        // seal of the note the user just edited.
        navigator.sendBeacon(url, payload); // 문자열=text/plain(simple request) → preflight 없이 전송 보장
        s.lastHash = hash;
      }
    } catch (e) {
      console.error("[nanalstamp] beacon error", e);
    }
  }

  // 주기 검사: 5분 지났고 + 지금 안 치고 있는(idle) 변경 노트를 봉인.
  // (타이핑 중이면 s.timer가 살아있어 건너뜀 → "수정중이면 조금 뒤에")
  private sweepSeals() {
    if (!this.settings.enabled) return;
    if (!this.sealingAllowed()) return; // D2 모바일 FREE: flush가 어차피 no-op — 30초 순회 자체를 생략
    const now = Date.now();
    for (const [path, s] of this.states) {
      if (s.dirty && !s.timer && now - s.dirtyAt >= MIN_INTERVAL_MS) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile && this.inSealScope(path)) this.flush(f, "settle");
      }
    }
  }

  // 실제 봉인(throttle 무시): 현재 내용 해시만 전송. dedup 포함.
  /// 업무 완료 시 고른 결과 노트를 증적으로 편입한다(2026-07-26).
  /// (1) 즉시 봉인 (2) 업무에 과제가 있으면 그 과제에 귀속.
  ///
  /// 서버는 평문 경로를 모르므로 귀속용 path_hash는 여기서 만든다(team_project_notes는
  /// INSERT OR IGNORE 순수 추가라 단건 호출이 안전하고 멱등하다). 폴더 패턴 기반 자동 동기화
  /// (syncProjectNotes)와 별개 경로다 — 산출물이 과제 폴더 밖에 있어도 귀속돼야 하기 때문이다.
  ///
  /// 완료는 이미 서버에서 확정된 뒤라, 여기서 실패해도 되돌리지 않고 알림만 남긴다.
  async sealResultNote(path: string, projectId: string | null): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { new Notice(t.taskResultMissing(path)); return; }
    try {
      await this.flush(f, "task-result");
    } catch (e) {
      new Notice(t.taskResultSealFail(basenameOf(path)));
      return;
    }
    if (projectId) {
      try {
        const h = await hashPath(path);
        await this.taskPost(`/attest/team/projects/${encodeURIComponent(projectId)}/notes`,
          { path_hashes: [h] }, { silent: true });
      } catch (e) { /* 귀속 실패는 조용히 — 폴더 동기화가 다음 기회에 다시 시도한다 */ }
    }
    new Notice(t.taskResultSealed(basenameOf(path)));
  }

  /// 노트 이동을 원장과 과제 귀속에 반영한다(2026-07-26).
  ///
  /// 왜 필요한가: 원장은 `UNIQUE(user_id, file_hash)`라 **내용이 그대로면 이동해도 새 엔트리가
  /// 생기지 않는다**(서버 append_plugin_entry가 내용 해시로 멱등 반환). 기존 엔트리는 첫 봉인
  /// 당시의 **옛 경로 해시**를 그대로 들고 있어, 과제 귀속(path_hash 기준)이 어긋난다.
  /// 실측(2026-07-26): 과제1 귀속 13건 중 원장과 매칭되는 것이 10건뿐이었다 —
  /// 과제 리포트의 "귀속 봉인 건수"가 그만큼 적게 나온다.
  ///
  /// 두 가지를 한다.
  ///  (1) **이동 사실을 `_move/` 마커로 봉인** — 이동도 연구 기록의 일부이고, 원장에 남으면
  ///      비트코인 앵커링에 함께 실린다. `_` 접두라 활동량 집계에서는 자동 제외된다.
  ///  (2) **옛 경로 해시도 과제에 귀속** — 귀속 테이블은 append-only(INSERT OR IGNORE)라
  ///      "과거에 이 경로에 있던 산출물"을 남기는 것이 자연스럽고, 원장 엔트리가 다시 매칭된다.
  ///
  /// 원장 자체는 건드리지 않는다(불변). 실패는 조용히 넘긴다 — 다음 이동·동기화가 다시 시도한다.
  /// "봉인된 적 있는데 지금 내 기기에 없다"를 **팀 범위만** 보고한다(0016).
  ///
  /// 왜 서버가 못 하나: 사슬은 **봉인된 것만** 안다. 노트를 지우거나 제목을 바꿔도 사슬에는
  /// 아무 일도 일어나지 않는다(마지막 봉인이 그대로 남을 뿐이다). vault 를 보는 쪽만 알 수 있다.
  ///
  /// 왜 팀만인가: 개인은 자기 vault 를 자기가 본다. 서버에 올려 봐야 얻는 것 없이
  /// "누가 무엇을 지웠나"만 남는다. 팀은 다르다 — 조직이 "그때 우리 기록이 이랬다"를
  /// 증명해야 하고, 어제 있던 노트가 오늘 없으면 그 사실이 보여야 한다.
  ///
  /// 이 값은 본질적으로 **내 기기의 주장**이다(서버가 확인할 수 없다). 그래서 서버 응답도
  /// 화면도 변경 이력 표도 `[기기]` 로 표시해 사슬에서 나온 사실과 구분한다.
  private async reportMissingPaths(): Promise<void> {
    const root = this.teamRoot();
    if (!this.settings.apiKey || !root) return;   // 팀 미소속이면 할 일이 없다
    try {
      // 서버가 아는 "팀 범위에서 봉인된 경로"를 기준으로 삼는다. 로컬 인덱스는 주장이라
      // 쓰지 않는다 — 계정을 오갔거나 인덱스가 상하면 없는 삭제를 보고하게 된다.
      const rows = await this.fetchAllSealedNotes();
      if (!rows) return;                          // 못 받았으면 **보고하지 않는다**(빈 목록이 아니다)
      const here = new Map<string, string>();     // 경로해시 → 경로(팀 루트 아래만)
      for (const f of this.app.vault.getFiles()) {
        if (f.path !== root && !f.path.startsWith(root + "/")) continue;
        here.set(await hashPath(f.path), f.path);
      }
      // ★ 팀 범위였던 것만 보고한다(2026-07-31).
      //
      // 처음에는 "지금 vault(팀 루트 아래)에 없으면 사라진 것"으로 봤는데, 그러면 **개인 폴더
      // 노트가 전부 사라진 것**이 된다 — here 에는 팀 루트 아래만 담기기 때문이다.
      // 실측에서 지워지지도 않은 `연구노트/…` 6건이 관리자 화면에 경로째 떴다.
      //
      // 그 경로가 팀 것이었는지는 **아카이브 로그**가 안다 — 봉인하던 순간의 경로가 커밋에
      // 그대로 적혀 있다. 로그에 없으면 판단할 근거가 없으므로 **보고하지 않는다**.
      // (서버도 team_scope 로 한 번 더 거른다 — 방어는 양쪽에 있어야 한다.)
      const wasTeam = new Set<string>();
      try {
        for (const e of await this.rewindLog()) {
          if (this.inTeamRoot(e.notePath)) wasTeam.add(await hashPath(e.notePath));
        }
      } catch { return; }                          // 근거를 못 읽으면 보고하지 않는다
      const items: Array<{ path: string; last_seq: number }> = [];
      for (const r of rows) {
        if (here.has(r.pathHash)) continue;       // 지금 있다
        if (!wasTeam.has(r.pathHash)) continue;   // 팀 범위였다는 근거가 없다
        items.push({ path: r.pathHash, last_seq: r.seq });
      }
      const reporter = this.settings.reporterId;
      if (!reporter) return;
      for (let i = 0; i < Math.max(1, Math.ceil(items.length / 400)); i++) {
        const part = items.slice(i * 400, (i + 1) * 400);
        if (i > 0 && part.length === 0) break;
        const r = await requestUrl({
          url: `${this.base()}/attest/storage/missing-paths`,
          method: "PUT", contentType: "application/json",
          headers: { "x-nanal-api-key": this.settings.apiKey },
          body: JSON.stringify({ items: part, reporter_id: reporter, append: i > 0 }),
          throw: false,
        });
        if (r.status !== 200) { console.warn("[nanalstamp] 사라진 것 보고 실패", r.status); return; }
      }
    } catch (e) { console.warn("[nanalstamp] 사라진 것 보고 오류", e); }
  }

  private async recordNoteMove(oldPath: string, newPath: string): Promise<void> {
    if (!this.settings.apiKey || oldPath === newPath) return;
    try {
      const [oldHash, newHash] = await Promise.all([hashPath(oldPath), hashPath(newPath)]);
      // (1) 이동 마커 — **서버가 만든다**(/attest/move).
      //
      // 예전에는 여기서 `/attest` 에 `path="_move/<해시>"` 로 직접 보냈다. 그런데 그 라우트에
      // "경로는 64hex 여야 한다"가 들어가면서 **400 으로 조용히 막혔다**(아래 throw:false 탓에
      // 아무도 몰랐다). 그 사이 개명 이력이 사슬에 남지 않았다(2026-07-31 실측).
      //
      // `_` 접두를 클라이언트가 다시 쓰게 하지 않는다 — 검증기가 그 접두를 "vault 파일이 아닌
      // 서버 기록"으로 보고 '있어야 할 목록'에서 빼므로, 직접 쓸 수 있으면 아무 기록이나
      // 검사 대상에서 빼낼 수 있다. 마커의 내용도 시각도 서버가 정한다.
      // 사슬은 **경로를 아는 쪽**이 정해 준다(0017 과 같은 원칙). 서버가 새 경로의 team_scope 를
      // 보고 정하게 두면, 개명 직후에는 그 경로가 아직 봉인 전이라 팀 자료의 개명이 개인 사슬로
      // 떨어진다(2026-08-01 실측: solo seq 3 에 _move 가, team seq 2 에 새 이름 봉인이 갈렸다).
      const inTeam = this.inTeamRoot(newPath) || this.inTeamRoot(oldPath);
      const mv = await requestUrl({
        url: `${this.base()}/attest/move`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(inTeam) },
        body: JSON.stringify({ old_path: oldHash, new_path: newHash,
                               ...(this.teamRoot() ? { team_scope: inTeam } : {}) }),
        throw: false,
      });
      // 조용히 넘기지 않는다 — 조용한 실패가 이 결함을 하루 동안 숨겼다.
      if (mv.status !== 200) console.error("[nanalstamp] 개명 기록 실패", mv.status, mv.text?.slice(0, 200));
      // (2) 옛·새 경로 해시를 이 노트가 속한 과제에 귀속.
      const root = this.teamRoot();
      if (!root) return;
      for (const prj of this.teamProjects) {
        const pats = scopedPatterns(root, parsePatterns(prj.folder_patterns));
        if (!matchesPatterns(oldPath, pats) && !matchesPatterns(newPath, pats)) continue;
        await this.taskPost(`/attest/team/projects/${encodeURIComponent(prj.id)}/notes`,
          { path_hashes: [oldHash, newHash] }, { silent: true });
      }
    } catch (e) { /* 조용히 — 이동 기록 실패가 개명 자체를 막으면 안 된다 */ }
  }

  async flush(file: TFile, reason: string) {
    // 로그인 게이트가 범위 게이트보다 **먼저**다(P-08). 미로그인 사용자가 수동 봉인을 누르면
    // 폴더를 고르라는 모달이 아니라 로그인 안내를 받아야 한다 — 순서가 반대면 로그인도 안 한
    // 사람이 범위를 정하게 되고, 그 선택으로 scopeChosen 이 소모돼 로그인 직후의 안내가 사라진다.
    if (!this.settings.apiKey) {
      if (reason === "manual") { new Notice(t.apiKeyMissing); this.openOwnSettings(); }
      return; // 자동 경로는 기존과 동일하게 침묵(상태바가 안내한다)
    }
    // 키 거부가 범위 게이트보다 **먼저**다(M-1) — 로그인 게이트와 같은 논거다: 키가 거부된
    // 상태에서 수동 봉인이 범위 모달을 열면, 고치지도 못할 상태에서 선택만 소모된다.
    // 거부된 키의 범위만 중단(P-03). 수동 클릭은 조용한 no-op 이 되면 안 되므로 이유를 말한다 —
    // 팀 키 거부는 목적지가 설정 메인이 아니라 연동 카드라, 화면을 여는 대신 안내만 한다.
    const pathInTeam = this.inTeamRoot(file.path);
    if (this.authFailedFor(pathInTeam)) {
      if (reason === "manual") {
        const teamKeyBad = pathInTeam && !!this.settings.teamApiKey;
        new Notice(teamKeyBad ? t.teamAuthFail : t.authFail);
        if (!teamKeyBad) this.openOwnSettings();
      }
      return;
    }
    // 범위 미설정이면 봉인하지 않는다(2026-07-28). inSealScope도 false를 주지만, **수동 실행일 때는
    // 이유를 말해야 한다** — 명령을 눌렀는데 아무 일도 안 일어나면 고장으로 읽힌다.
    if (this.scopeUnset()) {
      if (reason === "manual") {
        new Notice(t.scopeUnsetNotice);
        new OnboardingScopeModal(this.app, this).open();
      }
      return;
    }
    // 자동 경로는 침묵하지만 **수동 클릭에는 이유를 말한다** — 눌렀는데 아무 일도 없으면
    // 고장으로 읽힌다(범위 미설정 게이트와 같은 취지). 문구는 상태바 툴팁과 같은 것을 쓴다.
    if (!this.settings.enabled) {
      if (reason === "manual") new Notice(t.offTitle);
      return;
    }
    if (!this.inSealScope(file.path)) {
      if (reason === "manual") new Notice(t.outScopeTitle);
      return;
    }
    const s = this.stateOf(file.path);
    if (s.timer) {
      window.clearTimeout(s.timer);
      s.timer = undefined;
    }
    // 봉인(해시)은 크기 무관 항상 — 해시는 비용 0이므로 크기 게이트 없음(원본 완전성).
    // 파일당 상한은 클라우드 보관(업로드) 경로에서만 적용된다(overUploadLimit — 팀 정책·5GB 하드캡).
    if (!this.sealingAllowed()) {
      // 결제 직후 자기치유: 수동 시도 시 자격 재조회(성공 시 mobileEntitled 갱신 → 다음 시도부터 통과). fetch는 자체 스로틀 없음 — 수동 클릭당 1회 GET이라 무해.
      if (reason === "manual") { new Notice(t.mobileSealNeedPlan); void this.fetchStorageUsage(); }
      return; // 모바일 FREE: 자동·수동 봉인 전부 차단(D2) — 모든 봉인은 flush를 지나므로 여기 한 곳이면 충분
    }
    const interactive = reason !== "retry" && reason !== "catchup";
    // 상한·쿼터 게이트 — 넘으면 **봉인하지 않는다.** 첨부만 빼고 노트를 봉인하면 증거가
    // 불완전해지고, 무엇보다 사용자가 크기를 줄이도록 만들어야 한다(2026-07-30 정책).
    // 모든 봉인이 이 함수를 지나므로 여기 한 곳이면 충분하다(sealingAllowed 와 같은 자리).
    const hold = this.sealHoldOf(file);
    if (hold) { await this.noteSealHold(file.path, hold, interactive); return; }
    if (this.settings.sealHolds[file.path]) await this.clearSealHold(file.path); // 조건이 풀렸다
    try {
      const { hash, content: sealedBytes } = await this.hashWithContent(file);
      if (hash === s.lastHash) {
        s.dirty = false;
        if (this.failed.delete(file.path)) void this.persistFailed();
        if (reason === "manual") new Notice(t.alreadySealed); // 수동 클릭엔 "이미 봉인됨"을 말해준다(조용한 no-op 방지)
        return;
      }
      const pathHash = await hashPath(file.path);
      const encName = await this.encNameFor(file.path, pathHash);
      const vault = encName ? await this.encVaultFor() : null; // vault는 이름과 세트(서버 both-or-neither)
      // ★ 팀 폴더의 기록은 **팀 계정의 사슬**로 간다. 사슬은 계정에 매여 있으므로 여기서
      //   키를 잘못 고르면 팀 자료가 개인 사슬에 쌓이고, 관리자가 그것을 볼 수 없다.
      //   팀 계정을 따로 연결하지 않았으면 개인 키가 그대로 쓰인다(같은 계정인 경우).
      const inTeam = this.inTeamRoot(file.path);
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/attest`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(inTeam) },
        body: JSON.stringify({
          hash, path: pathHash, client_ts: new Date().toISOString(),
          ...(encName ? { enc_name: encName } : {}),
          ...(vault ? { enc_vault: vault.enc, vault_hash: vault.hash } : {}),
          ...(encName ? { size: file.stat.size } : {}), // 재구성 용량 미리보기용(이름과 세트)
          // 이 경로가 **팀 루트 아래인가**(0017). 서버는 경로를 해시로만 알아 스스로 판정할 수
          // 없고, 잘못 가르면 팀 관리자에게 팀원의 개인 노트가 보인다(2026-07-31 실측으로 겪었다).
          // 경로를 아는 쪽이 말해 주어야 한다. 팀 미소속이면 보내지 않는다 — 그때는 팀 범위라는
          // 개념 자체가 없고, 서버는 미상(NULL)으로 두어 팀 화면에서 제외한다.
          // ★ 저장소 판정(`teamBlobFor`)과 **다르다.** 저장소는 팀 custody 를 쓰는지까지 보지만,
          //   사슬은 **자료의 성격**이라 팀 폴더 아래인지만 본다. 팀이 custody 를 안 쓰더라도
          //   팀 폴더의 기록은 팀 자료다(0020).
          ...(this.teamRoot() ? { team_scope: inTeam } : {}),
          tz: new Date().getTimezoneOffset(), // 현지 자정 앵커 배칭용(분, DST 자동 반영)
        }),
        throw: false,
      });
      // 401/403: 키가 나쁘거나 만료 — 무한 재시도 중단하고 사용자에게 알림
      if (res.status === 401 || res.status === 403) {
        // 어느 키가 거부됐는지 갈라 세운다 — 팀 좌석 회수가 개인 봉인을 멈추면 안 된다(P-03).
        // 분기·Notice·상태바 갱신은 markAuthFailed 한 곳에 있다(presign 401 과 같은 규칙).
        this.markAuthFailed(inTeam);
        if (this.failed.delete(file.path)) void this.persistFailed();
        return;
      }
      // 429: Retry-After 존중(없으면 지수형 상한) + 지터. 큐에 남겨 재시도.
      if (res.status === 429) {
        const raw = (res.headers?.["retry-after"] ?? res.headers?.["Retry-After"]) as string | undefined;
        const ra = parseInt(String(raw ?? ""), 10);
        const waitMs = (isNaN(ra) ? RETRY_MS : ra * 1000)
          + Math.floor(Math.random() * 1000); // 지터
        this.backoffUntil = Date.now() + waitMs;
        this.failed.add(file.path);
        void this.persistFailed();
        void this.updateActiveStatus();
        if (interactive) new Notice(t.rateLimited);
        return;
      }
      // 그 외 비정상(5xx·네트워크) → throw → catch에서 재시도 큐로
      if (res.status !== 200 || !res.json?.ok) throw new Error(`${res.status}: ${res.json?.error ?? "unknown"}`);
      // 200 은 "응답이 왔다"일 뿐 "내가 보낸 그것을 기록했다"가 아니다(2026-07-30).
      // 서버가 돌려준 조각들로 고리를 **다시 계산**해 내 내용으로 만들어졌는지 확인한다 —
      // 검증기 3종이 나중에 하는 그 계산을 봉인하는 자리에서 한 번 더 하는 것이다.
      // 확인할 수 없으면(구서버·계정 미상) 통과시킨다: 봉인은 성공했을 수 있는데
      // 확인 수단이 없다고 되돌리면 그게 더 나쁘다.
      // 팀 계정을 따로 연결했으면 팀 봉인은 **그 계정 사슬**에 들어간다. 개인 계정 ID 로
      // 고리를 계산하면 늘 어긋나 봉인이 실패로 처리되고, 원문도 따라 올라가지 않는다
      // (2026-08-01 실측: 사슬에는 들어갔는데 sealedIndex 가 비어 있었다).
      const claim = inTeam && this.settings.teamApiKey
        ? (this.settings.teamClaimAccount || undefined)
        : this.settings.claimAccount;
      const ack = await verifySealAck(res.json, hash, claim, sha256Hex);
      if (ack.ok === false) {
        console.error("[nanalstamp] 봉인 응답이 보낸 내용과 맞지 않습니다", ack.why, file.path, res.json);
        throw new Error(`seal ack ${ack.why}`);   // 재시도 큐로 — 조용히 성공 처리하지 않는다
      }
      s.lastHash = hash;
      s.lastAttestAt = Date.now();
      s.dirty = false;
      s.dirtyAt = 0; // 대기 종료 — 다음 수정에서 5분 카운트가 새로 시작
      this.settings.sealedIndex[file.path] = hash; // 전송 성공 기록(확정 대기 표시·백필 중복 방지) — 아래 persist()로 저장
      this.settings.sealedAt[file.path] = Date.now(); // 확정 지연 SLA 판정 기준
      this.invalidateVerify(hash); // 방금 봉인된 해시 캐시 무효화 → 상태바가 즉시 '봉인됨' 반영
      const removed = this.failed.delete(file.path);
      // 연속-증명 지표: 봉인 성공한 오늘 날짜 기록 + 누적 카운트
      const day = fmtDate(new Date());
      if (!this.settings.sealDays.includes(day)) this.settings.sealDays.push(day);
      this.settings.sealDayCounts[day] = (this.settings.sealDayCounts[day] ?? 0) + 1;
      if (this.settings.sealDays.length > 400) this.settings.sealDays = this.settings.sealDays.slice(-400);
      this.settings.lifetimeCount++;
      if (removed) this.settings.failedPaths = Array.from(this.failed);
      await this.persist();
      void this.updateActiveStatus();
      // 봉인 시점 원문 아카이브·미러(비동기, 봉인 흐름 안 막음).
      // 위에서 읽은 바이트를 그대로 넘긴다 — 다시 읽으면 그 사이 편집분이 잡혀 이 버전을 잃는다.
      void this.recordSealProof(file, hash, res.json.seq, sealedBytes);
      // digest 등록부 보고(2026-08-02) — 서버는 평문 경로를 모르므로 「이게 〈기간〉 digest 다」는
      // 여기서만 말할 수 있다. 실패해도 봉인에는 영향이 없다.
      void this.reportDigestIfAny(file.path, hash);
      // §3 과제 귀속: 봉인된 노트가 active 과제 폴더에 걸리면 즉시 동기화(비동기·실패 침묵).
      // 모든 봉인(수동·자동·모바일·catchup)이 flush를 지나므로 여기 한 곳이면 충분.
      // **folder_patterns는 루트-상대다**(2026-07-25: 서버가 과제명을 그대로 저장) — scopedPatterns로
      // 팀 루트를 붙이지 않으면 이 판정이 항상 false가 되어 봉인 시점 귀속이 조용히 죽는다.
      // 그러면 완결 리포트(종결 후 hourly 워커가 서명·불변 보관)가 증거를 누락한 채 확정될 수 있다.
      // syncProjectNotes(:5154)와 **같은 술어**를 써야 한다 — 한쪽만 고치면 재발한다.
      const troot = this.teamRoot();
      if (troot && this.teamProjects.some((p) =>
        matchesPatterns(file.path, scopedPatterns(troot, parsePatterns(p.folder_patterns))))) void this.syncProjectNotes();
      if (interactive) sealNotice(t.noticeSealed(file.basename, res.json.seq, t.reason[reason] ?? reason));
    } catch (e: any) {
      this.failed.add(file.path); // 재시도 큐
      void this.persistFailed();
      void this.updateActiveStatus();
      if (interactive) new Notice(t.noticeFail(file.basename, e?.message ?? String(e)));
      console.error("[nanalstamp] seal error", file.path, e);
    }
  }

  // M3: 체인 head를 비트코인(OTS)에 앵커
  /// 제출 패키지 만들기 — 리본·명령 팔레트가 함께 쓰는 진입점.
  openSubmissionPackage(): void {
    if (!this.settings.apiKey) { new Notice(t.apiKeyMissing); return; }
    // 구독자인지 아닌지를 **이미 알고 있으면 서버 왕복 없이 바로** 다음 화면으로 간다.
    // 리본을 누른 사람은 즉시 알아야 하고, 로딩을 거쳐 알게 되면 고장으로 읽힌다(2026-07-29 지적).
    // entitlement 가 아직 안 왔으면 평소대로 서버에 묻는다 — 402 가 같은 화면을 띄운다.
    //
    // 판정 근거는 `/attest/pricing` 이 준 entitlement 하나다(fetchEntitlement). `is_pro` 는
    // 서버가 만료·유예(D+7)까지 계산해 준 값이라 그것을 따른다(isPro 주석 참조).
    const e = this.entitlement;
    const free = e !== null && !this.isPro();
    if (!free) { new SubmissionPackageModal(this.app, this).open(); return; }

    // FREE 는 만들 때마다 크레딧 1건이 나간다. 차감 확인은 **'만들기'를 누를 때** 창 안에서
    // 받는다(packagemodal.renderCreditConfirm) — 서버도 zip 을 조립하는 그 순간(요약 PDF)에
    // 깎으므로, 묻는 자리와 나가는 자리가 같아야 한다. 구독자에게는 묻지 않는다(차감이 없다).
    // 크레딧이 0이면 물을 것이 없다 — 차감될 것이 없으니 바로 구매 안내로 보낸다.
    const credits = e?.cert_credits ?? 0;
    new SubmissionPackageModal(this.app, this, true, credits <= 0, credits).open();
  }

  async anchorNow() { // 대시보드 '확정 대기' 행 클릭에서도 호출
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/attest/anchor`,
        method: "POST",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200 || !res.json?.ok) throw new Error(`${res.status}`);
      this.invalidateVerify(); // 앵커로 블록고가 바뀌므로 전체 캐시 무효화(stale ₿ 표시 방지)
      new Notice(t.anchorOk);
      void this.updateActiveStatus();
    } catch (e: any) {
      new Notice(t.anchorFail(e?.message ?? String(e)));
    }
  }

  // 점검 요청 — 활성 노트의 현재 해시로 POST /attest/review/request.
  // 성공 시 안내, 중복(400)은 서버 문구 우선, 그 외(404·네트워크)는 사람이 읽을 폴백 문구.
  /// 묶음 점검 요청 — 기간(일)과 과제로 범위를 정해 한 번에 낸다.
  /// 이미 승인된 기록은 **서버가 뺀다** — 사용자가 무엇이 점검됐는지 기억할 필요가 없다.
  async sendReviewRequest(
    days: number, projectId: string | undefined, title: string, note: string,
  ): Promise<{ ok: boolean; count?: number; message?: string }> {
    if (!this.settings.apiKey) return { ok: false, message: t.apiKeyMissing };
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/review/request-batch`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(true) },
        body: JSON.stringify({ from, to, project_id: projectId, title, note }),
        throw: false,
      });
      if (res.status === 200) return { ok: true, count: res.json?.item_count ?? 0 };
      // 서버가 이유를 말해 주면 그대로 보여준다 — "실패했습니다"보다 할 일을 알 수 있다.
      return { ok: false, message: typeof res.json?.error === "string" ? res.json.error : undefined };
    } catch {
      return { ok: false };
    }
  }

  private async requestReview(file: TFile) {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    let hash: string;
    try { hash = await this.hashOf(file); } catch { return new Notice(t.reviewReqFail); }
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/review/request`,
        method: "POST",
        // 점검은 팀 기능이고 마커가 팀 사슬(_review/)에 쌓인다 — 팀 계정으로 보낸다.
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(true) },
        body: JSON.stringify({ file_hash: hash }),
        throw: false,
      });
      if (res.status === 200 && res.json?.review_id) new Notice(t.reviewReqSent);
      else if (res.status === 400 && typeof res.json?.error === "string") new Notice(res.json.error);
      else new Notice(t.reviewReqFail);
    } catch {
      new Notice(t.reviewReqFail);
    }
  }

  // 점검 상태 조회(모달 표시용) — GET /attest/review/status. 200이면 리뷰 배열, 그 외
  // (404 미봉인·403 비권한·네트워크)는 null로 조용히 처리해 비팀 사용자에게 잡음을 주지 않는다.
  async fetchReviewStatus(file: TFile): Promise<any[] | null> {
    if (!this.settings.apiKey) return null;
    let hash: string;
    try { hash = await this.hashOf(file); } catch { return null; }
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/review/status?file_hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.keyFor(this.inTeamRoot(file.path)) },
        throw: false,
      });
      if (res.status === 200 && Array.isArray(res.json?.reviews)) return res.json.reviews;
    } catch { /* 조용히 생략 */ }
    return null;
  }

  // 개발노트 템플릿: 오늘 날짜 노트 생성/열기 + 골격 삽입 (선택적 편의)
  private async newDevNote() {
    if (!this.settings.templatesEnabled) return new Notice(t.tplOff);
    try {
      const d = fmtDate(new Date());
      const folder = this.settings.noteFolder.trim().replace(/^\/+|\/+$/g, "");
      const fpath = (folder ? folder + "/" : "") + `Dev ${d}.md`;
      let file = this.app.vault.getAbstractFileByPath(fpath);
      if (!(file instanceof TFile)) {
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
          await this.app.vault.createFolder(folder).catch(() => {});
        }
        file = await this.app.vault.create(fpath, `${tpl.title(d)}\n${entryBlock("cont")}`);
        new Notice(t.devNoteCreated(fpath));
      }
      // 위 분기를 지나면 반드시 TFile 이다(있으면 그것, 없으면 방금 만든 것). 캐스팅 대신 좁힌다 —
      // 같은 경로에 폴더가 있으면 캐스팅은 openFile 에서 터지지만 이쪽은 조용히 물러난다.
      if (!(file instanceof TFile)) return;
      await this.app.workspace.getLeaf(false).openFile(file);
      const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      if (ed) ed.setCursor(ed.lineCount(), 0);
    } catch (e: any) {
      new Notice(t.tplErr(e?.message ?? String(e)));
      console.error("[nanalstamp] newDevNote error", e);
    }
  }

  // 5.2: 경로가 digest 폴더 아래인가(미러 라우팅용). 설정이 비었으면 항상 false(라우팅 없음).
  private digestFolderPath(): string {
    // 팀이면 **팀 루트 아래 공통**이다 — 밖에 두면 봉인 범위에 들지 않아 절차가 끊긴다
    // (2026-08-02 실기기 확인: digests/2026-07.md 가 inScope=false 였다).
    return digestFolderFor(this.teamRoot(), this.settings.digestFolder || "");
  }
  protected isDigestPath(path: string): boolean {
    const df = this.digestFolderPath();
    return df !== "" && (path === df || path.startsWith(df + "/"));
  }

  // digest 스캐폴드 — 직전 **기간**(주간·월간·분기, 팀 설정)의 봉인 통계를 자동 삽입한
  // 조직 공유용 정리본을 만든다. 통계는 로컬 아카이브 원장(archiveLog)만 사용(서버 호출 없음).
  // 서술은 사용자가 직접 작성한다.
  //
  // 2026-08-02: 월간 고정에서 주기 선택으로. 파일명·통계 구간이 함께 움직인다 —
  // 파일명만 바꾸고 통계를 달로 두면 「2026-W31.md 인데 내용은 7월 전체」가 된다.
  digestCadence(): string {
    const c = this.settings.teamDigestCadence;
    return c === "none" || c === "weekly" || c === "monthly" || c === "quarterly" ? c : "monthly";
  }

  /// 지금 써야 할 기간(= 직전 기간). 주기가 꺼져 있으면 null.
  digestTargetPeriod(): string | null {
    const c = this.digestCadence();
    if (c === "none") return null;
    return previousPeriod(c, fmtDate(new Date()));
  }

  /// 그 기간 글이 vault 에 이미 있는가 — 리본 배지·메뉴가 이걸로 「미작성」을 판단한다.
  digestMissing(): string | null {
    // **팀 기능이다.** 팀에 속하지 않은 사람에게 뜨면 눌러도 등록부에 보고할 곳이 없고,
    // 조직 공유용 글을 혼자 쓰라고 재촉하는 셈이 된다(2026-08-02 캡처 점검에서 발견).
    if (!this.teamRoot()) return null;
    const p = this.digestTargetPeriod();
    if (!p) return null;
    const folder = this.digestFolderPath();
    const fpath = (folder ? folder + "/" : "") + `${p}.md`;
    return this.app.vault.getAbstractFileByPath(fpath) ? null : p;
  }

  async createDigest(period?: string) {
    try {
      const cadence = this.digestCadence();
      if (cadence === "none") { new Notice(t.digestOff); return; }
      const ym = period ?? previousPeriod(cadence, fmtDate(new Date()));
      const folder = this.digestFolderPath();
      const fpath = (folder ? folder + "/" : "") + `${ym}.md`;
      let file = this.app.vault.getAbstractFileByPath(fpath);
      if (file instanceof TFile) {
        new Notice(t.digestExists);
        await this.app.workspace.getLeaf(false).openFile(file);
        return;
      }
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder).catch(() => {});
      }
      const entries = await this.archiveLog();
      const stats = computeDigestStats(entries, ym, (ts) => fmtDate(new Date(ts)), cadence);
      file = await this.app.vault.create(fpath, t.digestScaffold(ym, stats));
      new Notice(t.digestCreated(fpath));
      // inScope 그대로 유지 — fpath는 항상 새로 만든 .md(다이제스트 노트) 자신의 경로다. 참조 스코프
      // 면제(inSealScope)는 노트가 아니라 첨부에 적용되는 예외이므로 여기엔 해당하지 않는다.
      if (!this.inScope(fpath)) new Notice(t.digestOutOfScope); // 봉인 범위 밖이면 경고만(자동 변경 안 함)
      // 위 분기를 지나면 반드시 TFile 이다(있으면 그것, 없으면 방금 만든 것). 캐스팅 대신 좁힌다 —
      // 같은 경로에 폴더가 있으면 캐스팅은 openFile 에서 터지지만 이쪽은 조용히 물러난다.
      if (!(file instanceof TFile)) return;
      await this.app.workspace.getLeaf(false).openFile(file);
      const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      if (ed) ed.setCursor(ed.lineCount(), 0);
      this.updateTaskRibbon();
    } catch (e: any) {
      new Notice(t.digestErr(e?.message ?? String(e)));
      console.error("[nanalstamp] createDigest error", e);
    }
  }

  /// 봉인한 노트가 digest 였으면 서버 등록부에 알린다(2026-08-02).
  /// **서버는 평문 경로를 모른다** — 경로해시만 안다. 그래서 「이게 〈기간〉 digest 다」는
  /// 여기서만 말할 수 있다. 실패해도 봉인에는 영향이 없다(다음 봉인에 다시 시도).
  protected async reportDigestIfAny(path: string, fileHash: string): Promise<void> {
    const cadence = this.digestCadence();
    if (cadence === "none" || !this.settings.apiKey) return;
    if (!this.isDigestPath(path)) return;
    const base = path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    if (!/^\d{4}-(W\d{2}|Q[1-4]|\d{2})$/.test(base)) return;
    if (this.settings.digestReported[base] === fileHash) return;
    const pathHash = await hashPath(path);
    const res = await this.taskPost("/attest/team/digests",
      { period: base, cadence, path_hash: pathHash, file_hash: fileHash }, { silent: true });
    if (res) {
      this.settings.digestReported[base] = fileHash;
      await this.saveSettings();
    }
  }

  // 현재 노트 커서 위치에 카테고리 항목 삽입
  private insertEntry(catKey: string) {
    if (!this.settings.templatesEnabled) return new Notice(t.tplOff);
    const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!ed) return new Notice(t.noNote);
    ed.replaceSelection(entryBlock(catKey));
  }

  // 공유용 증명 번들을 노트 옆에 .nanalproof 파일로 저장
  // ── P1: 자동 증명 원장(로컬 vault) + P2: PRO GitHub 미러 ─────────────────────
  // tier 게이트: entitlement가 pro/team이면 미러 허용(편의 기능이라 클라 게이트로 충분).
  /// **is_pro 가 있으면 그것을 따른다.** 서버가 만료·유예(D+7)를 계산해 준 값이고,
  /// `tier` 는 만료돼도 'pro' 로 남는다 — `||` 로 묶으면 만료 판정이 통째로 무의미해진다.
  /// 실제로 그랬다: 구독이 끝났는데 플러그인은 자기가 Pro 라고 믿고 업로드를 계속 시도해
  /// 403 을 조용히 삼켰고, 사용자는 원문이 보관되는 줄 알았다(2026-07-30 e2e).
  isPro(): boolean {
    const e = this.entitlement;
    if (!e) return false;
    if (typeof e.is_pro === "boolean") return e.is_pro;
    return e.tier === "pro" || e.tier === "team";   // 구버전 서버 폴백
  }

  // P2/4.3/C1: GitHub 미러가 동작하는 조건 — Pro이고, 고급 'GitHub 내보내기' 토글이 켜져 있거나 팀 custody가 활성.
  // 팀 custody는 조직이 관리하므로 멤버의 backend 선택과 무관하게 미러를 켠다(멤버 무설정 보장).
  mirrorActive(): boolean {
    // C1: GitHub 내보내기(고급 토글) 또는 팀 custody. nanal과 병행 가능(mirrorIndex/nanalIndex 분리).
    return this.isPro() && (this.settings.githubExport || !!this.settings.teamCustody);
  }



  // C2: 팀 custody 스토리지가 nanal인지 — **계정 단위** 판정(쿼터·키 발급 라우트 선택).
  protected teamNanal(): boolean { return this.settings.teamStorage === "nanal"; }

  /// 이 노트의 원문·이름을 팀 저장소에 둘 것인가 — **노트마다** 갈린다.
  ///
  /// 팀 custody 라고 vault 의 모든 노트가 조직 것은 아니다. 개인 폴더 노트까지 팀 스토리지로
  /// 올라가면 관리자가 `/storage/team/geturl` 로 대리 열람할 수 있고, WORM 이라 지울 수도 없다.
  /// 2026-07-31 에 실제로 그 상태였다(개인 네임스페이스는 객체 0개였다).
  ///
  /// 봉인 범위 판정(`inScope`)과 다르다는 점에 주의 — 개인 폴더도 **봉인은 된다.**
  /// 여기서 가르는 것은 "원문을 어디에 두고 누구 키로 잠그나"뿐이다.
  protected teamBlobFor(path: string): boolean {
    return teamBlobScopePure(path, this.teamRoot(), this.teamNanal());
  }

  /// 팀 계정이 바뀌면 팀 쪽 캐시를 비운다.
  ///
  /// 비우지 않으면 **이전 계정의 DEK 로 새 계정의 원문을 암호화**하게 된다. 그렇게 올라간
  /// 객체는 어느 키로도 풀 수 없다 — 되돌릴 수 없는 종류의 실수다.
  resetTeamKeyCaches(): void {
    this.dekCache.delete("team");
    this.dekDeny.delete("team");
    this.lastUsage = null;
    this.teamAuthFailed = false; // 새 팀 키(또는 해제 후 개인 키)로 재시도 허용
  }

  /// 해시만 알고 경로를 모르는 요청은 **양쪽 계정에 물어본다**.
  ///
  /// 팀 계정을 따로 연결하면 그 봉인은 팀 계정 사슬에 있어 개인 키로는 못 찾는다. 그런데
  /// 노트를 열 때 도는 검증처럼 경로를 모르는 자리가 있다 — 거기서 한쪽만 물으면 팀 노트가
  /// "봉인 안 됨"으로 보인다. 팀을 먼저 묻고, 못 찾으면 개인으로 되돌아본다.
  /// 팀 계정을 안 쓰면 두 키가 같으므로 한 번만 나간다.
  protected async askBothAccounts<T>(
    run: (key: string) => Promise<T | null>,
  ): Promise<T | null> {
    const team = this.keyFor(true), solo = this.keyFor(false);
    if (team !== solo) {
      const r = await run(team);
      if (r != null) return r;
    }
    return run(solo);
  }

  /// 이 요청에 쓸 API 키.
  ///
  /// 회사 메일과 개인 메일이 다른 사람이 있다 — 회사가 `hong@회사.com` 에 좌석을 주고
  /// 개인은 `hong@gmail.com` 으로 구독하는 식이다. 그때 팀 폴더의 기록은 회사 계정으로,
  /// 개인 폴더는 본인 계정으로 가야 소유·회수·과금이 갈린다.
  ///
  /// **둘이 같은 계정이면 아무것도 설정하지 않는다** — 팀 키가 비어 있으면 개인 키가
  /// 양쪽에 쓰여 지금까지와 똑같이 동작한다.
  protected keyFor(team: boolean): string {
    return apiKeyForPure(team, this.settings.apiKey, this.settings.teamApiKey);
  }

  // 봉인 시점(flush 성공 직후) 아카이브·미러. 확정 전이라 block=undefined(커밋 메시지 pending).
  // 원문 보존이 목적 — 확정 여부와 무관하게 그 순간 내용을 git에 박아 중간 봉인 버전이 유실되지 않게 한다.
  // 봉인 흐름을 막지 않도록 fire-and-forget(void)으로 호출된다. 실패는 삼킨다(봉인 자체는 성공 유지).
  // 일시 실패(bundle found:false·github 429·네트워크)면 sealArchiveRetry에 넣어 재시도 인터벌이 재포착한다
  // (봉인 순간이 그 버전 원문의 유일한 포착 지점이라 조용한 유실을 막는다).
  /// captured: 봉인 순간에 읽은 바로 그 내용. 있으면 **다시 읽지 않는다.**
  /// 재시도·스윕 경로는 넘기지 않는다 — 그쪽은 "현재 내용이 아직 그 봉인과 같은" 파일만 다루므로
  /// 다시 읽어도 같은 바이트다(대형 첨부도 그 경로로 흘려 읽는다).
  /// 원문 보관이 이번에 왜 멈췄는지 **남긴다.**
  ///
  /// 예전에는 실패마다 조용히 되돌아갔다(`return`). 그래서 팀 계정 구성에서 증명 조회가
  /// 404 로 떨어지는 결함이 **오류 한 줄 없이** 숨었고, 원문이 영영 안 올라갔다
  /// (2026-08-01 실측 — 찾는 데 오래 걸렸다). 보류는 정상 동작이지만 침묵은 아니다.
  ///
  /// retry=true 면 다음 틱에 다시 잡는다. false 는 "이번 봉인으로는 할 일이 없다"는 뜻이다.
  private stallUpload(path: string, why: string, retry: boolean): void {
    if (retry) {
      console.warn(`[nanalstamp] 원문 보관 보류: ${path} — ${why}`);
      this.settings.uploadStall[path] = { why, at: Date.now() };
    } else if (this.settings.uploadStall[path]) {
      delete this.settings.uploadStall[path];   // 더 할 일이 없어졌다 — 보류도 아니다
    }
    this.markRetry(path, retry);
  }

  /// vault 에서 사라진 노트의 원문을 **아카이브에서** 꺼내 올린다.
  ///
  /// 지운 노트라도 봉인된 그 버전은 로컬 git 에 있다. 복구 명령(「원문 보관 상태 점검」)이
  /// 쓰는 길을 자동 재시도도 쓰게 한 것뿐이다 — 새 경로가 아니다.
  /// 못 찾으면 그때는 큐에서 뺀다(정말 올릴 것이 없다).
  private async retryFromArchive(path: string, knownHash?: string): Promise<void> {
    // 삭제 경로에서 부를 때는 sealedIndex 가 곧 비워지므로 해시를 함께 받는다.
    const hash = knownHash || this.settings.sealedIndex[path];
    if (!hash) { this.markRetry(path, false); return; }
    if (this.settings.nanalIndex[path] === hash) { this.markRetry(path, false); return; }
    try {
      const found = await this.findInArchiveByHashes(new Set([hash]));
      const bytes = found.get(hash);
      if (!bytes) {
        this.stallUpload(path, "지워진 노트 — 아카이브에서도 원본을 찾지 못했습니다", false);
        return;
      }
      // 증명 조회는 상위 계층이 이미 갖고 있다(양쪽 계정에 묻는다).
      const proof = await this.proofBodyFor(hash);
      if (!proof) { this.stallUpload(path, "지워진 노트 — 증명을 아직 받지 못했습니다", true); return; }
      if (await this.uploadRecoveredBytes(path, hash, bytes, proof)) {
        this.settings.nanalIndex[path] = hash;
        await this.persist();
        this.stallUpload(path, "", false);   // 올라갔다 — 보류 해제
      }
    } catch (e) {
      this.stallUpload(path, `지워진 노트 재업로드 실패: ${(e as Error)?.message ?? e}`, true);
    }
  }


  private async recordSealProof(
    file: TFile, hash: string, seq?: number, captured?: string | ArrayBuffer | null,
  ): Promise<void> {
    // 보관을 끄는 설정은 없다. 예전에는 "증명 자동 저장" 토글 하나가 여기서 return 을 시켜
    // 아카이브 커밋·미러·스토리지 전송까지 통째로 막았다 — 그 토글 자체를 없앴다(2026-07-30).
    // 키 거부는 **경로별로** 판단한다(아래 authFailedFor) — 여기서 개인 플래그로 통째로 막으면
    // 개인 키만 거부된 사용자의 팀 노트 원문 보관이 사유도 없이 멈춘다(P-03 완결).
    if (!this.settings.enabled || !this.settings.apiKey) return;
    if (!this.inSealScope(file.path)) return;
    // 거부된 키로는 아래 번들 조회부터 401 이다 — 30초마다 다시 물으면 stall 사유가 "HTTP 401"로
    // 덮여 진짜 원인(키 거부)이 가려진다. 사유를 남기고 재시도 셋에 걸어 둔다:
    // 키가 복구되면(saveSettings·resetTeamKeyCaches 가 플래그를 내린다) 다음 틱에서 재개된다(P-03).
    if (this.authFailedFor(this.inTeamRoot(file.path))) {
      this.stallUpload(file.path, "로그인 키가 거부됨 — 다시 로그인하면 재개됩니다", true);
      return;
    }
    const archiveNeeded = this.archiveEnabled();
    const mirrorNeeded = this.mirrorActive();
    let nanalNeeded = this.nanalActive();
    // 업로드 게이트(파일당 상한은 팀 정책·5GB 하드캡뿐): 초과 파일은 클라우드 보관만 제외하고
    // nanalNeeded를 접는다 — 재시도 셋에 남아 30초마다 대용량 재읽기를 반복하지 않게(봉인·아카이브·미러는 그대로).
    if (nanalNeeded && this.overUploadLimit(file)) { void this.noteUploadSkip(file); nanalNeeded = false; }
    // "지금부터만" 선택 시 nanalSince 이전 mtime 파일은 소급 업로드 제외(재시도 틱이 옛 노트를 올리지 않게).
    if (nanalNeeded && !this.nanalEligibleFile(file)) nanalNeeded = false;
    if (!archiveNeeded && !mirrorNeeded && !nanalNeeded) { this.stallUpload(file.path, "보관 대상 아님(설정·용량·시작 시점)", false); return; }
    // 이미 이 해시로 아카이브·미러·스토리지 완료면 스킵(내용 무변경 재봉인 이중 커밋 방지).
    const archived = this.settings.archiveIndex[file.path] === hash;
    const mirrored = this.settings.mirrorIndex[file.path] === hash;
    const nanaled = this.settings.nanalIndex[file.path] === hash;
    if ((!archiveNeeded || archived) && (!mirrorNeeded || mirrored) && (!nanalNeeded || nanaled)) { this.stallUpload(file.path, "이미 이 내용으로 보관됨", false); return; }

    // C1: 쿼터 초과 backoff 중이고 나머지(아카이브·미러)는 이미 끝났다면 — bundle fetch·파일 읽기도
    // 낭비다. 경로만 재시도 셋에 남겨두고 backoff 만료 후 재포착("결제 전 재시도는 무의미"의 완결).
    if (Date.now() < this.storageQuotaBackoffUntil &&
        (!archiveNeeded || archived) && (!mirrorNeeded || mirrored)) {
      this.stallUpload(file.path, "저장 용량 초과로 잠시 멈춤", true); return;
    }

    // 미확정 번들: /attest/bundle 은 확정 전에도 segment(해시체인)+pubkey 반환(anchor 없음/pending).
    let body = "";
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/bundle?hash=${hash}`,
        method: "GET",
        // 증명은 **그 봉인이 들어간 계정**에게 묻는다. 팀 폴더 노트를 개인 키로 물으면
        // found:false 가 돌아오고 여기서 조용히 되돌아가 원문이 영영 올라가지 않는다.
        headers: { "x-nanal-api-key": this.keyFor(this.inTeamRoot(file.path)) },
        throw: false,
      });
      // ★ 여기서 조용히 되돌아가 원문이 영영 안 올라간 적이 있다(2026-08-01). 사유를 남긴다.
      if (res.status !== 200 || !res.json?.found) {
        this.stallUpload(file.path, `증명을 아직 받지 못함(HTTP ${res.status}${res.json?.found === false ? ", found=false" : ""})`, true);
        return;
      }
      body = JSON.stringify(res.json, null, 2);
      // seq 미전달(재시도 경로)이면 번들의 matched_seq로 복원 — 커밋 메시지 seq 품질 유지.
      if (seq == null && typeof res.json.matched_seq === "number") seq = res.json.matched_seq;
    } catch (e) { this.stallUpload(file.path, `증명 조회 실패: ${(e as Error)?.message ?? e}`, true); return; }

    // 원문/바이트 읽기(현재 파일). 비동기 사이에 파일이 또 바뀌었으면 이 봉인 해시와 불일치 →
    // 잘못된 내용을 seq에 붙이지 않도록 스킵(그 새 내용은 자기 자신의 봉인에서 아카이브된다).
    // 이 경우 원문은 이미 파일에서 사라져 재시도해도 못 잡으므로 셋에서 제거한다.
    // 대형 첨부는 **힙에 올리지 않는다.** 아카이브는 파일 복사, 스토리지는 스트리밍으로 간다.
    // (실측: 625MB 첨부 하나가 읽기만으로 +631MB, git.add 까지 가면 RSS 2GB — 2026-07-30)
    // 봉인 순간의 바이트를 받았으면 그것이 정답이다 — 파일을 다시 읽지 않는다.
    // (예전에는 늘 다시 읽었고, 그 사이 한 글자만 더 쳐도 이 버전을 조용히 버렸다. 2026-07-30)
    const bigAbs = captured == null && this.isBinary(file) && file.stat.size > ARCHIVE_INLINE_MAX
      ? this.absPathOf(file) : null;
    let original: string | ArrayBuffer | null = captured ?? null;
    if (original == null) {
      try {
        if (bigAbs) {
          if (await this.hashFileStream(bigAbs) !== hash) { this.stallUpload(file.path, "봉인 뒤 파일이 바뀜 — 다음 봉인이 덮는다", false); return; }
        } else if (this.isBinary(file)) {
          original = await this.app.vault.readBinary(file);
          if (await sha256HexBytes(original) !== hash) { this.stallUpload(file.path, "봉인 뒤 파일이 바뀜 — 다음 봉인이 덮는다", false); return; }
        } else {
          original = await this.app.vault.read(file);
          if (await sha256Hex(original) !== hash) { this.stallUpload(file.path, "봉인 뒤 파일이 바뀜 — 다음 봉인이 덮는다", false); return; }
        }
      } catch (e) { this.stallUpload(file.path, `원본 읽기 실패: ${(e as Error)?.message ?? e}`, true); return; }
    }

    try {
      if (archiveNeeded && !archived) {
        await this.archiveVersion(safeName(file.path), file.path,
          bigAbs ? { copyFrom: bigAbs, size: file.stat.size, hash } : original!, body, seq, undefined);
        this.settings.archiveIndex[file.path] = hash;
      }
      // GitHub 미러는 대형 첨부를 다루지 못한다(API 한도) — 원문 보관은 아카이브·스토리지가 맡는다.
      if (mirrorNeeded && !mirrored && !bigAbs) {
        if (await this.mirrorToGithub(file, body, seq, undefined, true, original!)) {
          this.settings.mirrorIndex[file.path] = hash;
        }
      }
      if (nanalNeeded && !nanaled) {
        // original 을 넘기지 않으면 mirrorToNanal 이 파일에서 스트리밍한다.
        if (await this.mirrorToNanal(file, hash, body, true, original ?? undefined)) {
          this.settings.nanalIndex[file.path] = hash;
        }
      }
      await this.persist();
    } catch (e) { console.error("[nanalstamp] seal-time archive error", file.path, e); }

    // 아카이브·미러·스토리지가 이 해시로 모두 완료됐으면 재시도 셋에서 제거, 하나라도 미완(예: mirror 429)이면 재시도로 남긴다.
    const nowArchived = !archiveNeeded || this.settings.archiveIndex[file.path] === hash;
    const nowMirrored = !mirrorNeeded || !!bigAbs || this.settings.mirrorIndex[file.path] === hash;
    const nowNanaled = !nanalNeeded || this.settings.nanalIndex[file.path] === hash;
    if (nowArchived && nowMirrored && nowNanaled) {
      this.stallUpload(file.path, "", false);      // 전부 끝 — 보류 기록도 지운다
    } else {
      // 무엇이 남았는지 적는다. "실패했다"만으로는 다음에 무엇을 봐야 할지 알 수 없다.
      const left = [!nowArchived && "아카이브", !nowMirrored && "미러", !nowNanaled && "원문 보관"]
        .filter(Boolean).join("·");
      this.stallUpload(file.path, `${left} 미완 — 다시 시도한다`, true);
    }
  }

  // 봉인 시점 아카이브·미러의 일시 실패 재시도(메모리만 — 재시작하면 catchUp/ledgerSweep이 현재 상태를 다시 커버).
  // 각 path의 현재 해시가 아직 sealedIndex와 같으면(그 봉인 유지 중) recordSealProof 재호출; 편집돼 달라졌으면
  // 그 중간 버전은 이미 새 봉인이 recordSealProof를 다시 부르므로 셋에서 제거.
  private retrySealArchive() {
    // 개인 키 거부 중에는 재시도 틱 자체가 쉰다 — 팀 경로 재개는 개인 키 복구 후.
    // 의도된 단순화(2026-08-09 최종 리뷰). 봉인 시점의 첫 시도는 per-path 로 갈리므로
    // 팀 노트가 **새로** 봉인되는 길은 열려 있고, 여기서 막히는 것은 밀린 재시도뿐이다.
    if (!this.settings.enabled || this.authFailed || this.sealArchiveRetry.size === 0) return;
    if (this.backoffUntil > Date.now()) return; // 429 백오프 존중
    for (const p of Array.from(this.sealArchiveRetry)) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) {
        // ★ vault 에 파일이 없다고 포기하지 않는다(2026-08-01). 봉인 시점에 **아카이브가 먼저**
        //   채워지므로 그 버전의 원본은 로컬 git 에 그대로 있다. 여기서 큐를 비우면 올릴 수
        //   있는 원문을 영영 안 올리게 된다 — "원본이 없어서"가 아니라 "안 찾아서" 못 올리는 것.
        void this.retryFromArchive(p);
        continue;
      }
      void (async () => {
        let hash: string;
        try { hash = await this.hashOf(f); } catch { return; }
        if (hash !== this.settings.sealedIndex[p]) { this.markRetry(p, false); return; } // 편집됨 → 새 봉인이 커버
        await this.recordSealProof(f, hash); // 성공/완료 시 recordSealProof가 셋에서 스스로 제거
      })();
    }
  }

  // 확정(비트코인 블록 존재)된 노트의 자기검증 번들을 로컬 원장에 저장하고,
  // Pro·미러 on이면 원본+증명을 GitHub에 push. 이미 같은 해시로 저장돼 있으면 아무 것도 안 함.
  // verify(옵션)를 주면 서버 재조회를 아낀다(확정 판정·seq·블록고에 사용).
  private async recordConfirmedProof(file: TFile, hash: string, verify?: any, silent = false): Promise<boolean> {
    // 위와 같다 — blanket 게이트 없이 아래 per-path 판정이 전담한다(P-03 완결).
    if (!this.settings.enabled || !this.settings.apiKey) return false;
    if (!this.inSealScope(file.path)) return false;
    // 위와 같은 이유 — 거부된 키로 번들을 다시 묻지 않는다. 이 함수는 실패를 조용히 false 로
    // 돌려주는 것이 관례이고, 보류 기록은 recordSealProof 가 이미 남겼다(P-03).
    if (this.authFailedFor(this.inTeamRoot(file.path))) return false;

    const mirrorNeeded = this.mirrorActive();
    const archiveNeeded = this.archiveEnabled();
    let nanalNeeded = this.nanalActive();
    // 업로드 게이트: 한도 초과 첨부는 스토리지만 제외(원장·아카이브·미러는 진행) — 사유는 attachSkipped에 기록.
    if (nanalNeeded && this.overUploadLimit(file)) { void this.noteUploadSkip(file); nanalNeeded = false; }
    // "지금부터만" 선택 시 nanalSince 이전 mtime 파일은 확정 시점 보충 업로드에서도 제외.
    if (nanalNeeded && !this.nanalEligibleFile(file)) nanalNeeded = false;
    const ledgered = this.settings.ledgerIndex[file.path] === hash;
    const mirrored = this.settings.mirrorIndex[file.path] === hash;
    const archived = this.settings.archiveIndex[file.path] === hash;
    const nanaled = this.settings.nanalIndex[file.path] === hash;
    if (ledgered && (!mirrorNeeded || mirrored) && (!archiveNeeded || archived) && (!nanalNeeded || nanaled)) return false; // 로컬·(필요시)미러·아카이브·스토리지 모두 완료

    const v = verify ?? (await this.cachedVerify(hash));
    const block: number | undefined = v?.bitcoin?.block_height ?? v?.matches?.[0]?.bitcoin?.block_height;
    if (!v?.found || !block) return false; // 미봉인/미확정 → 다음 기회에
    const seq: number | undefined = v?.seq ?? v?.matches?.[0]?.seq;

    try {
      // 자기검증 번들(내보내기와 동일한 /attest/bundle 응답 JSON 그대로)
      const res = await requestUrl({
        url: `${this.base()}/attest/bundle?hash=${hash}`,
        method: "GET",
        // 위와 같은 이유 — 그 봉인이 들어간 계정에게 묻는다.
        headers: { "x-nanal-api-key": this.keyFor(this.inTeamRoot(file.path)) },
        throw: false,
      });
      if (res.status !== 200 || !res.json?.found) return false;
      const body = JSON.stringify(res.json, null, 2);

      let changed = false;
      if (!ledgered) {
        const folder = this.settings.ledgerFolder.replace(/^\/+|\/+$/g, "") || "nanalStamp/proofs";
        const rel = `${folder}/${safeName(file.path)}.nanalproof`;
        await this.ensureVaultFolder(folder);
        await this.writeVaultFile(rel, body); // 있으면 확정본으로 덮어쓰기
        this.settings.ledgerIndex[file.path] = hash;
        changed = true;
        if (!silent) new Notice(t.ledgerSaved(rel));
      }
      // 원문은 아카이브·미러 공용으로 한 번만 읽는다(중복 read 지양). 첨부는 바이트로 읽는다.
      // 대형 첨부는 읽지 않는다 — 아카이브는 파일 복사, 스토리지는 스트리밍(recordSealProof 와 같은 규칙).
      const bigAbs = this.isBinary(file) && file.stat.size > ARCHIVE_INLINE_MAX ? this.absPathOf(file) : null;
      let original: string | ArrayBuffer | null = null;
      if (!bigAbs && ((archiveNeeded && !archived) || (mirrorNeeded && !mirrored) || (nanalNeeded && !nanaled))) {
        try { original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file); } catch { original = null; }
      }
      // P1.5: 로컬 git 아카이브(전 티어, 데스크탑만) — 원문+증명을 git 이력에 커밋. 실패는 삼킴(크래시 금지).
      if (archiveNeeded && !archived && (original != null || bigAbs)) {
        try {
          await this.archiveVersion(safeName(file.path), file.path,
            bigAbs ? { copyFrom: bigAbs, size: file.stat.size, hash } : original!, body, seq, block);
          this.settings.archiveIndex[file.path] = hash;
          changed = true;
        } catch (e) {
          console.error("[nanalstamp] archive commit error", file.path, e);
        }
      }
      // P2: PRO GitHub 미러(원본 + 증명) — 로컬과 별도 추적. 실패 시 인덱스 미갱신 → 다음 sweep 재시도.
      if (mirrorNeeded && !mirrored && original != null && !bigAbs) {   // 대형 첨부는 GitHub API 한도 밖
        if (await this.mirrorToGithub(file, body, seq, block, silent, original)) {
          this.settings.mirrorIndex[file.path] = hash;
          changed = true;
        }
      }
      // B: nanal 스토리지 — 봉인 시점에 업로드가 안 된 경우(당시 실패·backend 후속 활성화)의 보충 경로.
      // 정상 수명주기에선 봉인 시점 업로드가 nanalIndex를 채워 이 분기는 스킵된다 — S3 proof는 pending 고정
      // (블록 확정은 온라인 이력으로 확인). S3에 pending proof가 이미 있을 수 있어 force로 새 버전을 쌓는다.
      if (nanalNeeded && !nanaled && (original != null || bigAbs)) {
        if (await this.mirrorToNanal(file, hash, body, silent, original ?? undefined)) {
          this.settings.nanalIndex[file.path] = hash;
          changed = true;
        }
      }
      if (changed) await this.persist();
      return changed;
    } catch (e: any) {
      console.error("[nanalstamp] ledger error", file.path, e);
      return false;
    }
  }

  // 백그라운드 sweep: in-scope·봉인된 노트를 순회, 확정됐고 아직 원장에 없는 것을 저장/미러.
  // 로드 직후 1회 + 하루 1회 호출. 레이트 고려해 sweep당 최대 LEDGER_SWEEP_BATCH개만 처리.
  private async ledgerSweep() {
    if (this.ledgerSweeping) return;
    if (!this.settings.enabled || !this.settings.apiKey || this.authFailed) return; // 보관을 끄는 설정은 없다 — 이 스윕은 원장뿐 아니라 아카이브·스토리지 보충도 한다
    this.ledgerSweeping = true;
    try {
      this.rebuildReferencedSet(); // 스윕 진입 시 최신화 — 참조 기반 첨부 판정
      let done = 0, examined = 0;
      const mirrorNeeded = this.mirrorActive();
      const archiveNeeded = this.archiveEnabled();
      const nanalNeeded = this.nanalActive();
      // 커서부터 랩어라운드 순회(기아 해소, 위 sweepCursor 주석 참조). files[k]가 아니라
      // files[(cursor+k) % length]를 보되, break 판정은 k(원래 인덱스 진행량) 기준으로 그대로 둔다.
      const files = this.app.vault.getFiles();
      let brokeEarly = false;
      for (let k = 0; k < files.length; k++) {
        if (done >= LEDGER_SWEEP_BATCH || examined >= SWEEP_EXAMINE_CAP) {
          // k = 다음에 볼 인덱스(현재 파일은 아직 처리 전) — 여기서부터 다음 sweep 재개.
          this.sweepCursor = (this.sweepCursor + k) % files.length;
          brokeEarly = true;
          break;
        }
        const f = files[(this.sweepCursor + k) % files.length];
        if (!this.isSealable(f) || !this.inSealScope(f.path)) continue;
        // 업로드 게이트(파일 단위): 한도 초과 첨부는 스토리지만 제외 — 봉인·원장·아카이브·미러는 그대로 진행.
        // fNanal=false로 접어야 nanalIndex 미존재가 "미완"으로 읽혀 매 sweep 대용량 재해시를 반복하지 않는다.
        // nanalBackfill=false면 nanalSince 이전 mtime 노트는 소급 보관 대상에서 제외(시작 범위 선택 — "지금부터"만).
        const fNanal = nanalNeeded && !this.overUploadLimit(f) && this.nanalEligibleFile(f);
        if (nanalNeeded && !fNanal) void this.noteUploadSkip(f);
        // mtime 스킵: 이 파일 버전을 이미 '안정'(완료 or 미봉인)으로 판정했으면 read·hash·verify 생략.
        // → 대용량 vault에서 매 sweep마다 전체 재스캔·재검증하는 과부하를 없앤다.
        // 단, mtime-안정이어도 미러/아카이브가 아직 안 된 노트는 스킵하지 않는다(P1.5 등 신규 요구가
        // 추가되면 예전 mtime 마킹이 '완료'를 뜻하지 않으므로 — archiveIndex/mirrorIndex 존재로 판정).
        // nanal 조건은 존재 여부가 아니라 ledgerIndex(확정 해시)와 값 일치로 판정 — 재봉인 노트가 구버전
        // 업로드 존재만으로 영구 스킵되던 버그(2026-07-21) 수정. 해시 재계산 없이 설정 조회만으로 판정 가능.
        if (this.settings.ledgerMtime[f.path] === f.stat.mtime &&
            (!mirrorNeeded || this.settings.mirrorIndex[f.path] !== undefined) &&
            (!archiveNeeded || this.settings.archiveIndex[f.path] !== undefined) &&
            (!fNanal || this.settings.nanalIndex[f.path] === this.settings.ledgerIndex[f.path])) continue;
        examined++;
        let hash: string;
        try { hash = await this.hashOf(f); } catch { continue; }
        const fullyDone = this.settings.ledgerIndex[f.path] === hash &&
                          (!mirrorNeeded || this.settings.mirrorIndex[f.path] === hash) &&
                          (!archiveNeeded || this.settings.archiveIndex[f.path] === hash) &&
                          (!fNanal || this.settings.nanalIndex[f.path] === hash);
        if (fullyDone) { this.settings.ledgerMtime[f.path] = f.stat.mtime; continue; }
        const v = await this.cachedVerify(hash);
        if (v === null) continue; // 조회 실패(네트워크·429) — 판단 보류, 마킹 없이 다음 기회에
        if (!v.found) {
          // 서버가 명시적으로 "이 계정 체인에 없음" — 계정 전환 등으로 남은 고아 원장 자기치유.
          // 현재 내용 해시가 원장의 확정 해시와 같은데 체인에 없다면 그 원장 항목은 현 계정에서 무효 —
          // 지워서 백필이 현재 계정으로 재봉인하게 한다(2026-07-21 실측: 전환 볼트에서 7건 영구 대기).
          // 로컬 아카이브(archiveIndex)는 과거 사실이므로 보존. nanalIndex도 재봉인 후 새 해시로 자연 갱신.
          if (this.settings.ledgerIndex[f.path] === hash) {
            delete this.settings.ledgerIndex[f.path];
            if (this.settings.sealedIndex[f.path] === hash) delete this.settings.sealedIndex[f.path];
            delete this.settings.ledgerMtime[f.path]; // 안정 마킹 해제 — 백필·다음 스윕이 다시 본다
            // 세션 내 상태(s.lastHash)도 지운다 — 남으면 flush가 "이미 봉인됨"으로 no-op되어
            // 백필이 같은 파일만 매 틱 집는 라이브락이 된다(리뷰 지적, 세션 내 계정 전환 케이스).
            this.states.delete(f.path);
            console.warn("[nanalstamp] orphan ledger entry cleared (reseal scheduled)", f.path);
            this.startBackfill(); // 백로그가 생겼으니 백필 재가동(이미 돌고 있으면 재시작 무해)
            continue;
          }
          if (this.settings.sealedIndex[f.path] === hash) {
            // 로컬 "전송했다" 주장이 서버 체인에 없음 — 서버 DB 초기화·계정 전환의 유령 주장(2026-07-22 실측 792건).
            // 주장을 철회하고 재봉인을 유도한다 — 아니면 영원히 '확정 대기'로 위장되고 보관도 안 된다.
            delete this.settings.sealedIndex[f.path];
            delete this.settings.sealedAt[f.path];
            this.states.delete(f.path); // s.lastHash 잔존 시 flush no-op 라이브락 방지(고아 원장 치유와 동일 원칙)
            console.warn("[nanalstamp] stale sealed claim cleared (reseal scheduled)", f.path);
            this.startBackfill();
            continue; // ledgerMtime 미기록 — 재봉인 후 재검
          }
          this.settings.ledgerMtime[f.path] = f.stat.mtime; // 원장과 무관한 미봉인 파일 — 기존 안정 마킹 유지
          continue;
        }
        const block = v?.bitcoin?.block_height ?? v?.matches?.[0]?.bitcoin?.block_height;
        if (!block) {
          // 미확정이어도 보관 동기화는 "봉인 기준"으로 진행 — 확정 대기가 업로드를 인질로 잡지 않게(2026-07-22).
          // sealedIndex[f.path]===hash: 이 내용이 이미 서버에 봉인 전송된 버전일 때만(미봉인 수정본 배제).
          if (this.settings.sealedIndex[f.path] === hash &&
              ((archiveNeeded && this.settings.archiveIndex[f.path] !== hash) ||
               (mirrorNeeded && this.settings.mirrorIndex[f.path] !== hash) ||
               (fNanal && this.settings.nanalIndex[f.path] !== hash))) {
            await this.recordSealProof(f, hash); // 축별 미완만 처리·재시도 셋 관리(봉인 시점 경로 재사용)
            done++;
          }
          continue; // 확정 심사는 다음 sweep에서(mtime 미기록)
        }
        if (await this.recordConfirmedProof(f, hash, v, true)) done++; // 개별 알림 억제
        // 완전 완료(로컬+미러+아카이브+스토리지)면 mtime 등록해 스킵. 미완이면 미등록 → 다음 sweep 재시도.
        if (this.settings.ledgerIndex[f.path] === hash &&
            (!mirrorNeeded || this.settings.mirrorIndex[f.path] === hash) &&
            (!archiveNeeded || this.settings.archiveIndex[f.path] === hash) &&
            (!fNanal || this.settings.nanalIndex[f.path] === hash)) this.settings.ledgerMtime[f.path] = f.stat.mtime;
      }
      await this.persist(); // ledgerMtime 저장
      if (done > 0) new Notice(t.ledgerSweepDone(done)); // sweep당 요약 알림 1개
      // 전체 파일을 한 바퀴 다 못 돌고 break했으면(사유 무관 — 원래는 examine 상한만 봐서 done-break 시
      // 다음 로드까지 멈추던 버그였다) 30초 뒤 조용히 이어받아 가볍게 드레인. 다 돌았으면 멈춤.
      if (brokeEarly) window.setTimeout(() => void this.ledgerSweep(), 30000);
    } catch (e) {
      console.error("[nanalstamp] ledger sweep error", e);
    } finally {
      this.ledgerSweeping = false;
    }
  }

  // vault 폴더 보장(중첩 경로 포함). 이미 있으면 무시. (ArchiveSourceView의 Excalidraw 사본 생성도 재사용)
  // **실제로 생긴 폴더 수**를 돌려준다(2026-08-05) — 자동 적용이 "N개 만들었습니다"를 사람에게
  // 보여 주므로 시도 횟수가 아니라 결과를 세야 한다. createFolder 실패는 예외를 삼키기 때문에
  // (경합·권한·이름 충돌) 호출 뒤 다시 조회해 확인한다. 세지 않는 호출부는 그냥 무시하면 된다.
  async ensureVaultFolder(folder: string): Promise<number> {
    const clean = folder.replace(/^\/+|\/+$/g, "");
    if (!clean) return 0;
    let cur = "";
    let made = 0;
    for (const p of clean.split("/")) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur).catch(() => {});
        if (this.app.vault.getAbstractFileByPath(cur)) made++;
      }
    }
    return made;
  }

  // vault 파일 쓰기(있으면 덮어쓰기, 없으면 생성).
  private async writeVaultFile(path: string, body: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
  }

  // ── P1.5: 로컬 git 아카이브(전 티어 내용 보존, isomorphic-git) ────────────────

  // git 연산 직렬화: 이전 작업이 끝난 뒤(성공/실패 무관) 다음 작업을 실행.




  // ── 대시보드 데이터 접근자 ─────────────────────────────────────────────────
  // (path, mtime) 키 해시 캐시 — 대시보드가 vault 전체를 훑어도 재계산은 변경 파일만.
  private dashHashCache = new Map<string, { mtime: number; hash: string }>();
  async currentHashCached(file: TFile): Promise<string | undefined> {
    const c = this.dashHashCache.get(file.path);
    if (c && c.mtime === file.stat.mtime) return c.hash;
    try {
      const hash = await this.hashOf(file, true);
      this.dashHashCache.set(file.path, { mtime: file.stat.mtime, hash });
      return hash;
    } catch { return undefined; }
  }


  // 그날로: 아카이브 전체 로그(pending 포함) — 삭제 노트 탐색 전용.
  // archiveLog(확정 전용)와 분리: 대시보드 집계 의미론(timeline·syncStatus·certCandidates)을 오염시키지 않는다.
  // 개명 감지 — '삭제됨' 후보의 마지막 보관본 해시가 현재 vault 어느 노트의 봉인 해시와 같으면
  // 삭제가 아니라 이름 변경(같은 내용이 새 경로로 존재) → 삭제 목록에서 제외(2026-07-22 사용자 지적).
  // 개명 후 내용까지 수정된 경우는 해시가 달라 목록에 남는다(옛 버전이 아카이브에만 있으므로 정직).
  async filterRenamed(deleted: RewindEntry[]): Promise<RewindEntry[]> {
    if (deleted.length === 0) return deleted;
    const current = new Set<string>();
    for (const idx of [this.settings.nanalIndex, this.settings.sealedIndex, this.settings.ledgerIndex]) {
      for (const [p, h] of Object.entries(idx)) {
        if (typeof h === "string" && this.app.vault.getAbstractFileByPath(p)) current.add(h);
      }
    }
    const out: RewindEntry[] = [];
    for (const e of deleted) {
      // deletedEntries가 이미 경로별 최신 항목만 남겼고 oid를 갖고 있다 — 경로별 git.log 재순회 금지(성능).
      const safe = safeName(e.notePath);
      const rel = isMarkdownPath(e.notePath) ? `notes/${safe}.md` : `attachments/${safe}`;
      let renamed = false;
      if (e.oid) {
        const bytes = await this.archiveReadBytes(e.oid, rel);
        if (bytes && current.has(await sha256HexBytes(bytes))) renamed = true;
      }
      if (!renamed) out.push(e);
    }
    return out;
  }

  // 개명 계보 결정: "아카이브에만 남은 옛 경로 → 현존하는 새 경로" 매핑(표시 전용).
  // 1차 근거 = renameMap(이벤트 기록, 내용 무관 확실). 과거 개명은 내용 지문으로 소급:
  // 개명은 내용을 바꾸지 않으므로 옛 경로의 "마지막 보관본"과 새 경로의 "첫 보관본"이 같다 —
  // 개명 직후 재봉인(경로 커밋먼트)이 같은 내용을 새 경로로 아카이브하기 때문. 개명 후 수정해도 성립.
  // blob 읽기는 후보 선별(successorCandidates)로 제한하고 세션 캐시로 재렌더 비용을 없앤다.

  // 수동 개명 연결(삭제된 노트 카드) — 이벤트·소급 자동이 못 이은 잔재를 사용자가 확정.
  setRenameLink(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    for (const [k, v] of Object.entries(this.settings.renameMap)) if (v === oldPath) this.settings.renameMap[k] = newPath;
    this.settings.renameMap[oldPath] = newPath;
    this.lineageResult = null; // 계보 캐시 무효 — 다음 렌더가 새 연결을 반영
    void this.saveSettings();
    void this.syncLineageFile();
  }


  // 전체 로그는 세션 캐시(쓰기 시 무효) — 대시보드·버전 모달·계보가 같은 스냅샷을 공유한다.
  // isomorphic-git의 전체 git.log는 커밋 수천 개에서 초 단위라, 호출마다 다시 돌면 UI가 "한참 뒤에" 뜬다(2026-07-22 사용자 지적).

  // 그날로: 삭제된 노트 찾기 — 아카이브에만 남은 경로를 골라 P6 버전 모달로 잇는다.
  // 서버는 경로를 해시로만 알므로(구조적 제약) 목록의 유일한 소스는 로컬 아카이브다.
  async findDeletedNotes(): Promise<void> {
    if (!Platform.isDesktopApp) { new Notice(t.archiveDesktopOnly); return; }
    if (!this.archiveEnabled() || !(this.settings.archivePath || "").trim()) { new Notice(t.pitNoArchive); return; }
    const entries = await this.rewindLog();
    const lineage = await this.renameLineage(entries); // 개명·이동된 노트는 삭제가 아니다(새 경로로 생존)
    // ★ 싼 필터를 먼저 돌린다(2026-07-31 실측).
    //
    // 로컬 아카이브는 **기기의 모든 vault 를 한 repo 에** 담는다. 그래서 이 vault 에서 보면
    // 삭제 후보가 1,434건이나 되는데(실측), 그중 이 vault 것은 몇 건뿐이다.
    // filterRenamed 는 **항목마다 아카이브 blob 을 읽어** 비싸고, filterToThisVault 는
    // 서버 한 페이지 + 경로 해시 비교라 싸다. 비싼 것을 먼저 돌리면 1,434번을 헛읽는다.
    // 둘 다 같은 목록에 대한 술어라 순서를 바꿔도 결과는 같다.
    const raw = deletedEntries(entries, (p) => !!this.app.vault.getAbstractFileByPath(p))
      .filter((e) => !lineage[e.notePath]);
    if (!raw.length) { new Notice(t.rewindNoneDeleted); return; }
    const mine0 = await this.filterToThisVault(raw);
    if (!mine0.length) { new Notice(t.rewindNoneDeleted); return; }
    const mine = await this.filterRenamed(mine0);
    if (!mine.length) { new Notice(t.rewindNoneDeleted); return; }
    new DeletedNoteSuggestModal(this.app, this, mine).open();
  }

  // 로컬 아카이브는 **기기의 모든 vault를 한 repo에** 담고 커밋에는 경로만 남는다. 그래서 다른 vault의
  // 노트가 "이 vault에 없다 → 삭제됨"으로 섞여 보인다(2026-07-28 설명서 촬영에서 발견).
  // 서버는 봉인마다 vault_hash를 알고 있으므로 경로해시로 대조해 이 vault 것만 남긴다.
  // 판정: 이 계정이 봉인한 적 없는 경로(서버 목록에 없음) = 같은 기기의 **다른 계정/vault** 것 → 뺀다.
  // vault 미상(vault_hash 없던 구 봉인)은 남긴다 — 예전에 지운 노트를 못 찾게 되는 쪽이 더 나쁘다.
  // 대조에 실패하면(오프라인·목록 상한) 거르지 않고 원래 목록을 준다.
  private async filterToThisVault(deleted: RewindEntry[]): Promise<RewindEntry[]> {
    const v = await this.encVaultFor();
    if (!v) return deleted;
    const byPath = new Map<string, string | null>();
    let before: number | undefined;
    for (let page = 0; page < 60; page++) {
      const r = await this.fetchSealedNotes(before);
      if (!r) return deleted;
      for (const row of r.rows) if (!byPath.has(row.pathHash)) byPath.set(row.pathHash, row.vaultHash);
      if (!r.hasMore || r.rows.length === 0) break;
      before = r.rows[r.rows.length - 1].seq;
      if (page === 59) return deleted; // 상한 초과 — 불완전한 집합으로 거르면 진짜 삭제 노트를 숨긴다
    }
    const keep: RewindEntry[] = [];
    for (const e of deleted) {
      const ph = await hashPath(e.notePath);
      if (!byPath.has(ph)) continue;              // 이 계정 봉인이 아님 → 다른 vault의 노트
      const vh = byPath.get(ph);
      if (vh === null || vh === v.hash) keep.push(e);
    }
    return keep;
  }


  // 확정 버전 원문을 현재 노트와 같은 크기의 새 탭(ArchiveSourceView)으로 연다. 상태는 leaf state로 전달 →
  // 뷰가 스스로 아카이브에서 읽는다(runArchive 락 경유). 분할 배치·재시작 복원 가능.
  async openArchiveSource(
    notePath: string,
    ver: { oid: string; ts: number; tzo: number; seq: string; block: string },
    safe: string,
    rel: string,
    isMd: boolean,
  ): Promise<void> {
    const state: ArchiveSourceState = { oid: ver.oid, rel, safe, isMd, notePath, seq: ver.seq, block: ver.block, ts: ver.ts };
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: ARCHIVE_SOURCE_VIEW_TYPE, active: true, state: state as unknown as Record<string, unknown> });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      if (existing[0].view instanceof DashboardView) void existing[0].view.render();
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // 봉인 노트 브라우저 열기 — 명령 팔레트·리본 메뉴 공용(기존 탭 재사용).
  async openNoteBrowser(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(NOTE_BROWSER_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: NOTE_BROWSER_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  dashboardArchiveOn(): boolean { return this.archiveEnabled(); }

  // 표시용 판정도 실제 봉인 판정과 같은 술어를 써야 한다 — 아니면 대시보드·노트 브라우저·계보 추적이
  // "이미 봉인된(참조 스코프 면제) 첨부"를 범위 밖으로 잘못 표시해 유령 좀비 상태가 남는다(2026-07-25 Task 11).
  dashInScope(p: string): boolean { return this.inSealScope(p); }

  // 시작 범위 모달: "기존 노트 원문까지 보관"을 고를 때 소급될 예상 용량(바이트) — 업로드 상한 초과 첨부는 제외.
  scopeSealableBytes(): number {
    let total = 0;
    for (const f of this.app.vault.getFiles()) {
      if (!this.isSealable(f) || !this.inSealScope(f.path)) continue;
      if (this.overUploadLimit(f)) continue;
      total += f.stat.size;
    }
    return total;
  }

  // 봉인 전송은 성공했지만 아직 ₿ 확정 전인 노트 표시용 — sealedIndex(영속)를 우선, 세션 상태를 보조로.
  pendingSealHash(path: string): string | undefined {
    return this.settings.sealedIndex[path] || this.states.get(path)?.lastHash || undefined;
  }

  // ── 초기 백필: 봉인 이력 없는 기존 노트를 백그라운드에서 천천히 봉인 ─────────
  // 3초에 1건(분당 20건) — 서버 한도(60/분/키)의 1/3만 써서 자동 봉인·재시도·일괄 봉인과 경합하지 않는다.
  // 후보 판정이 sealedIndex/ledgerIndex 기반이라 재시작해도 이어서 진행되고, 다 끝나면 스스로 조용해진다.
  // 백필 = (재)활성화 시 1회성 배수 작업. 백로그(봉인 이력 없는 기존 노트)를 3초에 1건씩
  // 비우고, 한 바퀴 스캔에서 할 일이 없으면 티커를 영구 종료한다 — 상시 백그라운드 스캔 금지.
  // 편집 중(dirty/settle 대기) 노트는 settle·최소간격·경계 파이프라인 소관이라 백필이 건드리지 않는다.
  startBackfill() {
    this.stopBackfill();
    this.backfillStuck.clear();          // 재가동은 "다시 해 보자"는 뜻이다
    this.backfillStuckNotified = false;
    this.backfillTimer = window.setInterval(() => void this.backfillTick(), 3000);
    this.registerInterval(this.backfillTimer);
  }
  private stopBackfill() {
    if (this.backfillTimer !== undefined) {
      window.clearInterval(this.backfillTimer);
      this.backfillTimer = undefined;
    }
  }
  private async backfillTick() {
    if (!this.sealingAllowed()) { this.stopBackfill(); return; } // D2 모바일 FREE: flush가 no-op이라 3초 공회전만 남음 → 종료(자격 획득 시 fetchStorageUsage가 재가동)
    if (!this.settings.autoBackfill) { this.stopBackfill(); return; } // 기능 꺼짐 → 종료(켜면 startBackfill로 재시작)
    if (!this.settings.enabled || !this.settings.apiKey) return;      // 준비 안 됨 → 대기(스캔 없이 즉시 반환)
    if (this.authFailed || Date.now() < this.backoffUntil) return;    // 일시 장애 → 대기
    this.rebuildReferencedSet(); // 스윕 진입 시 최신화(3초 틱이지만 순수 메모리 순회 — 파일 스캔 대비 미미)
    for (const f of this.app.vault.getFiles()) {
      if (!this.isSealable(f) || !this.inSealScope(f.path) || !this.sealTarget(f)) continue;
      // 편집 파이프라인이 소유한 노트는 백로그가 아니다 — 백필이 가로채면 5분 합치기가 무력화된다.
      const st = this.states.get(f.path);
      if (st?.dirty || st?.timer) continue;
      // 전송 실패 큐 소유분은 retryFailed(백오프 존중)가 처리 — 백필이 3초마다 재타격하지 않는다.
      if (this.failed.has(f.path)) continue;
      // 이번 세션에서 이미 봉인에 실패한 파일은 건너뛴다 — 아래 설명 참조.
      if (this.backfillStuck.has(f.path)) continue;
      const h = await this.currentHashCached(f);
      if (!h) continue;
      // ★ 봉인 여부 판단은 **대조 결과**로 한다(2026-07-30).
      //
      //   대조가 있으면: 그 목록에 있는 것만 봉인 대상이다. 로컬 인덱스는 보지 않는다 —
      //   sealedIndex 가 "했다"고 말하는데 서버는 모르는 경우가 세 번 있었고, 그때마다
      //   그 노트들이 **영원히** 봉인되지 않았다(계정 전환·DB 초기화·유령 주장).
      //
      //   대조가 아직 없으면(첫 로드·조회 실패): 예전 기준으로 후보를 고른다. 이때는
      //   빠뜨리는 쪽보다 겹치는 쪽이 안전하다 — 서버가 (user, file_hash) 로 멱등 처리한다.
      if (this.settings.reconcileAt) {
        if (!this.reconcilePending.some((x) => x.path === f.path && x.hash === h)) continue;
      } else {
        if (this.settings.ledgerIndex[f.path] === h) continue; // 확정 완료
        if (this.settings.sealedIndex[f.path] === h) continue; // 전송됨(확정 대기)
      }
      await this.flush(f, "catchup"); // 조용히 1건만 — 다음 후보는 다음 틱에
      // ★ 봉인이 실제로 됐는지 확인한다(2026-07-30).
      //
      // flush 는 여러 이유로 **조용히 아무 일도 하지 않을 수 있다.** 그러면 이 파일은 다음 틱에도
      // 후보로 뽑히고, 한 건만 처리하고 return 하므로 **그 한 건에 영원히 갇힌다** —
      // 뒤의 모든 노트가 봉인되지 않는데 아무 신호도 없다.
      // 실사용 vault 에서 실제로 그랬다: 범위 안 .md 103건이 한 번도 봉인되지 않은 채 멈춰 있었고
      // (전부 봉인 대상 판정), 그 사실을 사용자도 우리도 몰랐다.
      // 이제 못 넘긴 파일은 이번 세션에서 건너뛰고 나머지를 계속 진행한다. 조용한 정지보다
      // "한 건은 못 했지만 나머지는 했다"가 낫다 — 그리고 그 한 건을 사람에게 말해 준다.
      if (this.settings.sealedIndex[f.path] !== h) this.backfillStuck.add(f.path);
      else this.reconcilePending = this.reconcilePending.filter((x) => x.path !== f.path);
      return;
    }
    // 한 바퀴 돌아 할 일 없음 = 백로그 소진. 다만 못 넘긴 것이 있으면 조용히 끝내지 않는다.
    if (this.backfillStuck.size > 0) {
      const n = this.backfillStuck.size;
      console.warn("[nanalstamp] 소급 봉인에서 넘기지 못한 노트", n, Array.from(this.backfillStuck).slice(0, 10));
      if (!this.backfillStuckNotified) {
        this.backfillStuckNotified = true;
        new Notice(t.backfillStuck(n), 12000);
      }
    }
    this.stopBackfill(); // 다음 (재)활성화까지 다시 돌지 않는다
    // 다 했다고 스스로 판단하지 않는다 — 서버에 한 번 더 물어 확인한다.
    // (여기서 새 대상이 나오면 reconcile 이 백필을 다시 켠다.)
    if (this.settings.reconcileAt) void this.reconcile();
  }

  // ── P6: 특정 시점 증명서 — 아카이브의 그 버전을 git으로 읽어 오프라인 검증 ────────
  // 현재 파일은 절대 건드리지 않는다(readBlob = 읽기 전용). 모든 git 접근은 archive 락에 태운다.






  // 오프라인 자기검증: 아카이브된 원문을 해시해 proof의 file_hash와 대조 + 확정 블록 존재 확인.
  // 서버·네트워크 불필요 — 아카이브만으로 "그때 이 내용을 썼다"가 성립함을 보인다.
  async selfVerifyArchived(noteContent: string, proof: any): Promise<PitVerify> {
    const computed = await sha256Hex(noteContent);
    const expected = String(proof?.file_hash || "").toLowerCase();
    const hashMatch = expected.length === 64 && computed === expected;
    const block: number | undefined = proof?.anchor?.bitcoin?.block_height;
    const seq: number | undefined = proof?.matched_seq;
    return { computed, expected, hashMatch, block, seq, ok: hashMatch && typeof block === "number" };
  }

  // FREE: 자기검증 번들을 vault에 폴더로 내보낸다(원문 + 증명 + 사람용 검증 안내). 폴더 경로 반환.
  async exportPitBundle(safe: string, dateLabel: string, oid: string, note: string, proofRaw: string, v: PitVerify): Promise<string> {
    const folder = `nanalStamp/certificates/${safe}__${dateLabel}__${oid.slice(0, 8)}`;
    await this.ensureVaultFolder(folder);
    await this.writeVaultFile(`${folder}/note.md`, note);
    await this.writeVaultFile(`${folder}/proof.nanalproof`, proofRaw);
    await this.writeVaultFile(`${folder}/VERIFY.md`, pitVerifyReadme(safe, dateLabel, v));
    return folder;
  }

  // PRO: 포맷된 HTML 증명서(표지)를 vault에 내보낸다. Pro가 아니면 가격 페이지로 안내하고 null.
  // 서버 pdf_cert는 한글 불가·해시전용이라 재사용 불가 → 클라에서 자체완결 HTML 생성(브라우저 인쇄로 PDF화).
  // 기록의 공개 진위확인 URL(Pro) — 증명서 QR용 무알림 버전(실패 시 null, 증명서는 QR 없이 발급).
  async publicLinkFor(hash: string): Promise<string | null> {
    if (!this.settings.apiKey) return null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/public-link`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ hash }),
        throw: false,
      });
      if (res.status !== 200) return null;
      const u: string = res.json.url;
      return u.startsWith("http") ? u : this.webBase() + u;
    } catch { return null; }
  }

  async exportPitCertificate(safe: string, noteName: string, noteContent: string, dateLabel: string, oid: string, v: PitVerify, proofRaw?: string): Promise<string | null> {
    if (!this.isPro()) { new Notice(t.proOnly); this.openExternal("/pricing"); return null; }
    // 신뢰 3층 연결: (1) 진위확인 QR(서버 원장 대조) (2) 내장 proof의 Ed25519 서명 검증(certgen)
    // (3) OTS/비트코인은 .nanalproof가 담당. 링크 발급 실패는 조용히 — QR 없는 증명서로 발급.
    const h = v.expected || v.computed;
    const verifyUrl = h ? await this.publicLinkFor(h) : null;
    let qrDataUri: string | null = null;
    if (verifyUrl) { try { qrDataUri = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 220 }); } catch { qrDataUri = null; } }
    const rel = `nanalStamp/certificates/${safe}__${dateLabel}__${oid.slice(0, 8)}-certificate.html`;
    await this.ensureVaultFolder("nanalStamp/certificates");
    await this.writeVaultFile(rel, pitCertificateHtml(noteName, noteContent, dateLabel, oid, v, this.iconUrl, verifyUrl ?? undefined, qrDataUri ?? undefined, proofRaw));
    return rel;
  }

  // B 열람 폴백: 활성 노트의 마지막 봉인 해시 원문을 읽기 전용 탭으로 연다(명령 팔레트용).
  // 버전별 열람은 증빙 모달(봉인 이력 행의 소스 버튼)이 담당한다.
  private async restoreFromNanal(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice(t.noNote); return; }
    if (!this.settings.apiKey) { new Notice(t.apiKeyMissing); return; }
    const hash = this.settings.nanalIndex[file.path] ?? this.settings.sealedIndex[file.path];
    if (!hash) { new Notice(t.nanalRestoreNone); return; }
    await this.openNanalView(file.path, hash, !this.isBinary(file));
  }

  // B: nanal 보관본 읽기 전용 탭 열기(복원 명령·증빙 모달 공용). 봉인 원문은 증거라 vault에
  // 편집 가능한 사본을 만들지 않는다 — 내려받기·해시 재검증은 뷰가 스스로 한다(재시작 후에도 복원).
  // oid의 "nanal:" 접두로 소스를 구분(git oid와 충돌 불가), rel에는 blob 확장자를 싣는다.
  async openNanalView(notePath: string, hash: string, isMd: boolean, ts = 0): Promise<void> {
    const state: ArchiveSourceState = {
      oid: `nanal:${hash}`,
      rel: isMd ? "md" : blobExt(notePath),
      safe: safeName(notePath),
      isMd,
      notePath,
      seq: "?",
      block: "?",
      ts, // 봉인 시각(epoch초) — 임베드의 시점 일관 버전 선택에 사용(0=미상 → 최신 봉인본)
    };
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: ARCHIVE_SOURCE_VIEW_TYPE, active: true, state: state as unknown as Record<string, unknown> });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ── "그날로"(Rewind): 봉인 버전 복원 중앙 로직 ─────────────────────────────


  // C1: 사용량/쿼터 조회(설정탭 사용량 바). 실패는 조용히 캐시 유지 — 잡음 금지.
  async fetchStorageUsage(): Promise<void> {
    // 스로틀 스탬프를 apiKey 가드보다 먼저 — 키가 비어도 usageStale()이 60초간 false가 되어
    // 설정탭의 fetch→display 재렌더 루프를 차단한다(스테일 entitlement + 키 삭제 엣지).
    this.usageFetchedAt = Date.now();
    if (!this.settings.apiKey) return;
    try {
      const res = await requestUrl({
        url: storageEndpoint(this.base(), this.teamNanal(), "usage"),
        method: "GET",
        headers: { "x-nanal-api-key": this.keyFor(this.teamNanal()) },
        throw: false,
      });
      if (res.status === 200 && typeof res.json?.used_bytes === "number") {
        // C2: 팀 모드 응답은 pool_bytes(팀 풀 쿼터), 개인은 quota_bytes — 라벨은 그대로, 값만 팀 풀로.
        this.lastUsage = { used: res.json.used_bytes, quota: res.json.pool_bytes ?? res.json.quota_bytes ?? 0 };
        // 쿼터는 첨부 크기와 달리 **누적되어 어느 날 갑자기** 걸린다. 봉인이 예고 없이 멎으면
        // 그 기간이 연구 기록의 공백으로 남는다 — 그래서 미리 알린다(단계마다 한 번씩).
        void this.warnQuotaNearFull();
        // D2: 모바일 봉인 자격 캐시 갱신(팀 스토리지 or 개인 쿼터>0)
        const ent = this.teamNanal() || this.lastUsage.quota > 0;
        if (ent !== this.settings.mobileEntitled) {
          this.settings.mobileEntitled = ent;
          void this.saveSettings();
          if (ent) this.startBackfill(); // 자격 획득(false→true): 게이트로 멈췄던 백필 재가동(소진되면 스스로 종료)
        }
      }
    } catch { /* 캐시 유지 */ }
  }

  // C1: 설정탭이 최근 60초 내 조회가 없을 때만 재조회하도록(실패 루프 방지).
  usageStale(): boolean {
    return Date.now() - this.usageFetchedAt > 60_000;
  }

  // ── 봉인 노트 브라우저 데이터 ──────────────────────────────────────────
  // D1: 리스트는 전원(게이트 없음) — 서버 /attest/notes.
  /// 봉인된 노트 전량(페이지를 이어 받는다). **못 받으면 null** — 빈 목록이 아니다.
  /// 부분 결과로 "사라졌다"를 판정하면 멀쩡한 노트를 사라졌다고 보고하게 된다.
  private async fetchAllSealedNotes(): Promise<NoteRow[] | null> {
    const out: NoteRow[] = [];
    let before: number | undefined;
    for (let page = 0; page < 200; page++) {
      const r = await this.fetchSealedNotes(before);
      if (!r) return null;
      out.push(...r.rows);
      if (!r.hasMore || r.rows.length === 0) return out;
      before = r.rows[r.rows.length - 1].seq;
    }
    return null;   // 상한 초과 — 불완전한 집합으로 판정하지 않는다
  }

  async fetchSealedNotes(beforeSeq?: number, vaultHash?: string, fromTs?: number, toTs?: number): Promise<{ rows: NoteRow[]; hasMore: boolean } | null> {
    if (!this.settings.apiKey) return null;
    try {
      const url = `${this.base()}/attest/notes?limit=30${beforeSeq != null ? `&before_seq=${beforeSeq}` : ""}${vaultHash ? `&vault_hash=${vaultHash}` : ""}${fromTs != null ? `&from_ts=${fromTs}` : ""}${toTs != null ? `&to_ts=${toTs}` : ""}`;
      const r = await requestUrl({ url, method: "GET", headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false });
      if (r.status !== 200) return null;
      return parseNotesResponse(r.json);
    } catch { return null; }
  }

  // vault 목록 — 서버 distinct(note_names)에서 바로(노트 스캔 없음). 브라우저 필터 드롭다운용.
  async fetchSealedVaults(): Promise<VaultRow[]> {
    if (!this.settings.apiKey) return [];
    try {
      const r = await requestUrl({ url: `${this.base()}/attest/vaults`, method: "GET", headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false });
      if (r.status !== 200) return [];
      return parseVaultsResponse(r.json);
    } catch { return []; }
  }

  // 노트 봉인 이력 — 브라우저 버전 모달용(기존 /attest/history 재사용, path=경로해시).
  async fetchNoteHistory(pathHash: string, beforeSeq?: number): Promise<{ rows: HistRow[]; hasMore: boolean } | null> {
    if (!this.settings.apiKey) return null;
    try {
      const url = `${this.base()}/attest/history?path=${pathHash}&limit=30${beforeSeq != null ? `&before_seq=${beforeSeq}` : ""}`;
      const r = await requestUrl({ url, method: "GET", headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false });
      if (r.status !== 200) return null;
      return parseHistoryResponse(r.json);
    } catch { return null; }
  }

  // vault 이름 복호 — decryptNoteName과 동일한 이중 DEK 폴백. 실패 시 해시 8자 표기.
  async decryptVaultName(v: VaultRow): Promise<string | null> {
    let frame: Uint8Array;
    try { frame = Uint8Array.from(atob(v.encVault), (c) => c.charCodeAt(0)); } catch { return null; }
    const order = this.teamNanal() ? [true, false] : [false, true];
    for (const team of order) {
      try {
        const dek = await this.nanalDek(team);
        if (!dek) continue;
        const pt = await decryptBlob(dek, v.vaultHash, "vault", frame);
        return new TextDecoder("utf-8").decode(pt);
      } catch { /* 다음 후보 */ }
    }
    return null;
  }

  // 이름 복호: 현재 모드 DEK 우선 → 타 모드 1회 폴백(C2 원문 읽기 관례) — 팀 전환 전후 이름 혼재 대응.
  // 둘 다 실패(410·키 불일치)면 null → 호출부가 해시 표기 폴백.
  async decryptNoteName(row: NoteRow): Promise<string | null> {
    if (!row.encName) return null;
    let frame: Uint8Array;
    try { frame = Uint8Array.from(atob(row.encName), (c) => c.charCodeAt(0)); } catch { return null; }
    const order = this.teamNanal() ? [true, false] : [false, true];
    for (const team of order) {
      try {
        const dek = await this.nanalDek(team);
        if (!dek) continue;
        const pt = await decryptBlob(dek, row.pathHash, "name", frame);
        return new TextDecoder("utf-8").decode(pt);
      } catch { /* 다음 후보 */ }
    }
    return null;
  }

  // D1 열람 게이트 판정: 팀 스토리지 or 개인 쿼터 보유. lastUsage는 뷰가 열릴 때 갱신.
  hasStoragePlan(): boolean {
    return this.teamNanal() || ((this.lastUsage?.quota ?? 0) > 0);
  }

  // ── vault 일괄 재구성(2026-07-22 정책 확정) — 공정 사용: 서버가 롤링 1년 2회 집행.
  // 복원 위치는 nanalStamp/restored-vault/<일시>/<원경로> — 현재 vault 무손상(원위치 이동은 사용자 검토 후).
  // 이름 없는 구 봉인은 스킵하고 리포트에 남긴다. 모든 바이트는 nanalFetch 해시 검증 통과분만 저장.
  async runVaultRestore(opts: { fromTs?: number; toTs?: number; vaultHash?: string; vaultLabel?: string }): Promise<void> {
    if (!this.settings.apiKey) { new Notice(t.apiKeyMissing); return; }
    // 세션 시작(한도 집행)
    let sessionId: string | null = null;
    try {
      const r = await requestUrl({
        url: `${this.base()}/attest/restore/start`, method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ from_ts: opts.fromTs ?? null, to_ts: opts.toTs ?? null, vault_hash: opts.vaultHash ?? null }),
        throw: false,
      });
      if (r.status !== 200) { new Notice(t.browserLoadFail); return; }
      if (r.json?.ok !== true) {
        const next = typeof r.json?.next_free_at === "number" ? fmtDate(new Date(r.json.next_free_at * 1000)) : "?";
        new Notice(`${t.restoreVaultLimit(next)}\n${t.restoreBuySoon}`, 10000);
        return;
      }
      sessionId = String(r.json.session_id);
    } catch { new Notice(t.browserLoadFail); return; }

    const stamp = fmtDateTime(new Date()).replace(/[: ]/g, "-");
    const rootDir = `${RESTORED_PREFIXES[0]}${stamp}`; // 판정 접두와 같은 출처(sealscope) — 어긋나면 재봉인 순환
    const progress = new Notice(t.restoreVaultRunning(0), 0);
    let done = 0, bytes = 0, skippedNoName = 0, skippedCopies = 0;
    const failed: string[] = [];
    // 보관본이 아예 없는 봉인(무료 구간에 봉인 → 원문 미업로드)은 **실패가 아니다**. 리포트에서 갈라 적지
    // 않으면 "구독 전 기록은 원문이 없다"는 정상 동작이 장애로 읽힌다(2026-07-28 설명서 촬영에서 발견).
    const noStored: string[] = [];
    let before: number | undefined;
    try {
      for (;;) {
        const page = await this.fetchSealedNotes(before, opts.vaultHash, opts.fromTs, opts.toTs);
        if (!page) break;
        for (const row of page.rows) {
          const name = await this.decryptNoteName(row);
          if (!name) { skippedNoName++; continue; }
          // 과거에 봉인돼버린 복원 사본은 재구성 대상에서 제외(순환 방지 — inScope 제외와 짝)
          if (isRestoredCopy(name)) { skippedCopies++; continue; }
          const isMd = name.toLowerCase().endsWith(".md");
          const r = await this.nanalFetch(row.fileHash, isMd ? "md" : blobExt(name), isMd);
          if ("error" in r) {
            (r.error === t.nanalRestoreNone ? noStored : failed).push(name);
            continue;
          }
          const dest = `${rootDir}/${name}`;
          const dir = dest.slice(0, dest.lastIndexOf("/"));
          await this.ensureVaultFolder(dir);
          try {
            if (isMd || typeof r.data === "string") {
              const text = typeof r.data === "string" ? r.data : new TextDecoder("utf-8").decode(new Uint8Array(r.data));
              await this.app.vault.create(dest, text);
              bytes += new TextEncoder().encode(text).byteLength;
            } else {
              await this.app.vault.createBinary(dest, r.data as ArrayBuffer);
              bytes += (r.data as ArrayBuffer).byteLength;
            }
            done++;
            if (done % 10 === 0) progress.setMessage(t.restoreVaultRunning(done));
          } catch { failed.push(name); } // 동일 경로 중복 등 — 리포트에 남김
        }
        if (!page.hasMore || page.rows.length === 0) break;
        before = page.rows[page.rows.length - 1].seq;
      }
    } finally {
      progress.hide();
    }

    // 복원 0건이면 무료 횟수·크레딧 미산정(aborted) — 전부 이름 미등록 스킵이거나 전송 한도(429) 등으로
    // 전건 실패해도 "받은 게 없으면" 소진하지 않는다(2026-07-22 검증 결함 수정 — 서버 정책도 0건만 aborted 인정).
    const aborted = done === 0;
    if (aborted && failed.length === 0 && noStored.length === 0 && skippedNoName === 0) {
      new Notice(t.restoreVaultNone);
      // 빈 실행 — aborted로 마감(한도 미산정, 서버가 note_count=0 확인)
      void this.finishRestore(sessionId, 0, 0, true);
      return;
    }
    // 리포트 노트 — 무엇이 복원·스킵·실패됐는지(감사 가능한 요약)
    const fmtRange = (ts?: number) => (ts != null ? fmtDateTime(new Date(ts * 1000)) : "—");
    const report = [
      `# vault 재구성 리포트`,
      ``,
      `- 실행: ${fmtDateTime(new Date())}`,
      `- 기간: ${fmtRange(opts.fromTs)} ~ ${fmtRange(opts.toTs)}`,
      `- vault: ${opts.vaultLabel ?? "모든 vault"}`,
      `- 복원: ${done}건 (${fmtBytes(bytes)})`,
      `- 이름 미등록 구 봉인 스킵: ${skippedNoName}건`,
      ...(skippedCopies > 0 ? [`- 복원 사본 제외: ${skippedCopies}건 (재구성 대상 아님)`] : []),
      ...(noStored.length
        ? [`- 보관본 없음 ${noStored.length}건 (원문 보관 전에 봉인된 기록 — 봉인·검증은 그대로 유효합니다):\n${noStored.map((f) => `  - ${f}`).join("\n")}`]
        : []),
      failed.length ? `- 실패 ${failed.length}건:\n${failed.map((f) => `  - ${f}`).join("\n")}` : `- 실패: 0건`,
      ``,
      `> 원본 검증: 모든 파일은 봉인 해시 검증을 통과한 바이트만 저장되었습니다.`,
    ].join("\n");
    try { await this.app.vault.create(`${rootDir}/${t.restoreReportName}`, report); } catch { /* 리포트 실패는 치명 아님 */ }
    void this.finishRestore(sessionId, done, bytes, aborted);
    new Notice(t.restoreVaultDone(done, rootDir), 10000);
  }

  private async finishRestore(sessionId: string | null, notes: number, bytes: number, aborted: boolean): Promise<void> {
    if (!sessionId) return;
    try {
      await requestUrl({
        url: `${this.base()}/attest/restore/finish`, method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ session_id: sessionId, note_count: notes, byte_count: bytes, aborted }),
        throw: false,
      });
    } catch { /* 기록 실패는 복원 결과에 영향 없음 */ }
  }


  // 백필 가동 여부 — 대시보드가 "자동 재봉인 진행 중"을 조치 필요와 구분해 표시하는 데 쓴다.
  isBackfilling(): boolean { return this.backfillTimer !== undefined; }

  // 보관 동기화 즉시 1회 — 대기 모달의 [지금 재시도](30초 주기를 기다리지 않음).
  kickStorageSync(): void {
    this.retrySealArchive();
    void this.ledgerSweep();
  }

  // 봉인명 인덱스(링크텍스트 → 최신 봉인 해시·경로) — 아카이브 뷰의 임베드 하이드레이션용.
  // 다른 기기(모바일)에서 봉인된 첨부는 이 vault에 없으므로, 원장 리스트의 복호 이름으로 찾는다.
  // basename 키는 더 짧은 경로 우선(Obsidian 링크 해석 관례 근사). 60초 캐시, 상한 20페이지(600건 — 초과는 콘솔 로그).
  private sealedNameCache: { at: number; map: Map<string, { hash: string; path: string; receivedAt: number }> } | null = null;
  async sealedAttachmentByLink(linkText: string): Promise<{ hash: string; path: string; receivedAt: number } | null> {
    const now = Date.now();
    if (!this.sealedNameCache || now - this.sealedNameCache.at > 60_000) {
      const map = new Map<string, { hash: string; path: string; receivedAt: number }>();
      let before: number | undefined = undefined;
      for (let page = 0; page < 20; page++) {
        const res: { rows: NoteRow[]; hasMore: boolean } | null = await this.fetchSealedNotes(before);
        if (!res) break;
        for (const row of res.rows) {
          const name = await this.decryptNoteName(row);
          if (!name) continue;
          const entry = { hash: row.fileHash, path: name, receivedAt: row.receivedAt };
          const full = name.toLowerCase();
          if (!map.has(full)) map.set(full, entry);
          const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
          const prev = map.get(base);
          if (!prev || prev.path.length > name.length) map.set(base, entry);
        }
        if (!res.hasMore || res.rows.length === 0) break;
        before = res.rows[res.rows.length - 1].seq;
        if (page === 19) console.warn("[nanalstamp] sealed name index capped at 600 — older embeds may not hydrate");
      }
      this.sealedNameCache = { at: now, map };
    }
    const key = linkText.toLowerCase();
    return this.sealedNameCache.map.get(key) ?? null;
  }

  // 봉인 임베드 버전 해석 — 노트 봉인 시각(noteTs)에 맞는 첨부 버전을 고른다(시점 일관 열람).
  // 이름 인덱스로 경로·최신 해시 확정 → /attest/history(경로해시, seq DESC)에서 noteTs 이하 최신 버전.
  // noteTs 이하가 없으면(같은 스윕에서 첨부가 노트보다 늦게 봉인) 노트 이후 가장 이른 버전으로 폴백.
  // noteTs=0(시각 미상)이면 최신 봉인본. 실패 시에도 최신 봉인본 — 로컬 폴백은 절대 없다(S3-only 원칙).
  async sealedEmbedVersion(linkText: string, noteTs: number): Promise<{ hash: string; path: string; receivedAt: number } | null> {
    const m = await this.sealedAttachmentByLink(linkText);
    if (!m || !noteTs) return m;
    try {
      const ph = await hashPath(m.path);
      let before: number | undefined;
      let earliestAfter: { hash: string; receivedAt: number } | null = null;
      for (let page = 0; page < 10; page++) {
        const r = await requestUrl({
          url: `${this.base()}/attest/history?path=${ph}&limit=50${before != null ? `&before_seq=${before}` : ""}`,
          method: "GET", headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false,
        });
        if (r.status !== 200 || !Array.isArray(r.json?.rows)) break;
        const rows = r.json.rows as Array<{ seq: number; received_at: number; file_hash: string }>;
        for (const row of rows) {
          if (typeof row.received_at !== "number" || typeof row.file_hash !== "string") continue;
          if (row.received_at <= noteTs) return { hash: row.file_hash, path: m.path, receivedAt: row.received_at }; // DESC — 첫 매치가 noteTs 이하 최신
          earliestAfter = { hash: row.file_hash, receivedAt: row.received_at }; // 마지막으로 남는 값 = 노트 이후 중 가장 이른 버전
        }
        if (r.json.has_more !== true || rows.length === 0) break;
        before = rows[rows.length - 1].seq;
      }
      if (earliestAfter) return { hash: earliestAfter.hash, path: m.path, receivedAt: earliestAfter.receivedAt };
    } catch { /* 최신 봉인본 폴백 */ }
    return m;
  }

  // P2/B: 이 노트의 GitHub 미러 파일 URL(개인 repo 또는 팀 custody). 미러 대상이 없으면 null.
  // /blob/HEAD/ 는 기본 브랜치로 해석된다. 경로 규칙은 mirrorToGithub의 contentPath와 동일해야 한다.
  githubMirrorUrl(file: TFile): string | null {
    const custody = this.settings.teamCustody;
    const repo = custody ? `${custody.org}/${custody.repo}` : this.settings.githubRepo.trim().replace(/^\/+|\/+$/g, "");
    if (!repo) return null;
    const safe = safeName(file.path);
    const contentPath = this.isBinary(file)
      ? `attachments/${safe}`
      : this.isDigestPath(file.path) ? `digests/${safe}.md` : `notes/${safe}.md`;
    const enc = contentPath.split("/").map(encodeURIComponent).join("/");
    return `https://github.com/${repo}/blob/HEAD/${enc}`;
  }






  // v2b: 명령 — 활성 노트의 nanal 보관 proof를 v1로 내보내기(vault에 파일 생성).
  /** Phase D: DEK 조회(세션 캐시 — 디스크 비저장). 실패·410(파기됨) 시 null —
   * 호출부는 업로드를 중단한다(평문 폴백 금지: DEK 없는 채 평문을 올리면 크립토-슈레딩이 무력화된다).
   * 402 쿼터 backoff와 대칭인 실패 처리: 410(파기 — 종결 상태)은 1시간 네거티브 캐시 + 세션당 1회 Notice,
   * 일시 실패(네트워크·5xx)는 60초 네거티브 캐시(한 sweep의 파일별 중복 GET 방지). 성공은 기존대로 영구 캐시.
   * 콜드 캐시 병렬 호출(조각 복원 5개 배치 등)은 in-flight Promise 공유로 GET 1회. */

  protected async fetchDek(k: string, team: boolean): Promise<string | null> {
    let status = 0;
    try {
      const r = await requestUrl({
        url: storageEndpoint(this.base(), team, "key"),
        method: "GET",
        headers: { "x-nanal-api-key": this.keyFor(team) },
        throw: false,
      });
      status = r.status;
      if (status === 200 && typeof r.json?.dek === "string") return r.json.dek;
    } catch { /* 네트워크 예외 — 아래 일시 backoff */ }
    this.dekCache.delete(k); // 실패 Promise는 캐시에 남기지 않는다(성공만 유지) — 재시도는 dekDeny 만료 후
    console.error("[nanalstamp] storage key", status);
    if (status === 410) {
      this.dekDeny.set(k, { until: Date.now() + 3_600_000, gone: true });
      if (!this.dekGoneNotified) { this.dekGoneNotified = true; new Notice(t.nanalDekGone); }
    } else {
      this.dekDeny.set(k, { until: Date.now() + 60_000, gone: false });
    }
    return null;
  }

  // 노트명(경로) 암호화 — NSE1 "name" 도메인, 키 파생 인자는 path_hash.
  // GCM 안전 논거: (키,nonce)가 path_hash로 결정되고 평문(경로)도 path_hash가 유일 결정하므로
  // 같은 (키,nonce)에 다른 평문이 들어갈 수 없다(cryptocore 수렴 계약의 경로판).
  // 주의: 이 도메인의 평문은 반드시 "경로 원문"이어야 한다 — path_hash가 결정하지 않는 값(제목 등)을 넣으면 계약 붕괴.
  // DEK 미취득(오프라인 backoff·410 슈레딩)이면 null — 봉인은 이름 없이 진행, 다음 봉인이 보충(스펙 B-2).
  private async encNameFor(path: string, pathHash: string): Promise<string | null> {
    try {
      // 원문과 **같은 판정**으로 키를 고른다. 계정 단위로 고르면 개인 노트 이름까지 팀 키로
      // 잠겨, 서버의 team_scope 필터 하나만 뚫리면 관리자가 그 이름을 푼다.
      const dek = await this.nanalDek(this.teamBlobFor(path));
      if (!dek) return null;
      const enc = await encryptBlob(dek, pathHash, "name", new TextEncoder().encode(path));
      return arrayBufferToBase64(enc.buffer as ArrayBuffer);
    } catch (e) { console.warn("[nanalstamp] enc_name skip", e); return null; }
  }

  // vault 식별 암호화 — "vault" 도메인, 키 파생 인자는 vault 이름 자체의 해시(경로해시와 동일 원리:
  // vault_hash가 이름을 유일 결정 → 같은 (키,nonce)에 다른 평문 불가). 세션 캐시(이름·모드 불변 전제,
  // 모드 전환 시 무효화는 dekCache와 동일하게 다음 세션 — 표시용이라 치명적이지 않음).
  private encVaultCache: { hash: string; enc: string } | null = null;
  private async encVaultFor(): Promise<{ hash: string; enc: string } | null> {
    if (this.encVaultCache) return this.encVaultCache;
    try {
      const name = this.app.vault.getName();
      if (!name) return null;
      const dek = await this.nanalDek(this.teamNanal());
      if (!dek) return null;
      const vh = await hashVaultName(name);
      const enc = await encryptBlob(dek, vh, "vault", new TextEncoder().encode(name));
      this.encVaultCache = { hash: vh, enc: arrayBufferToBase64(enc.buffer as ArrayBuffer) };
      return this.encVaultCache;
    } catch (e) { console.warn("[nanalstamp] enc_vault skip", e); return null; }
  }

  // D2: 모바일 봉인은 스토리지 플랜 전용 — 원본이 보존되는 봉인만 제공(로컬 git 아카이브는 데스크톱 전용이므로).
  private sealingAllowed(): boolean {
    return Platform.isDesktopApp || this.settings.mobileEntitled;
  }

  // presign → (exists면 스킵) → presigned URL로 S3 직접 PUT.
  // sealedHash=게이트·키용 원문 해시, blobHash=업로드 본문 자체 해시(원문이면 동일).
  // C1: size가 Content-Length로 서명되므로 body 크기와 정확히 일치해야 한다.
  // 402(쿼터 초과)는 1시간 backoff — 결제 전 재시도는 무의미(업그레이드 후 sweep이 재포착).
  // Phase D: encSha256이 있으면 body는 암호문 — S3 checksum만 암호문 해시로 서명하고
  // 키·게이트·exists(sha256/blob_sha256)는 평문 해시를 유지한다(콘텐츠주소·dedup 불변).
  // 일시 오류만 500ms 후 1회 즉시 재시도: 네트워크 예외(throw)·5xx. 4xx는 재시도 무의미(402 backoff·검증 오류)라 그대로 반환.
  // 재시도도 실패하면 null(예외) 또는 그 응답을 돌려주고, 상위의 기존 30초 스윕·재시도 경로가 재포착한다(여기서 루프 금지).
  protected async requestWithOneRetry(req: () => Promise<RequestUrlResponse>): Promise<RequestUrlResponse | null> {
    const attempt = async (): Promise<RequestUrlResponse | null> => {
      try { return await req(); } catch { return null; }
    };
    let res = await attempt();
    if (res && res.status < 500) return res;
    await new Promise((r) => window.setTimeout(r, 500));
    return (await attempt()) ?? res;
  }



  // ── P2: GitHub Contents API 미러(원본 notes/ + 증명 proofs/) ─────────────────

  // repo 최초 1회 README push(무엇인지 + 검증법). 이미 있으면(또는 이 repo에 한번 했으면) 건너뜀.
  protected async ensureGithubReadme() {
    const repo = this.settings.githubRepo.trim();
    if (!repo) return;
    if (this.settings.githubReadmeRepo === repo) return;
    try {
      const get = await requestUrl({ url: this.githubContentsUrl("README.md"), method: "GET", headers: this.githubHeaders(), throw: false });
      if (get.status === 200) { // 이미 존재 — 사용자 README를 덮지 않음
        this.settings.githubReadmeRepo = repo;
        await this.persist();
        return;
      }
      if (get.status === 401 || get.status === 403) return; // 인증 문제는 실제 push 단계에서 알림
      const readme =
        "# nanalStamp vault mirror\n\n" +
        "This repository is an automatic mirror created by the **nanalStamp** Obsidian plugin.\n\n" +
        "- `notes/` — original note content (the exact bytes that were hashed).\n" +
        "- `proofs/` — one `.nanalproof` per note: a self-verifying bundle (signature, Merkle path, OpenTimestamps proof, Bitcoin block, public key).\n\n" +
        "## Verify\n\n" +
        "Each proof is independently verifiable without nanalStamp's servers:\n\n" +
        "1. Hash the matching file in `notes/` with SHA-256 and check it against the proof.\n" +
        "2. Verify the embedded OpenTimestamps proof against the Bitcoin blockchain (`ots verify`) — or use the `/np-verify` helper.\n\n" +
        "The trust anchor is Bitcoin, not nanalStamp. Even if nanalStamp disappears, these proofs stand on their own.\n";
      if (await this.githubPut("README.md", readme, "nanalStamp: initialize mirror (README)")) {
        this.settings.githubReadmeRepo = repo;
        await this.persist();
      }
    } catch (e) {
      console.error("[nanalstamp] github readme error", e);
    }
  }

  private githubHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.settings.githubPat}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
  private githubContentsUrl(path: string): string {
    const repo = this.settings.githubRepo.trim().replace(/^\/+|\/+$/g, "");
    const enc = path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${repo}/contents/${enc}`;
  }

  // GitHub Contents API로 파일 생성/갱신(base64). 기존 sha 조회 후 PUT. 성공 시 true.
  // 401/403/429/409는 Notice로 알리고 false 반환 → 크래시 없이 다음 sweep에서 재시도.
  protected async githubPut(path: string, content: string | ArrayBuffer, message: string): Promise<boolean> {
    const url = this.githubContentsUrl(path);
    let sha: string | undefined;
    const get = await requestUrl({ url, method: "GET", headers: this.githubHeaders(), throw: false });
    if (get.status === 200) sha = get.json?.sha;
    else if (get.status === 401 || get.status === 403) { new Notice(t.mirrorFail(String(get.status))); return false; }
    else if (get.status === 429) { new Notice(t.rateLimited); return false; }
    const payload: any = {
      message,
      content: typeof content === "string" ? toBase64(content) : arrayBufferToBase64(content),
      committer: { name: "nanalStamp", email: "mirror@nanalstamp.com" },
    };
    if (sha) payload.sha = sha; // 갱신이면 기존 sha 필요
    const put = await requestUrl({
      url,
      method: "PUT",
      headers: { ...this.githubHeaders(), "content-type": "application/json" },
      body: JSON.stringify(payload),
      throw: false,
    });
    if (put.status === 200 || put.status === 201) return true;
    if (put.status === 429) { new Notice(t.rateLimited); return false; }   // 다음 sweep에서 재시도
    if (put.status === 409) return false;                                   // sha 경합 — 다음 sweep에서 재시도
    new Notice(t.mirrorFail(`${put.status}: ${put.json?.message ?? "unknown"}`));
    return false;
  }

  // 4.3: 팀 custody 미러 — 서버 프록시(PUT /attest/team/mirror)로 조직 repo에 통과 쓰기. content는 base64.
  // 서버가 members/<uid>/ 접두를 붙이므로 notes/·proofs/·attachments/ 상대 경로 그대로 전송한다.
  // 200이면 true. 404(오프보딩)면 teamCustody를 정리하고 false(조용히 중단). 409(동시 수정)·503·기타는
  // false → mirrorIndex 미갱신으로 다음 sweep에서 재시도(기존 미러 재시도 흐름에 편승). 400은 로그성 처리.
  protected async proxyPut(path: string, content: string | ArrayBuffer): Promise<boolean> {
    const content_b64 = typeof content === "string" ? toBase64(content) : arrayBufferToBase64(content);
    const res = await requestUrl({
      url: `${this.base()}/attest/team/mirror`,
      method: "PUT",
      headers: { "x-nanal-api-key": this.keyFor(true), "content-type": "application/json" },
      body: JSON.stringify({ path, content_b64 }),
      throw: false,
    });
    if (res.status === 200) return true;
    if (res.status === 404) { await this.setTeamCustody(null); return false; } // 오프보딩 — custody 정리 후 조용히 중단
    if (res.status === 429) { new Notice(t.rateLimited); return false; }        // 다음 sweep 재시도
    if (res.status === 409) return false;                                       // 동시 수정 — 다음 sweep 재시도
    if (res.status === 400) { console.error("[nanalstamp] team mirror rejected", path, res.json?.error ?? res.status); return false; }
    console.error("[nanalstamp] team mirror failed", path, res.status);         // 503(서버 미설정) 등 — 다음 sweep 재시도
    return false;
  }

  base() { return this.settings.serverUrl.replace(/\/$/, ""); } // 모달·뷰에서도 사용(재구성 status 등)
  // 사용자 페이지 도메인: API(api.nanalstamp.com)와 분리 → nanalstamp.com
  private webBase() { return this.base().replace("://api.", "://"); }

  openExternal(path: string) {
    const url = path.startsWith("http") ? path : this.webBase() + path;
    window.open(url, "_blank");
  }

  // 공개 검증 링크 생성(Pro) → 클립보드 복사
  async makePublicLink() {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    const f = this.app.workspace.getActiveFile();
    if (!f) return new Notice(t.noNote);
    try {
      const content = await this.app.vault.read(f);
      const hash = await sha256Hex(content);
      const v = await this.queryVerify(hash);
      if (!v?.found) return new Notice(t.sealFirst(f.basename)); // 미봉인이면 먼저 봉인 안내
      const res = await requestUrl({
        url: `${this.base()}/attest/public-link`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ hash }),
        throw: false,
      });
      if (res.status === 402) { new Notice(t.proOnly); this.openExternal("/pricing"); return; }
      if (res.status !== 200) { new Notice(t.linkFail(String(res.status))); return; }
      // 서버가 절대 URL(nanalstamp.com)을 반환 — 구버전 호환 위해 상대경로면 webBase 보정
      const u: string = res.json.url;
      const url = u.startsWith("http") ? u : this.webBase() + u;
      try { await navigator.clipboard.writeText(url); } catch (_) { /* ignore */ }
      new Notice(t.linkOk(url));
    } catch (e: any) { new Notice(t.linkFail(e?.message ?? String(e))); }
  }

  // 결제 시작 → pay 페이지 열기
  async startCheckout(planCode: string) {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    try {
      // 한국어=Toss(KRW), 그 외=Stripe(USD)
      const lang: Lang = this.settings.lang === "auto" ? pickLang() : (this.settings.lang as Lang);
      const gateway = lang === "ko" ? "toss" : "lemonsqueezy";
      const res = await requestUrl({
        url: `${this.base()}/attest/checkout`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ plan_code: planCode, gateway }),
        throw: false,
      });
      if (res.status !== 200) { new Notice(t.checkoutFail(String(res.status))); return; }
      this.openExternal(res.json.checkout_url);
      // 결제는 외부 브라우저에서 완료 — 잠시 뒤 자격 갱신 시도(구독/크레딧 반영)
      window.setTimeout(() => void this.refreshEntitlement(), 20000);
    } catch (e: any) { new Notice(t.checkoutFail(e?.message ?? String(e))); }
  }

  // 이메일/비번 로그인 → API 키 자동 발급(무료 가입자). tier 반환.
  async accountLogin(email: string, password: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.base()}/attest/account/login`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(res.json?.error || `HTTP ${res.status}`);
    this.settings.apiKey = res.json.api_key;
    this.settings.accountEmail = email.trim(); // 계정 카드 표시용
    await this.saveSettings();
    // 로그인 직후 팀 프로파일 적용(fire-and-forget, 실패 무시). 자동 적용이 꺼져 있으면 트래픽 생략.
    if (this.settings.teamProfileEnabled) void this.fetchTeamProfile();
    // 4.3: custody 미러 정보도 로그인 직후 수신(연결·오프보딩 반영).
    void this.fetchTeamMirrorInfo();
    return res.json.tier;
  }

  /// 팀 계정으로 로그인해 **그 계정의 키만** 저장한다. 개인 계정은 건드리지 않는다.
  ///
  /// 개인 계정과 같은 방식이어야 한다 — 키를 어디서 구하는지 모르는 사람에게 `nsk_…` 를
  /// 붙여넣으라고 하면 쓸 수 없다(2026-08-01 지적).
  async teamAccountLogin(email: string, password: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.base()}/attest/account/login`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      throw: false,
    });
    if (res.status !== 200) throw new Error(res.json?.error || `HTTP ${res.status}`);
    this.settings.teamApiKey = res.json.api_key;
    this.settings.teamAccountEmail = email.trim();
    // 봉인 응답 검증에 쓸 계정 ID. 구서버가 안 주면 비워 두고, 그때는 검증을 건너뛴다
    // (확인 수단이 없다고 봉인을 되돌리면 그게 더 나쁘다 — verifySealAck 의 기존 규칙).
    this.settings.teamClaimAccount = typeof res.json.user_id === "string" ? res.json.user_id : "";
    await this.saveSettings();
    this.resetTeamKeyCaches();
    // 팀 정보(루트·구조·custody)는 **팀 계정 것**을 봐야 한다 — 개인 계정에는 그 팀이 없다.
    if (this.settings.teamProfileEnabled) void this.fetchTeamProfile();
    void this.fetchTeamMirrorInfo();
    return res.json.tier;
  }

  /// 팀 계정 연결을 푼다 — 그 뒤로는 개인 키가 양쪽에 쓰인다(연결 전과 같다).
  async teamAccountLogout(): Promise<void> {
    this.settings.teamApiKey = "";
    this.settings.teamAccountEmail = "";
    this.settings.teamClaimAccount = "";
    await this.saveSettings();
    this.resetTeamKeyCaches();
  }

  /// 팀에서 빠졌을 때 팀 흔적을 지운다(2026-08-06).
  ///
  /// 종전에는 404 를 받아도 `teamRole` 하나만 지웠다. 그래서 **팀을 나가도 `teamStructure` 가
  /// 남아 `teamRoot()` 가 계속 옛 팀 루트를 가리켰다** — 그 폴더의 노트가 팀 범위로 봉인되고,
  /// 팀 UI 가 계속 보이고, 자동 적용(2026-08-05)이 붙은 뒤로는 **나간 팀의 폴더를 계속 되살리고**
  /// 상태 보고가 매번 404 를 받아 콘솔에 오류를 찍었다.
  ///
  /// **404 는 「팀원이 아니다」만 뜻한다** — 서버에서 이 응답은 `member_team` 한 곳에서만 나온다
  /// (팀 설정이 없는 새 팀도 200 에 빈 프로파일을 준다). 그래서 지워도 안전하다.
  ///
  /// 팀 계정 연결(`teamApiKey`)도 함께 푼다. 그 키로는 팀 라우트가 전부 404 라 쓸모가 없고,
  /// 남겨 두면 설정의 팀 정책 토글이 잠긴 채로 남는다(팀도 없는데 끌 수 없다). 같은 이유로
  /// custody 캐시는 `fetchTeamMirrorInfo` 가 이미 404 에서 비운다 — 여기서도 함께 비워 둔다
  /// (그 함수가 안 불릴 수 있다).
  ///
  /// 지울 것이 없으면 **조용히 지나간다** — 팀에 속한 적 없는 개인 사용자는 이 경로를 매번
  /// 지나므로, 저장·안내가 폴링마다 반복되면 안 된다.
  private async clearTeamState(): Promise<void> {
    const s = this.settings;
    const had = !!(s.teamRole || s.teamStructure || s.teamApiKey || s.knownFolderNames
                   || s.teamTemplates.length || this.teamProjects.length);
    if (!had) return;
    const hadTeamAccount = !!s.teamApiKey;
    // 봉인 범위는 **건드리지 않는다.** 팀 루트는 그 자체로 팀 봉인 범위였고(inFolderScopePure의
    // `teamRoot && under(teamRoot)`), 팀원이 아니게 되면 그 범위는 사라지는 것이 맞다.
    // 개인 범위(includeFolders·sealWholeVault)는 사용자가 정한 것이라 여기서 늘리지 않는다 —
    // 팀 기록이던 노트를 묻지도 않고 개인 기록으로 봉인하기 시작하면 그게 더 나쁘다.
    // 그 폴더를 계속 봉인하고 싶으면 사용자가 개인 범위에 직접 넣는다(설정 → 봉인 범위).
    s.teamRole = "";
    s.teamStructure = "";        // → teamRoot() 가 null 이 된다(이 정리의 핵심)
    s.teamTemplates = [];
    s.teamDigestCadence = "";
    s.teamAttachmentMaxMB = null;
    s.knownFolderNames = "";     // 옛 팀 이름 기준 이동 제안이 되살아나지 않게
    s.teamApiKey = ""; s.teamAccountEmail = ""; s.teamClaimAccount = "";
    this.teamProjects = [];
    // 미룬 이동은 따로 들고 있지 않다 — pendingFolderRenames()가 teamStructure·knownFolderNames
    // 로부터 그때그때 계산한다. 둘을 비웠으니 자동으로 빈 목록이 된다.
    this.folderSyncSnoozed = false;
    this.lastFolderResult = { missing: 0, conflicts: [] };
    this.lastFolderReport = "";
    await this.saveSettings();
    this.resetTeamKeyCaches();
    await this.setTeamCustody(null, null);
    // 조용히 지우면 "왜 팀 폴더가 안 생기지"가 된다 — 무슨 일이 있었는지 한 번 알린다.
    new Notice(hadTeamAccount ? t.teamLeftWithAccount : t.teamLeft, 12000);
  }

  // 3.2: 팀 프로파일 수신 — GET /attest/team/profile (멤버 키). 404(팀 미소속)·비200·네트워크 오류는
  // 조용히 스킵(호출부가 결과 상태로 Notice를 결정). 200이면 applyTeamProfile로 반영.
  async fetchTeamProfile(): Promise<"applied" | "not-member" | "no-key" | "error"> {
    if (!this.settings.apiKey) return "no-key";
    let res: any;
    try {
      res = await requestUrl({
        url: `${this.base()}/attest/team/profile`,
        method: "GET",
        // 팀 정보는 **팀 계정** 것이다. 개인 키로 물으면 404 가 나고 팀 루트가 사라져
        // 경로 판정이 통째로 무너진다(팀 폴더 노트가 개인으로 떨어진다).
        headers: { "x-nanal-api-key": this.keyFor(true) },
        throw: false,
      });
    } catch (_) { return "error"; }
    if (res.status === 404) { await this.clearTeamState(); return "not-member"; }
    if (res.status !== 200) return "error";
    const profile = res.json?.profile;
    // 역할은 프로파일 본문이 아니라 응답 최상위에 온다 — 팀을 떠나면 아래 404 분기에서 정리된다.
    this.settings.teamRole = typeof res.json?.role === "string" ? res.json.role : "";
    // 팀이 만료되면 팀 보관이 막힌다(서버가 팀 경로 presign 에서 403). 그 사실을 알리지 않으면
    // 팀원은 원문이 보관되는 줄 안 채 계속 쓴다 — 개인 만료와 같은 수준으로 한 번 알린다.
    const teamExpired = res.json?.expired === true;
    if (teamExpired && !this.teamExpiredNotified) {
      this.teamExpiredNotified = true;
      new Notice(t.teamExpired, 15000);
    } else if (!teamExpired) {
      this.teamExpiredNotified = false;
    }
    await this.applyTeamProfile(profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {});
    return "applied";
  }

  // 4.3/C2: custody 미러 정보 수신 — GET /attest/team/mirror/info (멤버 키). 팀 프로파일과 같은 타이밍에 호출.
  // enabled면 teamCustody={org,repo}로 캐시, 그 외(disabled·404 오프보딩·비200·네트워크 오류)면 null로 정리
  // (연결 해제·오프보딩 반영). 조용히 — 호출부(수동 버튼)만 결과 상태로 Notice를 결정한다.
  // C2: team_storage 필드(응답에 있으면)도 같은 타이밍에 갱신 — 구서버(필드 부재) → null → 현행 동작(하위 호환).
  async fetchTeamMirrorInfo(): Promise<"enabled" | "disabled" | "not-member" | "no-key" | "error"> {
    if (!this.settings.apiKey) return "no-key";
    let res: any;
    try {
      res = await requestUrl({
        url: `${this.base()}/attest/team/mirror/info`,
        method: "GET",
        // 팀 정보는 **팀 계정** 것이다. 개인 키로 물으면 404 가 나고 팀 루트가 사라져
        // 경로 판정이 통째로 무너진다(팀 폴더 노트가 개인으로 떨어진다).
        headers: { "x-nanal-api-key": this.keyFor(true) },
        throw: false,
      });
    } catch (_) { await this.setTeamCustody(null); return "error"; }
    // C2: 404 = 서버가 비멤버 확정(퇴사·오프보딩) — 두 필드 모두 클리어(고착 방지). 안 지우면 teamStorage:"nanal"이
    // 남아 nanalActive 강제 true → 팀 라우트 전부 404 → 보존이 영구 조용히 실패 + 설정 잠김 + 회복 경로 없음.
    // catch/비-200은 transient(네트워크·서버 오류)일 수 있어 teamStorage 보존(현행 유지).
    if (res.status === 404) { await this.setTeamCustody(null, null); return "not-member"; }
    if (res.status !== 200) { await this.setTeamCustody(null); return "error"; }
    const j = res.json ?? {};
    const teamStorage: "nanal" | null = j.team_storage === "nanal" ? "nanal" : null;
    if (j.enabled === true && typeof j.org === "string" && typeof j.repo === "string") {
      await this.setTeamCustody({ org: j.org, repo: j.repo }, teamStorage);
      return "enabled";
    }
    await this.setTeamCustody(null, teamStorage);
    return "disabled";
  }

  // teamCustody/teamStorage 캐시를 갱신(변경 있을 때만 persist — 불필요한 파일 쓰기 방지).
  // teamStorage 미전달(다른 오프보딩 호출부)이면 기존 값 유지 — GitHub custody 오프보딩이 팀 스토리지 상태까지
  // 임의로 지우지 않도록(둘은 독립 필드). fetchTeamMirrorInfo만 서버 응답값으로 명시 갱신한다.
  private async setTeamCustody(v: { org: string; repo: string } | null, teamStorage?: "nanal" | null): Promise<void> {
    const cur = this.settings.teamCustody;
    const same = (!cur && !v) || (!!cur && !!v && cur.org === v.org && cur.repo === v.repo);
    const ts = teamStorage === undefined ? this.settings.teamStorage : teamStorage;
    const sameStorage = this.settings.teamStorage === ts;
    this.settings.teamCustody = v;
    this.settings.teamStorage = ts;
    if (!same || !sameStorage) await this.saveSettings();
  }

  // 3.2: 팀 프로파일 반영 — teamProfileEnabled가 켜져 있을 때만(07-07 강제 금지: 끄면 로컬 값 유지).
  // profile에 존재하고 타입이 맞는 필드만 로컬 설정에 덮어쓴다(팀 정책 우선). 잘못된 타입은 개별 무시(전체 실패 금지).
  // 모르는 필드는 무시(전방 호환). 빈 프로파일({})도 정상 — 수신 시각만 갱신.
  private async applyTeamProfile(profile: Record<string, unknown>): Promise<void> {
    if (!this.settings.teamProfileEnabled) return;
    const s = this.settings;
    // 이원화(2026-07-24): include/exclude 필터 폐지 — structure(팀 표준 폴더 구조)가 스코프를 지배.
    // structure 키가 존재하면 명시적 상태(빈 구조 = 해제 → 로컬 설정 복귀), 키 부재 = 미관리(기존 값 유지).
    // 포털은 templates와 같은 이유(회수 가능해야 함)로 structure를 항상 전송한다.
    // 루트 필수(2026-07-25): parseTeamStructure가 root 없거나 불량이면 null → "" 저장(= 해제, 로컬 설정 복귀).
    if (profile.structure !== undefined) {
      const structure = parseTeamStructure(profile.structure);
      // 저장은 봉인 스코프 판정용이고, **폴더는 아래 ensureTeamFolders가 자동으로 만든다**(2026-08-05).
      // 종전 정책("폴더 자동 생성 금지, 2026-07-25")을 뒤집은 것이다 — 근거는 ensureTeamFolders 주석.
      const nextStructure = structure ? JSON.stringify(structure) : "";
      // 도착 사실은 그대로 알린다. 자동으로 만들더라도 vault에 폴더가 갑자기 생긴 이유를
      // 말해 주지 않으면 팀원 입장에서는 원인 모를 변화다.
      // 값이 실제로 바뀐 경우에만 띄우므로(같은 값 재수신은 조용) 수신마다 반복되지 않는다 —
      // 별도 "안내했음" 플래그를 저장할 필요가 없는 이유다.
      if (nextStructure && nextStructure !== s.teamStructure) new Notice(t.teamStructureArrived, 8000);
      s.teamStructure = nextStructure;
    }
    if (typeof profile.digest_cadence === "string") s.teamDigestCadence = profile.digest_cadence;
    if (typeof profile.seal_attachments === "boolean") s.sealAttachments = profile.seal_attachments;
    if (typeof profile.seal_kit_samples === "boolean") s.sealKitSamples = profile.seal_kit_samples;
    // attachment_max_mb: 개인 설정 UI는 제거됐지만 팀 관리(포털 team.html)·서버(team.rs)가 편집·배포하는 살아있는 계약 —
    // 전용 필드에 저장하고, 업로드 유효 상한 = uploadLimitMB()(팀 정책 ∧ 서버 하드캡 5GB — 봉인에는 상한 없음).
    if (typeof profile.attachment_max_mb === "number" && Number.isFinite(profile.attachment_max_mb) && profile.attachment_max_mb >= 0) {
      s.teamAttachmentMaxMB = profile.attachment_max_mb;
    }
    // templates: name·body가 둘 다 문자열인 원소만 캐시(그 외 무시).
    if (Array.isArray(profile.templates)) {
      s.teamTemplates = (profile.templates as unknown[])
        .filter((x): x is { name: string; body: string } =>
          !!x && typeof x === "object" &&
          typeof (x as any).name === "string" && typeof (x as any).body === "string")
        .map((x) => ({ name: x.name, body: x.body }));
    }
    s.teamProfileUpdatedAt = Date.now();
    await this.saveSettings(); // 폴더 범위·첨부 설정 변경 → 상태바 갱신 포함
    // 저장 뒤에 만든다 — teamRoot()가 teamStructure를 읽으므로 순서를 바꾸면 옛 루트에 만든다.
    this.lastFolderResult = await this.ensureTeamFolders();
    void this.syncFolderNames(); // 루트 이름이 바뀌었으면 폴더 이동을 제안한다
    // 이 시점의 lastFolderResult·pendingFolderRenames()를 바로 보고한다(Task 11) — syncFolderNames가
    // 이름변경 모달을 띄우면 사용자가 답할 때까지 그 함수는 끝나지 않는다(내부에서도 끝에 다시
    // 보고하지만, 모달이 오래 열려 있는 동안 관리자 화면이 그만큼 뒤처지면 안 된다).
    void this.reportFolderState();
  }

  /// 팀이 정한 폴더를 vault에 **자동으로** 만든다(2026-08-05).
  ///
  /// 끄기 스위치는 없다 — 조직 강제가 이 요금제를 사는 이유다. 종전 정책(applyTeamProfile의
  /// "폴더 자동 생성 금지, 2026-07-25")을 뒤집은 것이고, 그때와 전제가 다르다: 그때는 개인 제품의
  /// 연장이었고 지금은 조직이 돈을 내고 규정을 강제하는 제품이다. 팀이 정한 구조가 팀원의 클릭
  /// 한 번에 달려 있으면 제품이 스스로를 무력화한다.
  /// **개인 계정에는 이 동작이 없다** — 팀 루트가 없으면 곧바로 돌아간다.
  ///
  /// 되돌릴 수 있는 것만 자동이다:
  ///  - 빈 폴더·서식 → 만든다(폴더를 지우면 다음 수신에서 되살아난다 — 버그가 아니라 의도).
  ///  - 샘플 → **만들지 않는다**(samples: false). `.md`라 봉인 대상이 되고 봉인은 되돌릴 수 없다.
  ///  - 남의 노트가 있는 폴더 → 건드리지 않고 conflicts로 보고한다(관리자가 판단). 팀원에게 묻지
  ///    않는다 — 거부하면 그 사람만 규정 밖에 남고 아무도 모른다.
  ///
  /// 반환값은 Task 11의 보고(reportFolderState)가 그대로 싣는다.
  private async ensureTeamFolders(): Promise<{ missing: number; conflicts: string[] }> {
    // 조기 반환도 지문을 비운다 — 충돌이 사라진 경로가 여기로 빠지면(킷 미수신 등) 리셋이
    // 건너뛰어져 다음 같은 충돌에 팝업이 안 뜬다(실기기에서 잡은 구멍, 2026-08-06).
    if (!this.teamRoot()) { this.promptFolderConflicts([]); return { missing: 0, conflicts: [] }; }
    const targets = await this.teamFolderTargets({ samples: false });
    // 킷을 못 받은 대상(failed)은 경로 자체를 모른다 — 만들 수도 셀 수도 없다. 다음 수신에 다시 시도한다.
    const live = targets.filter((tg) => !tg.failed);
    if (!live.length) { this.promptFolderConflicts([]); return { missing: 0, conflicts: [] }; }

    // vault 스냅샷은 한 번만 뜬다 — 대상마다 다시 훑으면 5만 파일 vault에서 N배가 된다(모달 make()와 같은 이유).
    const all = this.app.vault.getAllLoadedFiles();
    const filePaths = all.filter((f) => !(f instanceof TFolder)).map((f) => f.path);
    const existing = new Set<string>(all.map((f) => f.path));

    // 이름이 바뀐 폴더가 아직 안 옮겨졌으면 **만들지 않는다.** 새 이름 폴더를 먼저 만들어 버리면
    // applyFolderRenames가 "새 이름이 이미 있다"며 이동을 통째로 막고(합치지 않는 것이 그쪽 정책),
    // 팀원의 기존 노트는 옛 이름 폴더에 남는다 — 그 폴더는 팀 범위 밖이라 귀속이 끊긴다.
    // 이동을 승인하면 syncFolderNames가 그 자리에서 이 함수를 다시 부른다.
    const renaming = this.pendingFolderRenames().length > 0;

    // 충돌 검사 대상 = **아직 한 번도 적용되지 않은** 자리들(2026-08-05 실기기 수정).
    //
    // 「팀 구조 목록에 없는 파일이 있으면 충돌」로 재면 팀원이 팀 폴더 안에서 쓴 **업무 노트**가
    // 전부 남의 것으로 잡힌다 — 일을 시작한 사람일수록 먼저 걸려서 관리자 화면이 거짓 경보로
    // 뒤덮인다(실측으로 잡았다). 가르는 기준은 「이 자리가 팀 구조가 생기기 전부터 남의
    // 것이었나」다: 구조가 하나도 없는데 폴더에 파일이 들어 있으면 남의 것이다.
    //
    // 팀 루트도 함께 본다 — 루트는 만들 폴더 목록에 안 들어가는데 정작 가장 위험한 경우가
    // 「팀 루트와 같은 이름의 개인 폴더」다. 루트 아래에 무엇이든 있는데 팀 구조가 통째로
    // 없으면(= 어느 대상도 적용된 적 없음) 그 폴더는 이 팀의 것이 아니다.
    const root = this.teamRoot()!;
    const virgin = live.filter((tg) => folderStatus(tg.allPaths, existing).existing === 0);
    const roots = virgin.map((tg) => tg.pathLabel);
    if (virgin.length === live.length && existing.has(root)) roots.push(root);
    const conflicts = detectFolderConflicts(roots, filePaths);
    const blocked = new Set(conflicts);
    const isBlocked = (p: string) => [...blocked].some((b) => p === b || p.startsWith(b + "/"));

    let created = 0;
    for (const tg of live) {
      if (isBlocked(tg.pathLabel)) continue; // 남의 자리 — 건드리지 않고 관리자에게 넘긴다
      if (renaming) continue;
      if (!folderStatus(tg.allPaths, existing).missing) continue;
      created += await this.materializeFolders(tg.folders, tg.files);
    }

    // 재판정은 **전부 만든 뒤 한 번의 스냅샷**으로(위와 같은 이유). 충돌·이름변경으로 건너뛴 대상도
    // 이 합에 그대로 들어간다 — 안 만든 것은 안 만든 것이고, 서버가 그 사실을 봐야 관리자가 손을 쓴다.
    // 아무것도 안 만들었으면 vault는 그대로이니 스냅샷을 다시 뜨지 않는다.
    const after = created ? new Set<string>(this.app.vault.getAllLoadedFiles().map((f) => f.path)) : existing;
    const missing = live.reduce((n, tg) => n + folderStatus(tg.allPaths, after).missing, 0);
    const uniqConflicts = [...new Set(conflicts)];
    if (created) new Notice(t.teamFoldersCreated(created), 8000);
    this.promptFolderConflicts(uniqConflicts);
    return { missing, conflicts: uniqConflicts };
  }

  /// 충돌은 팝업으로 처리한다(2026-08-06 사용자 결정 — 수동 메뉴 대신). 같은 충돌 집합에는
  /// 한 번만 띄우고(재시작·폴링마다 뜨면 협박), 그 뒤로는 12초 Notice로만 상기시킨다.
  /// 집합이 바뀌면(새 충돌 발생) 다시 팝업. 다 풀리면 지문을 비워 다음 충돌에 다시 뜨게 한다.
  private promptFolderConflicts(conflicts: string[]): void {
    if (!conflicts.length) {
      if (this.settings.folderConflictSig) { this.settings.folderConflictSig = ""; void this.saveSettings(); }
      return;
    }
    const sig = [...conflicts].sort().join("\n");
    if (sig === this.settings.folderConflictSig) {
      new Notice(t.teamFolderConflict(conflicts.join(", ")), 12000);
      return;
    }
    this.settings.folderConflictSig = sig;
    void this.saveSettings();
    new FolderConflictModal(this.app, this, conflicts).open();
  }

  /// 충돌 팝업에서 이름을 다 바꾼 직후 — 다음 폴링(5분)을 기다리지 않고 그 자리에서
  /// 자동 적용을 다시 돌리고 서버에 상태를 보고한다.
  async applyTeamFoldersNow(): Promise<void> {
    this.lastFolderResult = await this.ensureTeamFolders();
    void this.reportFolderState();
  }

  /// 마지막 자동 적용 결과. Task 11의 reportFolderState가 이 값을 서버에 싣는다.
  private lastFolderResult: { missing: number; conflicts: string[] } = { missing: 0, conflicts: [] };

  /// 마지막으로 보고한 내용 — 같은 상태를 매번 보내지 않는다(접속 신호는 last_used_at이 맡는다).
  private lastFolderReport = "";

  /// 「내 vault는 지금 이렇다」를 서버에 1회 보고한다(2026-08-05).
  /// 서버는 vault를 볼 수 없다 — 봉인 원장의 경로가 해시로만 저장되므로 여기서 말해 주지 않으면
  /// 관리자는 「폴더를 못 만든 사람」과 「다 갖춰 놓고 안 쓰는 사람」을 영원히 구별할 수 없다.
  ///
  /// pending_renames는 별도 state로 들고 있지 않는다 — pendingFolderRenames()(Task 10)가 스냅샷
  /// 비교로 그때그때 정확히 같은 값을 이미 내주므로, 값을 두 곳에 두면 갈릴 뿐이다.
  async reportFolderState(st = this.lastFolderResult): Promise<void> {
    // 가드는 **apiKey** 로 잰다 — teamApiKey 가 아니다(2026-08-05).
    // teamApiKey 는 회사 메일로 팀 계정을 **따로 로그인한** 사람에게만 채워진다(teamAccountLogin).
    // 한 계정을 쓰는 대다수 팀원은 영원히 "" 이고(keyFor 가 그때 개인 키를 양쪽에 쓴다),
    // teamApiKey 로 걸면 그 사람들은 **한 번도 보고하지 않아** 관리자 화면에 영원히
    // 「확인 안 됨」으로 남는다 — 이 기능이 대다수에게 무력화된다.
    // 실제로 보낼 키는 keyFor(true) 가 고른다(팀 키가 있으면 그것, 없으면 개인 키).
    if (!this.teamRoot() || !this.settings.apiKey) return;
    const renames = this.pendingFolderRenames().map((r) => ({ from: r.from, to: r.to }));
    // applied는 서버 verdict의 OR 조건 중 하나다(routes/team/folder_state.rs) — 클라이언트 주장을
    // 그대로 믿지는 않지만(missing·conflicts·pending_renames로 스스로도 판정한다), 여기서 거짓
    // true를 보내지만 않으면(= 실제 조건과 다르게 계산하지만 않으면) 손해가 없다. false를
    // 잘못 보내도 서버가 이미 "적용됨"이라 볼 근거가 있으면 그 판정 자체는 안 흔들린다 —
    // OR라 한쪽만 맞아도 결과는 NotApplied 쪽으로만 쏠리고 그 반대(거짓 Applied)는 못 만든다.
    const applied = st.missing === 0 && st.conflicts.length === 0 && renames.length === 0;
    // 서버 상한(MAX_ITEMS=50·MAX_PATH=400바이트)을 넘기면 통째로 400 — 이번 보고가 저장되지
    // 않고 관리자 화면은 지난 상태에 멈춘다. 잘라서라도 보내는 편이 낫다(capFolderReport 참조).
    const capped = capFolderReport(st.conflicts, renames);
    const body = {
      applied,
      missing: st.missing,
      conflicts: capped.conflicts,
      pending_renames: capped.pendingRenames,
      plugin_version: this.manifest.version,
    };
    const json = JSON.stringify(body);
    if (json === this.lastFolderReport) return;
    const r = await requestUrl({
      url: `${this.base()}/attest/team/folder-state`,
      method: "POST",
      headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(true) },
      body: json, throw: false,
    });
    // 조용히 넘기지 않는다 — 조용한 실패는 관리자 화면을 영원히 "확인 안 됨"으로 둔다.
    if (r.status >= 300) { console.error("[nanalstamp] 폴더 상태 보고 실패", r.status); return; }
    this.lastFolderReport = json;
  }

  // ── 팀 폴더 이름 추적(2026-07-26) ─────────────────────────────────────────────
  // 관리자가 포털에서 팀 루트나 과제명을 바꾸면 서버는 곧바로 새 이름을 내려주지만 vault의 폴더는
  // 옛 이름 그대로다. 그러면 봉인 스코프·과제 귀속이 옛 경로를 가리켜 끊긴다.
  // **자동으로 옮기지는 않는다** — 폴더 생성은 자동으로 바뀌었지만(ensureTeamFolders, 2026-08-05)
  // 그것은 없던 빈 폴더를 만드는 일이라 되돌릴 수 있다. 이동은 사람이 쓴 노트를 통째로 옮기는 일이고
  // 되돌리기 어렵다 — 그래서 감지해서 묻고, 승인하면 옮긴다.
  // 봉인 계보는 따로 손대지 않는다: Obsidian은 폴더를 옮기면 하위 파일마다 rename 이벤트를 재귀적으로
  // 보내고(2026-07-26 실기기 확인), onRename이 그때 상태 키·계보를 이미 이관한다.
  private folderSyncBusy = false;    // 모달 중복 오픈 방지(프로파일·과제 갱신이 각각 부른다)
  private folderSyncSnoozed = false; // "나중에" = 이번 세션만 조용히. 재시작하거나 명령을 쓰면 다시 묻는다

  /// 지금 서버가 말하는 이름들.
  private currentFolderSnapshot(): FolderNameSnapshot {
    const projects: Record<string, string> = {};
    for (const p of this.teamProjects) projects[p.id] = p.name;
    return { root: this.teamRoot() ?? "", projects };
  }
  /// 마지막으로 vault에 반영된 것으로 아는 이름들(불량 JSON은 빈 스냅샷 = 아무것도 제안하지 않음).
  private knownFolderSnapshot(): FolderNameSnapshot {
    const empty: FolderNameSnapshot = { root: "", projects: {} };
    if (!this.settings.knownFolderNames) return empty;
    try {
      const raw = JSON.parse(this.settings.knownFolderNames) as Partial<FolderNameSnapshot>;
      return {
        root: typeof raw.root === "string" ? raw.root : "",
        projects: raw.projects && typeof raw.projects === "object" ? (raw.projects as Record<string, string>) : {},
      };
    } catch (_) { return empty; }
  }
  private async saveFolderSnapshot(snap: FolderNameSnapshot): Promise<void> {
    this.settings.knownFolderNames = JSON.stringify(snap);
    await this.saveSettings();
  }

  /// 아직 vault에 반영하지 않은 이름 변경 — vault에 옛 폴더가 **실제로 있는** 것만.
  /// 자동 적용(ensureTeamFolders)이 "지금 만들어도 되는가"를 이 값으로 판단하므로 한 곳에 둔다.
  private pendingFolderRenames(): FolderRename[] {
    const next = this.currentFolderSnapshot();
    if (!next.root) return [];
    return detectFolderRenames(this.knownFolderSnapshot(), next)
      .filter((r) => this.app.vault.getAbstractFileByPath(r.from) instanceof TFolder);
  }

  /// 이름 변경을 감지해 사용자에게 묻는다. manual=true(명령 팔레트)면 스누즈를 무시하고 결과도 알린다.
  async syncFolderNames(manual = false): Promise<void> {
    if (this.folderSyncBusy) return;
    if (!manual && this.folderSyncSnoozed) return;
    const next = this.currentFolderSnapshot();
    if (!next.root) { if (manual) new Notice(t.folderSyncNone); return; }
    // 안 만들었거나 이미 옮긴 것은 할 일이 없다.
    const doable = this.pendingFolderRenames();
    if (!doable.length) {
      // 옮길 옛 폴더가 없다 = 추적만 갱신하면 된다. 이걸 안 하면 매번 같은 계산을 다시 한다.
      await this.saveFolderSnapshot(next);
      if (manual) new Notice(t.folderSyncNone);
      void this.reportFolderState(); // 이동 대기가 방금 사라졌을 수 있다 — 그 사실도 보고에 실린다.
      return;
    }
    this.folderSyncBusy = true;
    new FolderRenameModal(this.app, doable, async (ok) => {
      this.folderSyncBusy = false;
      // "나중에"면 스냅샷을 **갱신하지 않는다** — 갱신하면 옛 이름을 잊어 명령으로도 못 찾는다.
      // 대신 이번 세션만 조용히 한다(폴링마다 같은 모달이 뜨는 것을 막는 최소한의 장치).
      if (!ok) {
        this.folderSyncSnoozed = true;
        // 미룬 이동은 **보고에 실린다**(2026-08-05) — 스누즈는 이번 세션만 조용하게 할 뿐,
        // 관리자에게 안 보이게 하는 장치가 아니다. pendingFolderRenames()는 스냅샷을 아직
        // 안 갱신했으니 지금도 doable과 같은 값을 낸다.
        void this.reportFolderState();
        return;
      }
      await this.applyFolderRenames(doable);
      await this.saveFolderSnapshot(this.currentFolderSnapshot());
      // 이동 대기 때문에 미뤄 둔 자동 적용을 여기서 이어 간다 — 옮긴 뒤에야 새 이름 폴더를
      // 만들어도 안전하고, 옮기고 남은 빈자리(새 구조에서 추가된 폴더)도 이때 채워진다.
      this.lastFolderResult = await this.ensureTeamFolders();
      void this.reportFolderState();
    }).open();
  }

  /// 승인된 이동을 순서대로 실행. 새 이름이 이미 있으면 **합치지 않고 건너뛴다** — 두 폴더의 내용을
  /// 임의로 섞으면 되돌릴 수 없고, 어느 쪽이 정본인지는 사용자만 안다.
  private async applyFolderRenames(list: FolderRename[]): Promise<void> {
    let moved = 0;
    const blocked: string[] = [];
    for (const r of list) {
      const from = this.app.vault.getAbstractFileByPath(r.from);
      if (!(from instanceof TFolder)) continue; // 그 사이 사라졌다 — 조용히 건너뛴다
      if (this.app.vault.getAbstractFileByPath(r.to)) { blocked.push(r.to); continue; }
      try {
        // vault.rename이 아니라 fileManager.renameFile — 이쪽이 노트 안의 링크까지 고쳐 준다.
        await this.app.fileManager.renameFile(from, r.to);
        moved++;
      } catch (_e) { blocked.push(r.to); }
    }
    if (moved) new Notice(t.folderSyncMoved(moved));
    if (blocked.length) new Notice(t.folderSyncFailed(blocked.join(", ")), 10000);
  }

  // 무료 회원가입 — 이메일/비번 등록 → 인증 메일 발송(인증 후 로그인 가능)
  async accountRegister(email: string, password: string): Promise<void> {
    const res = await requestUrl({
      url: `${this.base()}/auth/register`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      throw: false,
    });
    if (res.status >= 300) throw new Error(res.json?.error || `HTTP ${res.status}`);
  }

  // 비밀번호 재설정 요청 — 이메일로 재설정 링크(웹 /reset?token=…) 발송.
  // 서버는 미가입 이메일도 200으로 응답(계정 존재 노출 방지). 새 비밀번호 설정은 웹에서 완료.
  async accountResetRequest(email: string): Promise<void> {
    const res = await requestUrl({
      url: `${this.base()}/auth/password/reset/request`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      throw: false,
    });
    if (res.status >= 300) throw new Error(res.json?.error || `HTTP ${res.status}`);
  }

  // 서버에 해시 봉인 여부/증명 정보 조회(verify). 실패 시 null.
  private async queryVerify(hash: string): Promise<any | null> {
    if (!this.settings.apiKey) return null;
    // 해시만 아는 자리라 **양쪽 계정에 묻는다**(팀 계정을 안 쓰면 한 번만 나간다).
    return this.askBothAccounts(async (key) => {
      try {
        const res = await requestUrl({
          url: `${this.base()}/attest/verify?hash=${hash}`,
          method: "GET",
          headers: { "x-nanal-api-key": key },
          throw: false,
        });
        if (res.status === 200 && res.json?.found) return res.json;
      } catch (_) { /* ignore */ }
      return null;
    });
  }

  // 해시별 verify 캐시. TTL 이내 재조회는 캐시 히트(서버 호출 절감).
  // 조회 실패(null)는 캐시하지 않아 다음에 재시도한다. 해시가 곧 내용 커밋먼트라 내용이 바뀌면 자연 무효화.
  private async cachedVerify(hash: string): Promise<any | null> {
    const now = Date.now();
    const hit = this.verifyCache.get(hash);
    if (hit && now - hit.ts < VERIFY_CACHE_TTL_MS) return hit.result;
    const result = await this.queryVerify(hash);
    if (result !== null) this.verifyCache.set(hash, { result, ts: now });
    return result;
  }

  // 상태가 바뀐 뒤 캐시 무효화(stale 방지). 해시 지정 시 그 항목만, 없으면 전체(예: 앵커로 블록고 변동).
  private invalidateVerify(hash?: string) {
    if (hash) this.verifyCache.delete(hash);
    else this.verifyCache.clear();
  }

  // 노트 빠른 전환 디바운스 — 연타 전환 시 마지막 전환만 상태(verify) 갱신.
  private scheduleStatusUpdate(delayMs = STATUS_DEBOUNCE_MS) {
    if (this.statusDebounceTimer !== undefined) window.clearTimeout(this.statusDebounceTimer);
    this.statusDebounceTimer = window.setTimeout(() => {
      this.statusDebounceTimer = undefined;
      void this.updateActiveStatus();
    }, delayMs);
  }

  // 자격(요금제·크레딧) 갱신 — 캐시 후 상태바 갱신. 결제 후/주기적으로 호출.
  async refreshEntitlement(): Promise<void> {
    this.entitlement = await this.fetchEntitlement();
    this.checkAccountSwitch();
    // P1-F: 결제 실패(past_due) 유예 중 — 세션당 1회 알림(기능은 유예 동안 유지됨).
    if (this.entitlement?.status === "past_due" && !this.pastDueNotified) {
      this.pastDueNotified = true;
      new Notice(t.pastDueNotice, 10000);
    } else if (this.entitlement && this.entitlement.status !== "past_due") {
      this.pastDueNotified = false; // 회복 후 재발 시 다시 알림
    }
    // 만료: status 는 'active' 인데 유예까지 지나 is_pro 가 꺼진 상태. 이때 원문 보관이 멈추는데
    // 아무 말도 하지 않으면 사용자는 계속 보관되는 줄 안다 — 조용한 중단이 가장 나쁘다.
    const e = this.entitlement;
    const expired = !!e && e.is_pro === false && (e.tier === "pro" || e.tier === "team")
      && this.settings.teamStorage !== "nanal";
    // 만료 임박 — 계좌이체 구독은 자동갱신이 없어서 **알리지 않으면 그대로 만료된다.**
    // 메일을 안 보는 사람이 많으니 매일 쓰는 화면에서도 알린다(D-30 부터).
    const until = e?.paid_until ?? null;
    if (e?.is_pro && until) {
      const left = Math.ceil((until - Date.now() / 1000) / 86400);
      if (left > 0 && left <= 30 && this.expiringNotifiedFor !== until) {
        this.expiringNotifiedFor = until;
        new Notice(t.subscriptionExpiring(left), 15000);
      }
    }
    if (expired && !this.expiredNotified) {
      this.expiredNotified = true;
      new Notice(t.subscriptionExpired, 15000);
    } else if (!expired) {
      this.expiredNotified = false;
    }
  }

  // 현재 API 키의 요금제·크레딧 조회(설정 화면 표시용)
  async fetchEntitlement(): Promise<{ tier: string; cert_credits: number; is_pro: boolean; status?: string; user_id?: string } | null> {
    if (!this.settings.apiKey) return null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/pricing`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status === 200) {
        if (Array.isArray(res.json?.plans)) this.pricingPlans = res.json.plans;
        const ent = res.json?.entitlement;
        if (ent) {
          // 요금제가 정한 첨부 상한. 서버가 tier→요금제를 이미 풀어 준다(플러그인이 되짚지 않는다).
          if (typeof ent.attachment_max_mb === "number" && ent.attachment_max_mb !== this.settings.attachmentMaxMb) {
            this.settings.attachmentMaxMb = ent.attachment_max_mb;
            void this.saveSettings();
          }
          return ent;
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  private setStatus(text: string, title: string, seal: "solid" | "faded" | "none" = "none") {
    this.statusEl.empty();
    if (seal !== "none") {
      const ic = this.statusEl.createSpan({ cls: "nanalstamp-status-icon" });
      if (seal === "faded") ic.addClass("is-faded");
      // 브랜드 씰(PNG data URL) — setIcon은 단색 강제라 사용하지 않음.
      ic.createEl("img", { cls: "nanalstamp-status-seal", attr: { src: this.iconUrl, width: 22, height: 22, alt: "nanalStamp" } });
    }
    this.statusEl.createSpan({ text });
    this.statusEl.setAttribute("aria-label", title);
  }

  /// 지금 활성인 것이 **파일 탭이 아닌가**. 그 하나만 답한다.
  ///
  /// 이 목록은 두 번 표류했다 — 2026-07-22 에 브라우저·대시보드를, 2026-07-29 에 업무함을
  /// 뒤늦게 넣었다. 그 사이 각 탭에는 `getActiveFile()`이 돌려주는 **직전에 열었던 노트**의
  /// 상태가 남아, 그 탭이 봉인된 것처럼 읽혔다. 목록이 한 곳에 없으면 새 뷰가 생길 때마다
  /// 같은 잔상 결함이 되살아나므로, 표시(updateActiveStatus)와 클릭이 이 술어를 함께 쓴다.
  /// 뷰별 **전용 표시**(사본 탭 이름·업무함 요약)는 여기서 다루지 않는다 — 그건 표시의 몫이다.
  overviewViewActive(): boolean {
    const w = this.app.workspace;
    return !!(w.getActiveViewOfType(NoteBrowserView)
      || w.getActiveViewOfType(DashboardView)
      || w.getActiveViewOfType(TaskInboxView)
      || w.getActiveViewOfType(ArchiveSourceView));
  }

  /// 상태바 갱신. 모달·설정탭에서도 부르므로 공개다(private 로 두면 타입 검사가 막는다).
  async updateActiveStatus() {
    this.stopPendingCountdown(); // 대기 카운트다운은 아래 dirty 분기에서만 다시 켠다
    this.activeAnchorPending = false; // 아래에서 '앵커 중'으로 확인되면 다시 켠다(주기 재검증 대상)
    const m = Math.round(MIN_INTERVAL_MS / 60000);
    const total = this.settings.lifetimeCount;
    const streak = computeStreak(this.settings.sealDays);
    const base = t.base(total, streak, m, this.settings.serverUrl);
    if (!this.settings.enabled) return this.setStatus(t.off, t.offTitle);
    if (this.authFailed) return this.setStatus(t.apiKeyRejected, t.authFail);
    if (!this.settings.apiKey) return this.setStatus(t.apiKeyMissing, t.loginDesc);
    // 범위 미설정 = 봉인이 **멈춰 있는** 상태다. 개요("총 N건")를 보여주면 잘 돌아가는 것처럼 읽히므로
    // 다른 어떤 표시보다 먼저 이걸 말한다(2026-07-28 — 범위 전 자동 봉인을 막으면서 함께 도입).
    if (this.scopeUnset()) return this.setStatus(t.scopeUnsetStatus, t.scopeUnsetTitle, "faded");
    // 팀 키만 거부 — 개인 봉인은 계속된다. 공용 배지(t.apiKeyRejected)를 쓰면 전체 정지로 읽히므로
    // 배지 자체를 팀 전용으로 둔다(툴팁이 무엇이 멈췄는지 말한다).
    // **범위 미설정보다 뒤**다(M-2): 범위가 없으면 개인 봉인도 멈춰 있어 "개인 봉인은 계속됩니다"가
    // 거짓이 된다 — 더 큰 진실을 먼저 말한다.
    if (this.teamKeyRejected()) return this.setStatus(t.teamKeyRejectedStatus, t.teamAuthFail);
    // 대조가 오래 못 돌았으면 **그 사실 자체**를 말한다(2026-07-30).
    // "빠진 것이 없다"와 "빠졌는지 모른다"는 다르다 — 후자를 침묵하면 전자로 읽힌다.
    // 범위 미설정과 같은 자리에 두는 이유: 둘 다 "지금 무슨 일이 벌어지는지 모르는" 상태다.
    if (this.reconcileUnknown()) return this.setStatus(t.reconcileUnknown, t.reconcileUnknownTitle, "faded");
    // 청크 업로드 진행 중이면 진행률 우선 표시(탭 전환 등 다른 갱신이 덮지 않게 — 종료 시 setUploadProgress(null)가 복원).
    if (this.uploadProgress) { const p = this.uploadProgress; return this.setStatus(t.uploadProgress(p.done, p.total), p.path, "faded"); }

    // 읽기 전용 봉인 사본 탭이 활성이면 그 탭 기준으로 표시 — getActiveFile은 '최근 파일'을 돌려줘
    // 다른 노트의 봉인 상태가 상태바에 남는 혼동이 있었다(2026-07-22 사용자 지적).
    const arch = this.app.workspace.getActiveViewOfType(ArchiveSourceView);
    if (arch) {
      const n = arch.displayBasename();
      if (n) return this.setStatus(t.statusArchiveTab(n), t.statusArchiveTitle, "faded");
    }
    // 업무함은 노트가 아니라 **업무 증적**을 보여준다 — 여기서 회신·완료·수정이 원장에 쌓인다.
    if (this.app.workspace.getActiveViewOfType(TaskInboxView)) {
      const s = this.taskSealSummary;
      if (s) return this.setStatus(t.taskInboxStatus(s.sealed, s.pending), t.taskInboxStatusTitle, "solid");
    }
    // 전용 표시가 없는 개요 탭은 계정 요약으로 — 특정 노트 상태를 보여주면 잔상이 된다.
    if (this.overviewViewActive()) return this.setStatus(t.overview(streak, total), base, "solid");

    const f = this.app.workspace.getActiveFile();
    if (!f || !this.isSealable(f)) return this.setStatus(t.overview(streak, total), base, "solid");
    if (!this.inSealScope(f.path)) return this.setStatus(t.outScope(f.basename), t.outScopeTitle);
    if (this.failed.has(f.path)) return this.setStatus(t.unsent(f.basename), t.unsentTitle(f.basename));

    const s = this.stateOf(f.path);
    // **보류를 가장 먼저 말한다.** 첨부가 상한을 넘어 봉인하지 않은 노트인데 "봉인됨"이나
    // "대기"로 보이면 사용자는 봉인된 줄 안다 — 조용한 실패가 이 제품에서 가장 나쁜 결함이다.
    const held = this.settings.sealHolds?.[f.path];
    if (held) {
      return this.setStatus(t.statusHold,
        held.kind === "attach"
          ? t.statusHoldAttachTitle(basenameOf(held.path), Math.ceil(held.size / (1024 * 1024)), held.limitMB, held.byTeam)
          : t.statusHoldQuotaTitle, "faded");
    }
    if (s.dirty) {
      this.startPendingCountdown();
      return this.setStatus(t.pending + this.pendingEtaText(s), t.pendingTitle(f.basename), "faded");
    }
    try {
      // 0.2: 첨부도 verify로 봉인/대기 상태 표시. currentHashCached(mtime 캐시)로 — .md는 cachedRead,
      // 첨부는 readBinary. 탭 전환마다 대용량 첨부를 재해시하지 않도록 캐시 경유한다.
      const hash = await this.currentHashCached(f);
      if (!hash) { this.setStatus(t.overview(streak, total), t.queryFail(base), "solid"); return; }
      const v = await this.cachedVerify(hash); // 해시별 캐시 경유(연타 전환·재방문 시 서버 호출 절감)
      if (v === null) { this.setStatus(t.overview(streak, total), t.queryFail(base), "solid"); return; }
      if (v.found) {
        const seq = v.seq;
        // 서버가 주는 epoch(초)를 사람이 읽는 시각으로. 없으면(구서버) 시각을 약속하지 않는
        // 짧은 문구를 쓴다 — `@ ` 뒤가 빈 채로 보이면 고장으로 읽힌다(오픈 전 검수 UX-13).
        const at = typeof v.received_at === "number" ? fmtDateTime(new Date(v.received_at * 1000)) : "";
        // 세 표면(상태바·증명 모달·봉인 이력)이 같은 상태를 같은 말로 부른다 — 미제출도 침묵하지 않고
        // "앵커 대기"라고 말해야 앵커가 빠진 것처럼 보이지 않는다(2026-07-28).
        const suffix = v.bitcoin?.block_height ? t.btc(v.bitcoin.block_height) : v.anchored ? t.anchoring : t.anchorWaiting;
        // '앵커 중'(anchored지만 ₿ 블록고 미확정)이면 주기 재검증 대상으로 표시.
        this.activeAnchorPending = !v.bitcoin?.block_height && !!v.anchored;
        this.setStatus(t.sealed(seq) + suffix,
          at ? t.sealedTitle(f.basename, seq, at) : t.sealedTitleNoTime(f.basename, seq), "solid");
        // P1/P2/P1.5: 확정(₿ 블록 존재)을 처음 감지하는 순간 로컬 원장 + (Pro)미러 + 로컬 git 아카이브
        // 로컬 미저장이거나, 미러/아카이브 대상인데 아직 안 됐으면 처리(실패분 재시도 포함).
        const mirrorPending = this.mirrorActive() && this.settings.mirrorIndex[f.path] !== hash;
        const archivePending = this.archiveEnabled() && this.settings.archiveIndex[f.path] !== hash;
        if (v.bitcoin?.block_height &&
            (this.settings.ledgerIndex[f.path] !== hash || mirrorPending || archivePending)) {
          void this.recordConfirmedProof(f, hash, v);
        }
      } else {
        this.setStatus(t.unsealed(f.basename), t.unsealedTitle(f.basename));
      }
    } catch {
      this.setStatus(t.overview(streak, total), t.queryFail(base), "solid");
    }
  }

  // ── 봉인 대기 카운트다운 ────────────────────────────────────────────────
  // 활성 노트가 dirty일 때만 1초 틱으로 상태바 "텍스트만" 갱신 — 해시 재계산·서버 호출 없음(부하 0 수준).
  // 남은 시간 = (직전 봉인 + 최소 간격) - 지금. 0 이하면 "멈추면 봉인"(settle/sweep이 곧 처리).
  private pendingEtaText(s: FileState): string {
    const remain = s.dirtyAt + MIN_INTERVAL_MS - Date.now();
    if (remain <= 0) return t.pendingSoon;
    const sec = Math.ceil(remain / 1000);
    return t.pendingEta(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
  }
  private startPendingCountdown() {
    if (this.countdownTimer !== undefined) return; // 이미 동작 중
    this.countdownTimer = window.setInterval(() => {
      const f = this.app.workspace.getActiveFile();
      const s = f ? this.states.get(f.path) : undefined;
      if (!f || !s?.dirty || !this.settings.enabled) { void this.updateActiveStatus(); return; } // 상태 변화 → 정식 갱신(거기서 카운트다운 정지)
      this.setStatus(t.pending + this.pendingEtaText(s), t.pendingTitle(f.basename), "faded");
    }, 1000);
    this.registerInterval(this.countdownTimer);
  }
  private stopPendingCountdown() {
    if (this.countdownTimer !== undefined) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = undefined;
    }
  }

  // 파일 이동: states·failed 키를 새 경로로 이관(오래된 키 누적 방지).
  // 경로가 바뀌면 경로-해시 커밋먼트도 달라지므로, dirty로 표시해 다음 봉인 때 재봉인되게 함.
  private async onRename(file: TFile, oldPath: string) {
    // 참조 집합 선치환: Obsidian의 링크 자동 갱신(→ resolved 이벤트)보다 rename이 먼저 도착하므로,
    // 참조되던 첨부가 잠깐 "미참조"로 보여 아래 이관을 건너뛰지 않게 경로만 즉시 바꿔둔다.
    if (this.referencedAttachments.delete(oldPath)) this.referencedAttachments.add(file.path);
    // 개명 계보 기록(표시 전용 — 원장·체인 불변): 옛 경로가 '삭제됨'으로 오인되거나 이력이 단절돼 보이는 것 방지.
    // 체인(A→B 후 B→C)은 기록 시점에 바로 압축하고, 이름 원상복귀(A→B→A)는 자기 매핑이 되므로 제거.
    for (const [k, v] of Object.entries(this.settings.renameMap)) if (v === oldPath) this.settings.renameMap[k] = file.path;
    this.settings.renameMap[oldPath] = file.path;
    delete this.settings.renameMap[file.path]; // 새 경로가 과거에 옛 경로였던 기록은 무효(자기/역방향 매핑 방지)
    this.lineageResult = null; // 계보 캐시 무효 — renameMap이 바뀌었다
    void this.syncLineageFile(); // 아카이브 lineage.json에도 영속(기기 이전 대비)
    if (!this.isSealable(file)) { await this.persist(); return; }
    const si = this.settings.attachSkipped.indexOf(oldPath);
    if (si !== -1) this.settings.attachSkipped[si] = file.path; // 스킵 표시도 새 경로로 이관
    const s = this.states.get(oldPath);
    if (s) {
      this.states.delete(oldPath);
      s.dirty = true; // 경로 커밋먼트 변경 → 재봉인 필요
      // ★ **lastHash 를 비운다**(2026-07-31).
      //
      // lastHash 는 "이 경로에서 마지막으로 봉인한 내용"이다. 경로가 바뀌면 그 말이 성립하지
      // 않는다 — 새 경로에서는 아직 아무것도 봉인하지 않았다.
      //
      // 비우지 않으면 flush 가 `hash === s.lastHash` 로 **서버에 가기도 전에 끊는다.**
      // 그래서 제목만 바꾸면(내용은 그대로) 요청이 아예 나가지 않았고,
      // 「이미 봉인된 내용입니다」만 뜬 채 새 경로 봉인·이동 마커·변경 이력이 전부 비었다.
      // 서버는 (내용, 경로)로 판정하도록 고쳐 두었는데(0015) 클라이언트가 앞에서 막고 있었다.
      s.lastHash = "";
      if (!s.dirtyAt) s.dirtyAt = Date.now(); // 대기 시작점(이미 대기 중이면 유지)
      this.states.set(file.path, s);
    }
    // 원장·귀속 반영 — sealedIndex를 지우기 **전에** 봉인 이력 유무를 본다(아래에서 delete된다).
    if (this.settings.sealedIndex[oldPath]) void this.recordNoteMove(oldPath, file.path);
    if (this.failed.delete(oldPath)) { this.failed.add(file.path); this.settings.failedPaths = Array.from(this.failed); }
    this.dashHashCache.delete(oldPath);
    delete this.settings.sealedIndex[oldPath]; // 경로가 커밋먼트에 포함 → 새 경로는 재봉인 대상
    if (this.activeFile?.path === oldPath) this.activeFile = file;
    await this.persist(); // attachSkipped·sealedIndex·failedPaths 이관을 한 번에 영속화
    void this.updateActiveStatus();
  }

  // 파일 삭제: 관련 상태 정리(무한 증식 방지).
  private async onDelete(file: TFile) {
    const s = this.states.get(file.path);
    if (s?.timer) window.clearTimeout(s.timer);
    this.states.delete(file.path);
    this.dashHashCache.delete(file.path);
    // ★ 아직 원문을 못 올린 채 지워졌으면, **지우기 전에 아카이브에서 꺼내 올린다.**
    //   sealedIndex 를 먼저 비우면 어느 해시를 올려야 할지 잃는다(2026-08-01 실측).
    //   봉인된 그 버전은 로컬 git 에 그대로 있으므로 올릴 수 있다 — 지웠다고 조직이
    //   원문을 잃어야 할 이유가 없다.
    const sealedHash = this.settings.sealedIndex[file.path];
    if (sealedHash && this.settings.nanalIndex[file.path] !== sealedHash && this.nanalActive()) {
      void this.retryFromArchive(file.path, sealedHash);
    }
    delete this.settings.sealedIndex[file.path];
    // 보류 목록도 정리한다. 안 그러면 지운 노트가 "봉인 못 함"으로 영원히 남아,
    // 정작 조치가 필요한 항목을 덮는다(2026-07-30 실기기 시험에서 발견).
    // 첨부를 지운 경우도 마찬가지 — 그 첨부 때문에 막혀 있던 노트를 함께 푼다.
    if (this.settings.sealHolds[file.path]) await this.clearSealHold(file.path);
    for (const [notePath, h] of Object.entries(this.settings.sealHolds)) {
      if (h.kind === "attach" && h.path === file.path) await this.clearSealHold(notePath);
    }
    if (this.settings.attachSkipped.includes(file.path)) {
      this.settings.attachSkipped = this.settings.attachSkipped.filter((p) => p !== file.path);
      await this.persist();
    }
    if (this.failed.delete(file.path)) await this.persistFailed();
  }

  // 플러그인 데이터 저장(상태 갱신 없이 — flush 등 잦은 호출용)
  protected async persist() { await this.saveData(this.settings); }
  private async persistFailed() {
    this.settings.failedPaths = Array.from(this.failed);
    await this.saveData(this.settings);
  }

  // 증명/타임라인 모달 — 활성 노트의 봉인 상태·seq·비트코인 앵커 + 연속 지표
  private showProof() {
    const f = this.app.workspace.getActiveFile();
    if (!f || !this.isSealable(f)) return new Notice(t.noNote);
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    new ProofModal(this.app, this, f).open();
  }

  // 모달용 접근자
  async proofFor(file: TFile): Promise<{ status: "sealed" | "changed" | "unsealed" | "pending" | "outscope"; seq?: number; receivedAt?: string; anchored?: boolean; blockHeight?: number; error?: boolean }> {
    if (!this.inSealScope(file.path)) return { status: "outscope" };
    const s = this.stateOf(file.path);
    if (s.dirty) return { status: "pending" };
    let hash: string;
    try { hash = await this.hashOf(file); } catch { return { status: "unsealed", error: true }; }
    const v = await this.cachedVerify(hash);
    if (v === null) return { status: s.lastHash ? "changed" : "unsealed", error: true };
    if (v.found) {
      return {
        status: "sealed",
        seq: v.seq ?? v.matches?.[0]?.seq,
        receivedAt: v.received_at ?? v.matches?.[0]?.received_at,
        anchored: !!(v.anchored || v.bitcoin?.block_height),
        blockHeight: v.bitcoin?.block_height ?? v.matches?.[0]?.bitcoin?.block_height,
      };
    }
    // 서버엔 없음: 예전에 봉인한 적 있으면 "변경됨", 아니면 "미봉인"
    return { status: s.lastHash ? "changed" : "unsealed" };
  }

  // 이 노트의 봉인 이력 한 페이지(무한 스크롤). 서버 /attest/history 가 file_path(경로해시)로 필터·페이징한다.
  // beforeSeq(옵션)=커서(이 seq 미만). 404면 구서버 폴백(fetchHistoryFallback: /attest/proof 전체 체인, 전량 1회).
  // apiKey 없음·비200(404 제외)·예외는 전부 조용히 null(모달이 섹션을 생략). received_at 은 epoch(초).
  async fetchHistoryPage(file: TFile, beforeSeq?: number): Promise<{
    rows: Array<{ seq: number; receivedAt: number; fileHash: string; confirmed: boolean; block?: number }>;
    hasMore: boolean;
    anchor: { headSeq: number; confirmed: boolean; block?: number } | null;
    total?: number;
    fallback: boolean;
  } | null> {
    if (!this.settings.apiKey) return null;
    const pathH = await hashPath(file.path);
    const cursor = typeof beforeSeq === "number" ? `&before_seq=${beforeSeq}` : "";
    let res: any;
    try {
      res = await requestUrl({
        url: `${this.base()}/attest/history?path=${pathH}&limit=20${cursor}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
    } catch { return null; }
    if (res.status === 404) return this.fetchHistoryFallback(file); // 구서버(엔드포인트 없음)
    if (res.status !== 200) return null;
    const data = res.json;
    const anchorRaw = data?.anchor;
    const headSeq = typeof anchorRaw?.head_seq === "number" ? anchorRaw.head_seq : -1;
    const block: number | undefined = typeof anchorRaw?.block_height === "number" ? anchorRaw.block_height : undefined;
    const anchorConfirmed = typeof block === "number";
    const rows = (Array.isArray(data?.rows) ? data.rows : [])
      .map((r: any) => {
        const seq = Number(r?.seq);
        // 신 서버: 행별 block(그 시점 확정 블록, 미확정 null). 구 서버 폴백: anchor 요약 + seq<=headSeq.
        const rowBlock: number | undefined = typeof r?.block === "number" ? r.block : undefined;
        const hasRowBlock = r?.block !== undefined; // null/number 를 서버가 명시 → 행별 판정 신뢰
        const confirmed = hasRowBlock ? typeof rowBlock === "number" : (anchorConfirmed && seq <= headSeq);
        return {
          seq,
          receivedAt: Number(r?.received_at) || 0,
          fileHash: String(r?.file_hash || ""),
          confirmed,
          block: hasRowBlock ? rowBlock : (confirmed ? block : undefined),
        };
      })
      .filter((r: any) => Number.isFinite(r.seq));
    return {
      rows,
      hasMore: data?.has_more === true,
      anchor: anchorRaw ? { headSeq, confirmed: anchorConfirmed, block: anchorConfirmed ? block : undefined } : null,
      total: typeof data?.total === "number" ? data.total : undefined,
      fallback: false,
    };
  }

  // 구서버 폴백: /attest/history 가 없을 때(404) 기존 /attest/proof(전체 체인)를 받아 경로해시로 필터, 전량 1회 렌더.
  // 현재 해시(없으면 sealedIndex, 그것도 없으면 아무 유효 64hex)로 조회한다(proof는 hash 불일치여도 chain을 준다).
  private async fetchHistoryFallback(file: TFile): Promise<{
    rows: Array<{ seq: number; receivedAt: number; fileHash: string; confirmed: boolean; block?: number }>;
    hasMore: boolean;
    anchor: { headSeq: number; confirmed: boolean; block?: number } | null;
    total?: number;
    fallback: boolean;
  } | null> {
    let hash = "";
    try { hash = (await this.currentHashCached(file)) || ""; } catch { hash = ""; }
    if (!/^[0-9a-f]{64}$/i.test(hash)) hash = this.settings.sealedIndex[file.path] || "";
    if (!/^[0-9a-f]{64}$/i.test(hash)) hash = "0".repeat(64);
    let data: any = null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/proof?hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200) return null;
      data = res.json;
    } catch { return null; }
    const chain: any[] = Array.isArray(data?.chain) ? data.chain : [];
    const pathH = await hashPath(file.path);
    const anchorRaw = data?.anchor;
    const headSeq = typeof anchorRaw?.head_seq === "number" ? anchorRaw.head_seq : -1;
    const block: number | undefined = anchorRaw?.bitcoin?.block_height;
    const anchorConfirmed = typeof block === "number";
    const rows = chain
      .filter((r) => r?.path === pathH)
      .map((r) => {
        const seq = Number(r.seq);
        const confirmed = anchorConfirmed && seq <= headSeq;
        return {
          seq,
          receivedAt: Number(r?.received_at) || 0,
          fileHash: String(r?.file_hash || ""),
          confirmed,
          block: confirmed ? block : undefined,
        };
      })
      .filter((r) => Number.isFinite(r.seq))
      .sort((a, b) => b.seq - a.seq);
    return {
      rows,
      hasMore: false, // 폴백은 전량 로드 — 무한 스크롤 없음
      anchor: anchorRaw ? { headSeq, confirmed: anchorConfirmed, block: anchorConfirmed ? block : undefined } : null,
      total: rows.length, // 구서버 폴백은 전량 로드라 rows 길이 = 총 건수
      fallback: true,
    };
  }

  streakInfo(): { streak: number; total: number } {
    return { streak: computeStreak(this.settings.sealDays), total: this.settings.lifetimeCount };
  }

  // ── 업무 요청함(§7b Work Inbox) — API·폴링·알림 라우팅 ──────────────────────

  taskInboxOn(): boolean { return this.settings.taskInboxEnabled && !!this.settings.apiKey; }

  // 공용 호출 래퍼 — 네트워크 오류는 null(호출부가 조용한 실패로 처리, 봉인 플로우에 영향 0).
  // res.json은 비-JSON 응답에서 throw할 수 있어 여기서 방어적으로 흡수한다.
  private async taskApi(method: string, path: string, body?: unknown): Promise<{ status: number; json: any } | null> {
    try {
      const res = await requestUrl({
        url: `${this.base()}${path}`,
        method,
        // 팀 업무 API 는 전부 **팀 계정** 것이다 — 개인 계정에는 그 팀이 없다.
        headers: { "x-nanal-api-key": this.keyFor(true), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        throw: false,
      });
      let json: any = null;
      try { json = res.json; } catch (_) { /* 비-JSON 본문 */ }
      return { status: res.status, json };
    } catch (_) { return null; }
  }

  // view=inbox(내가 수신자)|mine(내가 작성). 404 = 팀 미소속 → 폴링 조용히 비활성(§7b).
  /// 업무 목록 — 커서를 끝까지 따라간다(2026-07-26).
  /// 이전에는 `limit=100` 한 번만 불러, 열린 업무가 100건을 넘으면 초과분이 **조용히 사라졌다**
  /// (서버는 커서 페이징을 구현해 두었는데 클라가 안 썼다). 업무함을 매일 여는 표면으로 쓰려면
  /// 목록이 말없이 잘리면 안 된다. 상한(20페이지=2,000건)은 무한 루프 방어용이다.
  async fetchTasks(view: "inbox" | "mine", status: "open" | "done" = "open", maxPages = 20): Promise<TaskItem[] | null> {
    const out: TaskItem[] = [];
    let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const url = `/attest/team/tasks?view=${view}&status=${status}&limit=100`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await this.taskApi("GET", url);
      if (!r) return out.length ? out : null;
      if (r.status === 404) { this.taskNotMember = true; return null; }
      if (r.status !== 200) return out.length ? out : null;
      this.taskNotMember = false;
      const parsed = parseTasksResponse(r.json);
      out.push(...parsed.tasks);
      const more = r.json?.has_more === true && typeof r.json?.cursor === "string" && r.json.cursor;
      if (!more) return out;
      cursor = r.json.cursor;
    }
    return out;
  }

  async fetchTaskReplies(id: string): Promise<TaskReply[] | null> {
    const r = await this.taskApi("GET", `/attest/team/tasks/${encodeURIComponent(id)}/replies`);
    if (!r || r.status !== 200) return null;
    return parseRepliesResponse(r.json);
  }

  /// 업무를 **열었다**는 보고(읽음 배지) — 상세 모달·회신 스레드 펼침이 부른다.
  /// 로컬 낙관 갱신이 먼저다: 서버 왕복·다음 폴링을 기다리면 읽었는데도 빨간 숫자가 남는다.
  /// 서버 실패(오프라인·구서버 404)는 조용히 — 다른 기기 배지가 늦게 꺼질 뿐 기능이 죽지 않는다.
  reportTaskRead(task: TaskItem): void {
    const nowSec = Math.floor(Date.now() / 1000);
    task.myReadAt = Math.max(task.myReadAt ?? 0, nowSec);   // 뷰가 든 객체(즉시 점 제거용)
    const mark = (l: TaskItem[]) => { for (const x of l) if (x.id === task.id) x.myReadAt = Math.max(x.myReadAt ?? 0, nowSec); };
    mark(this.taskBadgeInbox);
    mark(this.taskBadgeMine);
    this.taskInboxBadge = badgeCount(this.taskBadgeInbox, this.taskBadgeMine, fmtDate(new Date()));
    this.updateTaskRibbon();
    // 열려 있는 모든 업무함 패널 재렌더 — 사이드바·중앙이 같은 TaskItem 객체를 공유하므로
    // 위 mark가 이미 반영돼 있고, 다시 그리기만 하면 된다(클릭한 패널만 그리면 다른 쪽 점이 남는다).
    for (const leaf of this.app.workspace.getLeavesOfType(TASK_INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof TaskInboxView) leaf.view.rerenderAfterRead();
    }
    void this.taskApi("POST", `/attest/team/tasks/${encodeURIComponent(task.id)}/read`);
  }

  // 수신자 선택용 팀원 명단(5분 캐시). 실패 시 이전 캐시라도 반환(모달이 빈 목록으로 막히지 않게).
  async fetchTaskRoster(): Promise<RosterMember[] | null> {
    const c = this.taskRosterCache;
    if (c && Date.now() - c.at < 5 * 60 * 1000) return c.members;
    const r = await this.taskApi("GET", "/attest/team/roster");
    if (!r || r.status !== 200) return c?.members ?? null;
    const members = parseRosterResponse(r.json);
    this.taskRosterCache = { members, at: Date.now() };
    return members;
  }

  // 카드 액션·생성 공용 POST — 성공 시 응답 json, 실패 시 서버 error 문구 Notice 후 null.
  // silent=true면 실패해도 여기서 Notice를 띄우지 않는다(다중 수신자 fan-out처럼 호출부가
  // 결과를 모아 한 번에 요약 Notice를 띄우는 경우 — 개별 실패마다 뜨는 걸 막는다).
  async taskPost(path: string, body?: unknown, opts?: { silent?: boolean }): Promise<any | null> {
    const r = await this.taskApi("POST", path, body);
    if (!r) { if (!opts?.silent) new Notice(t.taskActionFail(t.taskLoadFail)); return null; }
    if (r.status !== 200) { if (!opts?.silent) new Notice(t.taskActionFail(String(r.json?.error ?? `HTTP ${r.status}`))); return null; }
    return r.json ?? {};
  }

  /// 업무 필드 수정(2026-07-29). taskPost와 같은 오류 처리 — 서버가 바뀐 필드를 봉인하므로
  /// 응답의 amended·seal_seq로 "증적에 남았다"를 화면이 말해 줄 수 있다.
  /// taskApi·updateActiveStatus 는 private 이라 같은 클래스 안에서만 쓴다 — 이 두 래퍼는
  /// 위 refreshTaskSealSummary 가 부르기 위한 것으로, 접근 범위를 넓히지 않기 위한 우회다.
  private async taskApiPublic(method: string, path: string) { return this.taskApi(method, path); }

  async taskPatch(path: string, body: unknown): Promise<any | null> {
    const r = await this.taskApi("PATCH", path, body);
    if (!r) { new Notice(t.taskActionFail(t.taskLoadFail)); return null; }
    if (r.status !== 200) { new Notice(t.taskActionFail(String(r.json?.error ?? `HTTP ${r.status}`))); return null; }
    return r.json ?? {};
  }

  // ── 연구과제(§3) — 목록 갱신·귀속 동기화·킷 폴더 만들기 ──────────────────────

  /// 과제 목록 갱신 — 로드 시·SSE changed·수동 새로고침. 팀 미소속(404)·에러는 조용히 무시(pollTasks 규칙).
  async refreshProjects(): Promise<void> {
    if (!this.settings.apiKey) return;
    const [r, rc] = await Promise.all([
      this.taskApi("GET", "/attest/team/projects?status=active"),
      this.taskApi("GET", "/attest/team/projects?status=closed"), // projectReported 캐시 정리 근거 전용(아래)
    ]);
    if (!r || r.status !== 200) return; // 404(팀 미소속)·5xx·네트워크 — 침묵(기존 캐시 유지)
    const raw = Array.isArray(r.json?.projects) ? (r.json.projects as Array<Record<string, unknown>>) : [];
    this.teamProjects = raw
      .filter((p) => typeof p?.id === "string" && typeof p?.name === "string")
      .map((p) => ({
        id: p.id as string,
        name: p.name as string,
        code: typeof p.code === "string" ? p.code : "",
        folder_patterns: typeof p.folder_patterns === "string" ? p.folder_patterns : "",
        kit_id: typeof p.kit_id === "string" && p.kit_id ? p.kit_id : null,
      }));
    // member_count 변동 = 참여자 구성이 바뀐 신호 → 403 스킵 캐시 무효화(중도 합류자가 이번 세션에 재시도되게).
    for (const p of raw) {
      if (typeof p?.id !== "string" || typeof p?.member_count !== "number") continue;
      const prev = this.projectMemberCounts.get(p.id);
      if (prev !== undefined && prev !== p.member_count) this.projectSyncSkip.delete(p.id);
      this.projectMemberCounts.set(p.id, p.member_count);
    }
    // 종료 과제의 projectReported(64자 해시 배열)가 data.json에 영구 잔존하지 않게 정리.
    // closed 목록에 **확실히 있는** id만 삭제 — 네트워크 실패·불명 id는 보존(플레이크로 캐시가 증발하면 전량 재POST가 나간다).
    if (rc && rc.status === 200 && Array.isArray(rc.json?.projects)) {
      const closed = new Set((rc.json.projects as Array<Record<string, unknown>>)
        .map((p) => p?.id).filter((id): id is string => typeof id === "string"));
      let pruned = false;
      for (const id of Object.keys(this.settings.projectReported)) {
        if (closed.has(id)) { delete this.settings.projectReported[id]; pruned = true; }
      }
      if (pruned) await this.saveSettings();
    }
    void this.syncProjectNotes();
      void this.syncFolderNames(); // 과제명이 바뀌었으면 폴더 이동을 제안한다(2026-07-26)
    // 과제 폴더도 여기서 적용한다(2026-08-05, 실기기에서 잡았다).
    //
    // 자동 적용은 팀 프로파일이 도착할 때 돈다(applyTeamProfile). 그런데 **과제 목록은 다른
    // 요청으로 따로 온다** — 기동 시 두 호출이 경쟁해서, 과제 목록이 늦으면 그때의
    // teamFolderTargets 에는 팀 공통만 담긴다. 그 결과 과제 폴더는 만들어지지 않고,
    // 더 나쁘게는 **"missing 0 = 정상"이라는 거짓 보고**가 서버로 나가 관리자 화면에
    // 멀쩡한 것으로 뜬다(실측: 과제 폴더 13개가 없는데 applied:true 로 보고됐다).
    //
    // 목록이 손에 들어온 이 자리에서 다시 적용하고 다시 보고하면 그 창이 닫힌다.
    // 팀 루트가 없으면(개인 계정) ensureTeamFolders 가 즉시 빠져나온다.
    if (this.teamRoot()) {
      this.lastFolderResult = await this.ensureTeamFolders();
      void this.reportFolderState();
    }
  }

  /// §3 귀속 동기화: 참여 과제별로 vault 전체에서 폴더 패턴 매칭 → 미보고 path_hash만 배치 POST(400개씩).
  /// 참여 판정은 서버가 한다 — 403(비참여)은 세션 스킵 캐시, 기타 실패는 침묵(다음 트리거에 재시도).
  /// 경로 해시는 봉인과 동일한 정본 hashPath(PATH_HASH_PREFIX) — 접두가 어긋나면 귀속 전체가 깨진다.
  async syncProjectNotes(): Promise<void> {
    if (this.projectSyncBusy) return; // 트리거 겹침(봉인 연타·SSE) — 한 번에 하나만
    this.projectSyncBusy = true;
    try {
      const root = this.teamRoot();
      if (!root) return; // 루트 미설정 = 과제 폴더 경로를 파생할 수 없다 → 귀속 동기화 스킵(finally가 플래그를 푼다)
      for (const p of this.teamProjects) {
        if (this.projectSyncSkip.has(p.id)) continue;
        // 서버가 준 패턴(= 과제명)은 루트-상대다 — 프리픽스 조립은 taskcore가 소유한다(경로 규칙 단일화).
        const patterns = scopedPatterns(root, parsePatterns(p.folder_patterns));
        if (!patterns.length) continue;
        const files = this.app.vault.getMarkdownFiles().map((f) => f.path).filter((path) => matchesPatterns(path, patterns));
        if (!files.length) {
          // 빈 배열 ping = 참여 판정(서버 sync_notes는 참여자 검사를 배치 검증보다 먼저 함 → 참여자 200/added 0, 비참여 403).
          // 노트 0개 참여자(신규 합류 + 빈 폴더)도 "과제 폴더 만들기" 후보에 떠야 한다 — 이 기능의 핵심 시나리오.
          const r = await this.taskApi("POST", `/attest/team/projects/${encodeURIComponent(p.id)}/notes`, { path_hashes: [] });
          if (r?.status === 200) this.myProjectIds.add(p.id);
          else if (r?.status === 403) this.projectSyncSkip.add(p.id);
          continue; // 기타 실패(네트워크·5xx)는 미판정 유지 — 다음 트리거에 재시도
        }
        // 현재 경로 + **과거 경로**(renameMap)의 해시를 함께 보고한다(2026-07-26).
        // 이유: 원장은 (user, 내용해시) 유니크라 이동해도 새 엔트리가 안 생기고, 기존 엔트리는
        // 첫 봉인 당시의 옛 경로 해시를 들고 있다. 현재 경로만 귀속하면 그 엔트리가 매칭되지 않아
        // 과제 리포트의 "귀속 봉인 건수"가 적게 나온다. 귀속 테이블은 append-only라 과거 경로를
        // 남기는 것이 자연스럽고(그 시점에 실제로 거기 있었다), 이미 이동한 노트도 이걸로 치유된다.
        const current = new Set(files);
        const past = Object.entries(this.settings.renameMap)
          .filter(([, to]) => current.has(to))
          .map(([from]) => from);
        const hashes = await Promise.all([...files, ...past].map((path) => hashPath(path)));
        const reported = new Set(this.settings.projectReported[p.id] || []);
        const fresh = unreported(hashes, reported);
        if (!fresh.length) { this.myProjectIds.add(p.id); continue; } // 전부 보고 완료 = 과거 POST 성공 = 참여 확인
        let dirty = false;
        for (let i = 0; i < fresh.length; i += 400) {
          const batch = fresh.slice(i, i + 400);
          const r = await this.taskApi("POST", `/attest/team/projects/${encodeURIComponent(p.id)}/notes`, { path_hashes: batch });
          if (!r || r.status !== 200) {
            if (r?.status === 403) this.projectSyncSkip.add(p.id); // 비참여 신호 — 이번 세션은 더 안 건드림
            break; // 기타 실패(네트워크·5xx) — reported 미기록 → 다음 트리거에 재시도
          }
          for (const h of batch) reported.add(h);
          dirty = true;
          this.myProjectIds.add(p.id); // 403 아님 확인 — 참여자
        }
        if (dirty) {
          this.settings.projectReported[p.id] = [...reported];
          await this.saveSettings();
        }
      }
    } finally {
      this.projectSyncBusy = false;
    }
  }

  /// 폴더 만들기 후보 = 참여 확인(myProjectIds) + 킷 연결 과제.
  kitProjects(): TeamProject[] {
    return this.teamProjects.filter((p) => p.kit_id && this.myProjectIds.has(p.id));
  }

  /// 팀(teamStructure) + 참여 과제(GET /attest/team/kits/<id> 병렬)를 대상 목록으로.
  /// 경로 조립은 taskcore.manifestPaths 한 곳에만 있다 —
  /// 팀 공통 = commonPrefix(root)(`<루트>/공통`), 과제 = projectPrefix(root, 과제명)(`<루트>/과제/<이름>`).
  /// 루트 미설정이면 빈 목록(호출자가 안내 문구를 띄운다).
  ///
  /// 모달(FolderCreateModal)과 자동 적용이 **같은 함수**를 본다. 두 곳에서 각자 계산하면
  /// 모달에는 안 뜨는데 자동 생성은 되는(또는 그 반대) 상태가 난다.
  /// 상태(folderStatus)는 여기서 매기지 않는다 — 보는 쪽이 자기 시점의 vault 스냅샷으로 판정한다.
  ///
  /// 경로는 **여기서 NFC로 맞춘다**(nfcPaths, 2026-08-05). 서버가 준 문자열이 vault 경로 세계로
  /// 들어오는 유일한 관문이라, 여기서 맞춰 두면 모달·자동 적용·materializeFolders가 전부 같은
  /// 형태를 본다. 근거는 taskcore.nfcPath 주석.
  async teamFolderTargets(opts: { samples: boolean }): Promise<FolderTarget[]> {
    const root = this.teamRoot();
    if (!root) return [];
    const targets: FolderTarget[] = [];
    const raw = this.settings.teamStructure;
    if (raw) {
      let structure: TeamStructure | null = null;
      try { structure = parseTeamStructure(JSON.parse(raw)); } catch { structure = null; }
      if (structure) {
        // 팀 표준 구조는 **공통 아래**에 만든다(4계층 규약) — 과제와 같은 층에 두면
        // 어느 것이 과제인지 알 수 없고 이름이 겹칠 수 있다.
        const common = nfcPath(commonPrefix(root));
        const p = nfcPaths(manifestPaths(common, structure, { samples: opts.samples }));
        targets.push({ kind: "team", label: t.teamKitTitle, pathLabel: common,
          folders: p.folders, files: p.files, allPaths: p.allPaths, failed: false,
          hasSamples: (structure.files || []).some((f) => f.sample) });
      }
    }
    const projects = this.kitProjects();
    const loaded = await Promise.all(projects.map(async (p) =>
      ({ p, manifest: p.kit_id ? await this.loadKitManifest(p.kit_id) : null })));
    for (const { p, manifest } of loaded) {
      const label = p.code ? `${p.name} (${p.code})` : p.name;
      const prefix = nfcPath(projectPrefix(root, p.name));
      if (!manifest) {
        targets.push({ kind: "project", label, pathLabel: prefix, folders: [], files: [], allPaths: [],
          failed: true });
        continue;
      }
      const q = nfcPaths(manifestPaths(prefix, manifest, { samples: opts.samples }));
      targets.push({ kind: "project", label, pathLabel: prefix,
        folders: q.folders, files: q.files, allPaths: q.allPaths, failed: false,
        hasSamples: (manifest.files || []).some((f) => f.sample) });
    }
    return targets;
  }

  /// 공용 생성 헬퍼 — 미존재 폴더·템플릿만 생성(덮어쓰기 절대 없음). 판정은 taskcore.creationPlan(순수),
  /// 실제 생성만 이 함수 몫. folders/files는 manifestPaths가 만든 (프리픽스 적용된) 전체 경로.
  /// ensureVaultFolder를 쓰는 이유: createFolder는 비재귀이고, manifestPaths가 조상을 합성해도
  /// **prefix 자체의 조상**은 합성하지 않는다(스코프 소유권은 호출자). 모달에서 팀 행을 빼고 과제 행만
  /// 체크하면 `<root>`가 없는 채 `<root>/<과제명>`을 만들려 해 조용히 실패한다.
  /// **실제로 생긴 항목 수**(폴더 + 파일)를 돌려준다(2026-08-05). 종전에는 아무것도 돌려주지 않았고,
  /// 호출부(모달 make())는 생성 후 vault를 재조회해 folderStatus로 뱃지를 다시 판정했다 — 화면에
  /// 뱃지가 남는 모달에서는 그것으로 충분했다. 자동 적용은 모달이 없어 Notice 한 줄이 전부이므로
  /// "만들 것으로 계획한 수"를 그대로 보여 주면 거짓이 된다: 팀 킷 URL이 404이거나 create가
  /// 실패하면 계획보다 적게 생긴다. 그래서 생성 직후 조회로 확인한 것만 센다.
  /// 조상 폴더(prefix 자신의 부모 등 folders 목록 밖)도 생기면 함께 센다 — 사람에게는 그것도 생긴 폴더다.
  /// 팀 킷(2026-07-27)은 본문이 S3에 있어 `url`로 내려온다 — 만들 때 받아서 쓴다.
  /// 바이너리(이미지·PDF)는 createBinary로 써야 한다: create()는 문자열 API라 바이트가 손상된다.
  /// 한 파일이 실패해도 나머지는 계속 만든다 — 반쪽이라도 만들어 두면 사용자가 다시 눌러 채운다.
  /// 빈 파일을 만든 뒤 내용을 쓰기까지 기다리는 시간(ms). 템플릿 엔진(Templater 등)의
  /// on-create 처리가 **빈 내용을 먼저 읽도록** 하는 것이 목적이다. 서식 수십 개를 만들어도
  /// 배경 작업이라 총 몇 초는 문제되지 않는다 — 사용자에게 모달이 쏟아지는 쪽이 훨씬 나쁘다.
  private static readonly TEMPLATE_SETTLE_MS = 300;

  /// 서식 파일을 **템플릿 엔진이 건드리지 않게** 만든다(2026-08-06, 실사용 vault 사고).
  ///
  /// 킷 서식은 Templater 문법으로 짜여 있다(`tp.system.prompt` 로 이름을 묻고 `tp.file.rename`).
  /// 사용자가 그 서식으로 **노트를 만들 때** 동작하라고 넣은 것이다. 그런데 Templater 의
  /// `trigger_on_file_creation` 이 켜져 있으면 **새로 생기는 모든 파일**에서 실행돼서,
  /// 우리가 서식을 **배치**하는 것까지 "사용자가 서식을 쓴다"로 오해한다.
  ///
  /// 그 결과가 실제로 났다: 자동 적용이 도는 순간 입력 모달이 다섯 개 쌓이고, 취소하면
  /// `tp.file.rename(null)` 로 **`EX-20260806-null.md` 같은 파일**이 남는다. 더 나쁘게는
  /// 그 망가진 이름 그대로 봉인된 증거가 vault 에 남아 있었다(2026-07-28 것 3건 발견).
  ///
  /// 그래서 **빈 파일로 만든 뒤 내용을 쓴다.** 생성 시점에는 실행할 문법이 없어 아무 일도
  /// 일어나지 않고, Templater 는 수정(modify)에는 반응하지 않는다.
  /// 반환 = 실제로 만들어졌는가.
  private async createInert(path: string, body: string): Promise<boolean> {
    try {
      const f = await this.app.vault.create(path, "");
      // 생성 이벤트를 **처리할 시간**을 준 뒤 내용을 쓴다.
      // Templater 의 on-create 는 비동기라, 같은 tick(setTimeout 0)에 쓰면 그쪽이 읽을 때
      // 이미 우리 내용이 들어 있어 그대로 실행된다(2026-08-06 실측: 0ms 로는 모달이 그대로 떴다).
      // 실측상 modify 에는 반응하지 않으므로, 빈 내용을 먼저 읽히면 그 뒤는 안전하다.
      await new Promise((r) => window.setTimeout(r, NanalStampPlugin.TEMPLATE_SETTLE_MS));
      if (body) await this.app.vault.modify(f, body);
      return true;
    } catch (_e) {
      return !!this.app.vault.getAbstractFileByPath(path); // 이미 있었으면 만든 것이 아니다
    }
  }

  async materializeFolders(folders: string[], files: { path: string; body: string; url?: string }[]): Promise<number> {
    const existing = new Set<string>(this.app.vault.getAllLoadedFiles().map((f) => f.path));
    const plan = creationPlan({ folders, files }, existing);
    let made = 0;
    for (const f of plan.folders) made += await this.ensureVaultFolder(f);
    for (const tp of plan.files) {
      if (this.app.vault.getAbstractFileByPath(tp.path)) continue;   // 덮어쓰기 금지
      if (!tp.url) {
        if (await this.createInert(tp.path, tp.body)) made++;
        continue;
      }
      try {
        const r = await requestUrl({ url: tp.url, method: "GET" });
        if (r.status !== 200) continue;
        if (isBinaryPath(tp.path)) { await this.app.vault.createBinary(tp.path, r.arrayBuffer); made++; }
        else if (await this.createInert(tp.path, r.text)) made++;
      } catch (_e) { /* 개별 실패는 건너뛴다 */ }
    }
    return made;
  }

  /// 킷 매니페스트 로드(GET /attest/team/kits/<id>) — 실패 시 null(모달이 "불러오기 실패" 행 처리).
  async loadKitManifest(kitId: string): Promise<KitManifest | null> {
    const r = await this.taskApi("GET", `/attest/team/kits/${encodeURIComponent(kitId)}`);
    if (!r || r.status !== 200 || !r.json) return null;
    return parseKitManifest(r.json);
  }

  // 5분 인터벌 + 로드 직후 + 패널 열기/수동 새로고침 공용. manual=수동(404 비활성 상태도 재시도).
  // 첫 폴링은 스냅샷 기준만 수립하고 알림은 내지 않는다(재시작 때마다 과거 항목 재알림 방지).
  async pollTasks(manual = false): Promise<{ inbox: TaskItem[]; mine: TaskItem[] } | null> {
    if (!this.taskInboxOn()) return null;
    if (this.taskNotMember && !manual) return null; // 팀 미소속 — 조용히 폴링 중단(§7b)
    if (this.taskPollInflight) return this.taskPollInflight; // 겹침 = 같은 결과 공유
    const p = this.doPollTasks();
    this.taskPollInflight = p;
    try {
      return await p;
    } finally {
      this.taskPollInflight = null;
    }
  }

  private async doPollTasks(): Promise<{ inbox: TaskItem[]; mine: TaskItem[] } | null> {
    const inbox = await this.fetchTasks("inbox");
    if (!inbox) return null;
    const mine = await this.fetchTasks("mine");
    if (!mine) return null;
    const today = fmtDate(new Date());
    const events = this.taskSnapshot
      ? diffSnapshot(this.taskSnapshot, inbox, mine, today, this.settings.accountEmail.trim())
      : [];
    this.taskSnapshot = snapshotOf(unionTasks(inbox, mine), today);
    // 배지에는 완료 첫 페이지(100건)도 넣는다 — "담당자가 완료했는데 요청자가 모른다"는 open
    // 목록에서 사라지는 순간 놓친다. 실패는 빈 목록(배지 보조 재료라 폴링을 막지 않는다).
    // 100건 창(created_at 순)보다 오래된 미확인 완료는 배지에서 빠질 수 있다 — 설계 문서에 명시.
    const doneInbox = (await this.fetchTasks("inbox", "done", 1)) ?? [];
    const doneMine = (await this.fetchTasks("mine", "done", 1)) ?? [];
    this.taskBadgeInbox = [...inbox, ...doneInbox];
    this.taskBadgeMine = [...mine, ...doneMine];
    this.taskInboxBadge = badgeCount(this.taskBadgeInbox, this.taskBadgeMine, today);
    this.taskLastSyncAt = Date.now();
    this.updateTaskRibbon();
    for (const ev of events) this.notifyTaskEvent(ev);
    // 열려 있는 패널에 새 데이터 반영 — 인터벌·SSE 경유 폴링도 화면을 스스로 갱신한다
    // (수동 ↻ 없이도 최신 유지 — 2026-07-23 실사용 버그 수정). 추가 네트워크 호출 없음.
    this.pushTasksToOpenViews(inbox, mine);
    void this.refreshTaskSealSummary();
    // 팀 미소속(404)으로 멈췄던 SSE가 있으면 재가동(수동 새로고침이 taskNotMember를 리셋한 뒤).
    this.startTaskSse();
    return { inbox, mine };
  }

  /// 업무 증적 요약 갱신 — 실패는 조용히 넘긴다(상태바 보조 정보라 화면을 막을 이유가 없다).
  async refreshTaskSealSummary(): Promise<void> {
    if (!this.settings.apiKey) return;
    const r = await this.taskApiPublic("GET", "/attest/team/tasks/seal-summary");
    if (!r || r.status !== 200 || !r.json) return;
    const sealed = Number(r.json.sealed ?? 0);
    const pending = Number(r.json.pending ?? 0);
    if (!Number.isFinite(sealed)) return;
    this.taskSealSummary = { sealed, pending };
    void this.updateActiveStatus();
  }

  /// 열려 있는 업무함 패널 전부에 폴링 결과를 밀어넣는다(뷰가 변화 여부를 판단해 재렌더).
  private pushTasksToOpenViews(inbox: TaskItem[], mine: TaskItem[]): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TASK_INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof TaskInboxView) leaf.view.applyData(inbox, mine);
    }
  }

  // ── SSE 준실시간 구독(/attest/team/events) ──────────────────────────────
  // 서버는 팀 워터마크 변화 시 `event: changed`만 쏜다(상세 없음) — 수신 즉시 기존
  // pollTasks(스냅샷 diff → Notice/OS 알림 → 열린 패널 갱신)를 부른다. 5분 폴링은 안전망.
  // requestUrl은 응답 스트리밍이 안 되므로 전역 fetch(데스크톱 Obsidian은 지원)를 쓴다.

  startTaskSse(): void {
    if (!Platform.isDesktopApp) return;                        // 모바일 = 기존 폴링만(배터리)
    if (!this.taskInboxOn() || this.taskNotMember) return;     // 설정 OFF·키 없음·팀 미소속
    if (this.taskSseActive) return;                            // 이미 가동 중(idempotent)
    if (typeof fetch !== "function") return;                   // 방어 — 미지원 환경은 폴링만
    this.taskSseActive = true;
    this.taskSseBackoffMs = TASK_SSE_RETRY_MIN_MS;
    void this.runTaskSse();
  }

  stopTaskSse(): void {
    this.taskSseActive = false;
    try { this.taskSseAbort?.abort(); } catch (_) { /* 이미 닫힘 */ }
    this.taskSseAbort = null;
  }

  private async runTaskSse(): Promise<void> {
    try {
      while (this.taskSseActive && this.taskInboxOn() && !this.taskNotMember) {
        const ac = new AbortController();
        this.taskSseAbort = ac;
        try {
          // Store review note: this is the ONLY fetch() in the plugin — Obsidian's requestUrl
          // cannot stream a Server-Sent Events body (it buffers the whole response), so the
          // live task-inbox stream needs fetch + ReadableStream. Same single host as requestUrl.
          const res = await fetch(`${this.base()}/attest/team/events`, {
            headers: { "x-nanal-api-key": this.keyFor(true) },
            signal: ac.signal,
          });
          if (res.status === 404) { this.taskNotMember = true; break; } // 팀 미소속 — 침묵 플래그 연동, 수동 ↻이 리셋
          if (res.status === 401) break;                                // 키 불량 — 재시도 무의미(폴링 성공 시 재가동)
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          this.taskSseBackoffMs = TASK_SSE_RETRY_MIN_MS; // 연결 성공 — 백오프 리셋
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let ps = sseInitialState();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break; // 서버 롤링 재시작 등 — 아래 백오프로 재연결
            const fed = sseFeed(ps, dec.decode(value, { stream: true }));
            ps = fed.state;
            if (fed.events.some((e) => e.event === "changed")) { void this.pollTasks(); void this.refreshProjects(); } // §3: 과제 변경도 같은 워터마크에 편승
          }
        } catch (_) { /* 절단·네트워크 오류 — 백오프 재연결 */ }
        this.taskSseAbort = null;
        if (!this.taskSseActive) break;
        await new Promise<void>((res) => window.setTimeout(res, this.taskSseBackoffMs));
        this.taskSseBackoffMs = Math.min(this.taskSseBackoffMs * 2, TASK_SSE_RETRY_MAX_MS);
      }
    } finally {
      this.taskSseActive = false;
      this.taskSseAbort = null;
    }
  }

  /// 리본 메뉴 구성(2026-07-26 재편) — 카테고리 제목 + 구분선. 항목이 15개라 선만으로는
  /// 어느 그룹인지 읽히지 않아 제목을 넣었다(비활성 항목 + .nanalstamp-menu-header).
  /// 순서는 **쓰는 빈도**다: 업무 → 봉인 → 증명서·공유 → nanalStorage → 현황 → 계정.
  /// 카테고리 제목이 접두어를 대신하므로 항목 문구에서 "nanalStorage"·"현재 노트 지금" 같은
  /// 반복을 걷어냈다(팔레트에서는 플러그인 이름이 접두로 붙으므로 짧아도 모호하지 않다).
  /// Menu 인스턴스를 받아 채우기만 한다 — 리본을 클릭하지 않고도 구성을 검사할 수 있다.
  buildRibbonMenu(menu: Menu): void {
    // macOS 기본은 **네이티브 메뉴**다. 네이티브에서는 항목 색·폰트·아이콘을 앱이 제어할 수 없어
    // 카테고리 라벨이 시스템 회색으로만 나오고(사용자 화면에서 확인) 아이콘도 사라진다.
    // 이 메뉴 하나만 DOM 렌더로 돌린다 — 전역 설정("네이티브 메뉴")은 건드리지 않으므로 다른
    // 우클릭 메뉴는 사용자 취향 그대로다. 메서드가 없는 버전에서도 안전하게 옵셔널 호출.
    (menu as unknown as { setUseNativeMenu?: (v: boolean) => void }).setUseNativeMenu?.(false);
    // 이 메뉴에만 적용할 스타일(간격·hover)을 위해 컨테이너를 표시한다 — 다른 플러그인·코어
    // 메뉴에는 영향이 없어야 한다. dom은 비공식 필드라 옵셔널로 접근한다.
    (menu as unknown as { dom?: HTMLElement }).dom?.addClass("nanalstamp-ribbon-menu");
    // 제목을 **프래그먼트**로 넘겨 span에 클래스를 심는다 — MenuItem.dom은 비공식 필드라
    // 붙지 않는 경우가 있고(2026-07-26 실기기에서 스타일이 먹지 않았다), 그러면 Obsidian의
    // disabled 기본 흐림만 남아 제목이 읽히지 않는다. setTitle(DocumentFragment)은 공식 시그니처다.
    // 카테고리 제목 — **선택할 수 없는 라벨**이다(setDisabled). 그게 이 항목의 성격에 맞다.
    // 흐림 문제는 disabled 자체가 아니라 행에 걸리는 opacity가 라벨 색에 곱해져서 생겼다
    // (2026-07-26): 색을 아무리 정해도 반투명해져 읽히지 않았다. 그래서 CSS에서 그 opacity만
    // 걷어내고 색은 회색 계열을 유지한다 — 항목(본문색)과 구분되면서 읽히는 지점.
    // 제목은 프래그먼트로 넘겨 span에 클래스를 심는다(MenuItem.dom은 비공식 필드라 못 붙을 수 있다).
    const header = (label: string): void => {
      menu.addItem((i) => {
        const frag = document.createDocumentFragment();
        frag.createSpan({ cls: "nanalstamp-menu-header", text: label });
        i.setTitle(frag);
        // setIsLabel은 "선택 대상이 아닌 라벨"을 뜻하는 공식 API다 — disabled(비활성화된 기능)와
        // 의미가 다르고, 흐림 처리도 받지 않는다. 없는 버전에서는 disabled로 폴백한다.
        const it = i as unknown as { setIsLabel?: (v: boolean) => void };
        if (typeof it.setIsLabel === "function") it.setIsLabel(true);
        else i.setDisabled(true);
      });
    };
    const item = (title: string, icon: string, cb: () => void): void => {
      menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(cb));
    };
    // "처리해야 할 일" 항목 — 건수만 제목에 붙이면 평상시 항목과 구분되지 않아 지나친다
    // (2026-08-06 지적: 원문 누락이 있는데 경고로 안 읽혔다). 경고색 제목 + 경고 아이콘으로
    // 통일한다(빠진 봉인 발견·반려·원문 누락·봉인 보류 전부 같은 성격, 같은 모양).
    const warnItem = (title: string, cb: () => void, icon = "alert-triangle"): void => {
      menu.addItem((i) => {
        const frag = document.createDocumentFragment();
        frag.createSpan({ cls: "nanalstamp-menu-warn", text: title });
        i.setTitle(frag).setIcon(icon).onClick(cb);
      });
    };
    const withActiveFile = (fn: (f: TFile) => void) => () => {
      const f = this.app.workspace.getActiveFile();
      if (f) fn(f); else new Notice(t.noNote);
    };

    // 봉인이 멈춰 있으면 그것부터 말한다 — 메뉴를 열어도 원인이 안 보이면 사용자는 고장으로 읽는다.
    // 키 거부는 봉인 정지와 같은 급 — 메뉴를 열면 바로 보이고, 누르면 회복 경로로 간다(P-02).
    // 상태바와 같은 언어로 — 로그인이 범위보다 먼저다(M-5).
    if (this.authFailedAny()) {
      header(t.authFailMenuCat);
      warnItem(this.authFailed ? t.authFailMenu : t.teamAuthFailMenu, () => this.openOwnSettings(), "key");
    }
    if (this.scopeUnset()) {
      header(t.scopeUnsetMenuCat);
      item(t.scopeUnsetMenuItem, "folder-tree", () => {
        new OnboardingScopeModal(this.app, this).open();
      });
    }

    // 업무 — 미처리 건수는 리본 배지가 알리고, 제목에도 숫자를 붙여 메뉴에서 바로 보인다.
    if (this.settings.taskInboxEnabled) {
      header(t.menuCatWork);
      const n = this.taskInboxBadge;
      item(n > 0 ? `${t.taskInboxTitle} (${n > 99 ? "99+" : n})` : t.taskInboxTitle,
        "inbox", () => void this.openTaskInboxDefault());
      }
    // 「팀 폴더 만들기」 수동 메뉴는 없앴다(2026-08-06 사용자 결정) — 폴더·서식은 자동 적용이
    // 다 만들고, 자동이 멈추는 순간(이름 충돌)에는 메뉴가 아니라 팝업(FolderConflictModal)이
    // 온다. 샘플 포함 생성은 명령 팔레트(FolderCreateModal)에 남아 있다.
    // 관리자 전용 진입점 — 팀 관리(웹)로 바로. 관리자도 Obsidian에서 기록을 남기다가 팀 화면으로
    // 넘어갈 일이 잦은데, 이전에는 계정 메뉴를 거쳐 돌아가야 했다(2026-07-29 D 트랙에서 발견).
    if (this.settings.teamRole === "owner") {
      header(t.menuCatTeam);
      item(t.teamAdminCmd, "users", () => this.openExternal("/team"));
    }

    // 구분선은 두지 않는다 — 강조색 카테고리 제목이 이미 그룹을 나누고, 선까지 넣으면 항목
    // 21개짜리 메뉴가 불필요하게 길어진다(641 → 504px, 2026-07-26 실측).
    // 반려가 있으면 **맨 위에** 둔다 — 고쳐야 할 일이 있다는 뜻이고, 묻혀 있으면 놓친다.
    if (this.reviewRejected > 0) {
      header(t.menuCatReview);
      warnItem(t.reviewRejectedMenu(this.reviewRejected),
        () => new ReviewResultModal(this.app, this).open(), "undo-2");
    }

    header(t.menuCatSeal);
    // 빠진 봉인 확인 — 사람이 지금 눌러 답을 얻는 자리.
    // 자동 대조가 돌지만 **"지금 이 순간 빠진 게 없다"를 사람이 확인할 수 있어야** 한다.
    // 그 확신이 이 제품을 쓰는 이유이고, 자동만 있으면 확인할 방법이 없다.
    const pend = this.reconcilePending.length;
    if (pend > 0 || this.reconcileUnknown()) {
      warnItem(this.reconcileUnknown() ? t.checkMissingUnknown : t.checkMissingFound(pend),
        () => void this.checkMissingNow());
    } else {
      item(t.checkMissingCmd, "shield-check", () => void this.checkMissingNow());
    }
    item(t.sealCmd, ICON_ID, withActiveFile((f) => this.flush(f, "manual")));
    item(t.proofCmd, "file-search", () => this.showProof());
    item(t.anchorCmd, "anchor", () => this.anchorNow());

    // 노트 하나짜리 작업(증명서 PDF·공개 링크·특정 시점)은 여기서 뺐다 —
    // **제출 패키지가 이미 그것을 포함한다**: 범위에서 '이 노트만'을 고르면 그 노트의 원문·증명·
    // 증명서 PDF 가 한 묶음으로 나오고, 기준 시점도 패키지 쪽에서 고른다.
    // 같은 일을 하는 입구가 넷이면 무엇을 눌러야 할지 알 수 없다(2026-07-30).
    // 공개 링크는 그 노트의 증명 화면(ProofModal)으로 옮겼다 — 대상이 노트 하나이므로 제자리다.
    // 카테고리 이름도 그에 맞췄다(2026-08-05): 아래에 남은 것은 제출 패키지와 점검 요청뿐이라
    // '증명서·공유'는 이제 없는 기능을 가리킨다 — 하는 일 그대로 '내보내기·검토'.
    header(t.menuCatExport);
    item(t.pkgCmd, "package", () => this.openSubmissionPackage());
    item(t.reviewReqCmd, "stamp", () => {
      if (!this.settings.apiKey) return void new Notice(t.apiKeyMissing);
      new ReviewRequestModal(this.app, this).open();
    });

    header(t.menuCatStorage);
    item(t.browserCmd, "list-ordered", () => void this.openNoteBrowser());
    item(t.nanalRestoreCmd, "archive-restore", () => void this.restoreFromNanal());
    // 데이터를 잃은 순간의 두 해법이 리본에 없었다(P-06) — 팔레트 전용이던 진입점을 상시 노출한다.
    // 부르는 함수는 명령 등록부(rewind-find-deleted·restore-vault)와 같은 것이다.
    if (Platform.isDesktopApp) {  // 로컬 git 아카이브 기반 — 명령의 checkCallback 가드와 같은 판정
      item(t.rewindFindCmd, "history", () => void this.findDeletedNotes());
    }
    item(t.restoreVaultCmd, "folder-sync", () => new RestoreVaultModal(this.app, this).open());
    const openRecovery = (): void => {
      if (!this.settings.apiKey) return void new Notice(t.apiKeyMissing);
      new StorageRecoveryModal(this.app, this).open();
    };
    // 원문 누락은 "확인·재업로드가 필요한 상태"다 — 건수를 제목에 붙이는 것만으로는 안 읽힌다.
    if (this.settings.storageGapSeen > 0) warnItem(t.recCmdWithGap(this.settings.storageGapSeen), openRecovery, "cloud-alert");
    else item(t.recCmd, "cloud-upload", openRecovery);

    header(t.menuCatStatus);
    item(t.dashCmd, "layout-dashboard", () => void this.openDashboard());
    // 정기 digest — **안 쓴 기간이 있을 때만** 보인다(2026-08-02). 종전에는 명령 팔레트에만
    // 있어, 쓸 때가 됐다는 것을 사람이 알 방법이 없었다.
    const dmiss = this.digestMissing();
    if (dmiss) item(t.digestMissingMenu(periodLabel(dmiss)), "calendar-check", () => void this.createDigest(dmiss));

    header(t.menuCatAccount);
    // 계정이 없으면 요금제·내 계정보다 로그인이 먼저다 — 미로그인 사용자의 리본 유일 입구.
    if (!this.settings.apiKey) item(t.loginMenu, "log-in", () => this.openOwnSettings());
    item(t.pricingCmd, "credit-card", () => this.openExternal("/pricing"));
    // 막힌 것이 있으면 메뉴 맨 위에 — 배지는 "무언가 있다"만 말하고, 무엇인지는 여기서 본다.
    const holds = Object.entries(this.settings.sealHolds ?? {});
    if (holds.length > 0) {
      warnItem(t.holdMenu(holds.length), () => {
        const lines = holds.map(([notePath, h]) => t.holdDetailLine(
          basenameOf(notePath), h.kind, basenameOf(h.path), Math.ceil(h.size / (1024 * 1024)), h.limitMB));
        new Notice(`${t.holdsTitle(holds.length)}\n${lines.join("\n")}\n\n${t.holdsDesc}`, 20000);
      });
    }
    item(t.accountCmd, "user", () => this.openExternal("/account"));
  }

  // 업무함 배지 갱신 — 설정 변경·폴링 후 호출. 리본이 하나로 합쳐진 뒤(2026-07-26)로는
  // **배지만** 제어한다: 업무함을 꺼도 리본 자체(봉인·증명 진입점)는 남아야 하므로, 예전처럼
  // el.toggle()로 리본을 숨기면 플러그인 진입점이 통째로 사라진다.
  updateTaskRibbon(): void {
    const b = this.taskBadgeEl;
    if (!b) return;
    // 봉인 범위 미설정이 업무 건수보다 급하다 — 봉인이 **멈춰 있는** 상태이기 때문이다.
    // 상태바만으로는 눈에 안 들어와서(2026-07-28 지적) 항상 보이는 리본에도 경고를 띄운다.
    if (this.scopeUnset()) {
      b.setText("!");
      b.addClass("is-warn");
      b.show();
      // 배지만으로는 작아서 놓친다 — 아이콘 자체를 경고색으로 두른다(styles.css).
      this.taskRibbonEl?.addClass("nanalstamp-ribbon-warn");
      this.taskRibbonEl?.setAttribute("aria-label", t.scopeUnsetRibbon);
      return;
    }
    // 봉인 보류도 **봉인이 멈춰 있는** 상태다 — 범위 미설정이 "전부 멈춤"이라면 이건 "일부 멈춤"이라
    // 그다음 급이다. 설정·상태바에만 두면 그 노트를 열지 않는 한 모른 채 지나간다.
    const holds = Object.keys(this.settings.sealHolds ?? {}).length;
    if (holds > 0) {
      b.setText(String(holds > 9 ? "9+" : holds));
      b.addClass("is-warn");
      b.show();
      this.taskRibbonEl?.addClass("nanalstamp-ribbon-warn");
      this.taskRibbonEl?.setAttribute("aria-label", t.holdRibbon(holds));
      return;
    }
    b.removeClass("is-warn");
    this.taskRibbonEl?.removeClass("nanalstamp-ribbon-warn");
    this.taskRibbonEl?.setAttribute("aria-label", "nanalStamp");
    // 반려는 **업무 건수보다 급하다** — 내 기록이 되돌아왔다는 뜻이고, 그대로 두면
    // 제출물에서 빠진다. 숫자를 합치지 않고 반려를 우선 보여준다(합치면 무엇 때문인지 모른다).
    if (this.reviewRejected > 0) {
      b.setText(`↩${this.reviewRejected > 9 ? "9+" : this.reviewRejected}`);
      b.addClass("is-warn");
      b.show();
      this.taskRibbonEl?.setAttribute("aria-label", t.reviewRejectedRibbon(this.reviewRejected));
      return;
    }
    const n = this.settings.taskInboxEnabled ? this.taskInboxBadge : 0;
    if (n > 0) {
      b.setText(n > 99 ? "99+" : String(n));
      b.show();
    } else {
      b.hide();
    }
  }

  /// 내가 낸 점검 요청의 결과를 받아 배지를 갱신한다.
  /// 요청자는 점검함(웹)에 들어갈 권한이 없다 — 여기가 유일한 화면 경로다.
  async refreshMyReviews(): Promise<void> {
    if (!this.settings.apiKey) return;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/review/mine`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200) return;
      const rows: any[] = res.json?.reviews ?? [];
      const items: Array<{ seq: number; comment: string; title: string }> = [];
      for (const r of rows) {
        if (r.status !== "signed") continue;
        for (const it of (r.rejected ?? [])) {
          items.push({ seq: it.seq, comment: it.comment || "", title: r.title || "" });
        }
      }
      this.reviewRejectedItems = items;
      this.reviewRejected = items.length;
      this.updateTaskRibbon();
    } catch { /* 네트워크 실패로 배지가 사라지면 안 된다 — 이전 값을 유지한다 */ }
  }

  /// 봉인 폴더 트리 열기 — 설정 탭과 시작 모달이 같은 화면을 쓴다(선택 경로가 갈리면 설명이 갈린다).
  openFolderScopePicker(after?: () => void): void {
    new FolderTreeModal(
      this.app,
      parseFolders(this.settings.includeFolders),
      parseFolders(this.settings.excludeFolders),
      this.teamRoot(),
      async (inc, exc) => {
        this.settings.includeFolders = inc.join("\n");
        this.settings.excludeFolders = exc.join("\n");
        await this.saveSettings();
        new Notice(t.folderTreeSaved(inc.length));
        this.updateTaskRibbon();
        void this.updateActiveStatus();
        after?.();
      },
      this.settings.sealWholeVault,
    ).open();
  }

  /// 봉인 범위가 하나도 정해지지 않았는가 — 상태바·리본·봉인 게이트가 공유하는 단일 술어.
  scopeUnset(): boolean {
    return scopeUnset(this.teamRoot(), parseFolders(this.settings.includeFolders),
                      this.settings.sealWholeVault);
  }

  // 알림 라우팅(§7b·설계 §4): 창 활성 = Notice, 비활성 = OS 알림(데스크톱 전용 + 토글). 3종(할당·회신·초과)만.
  private notifyTaskEvent(ev: TaskEvent): void {
    const title = ev.task.title.length > 80 ? ev.task.title.slice(0, 77) + "…" : ev.task.title;
    const text = ev.type === "assigned"
      ? t.taskNotifyAssigned(personDisplay(ev.task.creatorName, ev.task.creatorEmail), title)
      : ev.type === "reply" ? t.taskNotifyReply(title) : t.taskNotifyOverdue(title);
    // 창을 보고 있어도 항상 OS 알림(2026-08-06 사용자 결정) — 사용자는 Obsidian을 계속 보고
    // 있지 않고, 앱 안 toast는 몇 초 뒤 사라져 놓치면 흔적이 없다(그 공백은 읽음 배지가 남긴다).
    // 소리·화면 지속(배너/알림)·표시 여부는 전부 macOS 시스템 설정(알림 → Obsidian)을 따른다 —
    // silent 등으로 앱이 사용자 설정을 덮지 않는다. requireInteraction은 힌트일 뿐 설정을 못 이긴다.
    if (Platform.isDesktopApp && this.settings.taskSystemNotify) {
      try {
        const n = new Notification("nanalStamp", { body: text, requireInteraction: true });
        n.onclick = () => { try { window.focus(); } catch (_) { /* 포커스 실패 무시 */ } void this.openTaskInbox(); };
        return;
      } catch (_) { /* OS 알림 불가(권한 등) — 아래 Notice 폴백 */ }
    }
    new Notice(text); // 모바일·OS 알림 꺼짐·발송 실패 — 앱 안 toast 폴백
  }

  // 패널 열기 — 파일 탐색기처럼 우측 사이드바 상주(목업). 이미 열려 있으면 드러내고 즉시 갱신.
  // 재사용 대상은 사이드 도크 리프로 한정(rootSplit 중앙 탭은 제외) — openTaskInboxWide와 대칭. 이래야
  // 중앙 탭만 열린 상태에서 openTaskInboxNarrow가 중앙을 재활용해 return하지 않고 새 사이드바를 만든다.
  async openTaskInbox(): Promise<void> {
    if (!this.settings.taskInboxEnabled) { new Notice(t.taskDisabled); return; }
    const existing = this.app.workspace.getLeavesOfType(TASK_INBOX_VIEW_TYPE)
      .find((leaf) => leaf.getRoot() !== this.app.workspace.rootSplit);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      if (existing.view instanceof TaskInboxView) void existing.view.refresh(true);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: TASK_INBOX_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // §Task 11: 중앙 편집 영역에 같은 뷰(TASK_INBOX_VIEW_TYPE) 새 탭 — 폭이 넓어 표 모드가 자동 적용된다.
  // 별도 뷰 타입은 만들지 않는다 — 사이드바 인스턴스와는 getRoot()로 구분해(중앙=rootSplit 소속) 서로
  // 뺏지 않고 공존시킨다. 이미 중앙에 열려 있으면 재사용(중복 생성 방지) — pushTasksToOpenViews는
  // getLeavesOfType 전체를 순회하므로 사이드바·중앙 두 인스턴스 모두 계속 갱신된다.
  async openTaskInboxWide(): Promise<void> {
    if (!this.settings.taskInboxEnabled) { new Notice(t.taskDisabled); return; }
    const existing = this.app.workspace.getLeavesOfType(TASK_INBOX_VIEW_TYPE)
      .find((leaf) => leaf.getRoot() === this.app.workspace.rootSplit);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      if (existing.view instanceof TaskInboxView) void existing.view.refresh(true);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TASK_INBOX_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // 리본·명령 진입점 — 데스크톱은 중앙 탭(넓은 표)이 기본, 모바일은 중앙도 좁아 무의미하므로 사이드바 카드.
  async openTaskInboxDefault(): Promise<void> {
    if (Platform.isMobile) return this.openTaskInbox();
    return this.openTaskInboxWide();
  }

  // 넓게→좁게 토글: 사이드바(카드)를 열어 드러내고, 중앙(rootSplit) 인스턴스는 닫아 중복을 없앤다.
  async openTaskInboxNarrow(): Promise<void> {
    await this.openTaskInbox(); // 우측 사이드바 열기/드러내기
    for (const leaf of this.app.workspace.getLeavesOfType(TASK_INBOX_VIEW_TYPE)) {
      if (leaf.getRoot() === this.app.workspace.rootSplit) leaf.detach();
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULTS, loaded);
    this.settings.enabled = true; // 플러그인 활성화 = 봉인 활성 — 토글 UI 제거(과거 false 저장분 무력화)
    // C1 마이그레이션: 예전 dropdown "github" 선택자·legacy githubMirror 토글 → 고급 'GitHub 내보내기'로 1회 이관.
    // (병행 허용 모델 — GitHub는 탈출구, nanal이 주 스토리지)
    const legacyBackend = (loaded as Partial<AttestSettings> | null)?.storageBackend as string | undefined;
    if (legacyBackend === "github" || (!legacyBackend && this.settings.githubMirror)) {
      this.settings.githubExport = true;
      this.settings.storageBackend = "off";
    }
    // 2026-07-28 마이그레이션: 예전 기본값은 "포함 폴더가 비면 vault 전체"였다. 그 상태로 이미 쓰던
    // 사용자에게서 봉인을 조용히 멈추면 그 기간의 기록에 공백이 생긴다(봉인은 소급되지 않는다).
    // 그래서 **이미 봉인 경험이 있는 기존 설치**만 wholeVault=true로 이관하고, 새 설치는 false로 남긴다.
    if (loaded && (loaded as Partial<AttestSettings>).sealWholeVault === undefined) {
      const usedBefore = ((loaded as Partial<AttestSettings>).lifetimeCount ?? 0) > 0
        || Object.keys((loaded as Partial<AttestSettings>).sealedIndex ?? {}).length > 0;
      this.settings.sealWholeVault = usedBefore && !(loaded as Partial<AttestSettings>).includeFolders;
    }
    this.settings.ledgerIndex = { ...(this.settings.ledgerIndex || {}) }; // DEFAULTS와 공유 참조 방지
    this.settings.mirrorIndex = { ...(this.settings.mirrorIndex || {}) };
    this.settings.ledgerMtime = { ...(this.settings.ledgerMtime || {}) };
    this.settings.archiveIndex = { ...(this.settings.archiveIndex || {}) };
    this.settings.nanalIndex = { ...(this.settings.nanalIndex || {}) };
    this.settings.sealedIndex = { ...(this.settings.sealedIndex || {}) };
    this.settings.sealDayCounts = { ...(this.settings.sealDayCounts || {}) };
    this.settings.projectReported = { ...(this.settings.projectReported || {}) }; // §3: DEFAULTS 공유 참조 방지
    // §Task 6: 뷰 상태 — 누락 필드 방어(구 저장분·부분 저장) + DEFAULTS 공유 참조 방지(filters 별도 클론).
    this.settings.taskViewPrefs = {
      ...DEFAULTS.taskViewPrefs,
      ...(this.settings.taskViewPrefs || {}),
      filters: { ...(this.settings.taskViewPrefs?.filters || {}) },
      colWidths: { ...(this.settings.taskViewPrefs?.colWidths || {}) }, // §Task 12: 컬럼 폭 — DEFAULTS 공유 참조 방지 + 누락 방어
      sorts: [...(this.settings.taskViewPrefs?.sorts || [])],           // 다중 정렬 — DEFAULTS 공유 참조 방지 + 누락 방어
    };
    // 구 단일 정렬(sortCol/sortDir) → 다중 정렬(sorts) 1회 마이그레이션. 이후 구 필드는 영구 제거.
    {
      const tvp = this.settings.taskViewPrefs as unknown as Record<string, unknown>;
      if (!this.settings.taskViewPrefs.sorts.length &&
          typeof tvp.sortCol === "string" && (tvp.sortDir === "asc" || tvp.sortDir === "desc")) {
        this.settings.taskViewPrefs.sorts = [{ col: tvp.sortCol as SortKey, dir: tvp.sortDir }];
      }
      delete tvp.sortCol;
      delete tvp.sortDir;
    }
    this.settings.attachSkipped = [...(this.settings.attachSkipped || [])]; // DEFAULTS 배열 공유 참조 방지
    delete (this.settings as unknown as Record<string, unknown>)["attachmentExtensions"]; // 폐기(참조 기반 전환) — 예전 저장분이 계속 영속되지 않게 제거
    this.settings.teamTemplates = (this.settings.teamTemplates || []).map((tt) => ({ ...tt })); // DEFAULTS 배열 공유 참조 방지
    // 아카이브 경로 기본값 채우기(데스크탑만) — 빈 값이면 홈 아래 nanalStamp-archive-<vault>/
    // **이미 값이 있으면 절대 건드리지 않는다.** 옛 사용자의 경로를 바꾸면 그 repo 의 이력이
    // 안 보이게 되고, 아카이브는 원문 보관처라 잘못 옮기면 되돌리기 어렵다.
    if (!this.settings.archivePath && Platform.isDesktopApp) {
      try { this.settings.archivePath = defaultArchivePath(this.app.vault.getName()); } catch { /* Node 미가용 */ }
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
    // API 키가 바뀌면 거부 상태 해제(새 키로 재시도 허용)
    if (this.settings.apiKey !== this.lastApiKey) {
      this.lastApiKey = this.settings.apiKey;
      this.pastDueNotified = false; // 계정 전환 시 past_due 알림 가드 리셋
      this.authFailed = false;
      // ★ 업로드 색인은 **계정 귀속**이다(2026-07-30 원인 규명).
      //   nanalIndex 는 "이 경로의 이 해시를 올렸다"인데 **어느 계정 스토리지에** 올렸는지가
      //   빠져 있었다. 계정을 바꿔도 남아 있으니 "이미 올렸다"로 읽혀 새 계정 경로에는
      //   업로드가 스킵됐다 — 실측: 이 vault 에서 원문 누락 260건 중 225건이 이 경로였고,
      //   그 파일들은 **옛 계정 폴더(u/<옛uid>/)에 멀쩡히 있었다.**
      //   구독의 핵심이 원문 보관이라 이 누락은 제품이 성립하지 않는 문제다.
      //   비우면 스윕이 다시 올린다 — 같은 계정 경로에 이미 있으면 서버 exists 로 스킵되니
      //   실제 재업로드는 정말 없는 것만 일어난다.
      this.settings.nanalIndex = {};
      this.settings.mirrorIndex = {};   // GitHub 미러도 계정(연결) 귀속이라 같은 이유로 비운다
      this.settings.ledgerMtime = {};   // '안정' 마킹 해제 — 스윕이 전부 다시 보게
      this.dekCache.clear(); // Phase D: 계정 전환 시 이전 계정 DEK로 암·복호하지 않도록
      this.dekDeny.clear(); // 이전 계정의 410·일시 실패 backoff도 새 키에는 무효
      this.dekGoneNotified = false;
      this.states.clear(); // 세션 봉인 상태(lastHash)는 이전 계정 기준 — 남으면 새 계정 재봉인이 no-op(리뷰 지적)
      this.invalidateVerify(); // verify 캐시도 계정 귀속 — 이전 계정의 found 결과가 새 키 판정을 오염시키지 않게
      // §7b: 업무함 상태도 계정 귀속 — 미소속 플래그·스냅샷·명단 캐시 리셋(새 키로 재시도 허용)
      this.taskNotMember = false;
      this.taskSnapshot = null;
      this.taskRosterCache = null;
      // §3: 과제 캐시도 계정 귀속 — 목록·참여 판정·스킵 전부 리셋(다음 refreshProjects가 재수립)
      this.teamProjects = [];
      this.myProjectIds.clear();
      this.projectSyncSkip.clear();
      this.projectMemberCounts.clear();
      void this.refreshEntitlement();
    }
    void this.updateActiveStatus();
  }
}
























