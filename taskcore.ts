// 업무 요청함 코어 — /attest/team/tasks 응답 파싱·섹션 분류·배지·폴링 스냅샷 diff.
// 순수(node --test 검증, DOM·Obsidian 의존 없음). 오늘 날짜(YYYY-MM-DD)는 호출자가 주입한다.
// 설계: docs/superpowers/specs/2026-07-23-work-inbox-design.md §7b + request-inbox-panel-mockup.html

export interface TaskItem {
  id: string;
  creatorUid: string;
  creatorEmail: string | null;
  creatorName: string | null;   // 팀 스코프 별칭(없으면 null → 이메일 폴백)
  assigneeUid: string | null;   // null = personal(내 업무)
  assigneeEmail: string | null;
  assigneeName: string | null;
  title: string;
  body: string;
  memo: string;
  priority: string;             // now|week|ref
  status: string;               // personal|requested|accepted|declined|done|canceled
  linkedNotePath: string | null;
  startDate: string | null;     // YYYY-MM-DD
  dueDate: string | null;
  requestedAt: number | null;   // epoch 초
  acceptedAt: number | null;
  doneAt: number | null;
  doneBy: string | null;
  doneComment: string | null;   // 완료 코멘트(선택) — 이력·감사 리포트
  declineReason: string | null;
  reopenReason: string | null;  // 마지막 되돌림 이유(있으면)
  reopenedAt: number | null;    // 마지막 되돌림 시각(epoch 초)
  reopenedBy: string | null;
  createdAt: number;
  updatedAt: number;
  replyCount: number;
  lastReplyAt: number | null;
  lastReplyAuthorEmail: string | null;
  myReadAt: number | null;      // 내가 마지막으로 연 시각(서버 team_task_reads) — null = 구서버 응답(판정 비활성)
  projectId?: string | null;    // 연구과제 연결(§7b+B) — 없으면 null(옵션: 구 스냅샷 호환)
  projectName?: string | null;  // 표시용 과제명(서버 join) — 태그 렌더에 사용
}

export interface TaskReply {
  id: string;
  authorUid: string;
  authorEmail: string | null;
  authorName: string | null;    // 팀 스코프 별칭
  body: string;
  createdAt: number;
}

export interface RosterMember {
  userId: string;
  email: string;
  displayName: string | null;   // 팀 스코프 별칭
  role: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/// 사람 표시(순수): 별칭이 있으면 별칭, 없으면 이메일 **전체**(로컬파트 자르기 금지), 둘 다 없으면 "?".
export function personDisplay(name: string | null, email: string | null): string {
  return name ?? email ?? "?";
}

/// 수신자 선택 옵션 라벨 — 별칭이 있으면 "별칭 (이메일)" 병기(별칭 중복의 구분자), 없으면 이메일.
export function rosterLabel(m: RosterMember): string {
  return m.displayName ? `${m.displayName} (${m.email})` : m.email;
}

/// GET /attest/team/tasks 응답 파싱 — 필수 필드(id·title·status·created_at) 불량 행은 스킵(방어).
export function parseTasksResponse(j: unknown): { tasks: TaskItem[]; hasMore: boolean; cursor: string | null } {
  const o = j as { tasks?: unknown; has_more?: unknown; cursor?: unknown } | null;
  const out: TaskItem[] = [];
  if (o && Array.isArray(o.tasks)) {
    for (const raw of o.tasks as Array<Record<string, unknown>>) {
      if (typeof raw?.id !== "string" || typeof raw.title !== "string") continue;
      if (typeof raw.status !== "string" || typeof raw.created_at !== "number") continue;
      const lr = (raw.last_reply ?? null) as Record<string, unknown> | null;
      out.push({
        id: raw.id,
        creatorUid: str(raw.creator_uid) ?? "",
        creatorEmail: str(raw.creator_email),
        creatorName: str(raw.creator_name),
        assigneeUid: str(raw.assignee_uid),
        assigneeEmail: str(raw.assignee_email),
        assigneeName: str(raw.assignee_name),
        title: raw.title,
        body: typeof raw.body === "string" ? raw.body : "",
        memo: typeof raw.memo === "string" ? raw.memo : "",
        priority: str(raw.priority) ?? "week",
        status: raw.status,
        linkedNotePath: str(raw.linked_note_path),
        startDate: str(raw.start_date),
        dueDate: str(raw.due_date),
        requestedAt: num(raw.requested_at),
        acceptedAt: num(raw.accepted_at),
        doneAt: num(raw.done_at),
        doneBy: str(raw.done_by),
        doneComment: str(raw.done_comment),
        declineReason: str(raw.decline_reason),
        reopenReason: str(raw.reopen_reason),
        reopenedAt: num(raw.reopened_at),
        reopenedBy: str(raw.reopened_by),
        createdAt: raw.created_at,
        updatedAt: num(raw.updated_at) ?? raw.created_at,
        replyCount: num(raw.reply_count) ?? 0,
        lastReplyAt: lr && typeof lr === "object" ? num(lr.created_at) : null,
        lastReplyAuthorEmail: lr && typeof lr === "object" ? str(lr.author_email) : null,
        myReadAt: num(raw.my_read_at),
        projectId: str(raw.project_id),
        projectName: str(raw.project_name),
      });
    }
  }
  return { tasks: out, hasMore: o?.has_more === true, cursor: str(o?.cursor) };
}

/// GET …/:id/replies 응답 파싱.
export function parseRepliesResponse(j: unknown): TaskReply[] {
  const o = j as { replies?: unknown } | null;
  const out: TaskReply[] = [];
  if (o && Array.isArray(o.replies)) {
    for (const raw of o.replies as Array<Record<string, unknown>>) {
      if (typeof raw?.id !== "string" || typeof raw.body !== "string" || typeof raw.created_at !== "number") continue;
      out.push({
        id: raw.id,
        authorUid: str(raw.author_uid) ?? "",
        authorEmail: str(raw.author_email),
        authorName: str(raw.author_name),
        body: raw.body,
        createdAt: raw.created_at,
      });
    }
  }
  return out;
}

/// GET /attest/team/roster 응답 파싱 — 이메일 순 정렬은 서버가 보장하지만 방어적으로 재정렬.
export function parseRosterResponse(j: unknown): RosterMember[] {
  const o = j as { members?: unknown } | null;
  const out: RosterMember[] = [];
  if (o && Array.isArray(o.members)) {
    for (const raw of o.members as Array<Record<string, unknown>>) {
      if (typeof raw?.user_id !== "string" || typeof raw.email !== "string") continue;
      out.push({ userId: raw.user_id, email: raw.email, displayName: str(raw.display_name), role: str(raw.role) ?? "member" });
    }
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/// 마감 초과: 마감일(YYYY-MM-DD)이 오늘보다 이전이고 아직 열린 요청/진행 상태.
/// ISO 문자열이라 사전순 비교 = 날짜순 비교. personal·declined·done은 초과 개념 없음.
export function isOverdue(t: TaskItem, todayYmd: string): boolean {
  if (!t.dueDate) return false;
  if (t.status !== "requested" && t.status !== "accepted") return false;
  return t.dueDate < todayYmd;
}

/// 마감 표시 종별 — 라벨 문구는 호출자(i18n) 소관.
export function dueKind(dueDate: string | null, todayYmd: string): "none" | "overdue" | "today" | "future" {
  if (!dueDate) return "none";
  if (dueDate < todayYmd) return "overdue";
  if (dueDate === todayYmd) return "today";
  return "future";
}

/// 섹션 정렬: 마감 초과 최상단(가장 오래 지난 것부터) → 마감 임박순(무마감 뒤) → 최신 생성순.
function sectionSort(tasks: TaskItem[], todayYmd: string): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const ao = isOverdue(a, todayYmd) ? 1 : 0;
    const bo = isOverdue(b, todayYmd) ? 1 : 0;
    if (ao !== bo) return bo - ao; // 초과 먼저
    const ad = a.dueDate ?? "9999-99-99";
    const bd = b.dueDate ?? "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1; // 마감 이른 순(초과끼리는 곧 "오래 지난 순")
    return b.createdAt - a.createdAt;
  });
}

export interface TaskSections {
  waiting: TaskItem[];  // 접수 대기(requested)
  active: TaskItem[];   // 진행 중(accepted + personal) — 마감 초과가 상단
  declined: TaskItem[]; // 반려됨(재요청 대상 — 보낸 요청 탭에서 의미)
}

/// open 목록을 패널 섹션으로 분류(§7b: 접수 대기 → 진행 중 → 완료(접힘)). done·canceled는
/// open 조회에 없지만 방어적으로 버린다.
export function sectionize(tasks: TaskItem[], todayYmd: string): TaskSections {
  const waiting: TaskItem[] = [];
  const active: TaskItem[] = [];
  const declined: TaskItem[] = [];
  for (const t of tasks) {
    if (t.status === "requested") waiting.push(t);
    else if (t.status === "accepted" || t.status === "personal") active.push(t);
    else if (t.status === "declined") declined.push(t);
  }
  return {
    waiting: sectionSort(waiting, todayYmd),
    active: sectionSort(active, todayYmd),
    declined: sectionSort(declined, todayYmd),
  };
}

/// mine 뷰를 "보낸 요청"(수신자 있음)과 "내 업무"(personal — 수신자 없음)로 분리.
/// declined·canceled 이력이 있어도 assignee 유무가 기준(반려건은 보낸 요청에 남아 재요청 유도).
export function partitionMine(mine: TaskItem[]): { sent: TaskItem[]; personal: TaskItem[] } {
  const sent: TaskItem[] = [];
  const personal: TaskItem[] = [];
  for (const t of mine) (t.assigneeUid ? sent : personal).push(t);
  return { sent, personal };
}

