// taskview.ts — 업무함(Work Inbox) Obsidian DOM 렌더 전담(§Task 6~, 2026-07-25).
// createEl 빌더만 사용(innerHTML 절대 금지). 순수 로직(통합·정렬·필터·그룹·보드)은 taskcore,
// 액션(모달·API 호출)은 WorkInboxActions 콜백으로 main.ts에 위임한다.
// i18n은 가변 `t`를 import하지 않고 렌더 시점 사전을 ctx.L로 주입받아 참조(섀도잉·staleness 방지).
import { Platform, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { PluginI18n } from "./i18n";
import { sortUnified, taskPasses, groupUnified, boardColumns, isOverdue, isUnread, dueKind, personDisplay, assigneeFilterKey, taskActionDefs } from "./taskcore";
import type { UnifiedTask, TaskType, TaskFilterState, SortKey, SortSpec, GroupBy, TaskGroup, BoardColumn, TaskActionKind } from "./taskcore";

export type ViewMode = "table" | "group" | "board" | "compact";

// settings.taskViewPrefs 형태(main.ts AttestSettings에도 동일 정의 — DEFAULTS 참조).
export interface TaskViewPrefs {
  view: ViewMode;
  sorts: SortSpec[];          // 다중 정렬(순서=우선순위, 빈 배열=기본 정렬: 완료 하단·마감초과 우선). 구 sortCol/sortDir는 loadSettings에서 1회 마이그레이션.
  groupBy: GroupBy;
  hideDone: boolean;
  filters: TaskFilterState;   // 담당·비고·시작일 포함(taskcore.TaskFilterState 확장분) — taskPasses 단독 판정.
  colWidths?: Record<string, number>; // 표 컬럼 폭(컬럼 키→px) — 드래그 리사이즈 결과 지속(§Task 12). 비어있으면 반응형 100%.
}

// 유형별 권한에 맞는 액션 콜백(모달·API는 main.ts가 소유 — 각 콜백 후 재조회).
export interface WorkInboxActions {
  accept(task: UnifiedTask): void;                    // received+requested — POST accept
  decline(task: UnifiedTask): void;                   // received+requested — TaskDeclineModal
  markDone(task: UnifiedTask, recall: boolean): void; // TaskDoneModal(recall=요청자 접수 전 회수 종결)
  request(task: UnifiedTask): void;                   // personal/declined — TaskRequestModal
  cancel(task: UnifiedTask): void;                    // sent+requested — POST cancel
  reopen(task: UnifiedTask): void;                    // done — TaskReopenModal(되돌리기)
  openNote(path: string): void;
  compose(): void;                                    // TaskComposeModal
  toggleThread(task: UnifiedTask): void;              // 카드 뷰 회신 스레드 펼침/접힘
  openDetail(task: UnifiedTask): void;                // 상세(설명·이력·완료 보고·회신) — 제목 클릭
  edit(task: UnifiedTask): void;                       // 우선순위·기간·과제·비고·담당자 수정(2026-07-29)
}

export interface WorkInboxCtx {
  app: App;
  host: HTMLElement;         // TaskInboxView.contentEl (empty 후 전달 — renderWorkInbox는 append만)
  unified: UnifiedTask[];    // main.ts에서 unifyTasks(inbox, mine) 결과
  myUid: string;             // 현재 사용자 uid — 보드 드래그 전이 권한(요청자/담당자) 판정용(§Task 9).
                             // 데이터에서 파생(inbox=assigneeUid·mine=creatorUid) — 빈 문자열이면 taskType으로 근사.
  today: string;             // YYYY-MM-DD
  wide: boolean;             // 리프가 중앙 편집 영역(rootSplit) 소속 && !Platform.isMobile (main.ts isWide()) — 폭 무관
  prefs: TaskViewPrefs;      // settings.taskViewPrefs (콜백에서 직접 변형 후 onPrefsChange)
  L: PluginI18n;             // 현재 번역 사전(t) — 섀도잉 방지 위해 주입
  onPrefsChange(): void;     // saveSettings + 전체 재렌더 트리거
  savePrefs(): void;         // prefs 저장만(전체 재렌더 없음) — 정렬·필터 라이브 편집용(팝오버·헤더 유지, 결과영역만 repaint)
  invalidateDone(): void;    // 완료 캐시 무효 — 완료 숨김 토글 시 main이 done 재조회하도록(Task 6 회귀 복구)
  actions: WorkInboxActions;
  // ── 배선 조정(Task 6) — 계획 시그니처엔 없던 실배선 보강 ──
  headerExtras: Array<{ label: string; short: string; onClick: () => void }>; // 킷/팀 폴더 등 부가 헤더 버튼(전제 충족 시 main이 채움). short=좁은 사이드바 헤더의 아이콘 아래 짧은 캡션(§3)
  renderCards(host: HTMLElement, list: UnifiedTask[]): void;    // 좁은 화면 카드 — 기존 카드 로직 재사용(Task 10에서 taskview로 이관 예정)
}

const VIEW_MODES: ViewMode[] = ["table", "group", "board", "compact"];
// 상단 유형 카테고리 세그먼트 옵션 — null=전체(필터 미적용), 나머지=단일 유형 필터(filters.types=[tt]).
const CATEGORY_OPTS: (TaskType | null)[] = [null, "received", "sent", "personal"];

function typeLabel(L: PluginI18n, tt: TaskType): string {
  return tt === "received" ? L.taskTypeReceived : tt === "sent" ? L.taskTypeSent : L.taskTypePersonal;
}
function categoryLabel(L: PluginI18n, c: TaskType | null): string {
  return c === null ? L.taskTypeAll : typeLabel(L, c);
}
// 현재 filters.types에서 선택 카테고리 파생 — 정확히 1개면 그 유형, 그 외(빈·미설정·복수)는 전체(null).
function currentCategory(f: TaskFilterState): TaskType | null {
  return f.types && f.types.length === 1 ? f.types[0] : null;
}
function viewModeLabel(L: PluginI18n, v: ViewMode): string {
  return v === "table" ? L.viewTable : v === "group" ? L.viewGroup : v === "board" ? L.viewBoard : L.viewCompact;
}
/// 상태가 **된 시각**(epoch 초) — 상태만 알면 "언제부터 그런지"를 알 수 없다(2026-07-26).
/// 반려는 전용 시각 필드가 없어 생략한다(updatedAt은 비고 수정 등으로도 움직여 오해를 만든다).
function statusStamp(task: UnifiedTask): number | null {
  switch (task.status) {
    case "requested": return task.requestedAt;
    case "accepted": return task.acceptedAt;
    case "done": return task.doneAt;
    default: return null;
  }
}

function statusPill(L: PluginI18n, task: UnifiedTask): { text: string; cls: string } {
  switch (task.status) {
    case "requested": return { text: L.taskStWait, cls: "is-wait" };
    case "accepted": return { text: L.taskStAcc, cls: "is-acc" };
    case "declined": return { text: L.taskStDeclined, cls: "is-declined" };
    case "done": return { text: L.taskStDone, cls: "is-done" };
    case "personal": return { text: L.taskStPersonal, cls: "is-personal" };
    default: return { text: task.status, cls: "is-personal" };
  }
}
function ymd(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// bare=true(표) — "마감" 접두 없이 날짜/상대만. 표는 컬럼 제목이 이미 "마감"이라 접두가 중복·폭 낭비.
// 카드·보드·컴팩트는 컬럼 제목이 없어 접두("마감 …")를 유지한다(bare=false).
function dueCell(L: PluginI18n, task: UnifiedTask, today: string, bare = false): { text: string; cls: string } {
  // 완료 행도 "마감" 컬럼이니 마감일(dueDate)을 보인다(완료일 doneAt 아님 — 마감 정렬 시 표시·순서 일치).
  if (task.status === "done") return { text: task.dueDate ? (bare ? task.dueDate : L.taskDueOn(task.dueDate)) : "—", cls: "is-ok" };
  const k = dueKind(task.dueDate, today);
  if (k === "none") return { text: bare ? "—" : L.taskDueNone, cls: "is-ok" };
  if (k === "today") return { text: bare ? L.taskDueTodayBare : L.taskDueToday, cls: "is-today" };
  if (k === "future") return { text: bare ? (task.dueDate as string) : L.taskDueOn(task.dueDate as string), cls: "is-ok" };
  const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(task.dueDate as string)) / 86400000));
  return { text: bare ? L.taskDueOverBare(days) : L.taskDueOver(days), cls: "is-overdue" };
}

