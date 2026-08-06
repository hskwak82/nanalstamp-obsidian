// pluginbase.ts — 플러그인 클래스의 최하위 계층. main.ts에서 분리(2026-07-26).
//
// 왜 상속 체인인가: NanalStampPlugin은 멤버 241개가 `this`로 얽혀 있어(this.settings만 107개
// 멤버가 쓴다) 파일만 쪼갤 수 없다. 자유 함수로 빼면 모든 본문의 `this.` 를 고쳐 써야 해
// "순수 이동"이 깨진다. 추상 상속으로 나누면 **메서드 본문이 한 글자도 안 바뀐 채** 옮겨진다.
//
// 이 파일이 갖는 것: (1) 하위 계층이 공유하는 상태 (2) 하위 계층이 위(최종 클래스)를 부를 때
// 필요한 `abstract` 선언. 가시성은 원래 것을 그대로 유지한다(외부에서 쓰는 것은 public).
import { Plugin, TFile, RequestUrlResponse } from "obsidian";
import type { AttestSettings } from "./main";

export abstract class NanalStampBase extends Plugin {
  settings!: AttestSettings;
  /// 401/403 → 키 교체 전까지 봉인·전송 중단. 여러 계층이 이 값을 게이트로 쓰므로
  /// 최종 클래스가 아니라 기반에 둔다(하위 계층이 자식 필드를 볼 수는 없다).
  authFailed = false;
  nanalUploading = new Set<string>(); // v2a: 같은 파일의 청크 업로드가 재시도 인터벌과 겹치지 않게
  storageQuotaBackoffUntil = 0; // C1: 402(쿼터 초과) 후 1시간 presign 중단 — 30초 재시도 루프의 무의미한 402 방지
  dekCache = new Map<string, Promise<string | null>>(); // Phase D: "user" | "team" → DEK 조회 Promise(in-flight 공유 — 콜드 캐시 병렬 GET 중복 방지, 세션 메모리만·디스크 비저장)
  dekDeny = new Map<string, { until: number; gone: boolean }>(); // Phase D: DEK 네거티브 캐시 — 410(파기, gone)은 1시간, 일시 실패는 60초
  uploadProgress: { path: string; done: number; total: number } | null = null;

  // ── 하위 계층이 부르는 상위 구현 — 최종 클래스(NanalStampPlugin)가 채운다 ──
  abstract base(): string;
  abstract isPro(): boolean;
  /// 팀 루트 폴더 이름(팀 미소속이면 null). **팀 소속 여부의 판정**으로도 쓴다 —
  /// 팀이 없으면 `team_scope` 같은 팀 전용 필드를 아예 보내지 않는다(서버는 미상으로 둔다).
  abstract teamRoot(): string | null;
  protected abstract teamNanal(): boolean;
  /// 이 노트의 **원문·이름**을 팀 저장소에 둘 것인가. 경로마다 갈린다.
  /// `teamNanal()`(계정이 팀 custody 인가)와 다르다 — 그것만 보면 개인 폴더 노트까지
  /// 조직 저장소로 간다(2026-07-31 실측). 저장소·DEK 를 고르는 자리는 전부 이것을 쓴다.
  protected abstract teamBlobFor(path: string): boolean;
  /// 이 요청에 쓸 API 키. 팀 계정을 따로 연결했으면 팀 쪽 요청은 그 키로 나간다.
  /// **연결하지 않았으면 개인 키가 양쪽에 쓰인다** — 개인과 팀이 같은 계정인 사람은
  /// 아무것도 설정하지 않아도 지금까지와 똑같이 동작한다.
  protected abstract keyFor(team: boolean): string;
  /// 해시만 알고 경로를 모르는 요청은 양쪽 계정에 물어본다(팀 → 개인).
  protected abstract askBothAccounts<T>(run: (key: string) => Promise<T | null>): Promise<T | null>;
  protected abstract isBinary(file: TFile): boolean;
  protected abstract overUploadLimit(file: TFile): boolean;
  protected abstract maybeNoticeLargeUpload(file: TFile): void;
  protected abstract noteUploadSkip(file: TFile): Promise<void>;
  protected abstract clearUploadSkip(path: string): Promise<void>;
  protected abstract setUploadProgress(p: { path: string; done: number; total: number } | null): void;
  protected abstract fetchDek(k: string, team: boolean): Promise<string | null>;
  protected abstract requestWithOneRetry(req: () => Promise<RequestUrlResponse>): Promise<RequestUrlResponse | null>;

  // ── 아카이브 계층이 부르는 상위 구현 ──
  abstract dashInScope(p: string): boolean;
  abstract dashboardArchiveOn(): boolean;
  abstract mirrorActive(): boolean;
  // 반환값 = 실제로 생긴 폴더 수(2026-08-05, 자동 적용의 "N개 만들었습니다"용). 아카이브 계층은 안 쓴다.
  abstract ensureVaultFolder(folder: string): Promise<number>;
  abstract flush(file: TFile, reason: string): Promise<void>;
  abstract saveSettings(): Promise<void>;
  protected abstract hashOf(file: TFile, cached?: boolean): Promise<string>;
  protected abstract isDigestPath(path: string): boolean;
  protected abstract persist(): Promise<void>;
  protected abstract ensureGithubReadme(): Promise<void>;
  protected abstract githubPut(path: string, content: string | ArrayBuffer, message: string): Promise<boolean>;
  protected abstract proxyPut(path: string, content: string | ArrayBuffer): Promise<boolean>;
}