// ── 유형 통합(§1, 2026-07-25) — inbox+mine 단일 목록 + taskType 파생. 서버 스키마 무변경 ──
export type TaskType = "received" | "sent" | "personal";
export type UnifiedTask = TaskItem & { taskType: TaskType };

/// inbox+mine을 단일 목록으로 통합하고 유형을 파생한다. received=inbox 전체(taskType 부여),
/// sent=mine 중 담당자 있음, personal=mine 중 담당자 없음. id 중복(셀프할당 등 양쪽 등장)은 received 우선.
/// cf. unionTasks — 별개 목적: unionTasks는 TaskItem[] 스냅샷 diff용([...inbox,...mine] 순서, 유형 파생 없음),
/// unifyTasks는 표시 계층의 UnifiedTask[] 유형 파생용(received/sent/personal). 혼동 금지.
export function unifyTasks(inbox: TaskItem[], mine: TaskItem[]): UnifiedTask[] {
  const out: UnifiedTask[] = [];
  const seen = new Set<string>();
  for (const t of inbox) { seen.add(t.id); out.push({ ...t, taskType: "received" }); }
  for (const t of mine) {
    if (seen.has(t.id)) continue; // received 우선 — 셀프할당은 받은 요청으로만
    out.push({ ...t, taskType: t.assigneeUid ? "sent" : "personal" });
  }
  return out;
}

export type SortKey = "title" | "type" | "project" | "priority" | "status" | "startDate" | "dueDate" | "assignee";
export type SortDir = "asc" | "desc" | null;
/// 다중 정렬 스펙 1개(컬럼+방향). sorts 배열의 순서 = 정렬 우선순위(0=1차, 1=2차 tiebreak…).
export interface SortSpec { col: SortKey; dir: "asc" | "desc"; }

const PRIORITY_RANK: Record<string, number> = { now: 0, week: 1, ref: 2 };
const STATUS_ORDER = ["personal", "requested", "accepted", "declined", "done", "canceled"];
const TYPE_ORDER: TaskType[] = ["received", "sent", "personal"];
function statusRank(s: string): number { const i = STATUS_ORDER.indexOf(s); return i === -1 ? STATUS_ORDER.length : i; }
function typeRank(tt: TaskType): number { const i = TYPE_ORDER.indexOf(tt); return i === -1 ? TYPE_ORDER.length : i; }
// 날짜 문자열 비교 — 값 있는 쪽이 오름차순에서 먼저(빈 값은 뒤). 내림차순은 호출부가 부호 반전(웹 dateSortCmp와 동일).
function dateSortCmp(a: string | null, b: string | null): number {
  const av = a || "", bv = b || "";
  if (av && bv) return av < bv ? -1 : av > bv ? 1 : 0;
  if (!av && !bv) return 0;
  return av ? -1 : 1;
}
function assigneeSortName(t: TaskItem): string | null {
  return (t.assigneeUid || t.assigneeEmail) ? personDisplay(t.assigneeName, t.assigneeEmail) : null;
}
const SORT_COMPARATORS: Record<SortKey, (a: UnifiedTask, b: UnifiedTask) => number> = {
  title: (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "ko"),
  type: (a, b) => typeRank(a.taskType) - typeRank(b.taskType),
  project: (a, b) => { const an = a.projectName || "", bn = b.projectName || ""; if (an && bn) return an.localeCompare(bn, "ko"); if (!an && !bn) return 0; return an ? -1 : 1; },
  priority: (a, b) => (PRIORITY_RANK[a.priority || "week"] ?? 1) - (PRIORITY_RANK[b.priority || "week"] ?? 1),
  status: (a, b) => statusRank(a.status) - statusRank(b.status),
  startDate: (a, b) => dateSortCmp(a.startDate, b.startDate),
  dueDate: (a, b) => dateSortCmp(a.dueDate, b.dueDate),
  assignee: (a, b) => { const an = assigneeSortName(a), bn = assigneeSortName(b); if (an && bn) return an.localeCompare(bn, "ko"); if (!an && !bn) return 0; return an ? -1 : 1; },
};

/// 다중 정렬 — sorts 순서대로 tiebreak(1차가 같으면 2차…). sorts가 있으면 완료(done)도 정렬
/// 기준대로 섞인다(사용자 확정). sorts가 비면(기본) 완료가 항상 하단(열린 업무 중 마감 초과 우선,
/// 나머지는 입력 순서 보존 — Array.sort 안정성). 각 컬럼 comparator는 SORT_COMPARATORS 재사용,
/// dir로 부호 반전. 원본 불변(slice).
export function sortUnified(tasks: UnifiedTask[], sorts: SortSpec[], todayYmd: string): UnifiedTask[] {
  const arr = tasks.slice();
  if (sorts.length) {
    arr.sort((a, b) => {
      for (const s of sorts) {
        const r = SORT_COMPARATORS[s.col](a, b);
        if (r !== 0) return s.dir === "desc" ? -r : r;
      }
      return 0;
    });
  } else {
    arr.sort((a, b) => {
      const d = (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0);
      if (d) return d;
      return (isOverdue(b, todayYmd) ? 1 : 0) - (isOverdue(a, todayYmd) ? 1 : 0);
    });
  }
  return arr;
}

export interface TaskFilterState {
  types?: TaskType[];
  statuses?: string[];
  priorities?: string[];
  projects?: string[];   // "" = 과제 없음 버킷
  assignees?: string[];  // 담당 멀티체크 — "" = 담당 없음(개인). assigneeFilterKey와 매칭.
  q?: string;            // 전 필드 검색(제목·설명·비고 OR) — 헤더 검색창. 컬럼 필터와 AND로 겹친다.
  titleText?: string;
  memoText?: string;     // 비고 부분일치
  startFrom?: string;    // 시작일 범위(문자열 비교)
  startTo?: string;
  dueFrom?: string;
  dueTo?: string;
  overdue?: boolean;     // 대시보드 파생 필터(웹 이식) — status와 AND
}

/// 담당 필터/그룹 매칭 키 — assigneeUid 우선, 없으면 email:<주소>, 둘 다 없으면 ""(담당 없음).
export function assigneeFilterKey(t: TaskItem): string {
  return t.assigneeUid ? t.assigneeUid : (t.assigneeEmail ? "email:" + t.assigneeEmail : "");
}

/// 표시 계층 필터 판정(멀티체크 AND · 텍스트 부분일치 · 날짜 문자열 범위). 빈 조건은 통과.
export function taskPasses(task: UnifiedTask, f: TaskFilterState, todayYmd: string): boolean {
  if (f.types && f.types.length && !f.types.includes(task.taskType)) return false;
  if (f.statuses && f.statuses.length && !f.statuses.includes(task.status)) return false;
  if (f.priorities && f.priorities.length && !f.priorities.includes(task.priority || "week")) return false;
  if (f.projects && f.projects.length) {
    const pv = task.projectId ? String(task.projectId) : "";
    if (!f.projects.includes(pv)) return false;
  }
  if (f.assignees && f.assignees.length && !f.assignees.includes(assigneeFilterKey(task))) return false;
  // 전 필드 검색 — 제목·설명·비고 중 하나라도 걸리면 통과. 컬럼별 필터(titleText 등)와는 AND다.
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [task.title, task.body, task.memo].map((x) => String(x || "").toLowerCase());
    if (!hay.some((h) => h.includes(needle))) return false;
  }
  if (f.titleText && !String(task.title || "").toLowerCase().includes(f.titleText.toLowerCase())) return false;
  if (f.memoText && !String(task.memo || "").toLowerCase().includes(f.memoText.toLowerCase())) return false;
  if (f.startFrom || f.startTo) {
    if (!task.startDate) return false;
    if (f.startFrom && task.startDate < f.startFrom) return false;
    if (f.startTo && task.startDate > f.startTo) return false;
  }
  if (f.dueFrom || f.dueTo) {
    if (!task.dueDate) return false;
    if (f.dueFrom && task.dueDate < f.dueFrom) return false;
    if (f.dueTo && task.dueDate > f.dueTo) return false;
  }
  if (f.overdue && !isOverdue(task, todayYmd)) return false;
  return true;
}

export type GroupBy = "status" | "type" | "assignee" | "project";
export interface TaskGroup { key: string; label: string; items: UnifiedTask[]; }

// 그룹 키·라벨 파생 — status/type은 토큰(DOM이 i18n), assignee/project는 데이터 파생(빈 그룹 label="").
function groupKeyLabel(t: UnifiedTask, by: GroupBy): { key: string; label: string } {
  switch (by) {
    case "status": return { key: t.status, label: t.status };
    case "type": return { key: t.taskType, label: t.taskType };
    case "assignee": {
      const key = t.assigneeUid ? t.assigneeUid : (t.assigneeEmail ? "email:" + t.assigneeEmail : "");
      return { key, label: key ? personDisplay(t.assigneeName, t.assigneeEmail) : "" };
    }
    default: { // project
      const key = t.projectId ? String(t.projectId) : "";
      return { key, label: key ? (t.projectName || key) : "" };
    }
  }
}