// ── 팝오버 모듈 상태 — 한 번에 하나만. repaint는 정렬·필터 라이브 편집 시 결과영역만 다시 그린다. ──
let openPop: HTMLElement | null = null;
let popCleanup: (() => void) | null = null;
let repaint: (() => void) | null = null;
// export — main.ts onClose에서 leaf 닫힘 시 document capture 리스너 잔존 방지용으로 호출.
export function closePopover(): void { if (popCleanup) popCleanup(); }

// 헤더 버튼 빌더 — "＋ 새 요청"처럼 앞머리 기호 + 공백 + 텍스트를 아이콘 span과 라벨 span으로 분리한다.
// 넓은 헤더(중앙)에서는 풀 라벨을 그대로 쓴다. 좁은 사이드바(head.is-icononly)에서는 CSS가 풀 라벨(.label)을
// 숨기고, short가 주어지면 아이콘 아래 짧은 캡션(.short)을 세로로 노출한다(§3: 과제/팀 폴더 둘 다 📁라
// 아이콘만으론 구분 불가 → "과제"/"팀" 캡션으로 식별). short가 없으면 아이콘만 남고 title 툴팁이 뜻을 보존한다.
function headBtn(head: HTMLElement, full: string, onClick: () => void, short?: string): void {
  const sp = full.indexOf(" ");
  const icon = sp > 0 ? full.slice(0, sp) : "";
  const text = sp > 0 ? full.slice(sp + 1) : full;
  const b = head.createEl("button", { cls: "nanalstamp-task-new" });
  b.setAttribute("aria-label", text);
  b.setAttribute("title", text);
  if (icon) b.createSpan({ cls: "nanalstamp-task-btn-icon", text: icon });
  b.createSpan({ cls: "nanalstamp-task-btn-label", text: icon ? text : full });
  if (short) b.createSpan({ cls: "nanalstamp-task-btn-short", text: short });
  b.addEventListener("click", () => onClick());
}

// 진입점 — 헤더 + (넓은 화면) 뷰 세그먼트 + 결과 영역(툴바 칩·완료숨김 + 표/카드). 정렬·필터 편집은
// 결과 영역만 repaint 해 팝오버·헤더를 유지한다(전체 재렌더는 뷰 전환·완료숨김 토글만).
export function renderWorkInbox(ctx: WorkInboxCtx): void {
  closePopover(); // 이전 렌더의 팝오버 리스너 정리(전체 재렌더 시 host.empty로 요소는 사라지나 document 리스너는 남으므로)
  const { host, L } = ctx;

  // ── 헤더: 제목 + ＋ 새 업무 + (부가 버튼) ──
  // 좁은 사이드바(!wide)에서는 라벨 텍스트를 CSS로 숨겨 아이콘만 남긴다(is-icononly). 아이콘/라벨은
  // "＋ 새 요청"처럼 앞머리 기호 + 공백 + 텍스트로 오므로 첫 공백에서 분리한다(title 툴팁엔 텍스트 유지).
  const head = host.createDiv({ cls: "nanalstamp-task-head" + (ctx.wide ? "" : " is-icononly") });
  head.createSpan({ cls: "nanalstamp-task-head-emoji", text: "📥" });
  head.createSpan({ cls: "nanalstamp-task-head-title", text: L.taskInboxTitle });
  headBtn(head, L.taskNewBtn, () => ctx.actions.compose(), L.taskNewShort);
  for (const ex of ctx.headerExtras) headBtn(head, ex.label, ex.onClick, ex.short);

  // ── 유형 카테고리 세그먼트(전체·받음·보냄·개인, 단일 선택) — 뷰 무관 공통 필터라 모든 뷰·카드에서 노출.
  // 표 "유형" 컬럼을 대체(컬럼 제거). 선택은 prefs.filters.types에 반영(전체=미설정)하고, 세그 하이라이트가
  // 헤더 영역에 있어 결과영역 repaint로는 갱신되지 않으므로 뷰 세그먼트와 동일하게 전체 재렌더(onPrefsChange).
  const cur = currentCategory(ctx.prefs.filters);
  const catSeg = host.createDiv({ cls: "nanalstamp-tv-catseg" + (ctx.wide ? "" : " is-narrow") });
  for (const c of CATEGORY_OPTS) {
    const on = cur === c;
    const b = catSeg.createEl("button", { cls: "nanalstamp-tv-catseg-btn" + (on ? " is-on" : ""), text: categoryLabel(L, c) });
    b.addEventListener("click", () => {
      if (currentCategory(ctx.prefs.filters) === c) return;
      if (c === null) delete ctx.prefs.filters.types;
      else ctx.prefs.filters.types = [c];
      ctx.onPrefsChange();
    });
  }

  // 검색 — 이미 전건을 받아 두었으므로(main.fetchTasks가 커서를 끝까지 따라간다) 즉시 필터한다.
  // 컬럼 필터와 별개로 제목·설명·비고를 한 번에 훑는 입구다. 값은 prefs에 남겨 뷰 전환·재시작에도 유지.
  const searchRow = host.createDiv({ cls: "nanalstamp-tv-search" });
  const searchInput = searchRow.createEl("input", { cls: "nanalstamp-tv-search-input" });
  searchInput.type = "search";
  searchInput.placeholder = L.taskSearchPh;
  searchInput.value = ctx.prefs.filters.q ?? "";
  searchInput.addEventListener("input", () => {
    const v = searchInput.value.trim();
    if (v) ctx.prefs.filters.q = v; else delete ctx.prefs.filters.q;
    ctx.savePrefs();
    if (repaint) repaint();
  });

  // 넓은 화면에서만 뷰 선택 세그먼트(표/그룹/보드/컴팩트). 좁으면 카드 강제라 숨김.
  if (ctx.wide) {
    const seg = host.createDiv({ cls: "nanalstamp-tv-seg" });
    for (const v of VIEW_MODES) {
      const on = ctx.prefs.view === v;
      const b = seg.createEl("button", { cls: "nanalstamp-tv-seg-btn" + (on ? " is-on" : ""), text: viewModeLabel(L, v) });
      b.addEventListener("click", () => {
        if (ctx.prefs.view === v) return;
        ctx.prefs.view = v;
        ctx.onPrefsChange();
      });
    }
  }

  // ── 결과 영역 — 정렬/필터/완료숨김 편집 시 이 영역만 repaint(헤더·세그·팝오버 유지) ──
  const region = host.createDiv({ cls: "nanalstamp-tv-region" });
  const paint = (): void => {
    region.empty();
    // 표시 파이프라인: 필터(taskPasses — 담당·비고·시작일 포함) AND → 정렬(기본=완료 하단·마감초과 우선) → 완료 숨김.
    const f = ctx.prefs.filters;
    const filtered = ctx.unified.filter((tk) => taskPasses(tk, f, ctx.today));
    const sorted = sortUnified(filtered, ctx.prefs.sorts, ctx.today);
    const visible = ctx.prefs.hideDone ? sorted.filter((tk) => tk.status !== "done") : sorted;

    // 툴바: 완료 숨김 토글 + 정렬/필터 요약 칩(모두 지우기).
    renderToolbar(region, ctx, paint);

    const body = region.createDiv({ cls: "nanalstamp-task-scroll" });
    // 빈 상태 — 진짜 0건 vs 필터 결과 0건 구분.
    if (!visible.length) {
      if (!ctx.unified.length) {
        body.createEl("p", { cls: "nanalstamp-task-state", text: L.taskEmpty });
        body.createEl("p", { cls: "nanalstamp-task-state is-tip", text: L.taskEmptyTip });
      } else {
        body.createEl("p", { cls: "nanalstamp-task-state", text: L.taskEmptyFiltered });
      }
      return;
    }
    // 좁은 화면·모바일 → 카드(필터·완료숨김은 위에서 반영).
    if (!ctx.wide) { ctx.renderCards(body, visible); return; }
    // 넓은 화면 → prefs.view 분기.
    switch (ctx.prefs.view) {
      case "group":
        renderGroupView(body, groupUnified(visible, ctx.prefs.groupBy, ctx.today), ctx, paint);
        return;
      case "compact":
        renderCompactView(body, visible, ctx);
        return;
      case "board": {
        // 컬럼은 이미 필터·hideDone이 반영된 visible에서 분류(완료 숨김이면 done 컬럼 자체를 제외).
        let cols = boardColumns(visible, ctx.today);
        if (ctx.prefs.hideDone) cols = cols.filter((c) => c.status !== "done");
        renderBoardView(body, cols, ctx);
        return;
      }
      default: // table
        renderTableView(body, visible, ctx, paint);
        return;
    }
  };
  repaint = paint;
  paint();
}

// ── 툴바: 완료 숨김 토글 + 정렬 칩 + 필터 요약 칩(모두 지우기) ──
function renderToolbar(region: HTMLElement, ctx: WorkInboxCtx, paint: () => void): void {
  const { L } = ctx;
  const bar = region.createDiv({ cls: "nanalstamp-tv-toolbar" });

  // 완료 숨김 토글 — hideDone을 뒤집고 완료 캐시 무효 후 전체 재렌더(main이 done 로딩 경로 재평가).
  const hd = bar.createEl("button", {
    cls: "nanalstamp-tv-hidedone" + (ctx.prefs.hideDone ? " is-on" : ""),
    text: ctx.prefs.hideDone ? L.taskDoneShow : L.taskDoneHide,
  });
  hd.addEventListener("click", () => {
    ctx.prefs.hideDone = !ctx.prefs.hideDone;
    ctx.invalidateDone();
    ctx.onPrefsChange();
  });

  // 정렬 칩(다중, 활성 시) — "정렬: 상태 ↑ · 마감 ↓"처럼 sorts 순서대로. 옆에 "정렬 지우기".
  if (ctx.prefs.sorts.length) {
    const summary = ctx.prefs.sorts
      .map((s) => sortColLabel(L, s.col) + (s.dir === "asc" ? " ↑" : " ↓"))
      .join(" · ");
    bar.createSpan({ cls: "nanalstamp-tv-chip", text: L.sortLabel + ": " + summary });
    const clr = bar.createEl("button", { cls: "nanalstamp-tv-chip-clear", text: L.sortClear });
    clr.addEventListener("click", () => { ctx.prefs.sorts = []; ctx.savePrefs(); closePopover(); paint(); });
  }

  // 필터 요약 칩 + 모두 지우기.
  const n = countActiveFilters(ctx.prefs.filters);
  if (n) {
    bar.createSpan({ cls: "nanalstamp-tv-chip is-filter", text: L.filterSummary(n) });
    const clr = bar.createEl("button", { cls: "nanalstamp-tv-chip-clear", text: L.filterClearAll });
    clr.addEventListener("click", () => { ctx.prefs.filters = {}; ctx.savePrefs(); closePopover(); paint(); });
  }
}

// ── 노션식 표 뷰 — 업무·과제·우선순위·상태·시작일·마감·담당·처리·비고 + 정렬 헤더 + 컬럼 필터 ──
// 유형(받음/보냄/개인)은 표 컬럼이 아니라 상단 카테고리 세그먼트로 필터한다(renderWorkInbox) — 표 컬럼·정렬·필터 제거.
// key = 컬럼 폭 저장·리사이즈 식별자(정렬 SortKey와 문자열 일치하는 컬럼은 재사용, 정렬 없는 처리/비고는 전용 키).
interface ColSpec { key: string; label: string; sort?: SortKey; filter?: "multi" | "text" | "date"; fcol?: string; }
function tableCols(L: PluginI18n): ColSpec[] {
  return [
    { key: "title", label: L.thTitle, sort: "title", filter: "text", fcol: "title" },
    { key: "project", label: L.thProject, sort: "project", filter: "multi", fcol: "project" },
    { key: "priority", label: L.thPriority, sort: "priority", filter: "multi", fcol: "priority" },
    { key: "status", label: L.thStatus, sort: "status", filter: "multi", fcol: "status" },
    { key: "startDate", label: L.thStart, sort: "startDate", filter: "date", fcol: "startDate" },
    { key: "dueDate", label: L.thDue, sort: "dueDate", filter: "date", fcol: "dueDate" },
    { key: "assignee", label: L.thAssignee, sort: "assignee", filter: "multi", fcol: "assignee" },
    { key: "act", label: L.thAct },                                          // 처리 — 정렬·필터 없음
    { key: "memo", label: L.thMemo, filter: "text", fcol: "memo" },          // 비고 — 텍스트 필터만
  ];
}

// 컬럼 리사이즈 폭 하한(px) — 이 아래로는 내용을 못 읽어 더 줄이지 않는다(웹 table-resize.js와 동일 60).
const RESIZE_MIN_W = 60;
// 폭 미저장 컬럼의 폴백(px) — 사용자가 처음 드래그하면 실제 렌더 폭으로 씨딩되므로 안전망 용도.
const DEFAULT_COL_W: Record<string, number> = {
  title: 200, project: 120, priority: 90, status: 90,
  startDate: 110, dueDate: 110, assignee: 120, act: 140, memo: 160,
};

/// **초기 배치 폭**(2026-07-26) — 내용 폭이 사실상 정해진 컬럼은 처음부터 필요 최소폭으로 잡는다.
/// 그전에는 저장 폭이 하나도 없으면 col에 폭을 주지 않아 `table-layout:fixed`가 9개 컬럼을
/// **균등 분배**했고, 날짜·상태·우선순위처럼 내용이 짧은 칸이 제목만큼 넓어져 정작 제목이 잘렸다.
/// 값의 근거는 "헤더(라벨 + 정렬·필터 아이콘)와 최대 내용 중 넓은 쪽 + 셀 패딩 16px":
///   · priority·startDate — 헤더가 지배(우선순위 4자 / 시작일 3자 + 아이콘)
///   · status·assignee·act — 내용이 지배(뱃지 "접수 대기" / 이름 / 버튼 "완료 보고")
///   · dueDate — 날짜 10자에 "N일 지남"·볼드가 겹쳐 startDate보다 약간 넓다
/// 여기 없는 컬럼(title·memo)은 폭을 주지 않아 **남는 공간을 흡수**한다 — 표가 넓어질수록
/// 제목이 길어지는 것이 옳은 방향이다. 사용자가 드래그로 조절하면 그 값(colWidths)이 이긴다.
/// 값은 실사용자가 손으로 맞춰 쓰던 폭을 기준으로 잡았다(2026-07-26 실측: priority 78·status 71·
/// act 82·startDate/dueDate 100·assignee 98·project 109). 계산으로 뽑은 추정치보다 좁았고,
/// 그쪽이 실제 렌더 결과이므로 소폭 여유만 얹어 따른다 — 넓게 잡아 남는 것보다 제목에 주는 편이 낫다.
const INITIAL_FIXED_COL_W: Record<string, number> = {
  project: 100, priority: 80, status: 92, startDate: 100, dueDate: 100, assignee: 96, act: 88,
  // 비고도 고정 쪽이다. 빼두면 남는 공간을 제목과 **균등 분배**해(실측 178/178) 대개 "—"뿐인 칸이
  // 제목만큼 넓어진다 — 잔여는 제목 하나가 가져가는 것이 옳다(사용자 실측 127에 맞춤).
  memo: 124,
};

function renderTableView(root: HTMLElement, list: UnifiedTask[], ctx: WorkInboxCtx, paint: () => void): void {
  const wrap = root.createDiv({ cls: "nanalstamp-tv-tablewrap" });
  const table = wrap.createEl("table", { cls: "nanalstamp-tv-table" });
  const cols = tableCols(ctx.L);

  // colgroup — table-layout:fixed의 컬럼 폭 제어면. 저장 폭이 하나라도 있으면 전 컬럼을 명시 px + 표 폭=합계로
  // 확정(넓히면 표가 커져 tablewrap이 가로 스크롤). 저장 폭이 없으면 col에 폭을 주지 않아 기존 반응형(width:100%) 유지.
  const colgroup = table.createEl("colgroup");
  const colEls = cols.map(() => colgroup.createEl("col"));
  const cw = ctx.prefs.colWidths ?? {};
  const hasCustom = Object.keys(cw).length > 0;
  if (hasCustom) applyColWidths(cols, colEls, table, cw);
  // 저장 폭이 없을 때도 고정 성격 컬럼은 최소폭을 명시한다(표 폭은 건드리지 않아 100% 반응형 유지).
  else cols.forEach((c, i) => { const w = INITIAL_FIXED_COL_W[c.key]; if (w) colEls[i].style.width = w + "px"; });

  const thr = table.createEl("thead").createEl("tr");
  const ths = cols.map((c) => renderHeaderCell(thr, c, ctx, paint));
  // 리사이즈 핸들 — 넓은 화면(중앙 탭)에서만. ths 전체를 모은 뒤 바인딩(씨딩이 모든 th 실측 폭을 필요로 함).
  if (ctx.wide) cols.forEach((c, i) => addResizeHandle(ths[i], i, cols, colEls, ths, table, ctx));

  const tbody = table.createEl("tbody");
  for (const task of list) renderTableRow(tbody, task, ctx);
}