/// 지정 축으로 묶어 순서 있는 그룹 배열 반환. status/type은 고정 순서, assignee/project는 빈 그룹 뒤 + 라벨 가나다.
/// 각 그룹 items는 기본 정렬(sortUnified dir=null — 완료 하단·마감 초과 우선).
export function groupUnified(tasks: UnifiedTask[], by: GroupBy, todayYmd: string): TaskGroup[] {
  const map = new Map<string, TaskGroup>();
  for (const t of tasks) {
    const { key, label } = groupKeyLabel(t, by);
    const g = map.get(key);
    if (g) g.items.push(t);
    else map.set(key, { key, label, items: [t] });
  }
  const groups = Array.from(map.values());
  if (by === "status") groups.sort((a, b) => statusRank(a.key) - statusRank(b.key));
  else if (by === "type") groups.sort((a, b) => typeRank(a.key as TaskType) - typeRank(b.key as TaskType));
  else groups.sort((a, b) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) || a.label.localeCompare(b.label, "ko"));
  for (const g of groups) g.items = sortUnified(g.items, [], todayYmd);
  return groups;
}

export interface BoardColumn { status: string; label: string; items: UnifiedTask[]; }
// 컬럼 순서 — 웹(personal 먼저)과 달리 requested를 맨 앞에 둔다: 통합 업무함은 "받은 일
// (requested·accepted) 우선" 프레이밍(스펙 §2). 순서만 이 결정을 따르고 분류 로직은 웹과 동일.
const BOARD_ORDER = ["requested", "accepted", "personal", "declined", "done"];

/// 보드(칸반)용 — 상태 컬럼별 분류(항상 5컬럼, 빈 컬럼 포함). label=상태 토큰(DOM이 i18n pill 라벨로 표시).
/// 컬럼 items는 기본 정렬(완료 하단·마감 초과 우선).
export function boardColumns(tasks: UnifiedTask[], todayYmd: string): BoardColumn[] {
  const by: Record<string, UnifiedTask[]> = {};
  for (const t of tasks) (by[t.status] = by[t.status] || []).push(t);
  return BOARD_ORDER.map((status) => ({
    status,
    label: status,
    items: sortUnified(by[status] || [], [], todayYmd),
  }));
}

// ── 액션 권한 매트릭스(§Task 10, 2026-07-25) — 카드(main)·표/보드(taskview) 단일 소스 ──
// 서버 전이 게이트(team_tasks.rs)와 1:1. received=담당자·sent/personal=요청자.
// DOM·i18n 의존 없음(순수) — 렌더러가 kind→라벨(i18n)·kind→실행(콜백)로 매핑한다.
export type TaskActionKind =
  | "accept" | "decline" | "report" | "cancel" | "recall"
  | "markDone" | "rerequest" | "request" | "reopen" | "edit";
export interface TaskActionDef { kind: TaskActionKind; variant?: "pri" | "done"; }


/// 이 업무를 **내가 고칠 수 있는가** — 서버 게이트(crud.rs patch_task)와 같은 식이다.
///   요청자 본인(creator_uid == uid) · 완료·취소 전까지.
///
/// 화면에서 이 판정을 여러 군데에 손으로 적었더니 반드시 한쪽이 어긋났다(2026-07-29:
/// 표의 액션만 고치고 상세 모달을 빠뜨려, 눌렀더니 "요청자만 가능합니다"가 났다).
/// **버튼이 떴는데 403이 나는 것이 안 뜨는 것보다 나쁘다** — 판정은 여기 하나뿐이어야 한다.
/// uid를 모르면 false: 모를 때는 막는 쪽이 안전하다.
export function canEditTask(
  t: Pick<UnifiedTask, "status" | "creatorUid">,
  selfUid: string | undefined | null,
): boolean {
  if (!selfUid) return false;
  if (t.creatorUid !== selfUid) return false;
  return t.status !== "done" && t.status !== "canceled";
}

/// 유형+상태별로 노출할 액션 버튼 집합을 파생한다(순서=표시 순서). 빈 배열이면 처리 없음.
/// received(담당자): requested→접수·반려·완료보고, accepted→완료보고.
/// sent(요청자): requested→회수·회수종결(recall), accepted→완료, declined→재요청.
/// personal(요청자): personal→요청·완료, accepted→완료.
/// done(모든 유형): 되돌리기 — received는 완료 처리자가 담당자(나)일 때만, 그 외(요청자)는 항상.
export function taskActionDefs(
  t: Pick<UnifiedTask, "taskType" | "status" | "doneBy" | "assigneeUid" | "creatorUid">,
  selfUid?: string,
): TaskActionDef[] {
  const defs: TaskActionDef[] = [];
  if (t.taskType === "received") {
    if (t.status === "requested") {
      defs.push({ kind: "accept", variant: "pri" });
      defs.push({ kind: "decline" });
      defs.push({ kind: "report", variant: "done" }); // requested→done은 접수 자동 소급
    } else if (t.status === "accepted") {
      defs.push({ kind: "report", variant: "done" });
    }
  } else if (t.taskType === "sent") {
    if (t.status === "requested") {
      defs.push({ kind: "cancel" });
      defs.push({ kind: "recall", variant: "done" }); // 요청자 회수 종결(모달)
    } else if (t.status === "accepted") {
      defs.push({ kind: "markDone", variant: "done" });
    } else if (t.status === "declined") {
      defs.push({ kind: "rerequest", variant: "pri" });
    }
  } else { // personal
    if (t.status === "personal") {
      defs.push({ kind: "request", variant: "pri" });
      defs.push({ kind: "markDone", variant: "done" });
    } else if (t.status === "accepted") {
      defs.push({ kind: "markDone", variant: "done" });
    }
  }
  // 수정 — 판정은 canEditTask 하나뿐이다(상세 모달도 같은 함수를 쓴다).
  if (canEditTask(t, selfUid)) defs.push({ kind: "edit" });
  if (t.status === "done") {
    const canReopen = t.taskType === "received"
      ? (t.doneBy != null && t.doneBy === t.assigneeUid)
      : true;
    if (canReopen) defs.push({ kind: "reopen" });
  }
  return defs;
}

/// 읽지 않음(노션식 읽음 배지, plans/2026-08-06-task-read-badge.md) — 내가 마지막으로 연 뒤에
/// 활동(회신·상태 전이·수정 — 전부 updated_at을 움직인다)이 있었나. 판정은 strict `>` —
/// 서버가 내 행동마다 read_at을 updated_at과 같은 시각으로 찍으므로 "같음 = 읽음"이다.
/// myReadAt이 null(구서버 응답, my_read_at 부재)이면 판정 비활성 — 전부 안읽음으로 만드는
/// 것보다 기존 동작 유지가 낫다(서버 먼저 배포 게이트의 안전망).
export function isUnread(t: TaskItem): boolean {
  return typeof t.myReadAt === "number" && t.updatedAt > t.myReadAt;
}

/// 충돌 폴더의 새 이름 제안(충돌 처리 팝업, 2026-08-06) — 같은 부모 아래 "<이름>-<suffix>",
/// 그것도 있으면 -2, -3…을 붙인다. 경로 전체를 받는다(충돌 목록이 pathLabel이므로).
export function conflictRenameSuggestion(path: string, existing: Set<string>, suffix: string): string {
  const cut = path.lastIndexOf("/");
  const parent = cut >= 0 ? path.slice(0, cut + 1) : "";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  for (let n = 1; ; n++) {
    const cand = `${parent}${base}-${suffix}${n > 1 ? `-${n}` : ""}`;
    if (!existing.has(cand)) return cand;
  }
}

/// 리본 배지 = 읽지 않음 ∪ (inbox의 접수 대기 ∨ 마감 초과). 한 업무는 1건(이중 계산 없음).
/// 상태 조건이 읽음과 무관하게 남는 이유: 마감이 지난 것은 읽었다고 사라지면 안 된다.
/// mine(내가 만든 업무)은 읽지 않음만 센다 — 접수 대기·마감 관리는 수신자의 몫이다.
export function badgeCount(inbox: TaskItem[], mine: TaskItem[], todayYmd: string): number {
  const inboxIds = new Set(inbox.map((t) => t.id));
  let n = 0;
  for (const t of inbox) if (t.status === "requested" || isOverdue(t, todayYmd) || isUnread(t)) n++;
  for (const t of mine) if (!inboxIds.has(t.id) && isUnread(t)) n++;   // 셀프 할당은 inbox가 이미 셌다
  return n;
}

// ── SSE 라인 파서(순수) — /attest/team/events 준실시간 구독용 ──
// fetch 스트리밍 청크는 이벤트·라인 경계와 무관하게 잘리므로(TCP 세그먼트),
// 미완성 라인·미완성 이벤트를 상태로 들고 다음 청크에 이어 붙인다.

export interface SseMessage {
  event: string; // event: 필드(없으면 "message")
  data: string;  // data: 라인들 join("\n")
}

export interface SseParseState {
  buf: string;      // 개행 미도달 잔여 바이트(문자)
  event: string;    // 진행 중 이벤트의 event 필드
  data: string[];   // 진행 중 이벤트의 data 라인들
}

export function sseInitialState(): SseParseState {
  return { buf: "", event: "", data: [] };
}