// 저장 폭(px)을 col 요소와 표 폭에 반영 — 폭 없는 컬럼은 DEFAULT_COL_W 폴백. 표 폭=명시 폭 합계라
// 컬럼을 넓히면 표가 컨테이너를 넘어 tablewrap(overflow-x:auto)이 가로 스크롤한다.
function applyColWidths(cols: ColSpec[], colEls: HTMLElement[], table: HTMLElement, cw: Record<string, number>): void {
  let sum = 0;
  cols.forEach((c, i) => {
    const w = cw[c.key] ?? DEFAULT_COL_W[c.key] ?? 120;
    colEls[i].style.width = w + "px";
    sum += w;
  });
  table.style.width = sum + "px";
}

// th 우측 경계의 드래그 리사이즈 핸들 — pointer 이벤트. 정렬(click)·필터(▾)와 충돌 방지:
// pointerdown에서 stopPropagation, 핸들 자체 click도 stopPropagation해 th 정렬 클릭으로 새지 않게 한다.
// 실제 이동이 있을 때만(onMove) 명시 폭으로 전환(단순 클릭은 표를 건드리지 않음). document 리스너는 up에서 확실히 제거.
function addResizeHandle(
  th: HTMLElement, idx: number, cols: ColSpec[], colEls: HTMLElement[],
  ths: HTMLElement[], table: HTMLElement, ctx: WorkInboxCtx,
): void {
  const handle = th.createDiv({ cls: "nanalstamp-col-resize-handle" });
  handle.setAttribute("aria-hidden", "true");
  handle.addEventListener("click", (e) => { e.stopPropagation(); }); // 드래그 후 발생하는 click이 정렬로 새지 않게
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation(); // th 정렬 핸들러(click) 및 텍스트 선택 억제
    const key = cols[idx].key;
    const startX = (e as PointerEvent).clientX;
    const cwMap = ctx.prefs.colWidths ?? (ctx.prefs.colWidths = {});
    const measured = () => Math.max(RESIZE_MIN_W, Math.round(th.getBoundingClientRect().width));
    const startW = cwMap[key] != null ? cwMap[key] : measured();
    let seeded = false;
    const seed = (): void => {
      if (seeded) return;
      // 미저장 컬럼을 실측 폭으로 씨딩 → 이후 전 컬럼 명시 px(표 폭 확정). 시각상 현재 레이아웃과 동일하게 시작.
      cols.forEach((c, i) => { if (cwMap[c.key] == null) cwMap[c.key] = Math.max(RESIZE_MIN_W, Math.round(ths[i].getBoundingClientRect().width)); });
      seeded = true;
      handle.addClass("is-dragging");
      document.body.addClass("nanalstamp-col-resizing");
    };
    const onMove = (ev: PointerEvent): void => {
      seed();
      cwMap[key] = Math.max(RESIZE_MIN_W, Math.round(startW + (ev.clientX - startX)));
      applyColWidths(cols, colEls, table, cwMap);
    };
    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      if (seeded) {
        handle.removeClass("is-dragging");
        document.body.removeClass("nanalstamp-col-resizing");
        ctx.savePrefs(); // DOM은 이미 최신 — 저장만(전체 재렌더 없이 폭 유지). 다음 재렌더는 hasCustom 경로로 복원.
      }
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
  });
}

// ── 그룹 뷰(§Task 8) — 그룹 기준 셀렉트 + 그룹별 소표(공용 표 렌더 재사용) + 접기(세션 Set) ──
const GROUP_BY_OPTS: GroupBy[] = ["status", "type", "assignee", "project"];
// 접힘 상태 — 모듈 세션 유지(전체 재렌더·repaint에도 접힘 보존). key=`${groupBy}:${groupKey}`(축 간 키 충돌 방지).
const collapsedGroups = new Set<string>();

function groupByOptLabel(L: PluginI18n, by: GroupBy): string {
  return by === "status" ? L.thStatus : by === "type" ? L.thType : by === "assignee" ? L.thAssignee : L.thProject;
}
// 그룹 헤더 라벨 — status/type 토큰은 i18n, assignee/project는 데이터 파생 라벨(빈 버킷은 "(비어 있음)").
function groupHeaderLabel(L: PluginI18n, by: GroupBy, g: TaskGroup): string {
  if (by === "status") return statusTokenLabel(L, g.key);
  if (by === "type") return typeLabel(L, g.key as TaskType);
  return g.label || L.groupEmpty;
}
// 색 점 — status 축은 상태 pill 색과 동일 테마 변수, 그 외 축은 중립(하드코딩 hex 금지).
function groupDotColor(by: GroupBy, key: string): string {
  if (by !== "status") return "var(--text-muted)";
  switch (key) {
    case "requested": return "var(--color-yellow)";
    case "accepted": return "var(--color-blue)";
    case "done": return "var(--color-green)";
    case "declined": return "var(--color-red)";
    default: return "var(--text-muted)"; // personal·canceled 등
  }
}

function renderGroupView(root: HTMLElement, groups: TaskGroup[], ctx: WorkInboxCtx, paint: () => void): void {
  const { L } = ctx;
  // 그룹 기준 셀렉트 — 변경 시 재그룹핑(전체 재렌더). 접힘 Set은 모듈 세션이라 유지.
  const bar = root.createDiv({ cls: "nanalstamp-tv-groupbar" });
  bar.createSpan({ cls: "nanalstamp-tv-muted", text: L.groupByLabel });
  const sel = bar.createEl("select", { cls: "nanalstamp-tv-groupsel" });
  for (const by of GROUP_BY_OPTS) {
    const o = sel.createEl("option", { text: groupByOptLabel(L, by) });
    o.value = by;
  }
  sel.value = ctx.prefs.groupBy;
  sel.addEventListener("change", () => {
    ctx.prefs.groupBy = sel.value as GroupBy;
    ctx.onPrefsChange();
  });

  if (!groups.length) {
    root.createEl("p", { cls: "nanalstamp-task-state", text: L.taskEmptyFiltered });
    return;
  }

  const wrap = root.createDiv({ cls: "nanalstamp-tv-groups" });
  for (const g of groups) {
    const ckey = ctx.prefs.groupBy + ":" + g.key;
    const collapsed = collapsedGroups.has(ckey);
    const section = wrap.createDiv({ cls: "nanalstamp-tv-group" });
    // 그룹 헤더 — 접기 토글(캐럿) + 색 점 + 라벨 + 건수.
    const header = section.createDiv({ cls: "nanalstamp-tv-group-head" + (collapsed ? " is-collapsed" : "") });
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.createSpan({ cls: "nanalstamp-tv-group-caret", text: collapsed ? "▸" : "▾" });
    const dot = header.createSpan({ cls: "nanalstamp-tv-group-dot" });
    dot.style.background = groupDotColor(ctx.prefs.groupBy, g.key);
    header.createSpan({ cls: "nanalstamp-tv-group-label", text: groupHeaderLabel(L, ctx.prefs.groupBy, g) });
    header.createSpan({ cls: "nanalstamp-tv-group-count", text: String(g.items.length) });
    const toggle = (): void => {
      if (collapsedGroups.has(ckey)) collapsedGroups.delete(ckey); else collapsedGroups.add(ckey);
      closePopover();
      paint();
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    // 그룹 본문 — 공용 표 렌더 재사용(헤더 정렬 클릭이 prefs 정렬로 동작). 접힘 시 생략.
    if (!collapsed) {
      const bodyList = sortUnified(g.items, ctx.prefs.sorts, ctx.today);
      renderTableView(section.createDiv({ cls: "nanalstamp-tv-group-body" }), bodyList, ctx, paint);
    }
  }
}

// ── 컴팩트 뷰(§Task 8) — 제목·유형·마감·상태만 한 줄, 조밀. 마감초과·완료 강조 ──
function renderCompactView(root: HTMLElement, list: UnifiedTask[], ctx: WorkInboxCtx): void {
  const { L } = ctx;
  const wrap = root.createDiv({ cls: "nanalstamp-tv-compact" });
  for (const task of list) {
    const overdue = isOverdue(task, ctx.today);
    const row = wrap.createDiv({
      cls: "nanalstamp-tv-compact-row" + (overdue ? " is-overdue" : "") + (task.status === "done" ? " is-done" : ""),
    });
    // 제목(연결 노트 있으면 클릭·키보드로 열기).
    if (isUnread(task)) row.createSpan({ cls: "nanalstamp-unread-dot", attr: { "aria-label": L.taskUnread } });
    const titleEl = row.createSpan({ cls: "nanalstamp-tv-compact-title is-link", text: task.title });
    titleEl.title = L.taskDetailOpenHint;
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    const openDetail = () => ctx.actions.openDetail(task);   // 표와 동일 — 제목은 항상 상세를 연다
    titleEl.addEventListener("click", openDetail);
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });
    // 유형 pill.
    row.createSpan({ cls: "nanalstamp-tv-type is-" + task.taskType, text: typeLabel(L, task.taskType) });
    // 마감(초과=빨강·오늘=노랑).
    const due = dueCell(L, task, ctx.today);
    row.createSpan({ cls: "nanalstamp-task-due " + due.cls, text: due.text });
    // 상태 pill.
    const st = statusPill(L, task);
    row.createSpan({ cls: "nanalstamp-task-st " + st.cls, text: st.text });
  }
}

// ── 보드(칸반) 뷰(§Task 9) — 상태 컬럼(requested·accepted·personal·declined·done) 가로 배치 + 세로 카드
// 스택 + 데스크톱 드래그 상태 전이. 드래그 허용 전이는 서버 게이트(team_tasks.rs)와 1:1(dragTargetsFor).
// 모바일(Platform.isMobile)은 드래그 미바인딩 — 카드의 액션 버튼이 모든 기기 공통 1차 경로다.

// 드래그 진행 상태 — dragstart~dragend 동안만 유지(동시 드래그 없음). 모듈 스코프라 repaint 사이 안전.
let boardDrag: { task: UnifiedTask; el: HTMLElement } | null = null;

// 드래그 목표 판정 — 현재 사용자의 요청자/담당자 역할별 유효 전이만 반환(빈 map = 드래그 불가).
// myUid가 있으면 uid 정확 비교(자기할당 시 요청자·담당자 동시 가능), 없으면 taskType으로 근사
// (received=담당자, sent/personal=요청자). 자기할당의 "회수 종결"은 근사 시 누락될 수 있음(허용 열화).
function dragTargetsFor(t: UnifiedTask, myUid: string, a: WorkInboxActions): Record<string, (card: HTMLElement) => void> {
  const isCreator = myUid ? t.creatorUid === myUid : t.taskType !== "received";
  const isAssignee = myUid ? (!!t.assigneeUid && t.assigneeUid === myUid) : t.taskType === "received";
  const targets: Record<string, (card: HTMLElement) => void> = {};
  if (t.status === "requested") {
    if (isAssignee) {
      targets.accepted = () => a.accept(t);   // 담당자 접수(API 직접)
      targets.declined = () => a.decline(t);  // 담당자 반려(사유 모달)
    }
    if (isCreator) targets.done = () => a.markDone(t, true);   // 요청자 회수 종결(모달, recall)
  } else if (t.status === "accepted") {
    if (isCreator || isAssignee) targets.done = () => a.markDone(t, false); // 완료 보고(모달)
  } else if (t.status === "declined") {
    if (isCreator) targets.requested = () => a.request(t);     // 요청자 재요청(마감 재확인 모달)
  } else if (t.status === "done") {
    // done → 되돌리기(reopen): 열린 컬럼(접수 대기·진행 중)에 드롭하면 reopen — 서버가 이전 상태로
    // 복원하므로 드롭 컬럼과 무관하게 동일 콜백. 권한은 서버 reopen(is_creator || is_doer)과 1:1이며
    // myUid 없을 땐 taskActionDefs의 reopen 게이트(received면 doneBy===assigneeUid, 그 외 항상)를 재사용.
    const canReopen = myUid
      ? (isCreator || (!!t.doneBy && t.doneBy === myUid))
      : (t.taskType === "received" ? (t.doneBy != null && t.doneBy === t.assigneeUid) : true);
    if (canReopen) {
      targets.requested = () => a.reopen(t);
      targets.accepted = () => a.reopen(t);
    }
  }
  // personal·canceled, done→done → 드래그 아웃 없음(담당자 지정 등은 별도 경로).
  return targets;
}

function highlightDropOk(col: HTMLElement, on: boolean): void {
  col.toggleClass("is-drop-ok", on);
  col.style.outline = on ? "2px dashed var(--interactive-accent)" : "";
  col.style.outlineOffset = on ? "-2px" : "";
}
function highlightDropOver(col: HTMLElement, on: boolean): void {
  col.toggleClass("is-drop-over", on);
  col.style.background = on ? "color-mix(in srgb, var(--interactive-accent) 14%, transparent)" : "";
}
function clearBoardHighlight(board: HTMLElement): void {
  board.removeClass("is-drag-active");
  board.querySelectorAll(".nanalstamp-tv-board-col").forEach((c) => {
    highlightDropOk(c as HTMLElement, false);
    highlightDropOver(c as HTMLElement, false);
  });
}

function renderBoardView(root: HTMLElement, cols: BoardColumn[], ctx: WorkInboxCtx): void {
  const { L } = ctx;
  const canDrag = !Platform.isMobile;   // 보드는 넓은 화면 전용이나 넓은 태블릿(isMobile)에선 드래그 비활성.
  const board = root.createDiv({ cls: "nanalstamp-tv-board" });
  for (const col of cols) {
    const colEl = board.createDiv({ cls: "nanalstamp-tv-board-col" });
    colEl.dataset.status = col.status;
    // 컬럼 헤더 — 색 점 + 상태 라벨(i18n) + 건수.
    const head = colEl.createDiv({ cls: "nanalstamp-tv-board-head" });
    const dot = head.createSpan({ cls: "nanalstamp-tv-group-dot" });
    dot.style.background = groupDotColor("status", col.status);
    head.createSpan({ cls: "nanalstamp-tv-board-name", text: statusTokenLabel(L, col.status) });
    head.createSpan({ cls: "nanalstamp-tv-board-count", text: String(col.items.length) });
    // 카드 스택.
    const listEl = colEl.createDiv({ cls: "nanalstamp-tv-board-list" });
    if (!col.items.length) {
      listEl.createEl("p", { cls: "nanalstamp-tv-muted nanalstamp-tv-board-empty", text: L.boardColEmpty });
    } else {
      for (const task of col.items) {
        const card = renderBoardCard(listEl, task, ctx);
        if (canDrag && Object.keys(dragTargetsFor(task, ctx.myUid, ctx.actions)).length) {
          bindBoardCardDrag(card, task, board, ctx);
        }
      }
    }
    if (canDrag) bindBoardColDrop(colEl, board, ctx);
  }
}