/// 청크를 누적 파싱해 완성된 이벤트들을 반환. 상태는 새 객체로 반환(입력 불변).
/// SSE 규약 준수: 빈 줄 = 디스패치(단 data 없으면 버림), `:` 시작 = 코멘트(keepalive ping),
/// `field: value`의 value 선행 공백 1개 제거, CRLF 허용. id·retry 필드는 무시.
export function sseFeed(state: SseParseState, chunk: string): { state: SseParseState; events: SseMessage[] } {
  const events: SseMessage[] = [];
  let buf = state.buf + chunk;
  let event = state.event;
  let data = [...state.data];
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") {
      if (data.length) events.push({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue; // 코멘트(: ping)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { state: { buf, event, data }, events };
}

// ── 열린 패널 자동 재렌더 판단(순수) ──
// 폴링·SSE로 새 데이터가 와도 화면에 영향 없는 재렌더는 피한다(입력 보존·깜빡임 방지).
// 렌더에 반영되는 필드만 직렬화해 키가 다르면 재렌더. 순서도 키에 포함(서버 정렬 = 표시 순서).

export function tasksRenderKey(tasks: TaskItem[]): string {
  return tasks
    .map((t) =>
      [
        t.id, t.status, t.updatedAt, t.replyCount, t.lastReplyAt ?? 0,
        t.title, t.body, t.memo, t.priority,
        t.startDate ?? "", t.dueDate ?? "",
        t.assigneeUid ?? "", t.assigneeName ?? "", t.creatorName ?? "",
        t.declineReason ?? "", t.doneAt ?? 0, t.projectName ?? "",
        // myReadAt 누락 → 다른 기기(포털)에서 읽어도 열린 패널의 안읽음 점이 안 꺼진다(2026-08-06 실기기 실측).
        t.myReadAt ?? -1,
      ].join(""),
    )
    .join("");
}

// ── 폴링 스냅샷 diff — 새 할당·새 회신·새로 마감 초과 3종만(§7b 알림 라우팅) ──

export interface TaskSnapshotEntry {
  status: string;
  replyCount: number;
  lastReplyAt: number | null;
  overdue: boolean;
}
export type TaskSnapshot = Record<string, TaskSnapshotEntry>;

/// inbox∪mine 합집합(id 중복은 첫 항목 우선 — 셀프 할당은 양쪽에 나온다).
export function unionTasks(inbox: TaskItem[], mine: TaskItem[]): TaskItem[] {
  const seen = new Set<string>();
  const out: TaskItem[] = [];
  for (const t of [...inbox, ...mine]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export function snapshotOf(tasks: TaskItem[], todayYmd: string): TaskSnapshot {
  const snap: TaskSnapshot = {};
  for (const t of tasks) {
    snap[t.id] = {
      status: t.status,
      replyCount: t.replyCount,
      lastReplyAt: t.lastReplyAt,
      overdue: isOverdue(t, todayYmd),
    };
  }
  return snap;
}

export interface TaskEvent {
  type: "assigned" | "reply" | "overdue";
  task: TaskItem;
}

/// 직전 스냅샷 대비 신규 이벤트 감지. 원칙:
/// - assigned: inbox에서 requested인데 직전엔 없었거나 requested가 아니었던 것(재요청 포함).
/// - reply: 직전에 알던 업무의 회신 수 증가 + 마지막 회신이 내 글이 아닐 때(내 회신 에코 방지.
///   myEmail을 모르면(빈 문자열) 보수적으로 알린다 — 놓침보다 중복이 낫다).
/// - overdue: 직전에 알던 업무가 미초과→초과로 넘어간 순간(스냅샷에 없던 업무는 assigned가 담당).
/// 첫 폴링(스냅샷 없음)은 호출자가 diff 없이 기준만 수립한다 — 시작 시 폭주 방지.
export function diffSnapshot(
  prev: TaskSnapshot,
  inbox: TaskItem[],
  mine: TaskItem[],
  todayYmd: string,
  myEmail: string,
): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const t of inbox) {
    if (t.status === "requested" && prev[t.id]?.status !== "requested") {
      events.push({ type: "assigned", task: t });
    }
  }
  for (const t of unionTasks(inbox, mine)) {
    const p = prev[t.id];
    if (!p) continue; // 신규 업무의 회신·초과는 assigned(또는 다음 주기)가 커버 — 시작 소음 방지
    if (t.replyCount > p.replyCount) {
      const mineReply = myEmail !== "" && t.lastReplyAuthorEmail === myEmail;
      if (!mineReply) events.push({ type: "reply", task: t });
    }
    if (!p.overdue && isOverdue(t, todayYmd)) {
      events.push({ type: "overdue", task: t });
    }
  }
  return events;
}

// ── 연구과제 귀속(§3) — 순수 판정·계획 함수 (Obsidian API 의존 금지) ──

/// 줄바꿈 구분 폴더 접두 목록 정규화. 서버가 주는 `folder_patterns` 형식을 읽는 유일한 파서다
/// (2026-07-25: 패턴이 과제명에서 파생되면서 서버 쪽 `parse_patterns`는 삭제됐다 — 서버는 이제
/// 파싱하지 않고 `name`만 저장한다). 줄바꿈 다중 패턴 형식 자체는 "추가 귀속 폴더" 부활을 위해 유지.
/// 저장값에는 테두리 공백·슬래시가 없음이 서버 valid_folder_name으로 보장되므로 이 trim은 no-op이다.
export function parsePatterns(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
}

/// 노트 경로가 패턴(폴더 접두)에 걸리는가 — 경로 세그먼트 경계 기준(서버 매칭과 동일 계약).
export function matchesPatterns(path: string, patterns: string[]): boolean {
  return patterns.some((p) => path === p || path.startsWith(p + "/"));
}

/// 아직 서버에 보고하지 않은 항목만(로컬 캐시 diff — append-only라 제거는 없다).
export function unreported(hashes: string[], reported: Set<string>): string[] {
  return hashes.filter((h) => !reported.has(h));
}

export interface KitManifest {
  folders: string[];
  templates: { path: string; body: string }[];
  /// 팀 킷(2026-07-27) — 본문이 S3에 있어 URL로 내려온다. 내장 킷은 이 필드가 없고
  /// templates에 본문이 인라인된다. 둘을 합쳐 만들 대상을 정한다(manifestPaths).
  /// `sample`은 `_samples/` 아래 여부 — 봉인 스코프에서 빼고, 만들지 말지도 이걸로 고른다.
  files?: { path: string; url: string; sample: boolean }[];
}

/// 팀 표준 구조 = 매니페스트 + 최상위 루트 폴더 이름(2026-07-25 루트 필수).
export interface TeamStructure extends KitManifest {
  root: string;
  /// 폴더별 규칙(2026-08-02) — 관리자가 팀 설정에서 「이 폴더에는 이 서식, 제목은 이 접두로」를
  /// 이어 준 것. 이름 규약이 안 통하는 외부 킷을 위해 있다(parseFolderRules 주석 참조).
  folderRules?: Record<string, FolderRule>;
}

/// 폴더 한 세그먼트로 안전한 이름인가 — 서버 valid_folder_name(team.rs)·포털 seValidName과
/// 동일 계약(스펙 §3a-0, 2026-07-25 2차 개정). **정규화하지 않는다** — JS `\s`/`trim`과 Rust
/// `is_whitespace`/`trim`의 공백 집합이 달라서(U+0085는 Rust만, U+FEFF는 JS만 공백) 한쪽이
/// 정규화하면 저장값과 실제 경로가 갈린다. 그래서 규칙 위반은 정규화 대신 거부한다.
/// 금지문자 8종 + 제어문자(Cc, U+0000–U+001F·U+007F–U+009F) — 경로·S3 키·리포트 표기를 깨뜨린다.
/// **테두리 금지는 모든 공백류(`\s` + U+FEFF) + 마침표** — ASCII 공백만으로는 부족하다:
/// 귀속 패턴 파서(parsePatterns/서버 parse_patterns)는 패턴 테두리를 trim하는데, 과제 폴더는
/// projectPrefix(root, 과제명)으로 원본 이름 그대로 만들어진다. 테두리 비ASCII 공백(NBSP 등,
/// 엑셀·웹 복붙에 흔하다)을 허용하면 실제 폴더(`팀루트/<NBSP>촉매개발`)와 귀속 매칭
/// (trim된 `팀루트/촉매개발`)이 갈려 "만든 폴더가 귀속되지 않는" 결함이 재발한다. **내부**
/// 비ASCII 공백(U+00A0 등)과 Windows 예약 디바이스명(`CON` 등)은 여전히 **의도적으로 허용**한다 —
/// 세 런타임이 동일하게 판정하는 것이 개별 위험 차단보다 중요하다(스펙 §3a-0).
export function isValidFolderName(name: string, max = 80): boolean {
  const len = [...name].length;
  if (len === 0 || len > max) return false;
  if (/[/\\:*?"<>|]|\p{Cc}/u.test(name)) return false;
  if (/^[\s\uFEFF.]|[\s\uFEFF.]$/.test(name)) return false;
  return true;
}

/// 템플릿 경로 마지막 세그먼트(파일명) 전용 — 선행 마침표만 예외 허용(.gitignore류).
/// 그 외(금지문자·제어문자·후행 마침표/공백·길이)는 isValidFolderName과 동일 판정.
/// ".."처럼 마침표만으로 된 원소는 예외로 봐주지 않는다(상대경로 참조 위험).
function isValidFileSegment(seg: string, max = 255): boolean {
  if (isValidFolderName(seg, max)) return true;
  if (seg.startsWith(".") && !seg.startsWith("..") && isValidFolderName(seg.slice(1), max)) return true;
  return false;
}

/// 경로의 모든 세그먼트가 안전한 이름인가 — 트리 원소도 루트와 같은 술어로 검증한다(스펙 §4a).
/// 세그먼트 상한 255는 관례적 값(§3a-0 root의 80·과제명 100과는 별개 스코프)일 뿐,
/// 파일시스템별 실제 한계를 보장하지 않는다 — 이 함수는 코드포인트를 세는데 ext4 NAME_MAX(255)는
/// 바이트, APFS는 UTF-16 코드유닛이라 인코딩에 따라 기준이 다르다(실무에서 세그먼트 하나에
/// 255 코드포인트 상당의 비ASCII 이름은 나타나지 않는다고 보고 값은 그대로 둔다).
/// isFile=true면 마지막 세그먼트만 isValidFileSegment(파일명 선행 마침표 허용)로 판정한다.
function pathSegmentsValid(path: string, isFile: boolean): boolean {
  const segs = path.split("/");
  if (segs.some((s) => s === "")) return false; // 빈 세그먼트(연속 슬래시·선행/후행 슬래시)
  return segs.every((seg, i) =>
    isFile && i === segs.length - 1 ? isValidFileSegment(seg) : isValidFolderName(seg, 255));
}

/// 매니페스트 필드만 걸러낸다(형태 불량 원소는 개별 무시 — applyTeamProfile "전체 실패 금지").
/// 세그먼트 검증 위반(예: 후행 공백 "연구노트 " — Windows가 생성 시 잘라내 실제 폴더와 어긋난다)도
/// 개별 무시 대상이다 — 원소 하나 때문에 매니페스트 전체를 버리지 않는다.
/// **`x.trim() !== ""` 술어는 두지 않는다** — pathSegmentsValid가 이미 빈 세그먼트·공백 테두리·
/// 제어문자를 전부 거부해 사실상 중복이고, 유일한 차이가 §3a-0과 충돌했다: trim은 비ASCII
/// 공백(NBSP 등)만으로 된 이름을 "빈 값"으로 보고 조용히 드롭하는데, isValidFolderName은 그
/// 공백을 **의도적으로 허용**한다. 서버 valid_path가 같은 세그먼트 술어만 쓰면 서버는
/// 저장·표시하는데 플러그인만 빼먹는 분기가 생긴다 — §3a-0이 막으려던 결함 클래스 그대로다.
function manifestFields(raw: unknown): KitManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { folders: [], templates: [] };
  const o = raw as Record<string, unknown>;
  const folders = Array.isArray(o.folders)
    ? (o.folders as unknown[]).filter((x): x is string => typeof x === "string" && pathSegmentsValid(x, false))
    : [];
  const files = Array.isArray(o.files)
    ? (o.files as unknown[])
        .filter((x): x is { path: string; url: string; sample?: boolean } =>
          !!x && typeof x === "object" &&
          typeof (x as { path?: unknown }).path === "string" &&
          typeof (x as { url?: unknown }).url === "string" &&
          pathSegmentsValid((x as { path: string }).path, true))
        .map((x) => ({ path: x.path, url: x.url, sample: (x as { sample?: unknown }).sample === true }))
    : undefined;
  const templates = Array.isArray(o.templates)
    ? (o.templates as unknown[])
        .filter((x): x is { path: string; body: string } =>
          !!x && typeof x === "object" &&
          typeof (x as { path?: unknown }).path === "string" &&
          typeof (x as { body?: unknown }).body === "string" &&
          pathSegmentsValid((x as { path: string }).path, true))
        .map((x) => ({ path: x.path, body: x.body }))
    : [];
  return files && files.length ? { folders, templates, files } : { folders, templates };
}

/// 킷 매니페스트 파싱(GET /attest/team/kits/<id>) — 루트 없음. 유효 내용이 없으면 null.
export function parseKitManifest(raw: unknown): KitManifest | null {
  const m = manifestFields(raw);
  if (!m.folders.length && !m.templates.length && !(m.files || []).length) return null;
  return m;
}

/// 팀 프로파일 structure 파싱 — **root 필수**(2026-07-25). root가 없거나 불량이면 null(=미설정,
/// 플러그인은 로컬 폴더 설정으로 복귀). root가 유효하면 트리가 비어도 구조는 활성이다
/// (루트가 곧 팀 영역 — 트리를 비워도 봉인 스코프가 무너지지 않는다).
/// **trim하지 않는다** — isValidFolderName 주석 참조(정규화 금지, 스펙 §3a-0).
export function parseTeamStructure(raw: unknown): TeamStructure | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawRoot = (raw as Record<string, unknown>).root;
  const root = typeof rawRoot === "string" ? rawRoot : "";
  if (!isValidFolderName(root)) return null;
  // 규칙이 없으면 **필드를 넣지 않는다** — 반환값 모양이 늘면 이 함수의 결과를 통째로
  // 비교하는 곳(테스트·스냅샷)이 조용히 깨진다. 있을 때만 싣는다.
  const rules = parseFolderRules((raw as Record<string, unknown>).folderRules);
  const out: TeamStructure = { root, ...manifestFields(raw) };
  if (Object.keys(rules).length) out.folderRules = rules;
  return out;
}

// ── 팀 폴더 4계층 규약 (2026-07-31) ────────────────────────────────────────
//
//     <팀 이름>/과제/<과제명>/…      과제 자료
//     <팀 이름>/공통/<표준 폴더>/…   과제에 매이지 않는 상시 자료
//
// 왜 층을 하나 더 두나: 예전에는 과제와 표준 폴더가 **같은 층**에 있었다.
//
//     나날랩스/과제1/…      ← 과제
//     나날랩스/연구노트/…   ← 표준 폴더
//
// 보는 사람이 어느 것이 과제인지 알 수 없고, 과제명을 「연구노트」로 지으면 표준 폴더와
// 이름이 겹친다. 기계도 못 가른다 — 과제 목록과 대조해야만 알 수 있어, 목록을 모르는 쪽
// (검증기·패키지·아카이브)에는 판단할 근거가 없다.
//
// 두 번째 칸을 규약으로 고정하면 **경로만 보고 성격이 정해진다.**
//
// 용어: 「팀자료」가 아니라 「공통」이다 — 과제 자료도 팀 자료라서 서로를 배제하지 못한다.
export const TEAM_PROJECTS_DIR = "과제";
export const TEAM_COMMON_DIR = "공통";

/// 과제 폴더 프리픽스 — `<루트>/과제/<과제명>`. join은 taskcore가 소유한다
/// (호출부마다 재구현하면 이 태스크가 없애려던 경로 규칙 중복이 되살아난다).
export function projectPrefix(root: string, projectName: string): string {
  return `${root}/${TEAM_PROJECTS_DIR}/${projectName}`;
}

/// 팀 공통(표준 구조) 프리픽스 — `<루트>/공통`.
export function commonPrefix(root: string): string {
  return `${root}/${TEAM_COMMON_DIR}`;
}

/// digest 노트가 놓일 폴더 — **팀이면 팀 루트 아래 공통**이다(2026-08-02).
///
/// 기본값 `digests/` 는 팀 루트 밖이라 봉인 범위에 들지 않았다. 봉인이 안 되면 등록부
/// 보고도, 포털 목록도, WORM 원문도 없다 — 절차 전체가 조용히 끊긴다(실측으로 발견).
/// 설정을 비우면 팀에서도 비운다(= digest 폴더 미사용).
export function digestFolderFor(root: string | null, folder: string): string {
  const f = (folder || "").trim().replace(/^\/+|\/+$/g, "");
  if (!f || !root) return f;
  const pre = commonPrefix(root);
  return f === pre || f.startsWith(pre + "/") || f === root || f.startsWith(root + "/")
    ? f : `${pre}/${f}`;
}

/// 폴더별 규칙 한 건 — 「이 폴더에는 이 서식, 제목은 이 접두로」.
export interface FolderRule { template?: string; prefix?: string }

/// 팀 구조가 실어 오는 폴더별 규칙(`structure.folderRules`).
///
/// 왜 필요한가: 이름 규약(서식 파일명 = 번호 뗀 폴더 이름)은 **우리가 만든 킷에서만** 통한다.
/// 외부 킷 381개 폴더 중 짝지어지는 것은 0개였다(2026-08-02 실측) — 밖에서 만든 킷이
/// 우리 이름 규칙을 따를 이유가 없다. 그래서 **관리자가 팀 설정에서 한 번 이어 주면**
/// 그것이 팀 전체에 배포된다. 킷을 고칠 필요도, 킷 제작자에게 요구할 것도 없다.
///
/// 모양이 다른 항목은 **버린다** — 규칙 하나가 잘못됐다고 새 노트 만들기가 실패하면 안 된다.
/// 킷 밖을 가리키는 경로(`..`·절대경로)도 버린다: 규칙이 vault 아무 파일이나 읽게 하면 안 된다.
export function parseFolderRules(raw: unknown): Record<string, FolderRule> {
  const out: Record<string, FolderRule> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const rule: FolderRule = {};
    if (typeof o.template === "string" && o.template) {
      const t = o.template;
      if (t.startsWith("/") || t.split("/").includes("..")) continue;
      rule.template = t;
    }
    if (typeof o.prefix === "string" && o.prefix) rule.prefix = o.prefix;
    if (rule.template === undefined && rule.prefix === undefined) continue;
    out[k] = rule;
  }
  return out;
}

/// 이 폴더에 적용할 서식 경로와 제목 접두.
/// 규칙이 없으면 **이름 규약**으로 떨어진다 — 번호를 뗀 폴더 이름을 접두로 쓰고,
/// 서식은 호출부가 그 이름으로 찾는다(template=null).
export function kitRuleFor(rules: Record<string, FolderRule>, folder: string):
    { template: string | null; prefix: string } {
  const r = rules[folder];
  const fallback = folder.replace(/^\d{2}-/, "");
  return { template: r?.template ?? null, prefix: r?.prefix ?? fallback };
}

/// 이 경로가 놓인 팀 폴더와 **그 킷의 뿌리**. 대상이 아니면 null.
///
/// 뿌리를 함께 돌려주는 이유: 폴더별 규칙(folderRules)의 서식 경로가 **킷 뿌리 기준**이라
/// 뿌리를 모르면 읽을 수 없다. 공통은 `<루트>/공통`, 과제는 `<루트>/과제/<과제명>`이다.
///
/// 서식 고르기와 이름 짓기가 **같은 판정**을 써야 한다 — 따로 두면 한쪽만 동작하는 폴더가 생긴다.
///
/// 대상은 두 곳이다(2026-08-02 과제까지 확장):
///   · `<루트>/공통/<구조에 있는 폴더>/…`  — 팀 표준 폴더
///   · `<루트>/과제/<과제명>/<숫자-이름>/…` — 과제 킷이 깐 폴더
///
/// 공통은 **구조 등재 여부**로, 과제는 **숫자-이름 형태**로 가른다. 과제 폴더 목록은
/// 킷마다 달라 한 곳에 모여 있지 않기 때문이다. 둘 다 사용자가 스스로 만든 폴더
/// (번호 없는 이름)에는 끼어들지 않는다 — 거기까지 참견하면 남의 vault 를 흔드는 것이다.
///
/// 서식 폴더(`9N-…`)는 양쪽 모두 제외한다 — 거기서 만드는 파일은 서식을 만드는 중이다.
/// 과제·공통 **바로 밑**의 파일도 제외한다(과제 개요·계획서 자리라 형식을 강제할 곳이 아니다).
export function teamFolderSegment(st: TeamStructure, path: string):
    { folder: string; kitRoot: string } | null {
  const common = `${commonPrefix(st.root)}/`;
  const projects = `${st.root}/${TEAM_PROJECTS_DIR}/`;
  let rest: string[];
  let kitRoot: string;
  if (path.startsWith(common)) {
    rest = path.slice(common.length).split("/");
    if (rest.length < 2) return null;                 // 공통 바로 밑 — 폴더가 없다
    if (!st.folders.includes(rest.slice(0, -1).join("/"))) return null;
    kitRoot = commonPrefix(st.root);
  } else if (path.startsWith(projects)) {
    rest = path.slice(projects.length).split("/");
    if (rest.length < 3) return null;                 // 과제명 + 폴더 + 파일이어야 한다
    kitRoot = `${projects}${rest[0]}`;
  } else {
    return null;
  }
  const folder = rest[rest.length - 2];
  if (!/^\d{2}-/.test(folder)) return null;
  if (/^9\d-/.test(folder)) return null;
  return { folder, kitRoot };
}

/// 번호를 뗀 폴더 이름만. 대상이 아니면 null.
export function teamFolderName(st: TeamStructure, path: string): string | null {
  const seg = teamFolderSegment(st, path);
  if (!seg) return null;
  const name = seg.folder.replace(/^\d{2}-/, "");
  return name || null;
}

/// 새로 만든 노트에 넣어 줄 **팀 서식 본문**. 없으면 null.
///
/// 왜 필요한가: 서식을 `90-템플릿`에 배포해도 새 노트는 **빈 채로** 생긴다. 사람은 빈 화면을
/// 못 채우고, 그러면 서식을 만든 의미가 없다(2026-08-02 지적). Templater 의 폴더 템플릿으로
/// 같은 일을 할 수 있지만 그건 **팀원마다 각자 설정해야** 하는 일이라, 관리자가 한 번 배포하면
/// 끝나야 하는 팀 정책과 맞지 않는다.
///
/// 짝짓는 규칙 — **번호를 뗀 폴더 이름이 서식 파일명에 들어 있으면 그것**.
/// `20-의사결정/` → `의사결정 기록.md`. 폴더에 번호를 붙이기로 한 규약(숫자-이름)이 여기서
/// 한 번 더 값을 한다. 짝이 여럿이면 **가장 짧은 이름**을 고른다(가장 덜 특수한 것).
/// 짝이 없으면 null — 엉뚱한 서식을 넣느니 빈 노트가 낫다.
export function templateForFolder(st: TeamStructure, path: string): string | null {
  const name = teamFolderName(st, path);
  if (!name) return null;
  let best: { path: string; body: string } | null = null;
  for (const t of st.templates) {
    const file = t.path.split("/").pop() || "";
    if (!file.includes(name)) continue;
    if (!best || file.length < (best.path.split("/").pop() || "").length) best = t;
  }
  return best ? best.body : null;
}

/// 옵시디언이 붙인 **기본 이름**인가(`무제` · `Untitled` · 뒤에 번호).
/// 사람이 지은 이름은 절대 건드리지 않는다 — 이 판정이 느슨하면 남이 붙인 제목을 갈아 끼운다.
export function isUntitledName(base: string): boolean {
  return /^(무제|Untitled)( \d+)?$/.test(base);
}

/// 팀 폴더의 새 노트 이름 — `<폴더>-<날짜>`. 같은 이름이 있으면 뒤에 번호를 붙인다.
/// `exists` 는 확장자 없는 이름을 받는다(호출부가 vault 를 본다).
export function nextNoteName(folder: string, dateISO: string, exists: (n: string) => boolean): string {
  const base = `${folder}-${dateISO}`;
  if (!exists(base)) return base;
  for (let n = 2; n < 100; n++) {
    const cand = `${base}-${n}`;
    if (!exists(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

/// 과제 귀속 패턴을 절대 경로로. 서버가 준 folder_patterns 는 **과제명(루트-상대)** 이므로
/// 과제 층을 끼워 넣는다 — 규약이 바뀌어도 서버 저장값은 그대로 둘 수 있다.
export function scopedPatterns(root: string, patterns: string[]): string[] {
  return patterns.map((p) => `${root}/${TEAM_PROJECTS_DIR}/${p}`);
}

/// 마지막으로 vault에 반영된 것으로 아는 팀 폴더 이름들(2026-07-26).
/// 서버는 "지금 이름"만 주고 "예전 이름"은 주지 않는다 — 무엇을 옮길지 알려면 우리가 기억해야 한다.
export interface FolderNameSnapshot {
  root: string;                        // 팀 최상위 루트 폴더명("" = 미설정·해제)
  projects: Record<string, string>;    // 과제 id → 과제명(= 폴더명)
}

/// 옮겨야 할 폴더 한 건 — from·to는 vault 기준 경로다.
export interface FolderRename {
  kind: "root" | "project";
  id: string;      // root면 "", project면 과제 id
  from: string;
  to: string;
}

/// 스냅샷과 현재 서버 값을 비교해 이동이 필요한 폴더를 낸다(계산만 — 실제 이동은 사용자 승인 후).
///
/// 반환 순서가 곧 실행 순서다. **루트가 먼저**이고, 그래서 과제 경로는 옛 루트가 아니라
/// **새 루트** 기준으로 계산한다 — 루트를 먼저 옮기고 나면 그 시점에 과제 폴더는 이미 새 루트
/// 아래에 있기 때문이다. 옛 루트로 계산하면 존재하지 않는 경로를 옮기려다 실패한다.
///
/// 양쪽 루트 중 하나라도 비면 아무것도 하지 않는다 — 첫 동기화(옛 이름을 모름)와 팀 루트
/// 해제(옮길 곳이 없음)가 여기에 해당한다. 어느 쪽이든 폴더를 건드릴 근거가 없다.
export function detectFolderRenames(prev: FolderNameSnapshot, next: FolderNameSnapshot): FolderRename[] {
  if (!prev.root || !next.root) return [];
  const out: FolderRename[] = [];
  if (prev.root !== next.root) out.push({ kind: "root", id: "", from: prev.root, to: next.root });
  for (const [id, prevName] of Object.entries(prev.projects)) {
    const nextName = next.projects[id];
    // 신규 과제는 prev에 없고, 삭제·종결된 과제는 next에 없다 — 둘 다 이동 대상이 아니다.
    if (!nextName || nextName === prevName) continue;
    out.push({ kind: "project", id, from: projectPrefix(next.root, prevName), to: projectPrefix(next.root, nextName) });
  }
  return out;
}

/// relPath 자신의 조상 체인(자기 자신 포함, 얕은 것부터) — "a/b/c" → ["a","a/b","a/b/c"].
function ancestorChain(relPath: string): string[] {
  const segs = relPath.split("/");
  const out: string[] = [];
  let cur = "";
  for (const s of segs) { cur = cur ? `${cur}/${s}` : s; out.push(cur); }
  return out;
}

/// 프리픽스 하나 아래로 매니페스트를 펼친 절대 경로 — **경로 규칙이 존재하는 유일한 장소**.
/// 팀 공통 = manifestPaths(commonPrefix(root), teamStructure), 과제 = manifestPaths(projectPrefix(root, 과제명), kitManifest).
/// prefix 자체 폴더를 항상 포함한다(루트·과제 폴더가 먼저 생겨야 하위가 생긴다).
///
/// 세 가지를 함께 한다(스펙 §4a) — 깊이 정렬만으로는 (1)을 해결하지 못한다(목록에 없는 조상은
/// 정렬해도 여전히 없다. 조상 합성과 정렬이 함께 필요하다):
/// (1) **조상 경로 합성** — 서버 validate_structure는 부모 폴더가 목록에 있을 것을 요구하지
///     않는다(예: folders에 "연구노트/실험"만 있어도, templates에 "연구노트/실험/_t.md"만
///     있어도 유효). Obsidian vault.createFolder는 비재귀이고 vault.create는 부모를 만들지
///     않으므로, 중간 폴더가 목록에 없으면 생성이 조용히 실패하고 뱃지가 영구 "부분"으로 남는다.
///     그래서 folders·templates 각 경로의 조상 체인을 prefix 아래 범위에서 전개해 folders에
///     포함시킨다(prefix 자체 밖은 합성하지 않는다 — prefix는 호출자가 이미 보장한 스코프).
/// (2) **순서 유지 중복 제거** — folderStatus(유일화함)와 creationPlan(안 함)이 갈려 뱃지 total과
///     실제 생성 수가 어긋나는 것을 막는다.
/// (3) **세그먼트 깊이 오름차순 정렬**(안정) — 조상이 자식보다 먼저 생성되게 한다.
/// (4) **샘플 제외**(2026-07-27, opts.samples=false 기본) — `_samples/` 아래는 하지도 않은
///     실험·수업 기록이다. vault에 만들면 `.md`라 **봉인**되고, 봉인은 되돌릴 수 없다.
///     그래서 기본은 만들지 않는다(사용자가 켜야 만들어진다).
export function manifestPaths(prefix: string, m: KitManifest, opts?: { samples?: boolean }): {
  folders: string[]; files: { path: string; body: string; url?: string }[]; allPaths: string[];
} {
  const depth = (p: string) => p.split("/").length;
  const wantSamples = opts?.samples === true;
  const keep = (rel: string) => wantSamples || !isKitSamplePath(rel);

  const folderRel = new Set<string>();
  for (const f of m.folders) if (keep(f)) for (const a of ancestorChain(f)) folderRel.add(a);
  const dirsOf = (rel: string) => {
    const dirEnd = rel.lastIndexOf("/");
    if (dirEnd > 0) for (const a of ancestorChain(rel.slice(0, dirEnd))) folderRel.add(a);
  };
  for (const t of m.templates) if (keep(t.path)) dirsOf(t.path);
  for (const f of m.files || []) if (keep(f.path)) dirsOf(f.path);
  const folders = [...new Set([prefix, ...[...folderRel].map((f) => `${prefix}/${f}`)])]
    .sort((a, b) => depth(a) - depth(b));

  const seen = new Set<string>();
  const files: { path: string; body: string; url?: string }[] = [];
  // 내장 킷: templates에 본문 인라인. 팀 킷: files에 URL — 본문은 생성 시점에 받는다.
  for (const t of m.templates) {
    if (!keep(t.path)) continue;
    const path = `${prefix}/${t.path}`;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, body: t.body });
  }
  for (const f of m.files || []) {
    if (!keep(f.path)) continue;
    const path = `${prefix}/${f.path}`;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, body: "", url: f.url });
  }
  return { folders, files, allPaths: [...folders, ...files.map((f) => f.path)] };
}

/// 서버가 준 경로를 vault 경로와 **같은 유니코드 형태**로 맞춘다(2026-08-05).
///
/// Obsidian은 vault 경로를 NFC로 다룬다(공개 API normalizePath 자체가 마지막에 NFC 정규화를 한다).
/// 반면 팀 구조 문자열은 관리자가 포털에 입력한 것이라, macOS Finder에서 폴더 이름을 복사해 붙이면
/// NFD로 들어온다 — `"나날랩스".normalize("NFD") !== "나날랩스"`이고 길이도 4 vs 10이다.
///
/// 형태가 갈리면 Set 비교가 통째로 어긋난다: 폴더가 **이미 있는데도** folderStatus가 매번 없다고
/// 판정해 자동 적용이 계속 만들려 들고(Obsidian은 중복이라 조용히 거절), 서버에는 영원히
/// missing>0으로 보고돼 멀쩡한 팀원에게 미적용 경보가 뜬다. detectFolderConflicts(:1088)가
/// 정규화를 호출부 몫으로 남긴 이유가 이것이다 — 여기가 그 호출부의 도구다.
///
/// 비용은 재고 나서 정했다: 5만 경로 NFC 정규화 실측 3.7ms(node). 대상은 수십 건뿐이라 사실상 공짜다.
export function nfcPath(p: string): string { return p.normalize("NFC"); }

/// manifestPaths 결과 전체를 NFC로 맞춘다. body는 손대지 않는다 — 경로가 아니라 내용이다.
export function nfcPaths(p: {
  folders: string[]; files: { path: string; body: string; url?: string }[]; allPaths: string[];
}): { folders: string[]; files: { path: string; body: string; url?: string }[]; allPaths: string[] } {
  return {
    folders: p.folders.map(nfcPath),
    files: p.files.map((f) => ({ ...f, path: nfcPath(f.path) })),
    allPaths: p.allPaths.map(nfcPath),
  };
}

/// 바이너리로 써야 하는 파일인가 — 텍스트 API(vault.create)로 쓰면 바이트가 손상된다.
/// 마크다운 킷에는 이미지·PDF가 섞여 오므로 판정이 필요하다. 목록에 없는 확장자는 텍스트로
/// 본다(킷 내용물은 대부분 .md이고, 오판해도 텍스트 쪽이 복구 가능하다).
export function isBinaryPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|zip|xlsx?|docx?|pptx?|mp4|mov|mp3|wav|ttf|otf|woff2?)$/i.test(path);
}