function renderBoardCard(listEl: HTMLElement, task: UnifiedTask, ctx: WorkInboxCtx): HTMLElement {
  const { L } = ctx;
  const overdue = isOverdue(task, ctx.today);
  const card = listEl.createDiv({
    cls: "nanalstamp-tv-card" + (overdue ? " is-overdue" : "") + (task.status === "done" ? " is-done" : ""),
  });
  // 제목 행 — 우선순위 점(테마 색) + 제목(연결 노트 열기).
  const titleRow = card.createDiv({ cls: "nanalstamp-tv-card-title" });
  if (isUnread(task)) titleRow.createSpan({ cls: "nanalstamp-unread-dot", attr: { "aria-label": L.taskUnread } });
  titleRow.createSpan({ cls: "nanalstamp-task-pill is-" + (task.priority || "week") + " nanalstamp-tv-card-pdot", text: L.taskPriLabel[task.priority] ?? task.priority });
  const titleEl = titleRow.createSpan({ cls: "nanalstamp-tv-card-name", text: task.title });
  if (task.linkedNotePath) {
    const path = task.linkedNotePath;
    titleEl.addClass("is-link");
    titleEl.title = path;
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    const open = () => ctx.actions.openNote(path);
    titleEl.addEventListener("click", open);
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
  // 메타 행 — 유형 pill + 과제 태그 + 담당.
  const meta = card.createDiv({ cls: "nanalstamp-tv-card-meta" });
  meta.createSpan({ cls: "nanalstamp-tv-type is-" + task.taskType, text: typeLabel(L, task.taskType) });
  if (task.projectName) meta.createSpan({ cls: "nanalstamp-tv-tag", text: task.projectName });
  if (task.assigneeUid || task.assigneeEmail) {
    const who = meta.createSpan({ cls: "nanalstamp-tv-muted", text: personDisplay(task.assigneeName, task.assigneeEmail) });
    if (task.assigneeEmail) who.title = task.assigneeEmail;
  }
  // 마감(초과=빨강·오늘=노랑).
  const due = dueCell(L, task, ctx.today);
  card.createDiv({ cls: "nanalstamp-tv-card-due" }).createSpan({ cls: "nanalstamp-task-due " + due.cls, text: due.text });
  // 액션 버튼(표와 동일 권한 매트릭스 재사용 — 단일 소스).
  renderRowActions(card.createDiv({ cls: "nanalstamp-tv-card-act" }), task, ctx);
  return card;
}

// HTML5 드래그 — 데스크톱 마우스 전용(모바일 터치 draggable 미지원). 성공·실패 모두 카드를 수동 이동하지
// 않는다 — 액션 콜백의 refresh(또는 재렌더)가 서버 진실값으로 카드를 옮기고, 부적격·레이스면 원위치 유지.
function bindBoardCardDrag(card: HTMLElement, task: UnifiedTask, board: HTMLElement, ctx: WorkInboxCtx): void {
  card.setAttribute("draggable", "true");
  card.addEventListener("dragstart", (e) => {
    const targets = dragTargetsFor(task, ctx.myUid, ctx.actions);
    if (!Object.keys(targets).length) { e.preventDefault(); return; } // 재렌더 사이 상태 레이스 방어
    boardDrag = { task, el: card };
    card.addClass("is-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", task.id); } catch (_e) { /* 일부 환경 setData 실패해도 드래그 계속 */ }
    }
    board.addClass("is-drag-active");
    board.querySelectorAll(".nanalstamp-tv-board-col").forEach((c) => {
      const st = (c as HTMLElement).dataset.status;
      if (st && targets[st]) highlightDropOk(c as HTMLElement, true);
    });
  });
  card.addEventListener("dragend", () => {
    card.removeClass("is-dragging");
    clearBoardHighlight(board);
    boardDrag = null;
  });
}

function bindBoardColDrop(colEl: HTMLElement, board: HTMLElement, ctx: WorkInboxCtx): void {
  const status = colEl.dataset.status || "";
  colEl.addEventListener("dragover", (e) => {
    if (!boardDrag) return;
    if (!dragTargetsFor(boardDrag.task, ctx.myUid, ctx.actions)[status]) return; // 유효 컬럼만 드롭 허용
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    highlightDropOver(colEl, true);
  });
  colEl.addEventListener("dragleave", () => highlightDropOver(colEl, false));
  colEl.addEventListener("drop", (e) => {
    if (!boardDrag) return;
    const handler = dragTargetsFor(boardDrag.task, ctx.myUid, ctx.actions)[status];
    if (!handler) return;
    e.preventDefault();
    highlightDropOver(colEl, false);
    handler(boardDrag.el);   // API 직접 또는 모달 — 재렌더가 카드 위치를 서버 진실값으로 확정
  });
}

function renderHeaderCell(thr: HTMLElement, c: ColSpec, ctx: WorkInboxCtx, paint: () => void): HTMLElement {
  const th = thr.createEl("th");
  const label = th.createSpan({ cls: "nanalstamp-tv-th-label", text: c.label });
  if (c.sort) bindSortHeader(th, label, c.sort, ctx, paint);
  if (c.filter && c.fcol) {
    const active = isColFilterActive(ctx.prefs.filters, c.fcol);
    // 필터 아이콘 = lucide "filter"(깔때기) — /team .th-filter와 동일 취지. 정렬 화살표(↑↓)와 모양이
    // 겹치지 않게 방향 화살표 대신 깔때기를 쓴다. 비활성은 은은(CSS), 활성은 accent(.is-on, CSS).
    const fi = th.createSpan({ cls: "nanalstamp-tv-filter" + (active ? " is-on" : "") });
    setIcon(fi, "filter");
    fi.setAttribute("role", "button");
    fi.setAttribute("tabindex", "0");
    fi.title = ctx.L.filterOpen;
    fi.setAttribute("aria-label", ctx.L.filterOpen);
    const open = () => openFilterPopover(c.fcol as string, c.filter as "multi" | "text" | "date", fi, ctx);
    fi.addEventListener("click", (e) => { e.stopPropagation(); open(); }); // 정렬 클릭과 분리
    fi.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); } });
  }
  return th;
}

// 다중 정렬 헤더 — 클릭 시 sorts에서 해당 col을 찾아 없으면 push(asc, 맨 뒤=최하위 우선순위),
// asc면 desc로, desc면 그 항목 제거. 여러 컬럼 누적 = 다중(추가 순서가 1차·2차 tiebreak…).
// 걸린 컬럼 헤더엔 순서 번호(1-based) + 방향 화살표를 표시(예: "1 ↑", "2 ↓"). paint()가 헤더까지
// 재그림하므로 순서·방향 표시가 즉시 갱신된다. done은 정렬 지정 시 기준대로 섞임(sortUnified 계약).
function bindSortHeader(th: HTMLElement, arrowHost: HTMLElement, col: SortKey, ctx: WorkInboxCtx, paint: () => void): void {
  th.addClass("is-sortable");
  const idx = ctx.prefs.sorts.findIndex((s) => s.col === col);
  if (idx !== -1) {
    const dir = ctx.prefs.sorts[idx].dir;
    arrowHost.createSpan({ cls: "nanalstamp-tv-arrow", text: " " + (idx + 1) + (dir === "asc" ? " ↑" : " ↓") });
  }
  th.addEventListener("click", () => {
    const sorts = ctx.prefs.sorts;
    const i = sorts.findIndex((s) => s.col === col);
    if (i === -1) sorts.push({ col, dir: "asc" });   // 새 컬럼 = 맨 뒤(최하위 우선순위)로 누적
    else if (sorts[i].dir === "asc") sorts[i].dir = "desc";
    else sorts.splice(i, 1);                          // desc → 제거
    ctx.savePrefs();
    closePopover();
    paint();
  });
}

// ── 컬럼 필터 — 멀티체크(유형·상태·우선순위·과제·담당)·텍스트(업무·비고)·날짜 범위(시작·마감) ──
type MultiField = "types" | "statuses" | "priorities" | "projects" | "assignees";
function multiField(fcol: string): MultiField {
  return fcol === "type" ? "types" : fcol === "status" ? "statuses" : fcol === "priority" ? "priorities" : fcol === "project" ? "projects" : "assignees";
}
function isColFilterActive(f: TaskFilterState, fcol: string): boolean {
  switch (fcol) {
    case "title": return !!f.titleText;
    case "memo": return !!f.memoText;
    case "startDate": return !!(f.startFrom || f.startTo);
    case "dueDate": return !!(f.dueFrom || f.dueTo);
    default: { const a = f[multiField(fcol)]; return !!(a && a.length); }
  }
}
function clearColFilter(f: TaskFilterState, fcol: string): void {
  switch (fcol) {
    case "title": delete f.titleText; break;
    case "memo": delete f.memoText; break;
    case "startDate": delete f.startFrom; delete f.startTo; break;
    case "dueDate": delete f.dueFrom; delete f.dueTo; break;
    default: delete f[multiField(fcol)]; break;
  }
}
function countActiveFilters(f: TaskFilterState): number {
  let n = 0;
  for (const k of ["types", "statuses", "priorities", "projects", "assignees"] as const) { const a = f[k]; if (a && a.length) n++; }
  if (f.titleText) n++;
  if (f.memoText) n++;
  if (f.dueFrom || f.dueTo) n++;
  if (f.startFrom || f.startTo) n++;
  if (f.overdue) n++;
  return n;
}