/// 킷 안의 샘플 경로인가 — `_samples/` 세그먼트. 서버 `is_sample`(routes/team_kits.rs)과
/// **같은 규칙**이어야 한다: 어긋나면 서버가 샘플이라 표시한 파일을 여기서 실제 기록으로 만든다.
export function isKitSamplePath(rel: string): boolean {
  return rel.split("/").some((seg) => seg === "_samples");
}

/// 생성 계획 — 미존재분만(덮어쓰기 절대 없음).
export function creationPlan(
  p: { folders: string[]; files: { path: string; body: string; url?: string }[] }, existing: Set<string>,
): { folders: string[]; files: { path: string; body: string; url?: string }[] } {
  return {
    folders: p.folders.filter((f) => !existing.has(f)),
    files: p.files.filter((f) => !existing.has(f.path)),
  };
}

/// 폴더 생성 상태(통합 폴더 만들기 모달, 2026-07-25). allPaths = 매니페스트 전체 경로
/// (root + folders + template paths, manifestPaths와 동일 집합).
/// existing = vault의 기존 경로 Set. 중복 경로는 유일 집합으로 센다.
export interface FolderStatus { total: number; existing: number; missing: number; state: "done" | "partial" | "none"; }
export function folderStatus(allPaths: string[], existing: Set<string>): FolderStatus {
  const uniq = [...new Set(allPaths)];
  const total = uniq.length;
  const exist = uniq.filter((p) => existing.has(p)).length;
  const missing = total - exist;
  const state: FolderStatus["state"] = missing === 0 ? "done" : exist > 0 ? "partial" : "none";
  return { total, existing: exist, missing, state };
}