const STATUS_OPT_ORDER = ["requested", "accepted", "personal", "declined", "done", "canceled"];
const PRIORITY_OPT_ORDER = ["now", "week", "ref"];
const TYPE_OPT_ORDER: TaskType[] = ["received", "sent", "personal"];

// 현재 목록에서 컬럼의 고유값 추출(멀티체크 옵션). value=매칭 키, label=데이터 파생 라벨(토큰은 optDisplay가 i18n).
function collectDistinct(unified: UnifiedTask[], col: "status" | "priority" | "project" | "assignee" | "type"): { value: string; label: string }[] {
  const map = new Map<string, string>();
  for (const t of unified) {
    let value = "", label = "";
    switch (col) {
      case "type": value = t.taskType; label = t.taskType; break;
      case "status": value = t.status; label = t.status; break;
      case "priority": value = t.priority || "week"; label = value; break;
      case "project": value = t.projectId ? String(t.projectId) : ""; label = value ? (t.projectName || value) : ""; break;
      case "assignee": value = assigneeFilterKey(t); label = value ? personDisplay(t.assigneeName, t.assigneeEmail) : ""; break;
    }
    if (!map.has(value)) map.set(value, label);
  }
  const arr = Array.from(map, ([value, label]) => ({ value, label }));
  const idx = (order: string[], v: string) => { const i = order.indexOf(v); return i === -1 ? order.length : i; };
  if (col === "type") arr.sort((a, b) => idx(TYPE_OPT_ORDER, a.value) - idx(TYPE_OPT_ORDER, b.value));
  else if (col === "status") arr.sort((a, b) => idx(STATUS_OPT_ORDER, a.value) - idx(STATUS_OPT_ORDER, b.value));
  else if (col === "priority") arr.sort((a, b) => idx(PRIORITY_OPT_ORDER, a.value) - idx(PRIORITY_OPT_ORDER, b.value));
  else arr.sort((a, b) => (a.value === "" ? 1 : 0) - (b.value === "" ? 1 : 0) || a.label.localeCompare(b.label, "ko"));
  return arr;
}
// 멀티체크 옵션 표시 라벨 — 토큰(유형·상태·우선순위)은 i18n, 데이터(과제·담당)는 파생 라벨(빈 버킷은 안내 문구).
function optDisplay(fcol: string, value: string, dataLabel: string, L: PluginI18n): string {
  switch (fcol) {
    case "type": return typeLabel(L, value as TaskType);
    case "status": return statusTokenLabel(L, value);
    case "priority": return L.taskPriLabel[value] ?? value;
    case "project": return dataLabel || L.taskProjectNone;
    case "assignee": return dataLabel || L.filterAssigneeNone;
    default: return dataLabel || value;
  }
}
function statusTokenLabel(L: PluginI18n, s: string): string {
  switch (s) {
    case "requested": return L.taskStWait;
    case "accepted": return L.taskStAcc;
    case "declined": return L.taskStDeclined;
    case "done": return L.taskStDone;
    case "personal": return L.taskStPersonal;
    default: return s;
  }
}
function sortColLabel(L: PluginI18n, col: SortKey): string {
  switch (col) {
    case "title": return L.thTitle;
    case "type": return L.thType;
    case "project": return L.thProject;
    case "priority": return L.thPriority;
    case "status": return L.thStatus;
    case "startDate": return L.thStart;
    case "dueDate": return L.thDue;
    case "assignee": return L.thAssignee;
  }
}

// createEl 팝오버(innerHTML 금지) — Obsidian 뷰(host) 내부에 fixed 배치해 컬럼 스크롤 클리핑을 피하고,
// 바깥클릭·Esc로 닫는다. 편집은 prefs.filters 갱신 + savePrefs + repaint(팝오버는 유지).
function openFilterPopover(fcol: string, kind: "multi" | "text" | "date", anchor: HTMLElement, ctx: WorkInboxCtx): void {
  closePopover();
  // 겉모양은 전부 styles.css 의 .nanalstamp-tv-pop 이 갖는다(2026-08-11 심사 대응으로 이동 —
  // 원래 주석에 적혀 있던 "시각 마감은 클래스로" 계획을 그대로 마쳤다). 위치는 아래 setCssStyles.
  const pop = ctx.host.createDiv({ cls: "nanalstamp-tv-pop is-" + kind });

  if (kind === "multi") buildMultiPop(pop, fcol, ctx);
  else if (kind === "text") buildTextPop(pop, fcol, ctx);
  else buildDatePop(pop, fcol, ctx);

  const clr = pop.createEl("button", { cls: "nanalstamp-tv-pop-clear", text: ctx.L.filterClear });
  clr.addEventListener("click", () => { clearColFilter(ctx.prefs.filters, fcol); ctx.savePrefs(); closePopover(); repaint?.(); });

  positionPopover(pop, anchor);

  const onDoc = (e: MouseEvent): void => {
    const tgt = e.target as Node;
    if (pop.contains(tgt) || anchor.contains(tgt) || anchor === tgt) return;
    closePopover();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); closePopover(); } };
  // 여는 클릭이 곧바로 바깥클릭으로 잡혀 닫히지 않게 다음 틱에 등록.
  window.setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
  document.addEventListener("keydown", onKey, true);
  popCleanup = () => {
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    // 접근성 — 팝오버 내부에 포커스가 있던 채로 닫히면(Esc·지우기 등) anchor(필터 아이콘)로 복원.
    const restore = pop.contains(document.activeElement);
    pop.remove();
    if (restore) { try { anchor.focus(); } catch (_) { /* 무시 */ } }
    openPop = null; popCleanup = null;
  };
  openPop = pop;
}

function buildMultiPop(pop: HTMLElement, fcol: string, ctx: WorkInboxCtx): void {
  const opts = collectDistinct(ctx.unified, fcol as "status" | "priority" | "project" | "assignee" | "type");
  if (!opts.length) { pop.createSpan({ cls: "nanalstamp-tv-muted", text: ctx.L.filterNone }); return; }
  const field = multiField(fcol);
  const selected = new Set<string>((ctx.prefs.filters[field] as string[] | undefined) ?? []);
  let first: HTMLInputElement | null = null;
  for (const o of opts) {
    const row = pop.createEl("label", { cls: "nanalstamp-tv-pop-opt" });
    const cb = row.createEl("input");
    cb.type = "checkbox";
    cb.checked = selected.has(o.value);
    if (!first) first = cb;
    row.createSpan({ text: optDisplay(fcol, o.value, o.label, ctx.L) });
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(o.value); else selected.delete(o.value);
      if (selected.size) (ctx.prefs.filters as Record<string, unknown>)[field] = Array.from(selected);
      else delete (ctx.prefs.filters as Record<string, unknown>)[field];
      ctx.savePrefs();
      repaint?.();
    });
  }
  // 접근성 — 열 때 첫 체크박스로 포커스(아이콘에 남은 포커스로 전체 Tab 순회 방지).
  if (first) window.setTimeout(() => first?.focus(), 0);
}

function buildTextPop(pop: HTMLElement, fcol: string, ctx: WorkInboxCtx): void {
  const field = fcol === "title" ? "titleText" : "memoText";
  const input = pop.createEl("input");
  input.type = "text";
  input.value = ((ctx.prefs.filters as Record<string, unknown>)[field] as string) ?? "";
  input.placeholder = ctx.L.filterTextPh;
  input.addEventListener("input", () => {
    const v = input.value;
    if (v) (ctx.prefs.filters as Record<string, unknown>)[field] = v;
    else delete (ctx.prefs.filters as Record<string, unknown>)[field];
    ctx.savePrefs();
    repaint?.();
  });
  window.setTimeout(() => input.focus(), 0);
}