/// 만들어야 할 폴더 대상 한 건 — 팀 공통(`<루트>/공통`) 또는 참여 과제(`<루트>/과제/<이름>`).
/// 계산은 NanalStampPlugin.teamFolderTargets 한 곳뿐이고, 모달(FolderCreateModal)과 자동 적용이
/// 그 결과를 함께 본다. 상태(folderStatus)는 여기 없다 — vault 스냅샷 시점에 달린 값이라
/// 보는 쪽이 자기 시점에 판정한다(모달의 FolderRow가 그것을 얹는다).
export interface FolderTarget {
  kind: "team" | "project";
  label: string;
  pathLabel: string;                           // 실제 생성 경로(부제 표시 — 무엇이 어디 생기는지 보이게)
  folders: string[];                          // 프리픽스 적용된 전체 폴더 경로(생성 대상)
  files: { path: string; body: string; url?: string }[]; // 프리픽스 적용된 파일(생성 대상). url = 팀 킷(S3)
  hasSamples?: boolean;                        // 이 킷에 _samples/ 가 있나(체크박스 노출 판정)
  allPaths: string[];                          // folders + files.path — folderStatus 판정용
  failed: boolean;                             // 킷 로드 실패(과제) — 체크 불가
}

/// 자동 생성이 **남의 노트를 팀 범위로 끌어들이게 되는** 폴더(2026-08-05).
///
/// 팀 루트가 `연구노트` 인데 개인 `연구노트` 가 이미 있으면, 그 아래에 팀 구조를 만드는 순간
/// 그 사람의 개인 노트가 팀 경로에 놓인다(= 팀 자료로 판정된다, 0017/0020). 되돌릴 수 없으므로
/// **자동으로 하지 않고 관리자에게 보고한다.** 팀원에게 묻지 않는다 — 팀원이 거부하면
/// 그 사람만 규정 밖에 남고 아무도 모른다.
///
/// 충돌 = **아직 한 번도 적용되지 않은** 대상의 폴더가 이미 있고 그 안에 파일이 들어 있다.
///
/// ★ "팀 구조 목록(allPaths)에 없는 파일이 있으면 충돌"로 재면 **안 된다**(2026-08-05 실기기에서
///   잡았다). allPaths 에는 **서식만** 들어 있어서, 팀원이 팀 폴더 안에서 정상적으로 쓴 업무
///   노트는 당연히 그 목록에 없다. 그렇게 재면 **일을 시작한 팀원 전원이 즉시 「이름 충돌」로
///   잡히고**(실측: 업무 노트 1개로 `시험연구소/공통`이 충돌 처리됨) 그 뒤로 폴더 생성까지
///   막힌다 — 가장 활발한 사람일수록 먼저 걸린다.
///
/// 가르는 기준은 「목록에 있나」가 아니라 **「이 폴더가 팀 구조가 생기기 전부터 남의 것이었나」**다:
///  - 그 대상의 구조가 vault 에 **하나도 없다**(applied 전) + 폴더는 이미 있고 파일이 들어 있다 → 충돌.
///  - 구조가 일부라도 있다 → 이미 「우리 것」이고 안의 노트는 업무 산출물이다 → 충돌 아님.
///
/// **팀 루트 자체도 검사한다.** 루트는 만들 폴더 목록(`<루트>/공통…`)에 안 들어가는데,
/// 정작 가장 위험한 경우가 「팀 루트와 같은 이름의 개인 폴더」다(초안은 이걸 못 잡았다 — 실측).
///
/// 겹치는 폴더는 가장 얕은 것만 — 한 사건이다.
/// 경로 비교는 이 파일의 다른 함수(folderStatus 등)와 마찬가지로 원문 그대로 한다 — Obsidian이 주는
/// 경로 정규화(대소문자·유니코드)는 호출부가 vault API로부터 그대로 받는 값이라 여기서 손대지 않는다.
///
/// 성능(2026-08-05): folders × vaultFiles로 곱해 도는 초안은 대형 vault(수만 파일)에서 실측
/// 100ms대였다(node 벤치, folders=80·files=5만 → ~106ms — 이 함수는 프로파일을 받을 때마다 불린다).
/// 파일마다 자기 조상 경로를 **얕은 것부터** 훑어 팀 폴더 집합(Set, O(1) 조회)에 처음 걸리는 곳에서
/// 멈추는 방향으로 뒤집었다 — "가장 얕은 것만" 규칙이 조상 체인이 얕은 순서로 온다는 성질 자체로
/// 만족되어 별도 중첩 제거 단계가 필요 없다. O(folders·files) → O(files·평균 경로 깊이), 같은
/// 벤치에서 ~8ms로 줄었다(약 13배).
///
/// @param roots     검사할 폴더의 뿌리들 — 각 대상의 프리픽스(`<루트>/공통`·`<루트>/과제/<이름>`)와
///                  **팀 루트**. 각각 "아직 적용 안 된 것"만 넘긴다(판정은 호출부 몫이다 —
///                  대상별 구조 존재 여부는 folderStatus 로 재는 것이라 여기서 다시 세지 않는다).
/// @param vaultFiles vault 의 **파일** 경로만(폴더 제외 — 빈 폴더는 충돌이 아니다)
export function detectFolderConflicts(roots: string[], vaultFiles: string[]): string[] {
  if (!roots.length) return [];
  const rootSet = new Set(roots);
  const conflicted = new Set<string>();
  for (const p of vaultFiles) {
    const dirEnd = p.lastIndexOf("/");
    if (dirEnd <= 0) continue; // 최상위 파일은 어떤 팀 폴더 아래도 아니다
    for (const dir of ancestorChain(p.slice(0, dirEnd))) {
      if (rootSet.has(dir)) { conflicted.add(dir); break; } // 얕은 것부터 훑으므로 첫 일치가 곧 최얕
    }
  }
  // 겹치면 얕은 것만 남긴다 — `<루트>`와 `<루트>/공통`이 함께 걸리면 한 사건이다.
  const out: string[] = [];
  for (const dir of [...conflicted].sort((a, b) => a.length - b.length)) {
    if (!out.some((o) => dir.startsWith(o + "/"))) out.push(dir);
  }
  return out;
}