function buildDatePop(pop: HTMLElement, fcol: string, ctx: WorkInboxCtx): void {
  const fromF = fcol === "dueDate" ? "dueFrom" : "startFrom";
  const toF = fcol === "dueDate" ? "dueTo" : "startTo";
  const mk = (labelText: string, field: string): void => {
    const row = pop.createDiv({ cls: "nanalstamp-tv-pop-date" });
    row.createSpan({ cls: "nanalstamp-tv-muted", text: labelText });
    const inp = row.createEl("input");
    inp.type = "date";
    inp.value = ((ctx.prefs.filters as Record<string, unknown>)[field] as string) ?? "";
    inp.addEventListener("change", () => {
      const v = inp.value;
      if (v) (ctx.prefs.filters as Record<string, unknown>)[field] = v;
      else delete (ctx.prefs.filters as Record<string, unknown>)[field];
      ctx.savePrefs();
      repaint?.();
    });
  };
  mk(ctx.L.filterFrom, fromF);
  mk(ctx.L.filterTo, toF);
}

// host(고정 위치) 기준 배치 + 뷰포트 클램프 — 오른쪽/아래 넘침이면 왼쪽·위로 되접는다.
function positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  pop.style.left = r.left + "px";
  pop.style.top = (r.bottom + 4) + "px";
  window.requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    let left = r.left, top = r.bottom + 4;
    if (left + pr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pr.width - 8);
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 4);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  });
}

function renderTableRow(tbody: HTMLElement, task: UnifiedTask, ctx: WorkInboxCtx): void {
  const { L } = ctx;
  const overdue = isOverdue(task, ctx.today);
  const tr = tbody.createEl("tr", {
    cls: "nanalstamp-tv-row" + (overdue ? " is-overdue" : "") + (task.status === "done" ? " is-done" : ""),
  });

  // 업무(제목) — 클릭하면 **상세**가 열린다: 설명·이력·완료 보고·회신은 표에 담을 수 없고,
  // 그전에는 어디에서도 볼 수 없었다(2026-07-26). 연결 노트는 상세 안에서 연다 — 제목 하나가
  // 노트 열기와 상세 보기를 상황에 따라 다르게 하면 어느 쪽이 될지 예측할 수 없다.
  const tdTitle = tr.createEl("td", { cls: "nanalstamp-tv-td-title" });
  // 안읽음 빨간 점(읽음 배지) — 네 렌더러(카드·표·컴팩트·보드)가 같은 판정(isUnread)을 쓴다.
  if (isUnread(task)) tdTitle.createSpan({ cls: "nanalstamp-unread-dot", attr: { "aria-label": L.taskUnread } });
  const titleEl = tdTitle.createSpan({ cls: "nanalstamp-tv-title is-link", text: task.title });
  titleEl.title = L.taskDetailOpenHint;
  titleEl.setAttribute("role", "button");
  titleEl.setAttribute("tabindex", "0");
  const openDetail = () => ctx.actions.openDetail(task);
  titleEl.addEventListener("click", openDetail);
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); }
  });
  // 회신 수 — 제목만 보여 주면 **회신이 왔는지 표에서 알 수 없다**(2026-08-06 지적).
  // 카드 뷰(views.ts renderCards)에는 있었는데 표에는 없어서, 넓게 보기로 바꾸면 사라졌다.
  // 열을 늘리지 않고 제목 옆에 붙인다 — 포털 업무함 표와 같은 자리·같은 모양이다.
  // 0건이면 그리지 않는다(없는 것을 0으로 적으면 눈만 어지럽다).
  if (task.replyCount > 0) {
    const rc = tdTitle.createSpan({ cls: "nanalstamp-tv-replies", text: L.taskReplies(task.replyCount) });
    rc.title = L.taskDetailOpenHint;
    rc.addEventListener("click", openDetail);   // 회신을 보러 가는 것이 이 배지의 목적이다
  }

  // 유형(받음/보냄/개인)은 표 컬럼에서 제거 — 상단 카테고리 세그먼트로 필터한다.

  // 과제.
  tr.createEl("td", { text: task.projectName || "—", cls: "nanalstamp-tv-muted" });

  // 우선순위 pill(기존 카드 pill 클래스 재사용).
  tr.createEl("td").createSpan({
    cls: "nanalstamp-task-pill is-" + (task.priority || "week"),
    text: L.taskPriLabel[task.priority] ?? task.priority,
  });

  // 상태 pill + **그 상태가 된 날**. 상태만으로는 "언제부터"를 알 수 없다 — 접수 대기는 요청일,
  // 접수됨은 접수일, 완료는 완료일을 아래 줄에 병기한다.
  const st = statusPill(L, task);
  const tdSt = tr.createEl("td");
  tdSt.createSpan({ cls: "nanalstamp-task-st " + st.cls, text: st.text });
  const stamp = statusStamp(task);
  if (stamp) tdSt.createDiv({ cls: "nanalstamp-tv-substamp", text: ymd(stamp) });

  // 시작일.
  tr.createEl("td", { text: task.startDate || "—", cls: "nanalstamp-tv-muted" });

  // 마감(초과=빨강·오늘=노랑). 표는 "마감" 컬럼 제목이 있으니 접두 없이(bare) 날짜/상대만.
  const due = dueCell(L, task, ctx.today, true);
  tr.createEl("td").createSpan({ cls: "nanalstamp-task-due " + due.cls, text: due.text });

  // 담당(별칭 우선, 툴팁=이메일).
  const who = (task.assigneeUid || task.assigneeEmail) ? personDisplay(task.assigneeName, task.assigneeEmail) : "—";
  const tdWho = tr.createEl("td", { text: who, cls: "nanalstamp-tv-muted" });
  if (task.assigneeEmail) tdWho.title = task.assigneeEmail;

  // 처리(유형+상태별 액션 버튼).
  renderRowActions(tr.createEl("td", { cls: "nanalstamp-tv-td-act" }), task, ctx);

  // 비고.
  tr.createEl("td", { text: task.memo || "—", cls: "nanalstamp-tv-muted nanalstamp-tv-memo" });
}

// 액션 kind → i18n 라벨. taskcore.taskActionDefs(단일 매트릭스)의 kind를 렌더 라벨로 매핑.
// main.ts 카드도 이 함수를 재사용(같은 PluginI18n 사전) — 라벨 단일 소스.
export function actionLabel(L: PluginI18n, kind: TaskActionKind): string {
  switch (kind) {
    case "accept": return L.taskBtnAccept;
    case "decline": return L.taskBtnDecline;
    case "report": return L.taskBtnReport;
    case "cancel": return L.taskBtnCancel;
    case "recall": return L.taskBtnMarkDone;
    case "markDone": return L.taskBtnMarkDone;
    case "rerequest": return L.taskBtnRerequest;
    case "request": return L.taskBtnRequest;
    case "reopen": return L.taskReopenBtn;
    case "edit": return L.taskEditBtn;
  }
}
// 액션 kind → 실행(WorkInboxActions 콜백). recall=markDone(recall=true), report/markDone=markDone(false).
// main.ts 카드도 이 함수를 재사용(같은 actions 객체) — 실행 배선 단일 소스.
export function runAction(a: WorkInboxActions, kind: TaskActionKind, task: UnifiedTask): void {
  switch (kind) {
    case "accept": a.accept(task); return;
    case "decline": a.decline(task); return;
    case "report": a.markDone(task, false); return;
    case "cancel": a.cancel(task); return;
    case "recall": a.markDone(task, true); return;
    case "markDone": a.markDone(task, false); return;
    case "rerequest": a.request(task); return;
    case "request": a.request(task); return;
    case "reopen": a.reopen(task); return;
    case "edit": a.edit(task); return;
  }
}
function actionCls(variant: "pri" | "done" | undefined): string {
  return variant ? "nanalstamp-task-act is-" + variant : "nanalstamp-task-act";
}

// 유형+상태별 처리 버튼(표·보드) — 권한 매트릭스는 taskcore.taskActionDefs 단일 소스(서버 게이트와 1:1).
// 카드(main.ts)도 같은 taskActionDefs·actionLabel·runAction을 쓴다(중복 매트릭스 제거, §Task 10).
function renderRowActions(td: HTMLElement, task: UnifiedTask, ctx: WorkInboxCtx): void {
  const { L, actions: a } = ctx;
  const defs = taskActionDefs(task, ctx.myUid);
  if (!defs.length) { td.createSpan({ cls: "nanalstamp-tv-muted", text: "—" }); return; }
  for (const d of defs) {
    const b = td.createEl("button", { text: actionLabel(L, d.kind), cls: actionCls(d.variant) });
    b.addEventListener("click", (e) => { e.stopPropagation(); runAction(a, d.kind, task); });
  }
}