// ── 폴더 상태 보고 — 서버 상한에 맞춰 자르기(Task 11, 2026-08-05) ──────────────────

/// 서버(`routes/team/folder_state.rs`) 배열 상한. 넘으면 통째로 400 — 보고 자체가 저장되지
/// 않고 관리자 화면은 지난 상태(또는 "확인 안 됨")에 멈춘다. 두 상수는 서버 값을 그대로 옮긴
/// 것이라 서버가 바뀌면 여기도 같이 바꿔야 한다(공유 모듈이 아니므로 자동으로 안 맞는다).
export const FOLDER_REPORT_MAX_ITEMS = 50;
/// 서버는 Rust `String::len()`(= UTF-8 바이트 길이)로 잰다. JS `.length`는 UTF-16 코드유닛이라
/// 한글 경로에서는 훨씬 적은 글자 수에서 이미 400바이트를 넘을 수 있다 — 바이트로 재야 한다.
export const FOLDER_REPORT_MAX_PATH_BYTES = 400;

/// 문자열을 UTF-8 기준 `max`바이트 이하로 자른다. 서로게이트 쌍 중간을 끊어도(극히 드문 극단
/// 사례) 에러 없이 한 글자씩 더 줄어들 뿐이라 안전하다 — 표시·판별용 경로 자르기라 완벽한
/// 문자 경계 보존까지는 필요 없다.
function truncateToBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).byteLength <= max) return s;
  let out = s;
  while (enc.encode(out).byteLength > max) out = out.slice(0, -1);
  return out;
}

/// 폴더 상태 보고(conflicts·pending_renames)를 서버 상한에 맞춰 자른다.
///
/// 정상 vault라면 이 상한에 걸릴 일이 거의 없지만(팀 구조가 만드는 폴더 수 자체가 수십 개
/// 미만), 과제가 수십 개로 늘어난 팀이나 이름이 아주 긴 한글 경로에서는 이론상 넘을 수
/// 있다 — 걸렸을 때 통째로 실패시키느니 잘라서라도 보내는 편이 낫다: 이번 보고가 저장돼야
/// 관리자 화면이 최신 상태를 반영하고, 반쯤이라도 아는 것이 계속 "확인 안 됨"으로 남는 것보다
/// 낫다. 자르는 순서는 호출자가 이미 급한 순으로 넘긴다 — conflicts는 얕은 것부터
/// (detectFolderConflicts), pending_renames는 루트가 먼저(detectFolderRenames) — 그래서 앞에서
/// 자르면 가장 급한 항목이 남는다.
///
/// "잘렸다"를 알리는 필드는 서버 스키마에 없고 임의로 추가하지 않는다 — 대신 정확히 상한
/// 개수(50개)가 찍히는 것 자체가 관리자에게는 "더 있을 수 있다"는 신호로 충분하다.
export function capFolderReport(
  conflicts: string[], pendingRenames: { from: string; to: string }[],
): { conflicts: string[]; pendingRenames: { from: string; to: string }[] } {
  const cap = (s: string) => truncateToBytes(s, FOLDER_REPORT_MAX_PATH_BYTES);
  return {
    conflicts: conflicts.slice(0, FOLDER_REPORT_MAX_ITEMS).map(cap),
    pendingRenames: pendingRenames.slice(0, FOLDER_REPORT_MAX_ITEMS)
      .map((r) => ({ from: cap(r.from), to: cap(r.to) })),
  };
}

// ── 업무 등록 다중 수신자(인별 복제) — 순수 페이로드 생성·결과 요약(§ fan-out, 웹과 동일 동작) ──

export interface TaskComposeFields {
  title: string;
  body: string;
  memo?: string;      // "" = 없음(§비고, 서버 4KB 상한은 호출자가 먼저 가드) — 옵션(구 호출자 호환)
  priority: string;
  startDate?: string; // "" = 없음(§시작일 디폴트는 호출자가 오늘로 채워 넣는다) — 옵션(구 호출자 호환)
  due: string;       // 마감기한은 항상 필수(2026-07-24 결정) — 호출자가 제출 전에 반드시 채워 넣는다.
  projectId: string; // "" = 과제 없음(§3)
}

/// 다중 수신자 제출 페이로드 생성 — 인별 복제(웹과 동일 동작). 마감기한은 항상 필수이므로 assignees=[]
/// (personal 1건)이든 assignees 1개 이상(각자 assignee_uid)이든 due_date를 포함한다(빈 값 검증은 호출자 소관).
export function buildTaskCreatePayloads(f: TaskComposeFields, assignees: string[]): Record<string, unknown>[] {
  const base: Record<string, unknown> = { title: f.title, body: f.body, priority: f.priority };
  if (f.projectId) base.project_id = f.projectId;
  if (f.memo) base.memo = f.memo;
  if (f.startDate) base.start_date = f.startDate;
  if (assignees.length === 0) {
    return [{ ...base, due_date: f.due }];
  }
  return assignees.map((uid) => ({ ...base, assignee_uid: uid, due_date: f.due }));
}

export interface FanoutOutcome {
  assignee: string;
  label: string; // Notice 표시용(별칭 또는 이메일) — roster 조회 실패 시 uid로 폴백
  ok: boolean;
}

/// 순차 POST 결과 요약(순서 보존) — 성공 수 + 실패 라벨 목록. UI는 이 값을 i18n 문구에 꽂아 쓴다.
export function summarizeFanout(outcomes: FanoutOutcome[]): { okCount: number; failed: string[] } {
  let okCount = 0;
  const failed: string[] = [];
  for (const o of outcomes) {
    if (o.ok) okCount++;
    else failed.push(o.label);
  }
  return { okCount, failed };
}
