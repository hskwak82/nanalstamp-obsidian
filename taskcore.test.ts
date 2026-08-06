import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTasksResponse, parseRepliesResponse, parseRosterResponse,
  personDisplay, rosterLabel, canEditTask,
  isOverdue, dueKind, sectionize, partitionMine, badgeCount, isUnread, conflictRenameSuggestion,
  unionTasks, snapshotOf, diffSnapshot, TaskItem,
  sseInitialState, sseFeed, tasksRenderKey,
  parsePatterns, matchesPatterns, unreported,
  parseTeamStructure, parseKitManifest, manifestPaths, creationPlan, isValidFolderName,
  isKitSamplePath, isBinaryPath,
  digestFolderFor,
  projectPrefix, commonPrefix, scopedPatterns, folderStatus, FolderStatus, detectFolderRenames,
  detectFolderConflicts, nfcPath, nfcPaths, capFolderReport, FOLDER_REPORT_MAX_ITEMS,
  templateForFolder, teamFolderName, isUntitledName, nextNoteName, parseFolderRules, kitRuleFor, teamFolderSegment,
  buildTaskCreatePayloads, summarizeFanout,
  unifyTasks, sortUnified, taskPasses, groupUnified, boardColumns, taskActionDefs,
  TaskType, UnifiedTask, TaskFilterState, SortKey, SortDir, GroupBy,
} from "./taskcore";

const TODAY = "2026-07-23";

function mk(over: Partial<TaskItem>): TaskItem {
  return {
    id: "t1", creatorUid: "u-a", creatorEmail: "a@t.com", creatorName: null,
    assigneeUid: "u-b", assigneeEmail: "b@t.com", assigneeName: null,
    title: "T", body: "", memo: "", priority: "week", status: "requested",
    linkedNotePath: null, startDate: null, dueDate: null,
    requestedAt: 100, acceptedAt: null, doneAt: null, doneBy: null, doneComment: null, declineReason: null,
    reopenReason: null, reopenedAt: null, reopenedBy: null,
    createdAt: 100, updatedAt: 100, replyCount: 0, lastReplyAt: null, lastReplyAuthorEmail: null,
    myReadAt: null,
    ...over,
  };
}

function mku(over: Partial<UnifiedTask>): UnifiedTask {
  return { ...mk(over), taskType: (over.taskType ?? "received") as TaskType };
}

test("parseTasksResponse: 정상 행 파싱 + 불량 행 스킵 + last_reply 평탄화", () => {
  const j = {
    tasks: [
      {
        id: "a", creator_uid: "u1", creator_email: "a@t.com", creator_name: "김연구",
        assignee_uid: "u2", assignee_email: "b@t.com", assignee_name: null,
        title: "보고서", body: "본문", memo: "", priority: "now", status: "requested",
        linked_note_path: "장비일지/2026-06.md", start_date: null, due_date: "2026-07-24",
        requested_at: 10, accepted_at: null, done_at: null, done_by: null, decline_reason: null,
        created_at: 10, updated_at: 11, reply_count: 2,
        last_reply: { body: "네", author_email: "b@t.com", created_at: 12 },
      },
      { id: "b", title: "개인 메모", status: "personal", created_at: 5, priority: "week", reply_count: 0, last_reply: null },
      { id: 3, title: "불량", status: "personal", created_at: 1 },   // id 타입 불량
      { id: "d", title: "불량", status: "personal" },                 // created_at 없음
    ],
    has_more: true,
    cursor: "10_a",
  };
  const r = parseTasksResponse(j);
  assert.equal(r.tasks.length, 2);
  assert.equal(r.tasks[0].id, "a");
  assert.equal(r.tasks[0].dueDate, "2026-07-24");
  assert.equal(r.tasks[0].linkedNotePath, "장비일지/2026-06.md");
  assert.equal(r.tasks[0].replyCount, 2);
  assert.equal(r.tasks[0].lastReplyAt, 12);
  assert.equal(r.tasks[0].lastReplyAuthorEmail, "b@t.com");
  assert.equal(r.tasks[0].creatorName, "김연구", "*_name 필드 수용");
  assert.equal(r.tasks[0].assigneeName, null);
  assert.equal(r.tasks[1].creatorName, null, "필드 없는 구서버 응답도 null로 안전");
  assert.equal(r.tasks[1].assigneeUid, null);
  assert.equal(r.tasks[1].lastReplyAt, null);
  assert.equal(r.hasMore, true);
  assert.equal(r.cursor, "10_a");
  // 비정상 응답은 빈 결과.
  assert.deepEqual(parseTasksResponse(null), { tasks: [], hasMore: false, cursor: null });
  assert.deepEqual(parseTasksResponse({ tasks: "x" }), { tasks: [], hasMore: false, cursor: null });
});

test("parseRepliesResponse / parseRosterResponse: 파싱 + 불량 스킵 + roster 이메일 정렬", () => {
  const rs = parseRepliesResponse({ replies: [
    { id: "r1", author_uid: "u1", author_email: "a@t.com", author_name: "김연구", body: "안녕", created_at: 3 },
    { id: "r2", body: 7, created_at: 4 }, // body 타입 불량
  ] });
  assert.equal(rs.length, 1);
  assert.equal(rs[0].body, "안녕");
  assert.equal(rs[0].authorName, "김연구");
  assert.deepEqual(parseRepliesResponse(null), []);

  const ms = parseRosterResponse({ members: [
    { user_id: "u2", email: "b@t.com", display_name: "박실험", role: "member" },
    { user_id: "u1", email: "a@t.com", role: "owner" },
    { user_id: 9, email: "bad@t.com" }, // user_id 불량
  ] });
  assert.deepEqual(ms.map((m) => m.email), ["a@t.com", "b@t.com"], "이메일 정렬");
  assert.equal(ms[0].role, "owner");
  assert.equal(ms[0].displayName, null);
  assert.equal(ms[1].displayName, "박실험");
  assert.deepEqual(parseRosterResponse(null), []);
});

test("personDisplay/rosterLabel: 별칭 우선, 없으면 이메일 전체 폴백(로컬파트 자르기 금지)", () => {
  assert.equal(personDisplay("김연구", "kim@t.com"), "김연구", "별칭 우선");
  assert.equal(personDisplay(null, "kim@t.com"), "kim@t.com", "별칭 없으면 이메일 전체");
  assert.equal(personDisplay(null, null), "?", "둘 다 없으면 ?");
  assert.equal(rosterLabel({ userId: "u", email: "kim@t.com", displayName: "김연구", role: "member" }),
    "김연구 (kim@t.com)", "선택 옵션은 병기(별칭 중복 구분)");
  assert.equal(rosterLabel({ userId: "u", email: "kim@t.com", displayName: null, role: "member" }),
    "kim@t.com");
});

test("isOverdue/dueKind: 열린 상태 + 마감 지남만 초과, personal·done은 제외", () => {
  assert.ok(isOverdue(mk({ dueDate: "2026-07-22", status: "requested" }), TODAY));
  assert.ok(isOverdue(mk({ dueDate: "2026-07-01", status: "accepted" }), TODAY));
  assert.ok(!isOverdue(mk({ dueDate: "2026-07-23", status: "requested" }), TODAY), "오늘 마감은 아직");
  assert.ok(!isOverdue(mk({ dueDate: null, status: "requested" }), TODAY), "무마감");
  assert.ok(!isOverdue(mk({ dueDate: "2026-07-01", status: "done" }), TODAY), "완료건 제외");
  assert.ok(!isOverdue(mk({ dueDate: "2026-07-01", status: "personal" }), TODAY), "personal 제외");
  assert.equal(dueKind(null, TODAY), "none");
  assert.equal(dueKind("2026-07-22", TODAY), "overdue");
  assert.equal(dueKind("2026-07-23", TODAY), "today");
  assert.equal(dueKind("2026-07-30", TODAY), "future");
});

test("sectionize: 접수 대기/진행 중/반려 분류 + 진행 중은 마감 초과 상단·마감 임박순", () => {
  const tasks = [
    mk({ id: "w1", status: "requested", dueDate: "2026-07-30", createdAt: 1 }),
    mk({ id: "a1", status: "accepted", dueDate: "2026-07-28", createdAt: 2 }),
    mk({ id: "a2", status: "accepted", dueDate: "2026-07-20", createdAt: 3 }), // 초과 → 최상단
    mk({ id: "p1", status: "personal", assigneeUid: null, dueDate: null, createdAt: 9 }),
    mk({ id: "a3", status: "accepted", dueDate: "2026-07-25", createdAt: 4 }),
    mk({ id: "d1", status: "declined", createdAt: 5 }),
    mk({ id: "x1", status: "canceled", createdAt: 6 }), // 방어: 어느 섹션에도 없음
  ];
  const s = sectionize(tasks, TODAY);
  assert.deepEqual(s.waiting.map((t) => t.id), ["w1"]);
  assert.deepEqual(s.active.map((t) => t.id), ["a2", "a3", "a1", "p1"], "초과 → 임박순 → 무마감 뒤");
  assert.deepEqual(s.declined.map((t) => t.id), ["d1"]);
});

test("partitionMine: 수신자 유무로 보낸 요청/내 업무 분리", () => {
  const { sent, personal } = partitionMine([
    mk({ id: "s1" }),
    mk({ id: "p1", assigneeUid: null, status: "personal" }),
    mk({ id: "s2", status: "declined" }),
  ]);
  assert.deepEqual(sent.map((t) => t.id), ["s1", "s2"]);
  assert.deepEqual(personal.map((t) => t.id), ["p1"]);
});

test("badgeCount: inbox의 접수 대기 + 마감 초과, 이중 계산 없음", () => {
  const inbox = [
    mk({ id: "1", status: "requested", dueDate: "2026-07-20" }), // 대기 + 초과 → 1건
    mk({ id: "2", status: "requested" }),                        // 대기
    mk({ id: "3", status: "accepted", dueDate: "2026-07-22" }),  // 초과
    mk({ id: "4", status: "accepted", dueDate: "2026-07-30" }),  // 진행(비초과) — 미포함
  ];
  assert.equal(badgeCount(inbox, [], TODAY), 3);
  assert.equal(badgeCount([], [], TODAY), 0);
});

// ── 읽음 배지(2026-08-06, plans/2026-08-06-task-read-badge.md) ──────────────

test("isUnread: strict > 판정 — 같으면 읽음, 재료 없으면(구서버) 비활성", () => {
  assert.equal(isUnread(mk({ updatedAt: 200, myReadAt: 100 })), true, "연 뒤에 활동 = 안읽음");
  assert.equal(isUnread(mk({ updatedAt: 200, myReadAt: 200 })), false, "같음 = 읽음(행위자 touch가 같은 시각을 찍는다)");
  assert.equal(isUnread(mk({ updatedAt: 200, myReadAt: 300 })), false, "읽은 뒤 활동 없음");
  assert.equal(isUnread(mk({ updatedAt: 200, myReadAt: 0 })), true, "한 번도 안 열었으면 안읽음");
  assert.equal(isUnread(mk({ updatedAt: 200, myReadAt: null })), false, "구서버 응답(my_read_at 부재) = 판정 비활성");
});

test("badgeCount: 읽지 않음 ∪ 상태 조건 — mine도 세고, 셀프 할당은 1건", () => {
  const inbox = [
    mk({ id: "1", status: "accepted", updatedAt: 200, myReadAt: 100 }),  // 안읽음만 → 1건
    mk({ id: "2", status: "requested", updatedAt: 200, myReadAt: 300 }), // 읽었지만 접수 대기 → 유지(합집합)
    mk({ id: "3", status: "accepted", updatedAt: 200, myReadAt: 300 }),  // 읽음·조건 없음 → 미포함
    mk({ id: "4", status: "accepted", updatedAt: 200, myReadAt: 100 }),  // 셀프 할당(mine에도 있음)
  ];
  const mine = [
    mk({ id: "4", status: "accepted", updatedAt: 200, myReadAt: 100 }),  // inbox가 이미 셌다 → 미포함
    mk({ id: "5", status: "accepted", updatedAt: 200, myReadAt: 100 }),  // 내가 만든 업무의 새 활동 → 1건
    mk({ id: "6", status: "requested", updatedAt: 200, myReadAt: 300 }), // mine은 접수 대기를 세지 않는다
    mk({ id: "7", status: "done", updatedAt: 200, myReadAt: 100 }),      // 완료됐는데 안 읽음 → 1건
  ];
  assert.equal(badgeCount(inbox, mine, TODAY), 5);
});

test("conflictRenameSuggestion: 같은 부모 아래 -접미사, 있으면 -2·-3", () => {
  const ex = new Set(["시험연구소", "회의록-개인", "회의록-개인-2"]);
  assert.equal(conflictRenameSuggestion("시험연구소", ex, "개인"), "시험연구소-개인");
  assert.equal(conflictRenameSuggestion("회의록", ex, "개인"), "회의록-개인-3", "이미 있으면 번호 증가");
  assert.equal(conflictRenameSuggestion("팀루트/공통", new Set(), "개인"), "팀루트/공통-개인", "부모 경로 유지");
});

test("badgeCount: 마감 초과는 읽어도 사라지지 않는다", () => {
  const inbox = [mk({ id: "1", status: "accepted", dueDate: "2026-07-20", updatedAt: 200, myReadAt: 300 })];
  assert.equal(badgeCount(inbox, [], TODAY), 1);
});

test("unionTasks: id 중복(셀프 할당) 제거 — inbox 우선", () => {
  const u = unionTasks([mk({ id: "x", replyCount: 5 })], [mk({ id: "x", replyCount: 0 }), mk({ id: "y" })]);
  assert.deepEqual(u.map((t) => t.id), ["x", "y"]);
  assert.equal(u[0].replyCount, 5, "inbox 항목 우선");
});

test("diffSnapshot: 새 할당 — 스냅샷에 없던 requested + 재요청(declined→requested)", () => {
  const prev = snapshotOf([mk({ id: "old", status: "declined" })], TODAY);
  const inbox = [
    mk({ id: "new", status: "requested" }),
    mk({ id: "old", status: "requested" }), // 재요청
    mk({ id: "acc", status: "accepted" }),  // 진행 중 — 할당 알림 아님
  ];
  const ev = diffSnapshot(prev, inbox, [], TODAY, "b@t.com");
  assert.deepEqual(ev.filter((e) => e.type === "assigned").map((e) => e.task.id), ["new", "old"]);
});

test("diffSnapshot: 새 회신 — 회신 수 증가 + 내 글 에코 제외, 미지의 업무는 침묵", () => {
  const known = mk({ id: "k", replyCount: 1, lastReplyAt: 10, status: "accepted" });
  const prev = snapshotOf([known], TODAY);
  // 상대(a@t.com)의 회신 → 알림.
  const bumped = mk({ id: "k", replyCount: 2, lastReplyAt: 20, lastReplyAuthorEmail: "a@t.com", status: "accepted" });
  let ev = diffSnapshot(prev, [bumped], [], TODAY, "b@t.com");
  assert.deepEqual(ev.map((e) => e.type), ["reply"]);
  // 내 회신 에코 → 침묵.
  const mineEcho = mk({ id: "k", replyCount: 2, lastReplyAt: 20, lastReplyAuthorEmail: "b@t.com", status: "accepted" });
  ev = diffSnapshot(prev, [mineEcho], [], TODAY, "b@t.com");
  assert.equal(ev.length, 0);
  // 내 이메일을 모르면(빈 문자열) 보수적으로 알림.
  ev = diffSnapshot(prev, [mineEcho], [], TODAY, "");
  assert.deepEqual(ev.map((e) => e.type), ["reply"]);
  // 스냅샷에 없던 업무의 회신은 침묵(시작 소음 방지).
  ev = diffSnapshot({}, [], [bumped], TODAY, "b@t.com");
  assert.equal(ev.length, 0);
});

test("diffSnapshot: 새로 마감 초과 — 미초과→초과 전이만, 이미 초과였으면 침묵", () => {
  const before = mk({ id: "d", status: "accepted", dueDate: "2026-07-23" }); // 어제 기준 미초과
  const prev = snapshotOf([before], "2026-07-22");
  const now = mk({ id: "d", status: "accepted", dueDate: "2026-07-23" });    // 오늘(24일) 기준 초과
  let ev = diffSnapshot(prev, [now], [], "2026-07-24", "b@t.com");
  assert.deepEqual(ev.map((e) => e.type), ["overdue"]);
  // 직전에도 이미 초과 → 반복 알림 없음.
  const prevOver = snapshotOf([now], "2026-07-24");
  ev = diffSnapshot(prevOver, [now], [], "2026-07-25", "b@t.com");
  assert.equal(ev.length, 0);
  // mine 쪽(보낸 요청)의 초과도 감지.
  ev = diffSnapshot(prev, [], [now], "2026-07-24", "a@t.com");
  assert.deepEqual(ev.map((e) => e.type), ["overdue"]);
});

test("diffSnapshot: 복합 — 재요청+회신+초과가 한 폴링에 섞여도 각각 1건", () => {
  const prev = snapshotOf([
    mk({ id: "r", status: "declined" }),
    mk({ id: "c", status: "accepted", replyCount: 0, dueDate: "2026-07-25" }),
  ], "2026-07-23");
  const inbox = [
    mk({ id: "r", status: "requested" }),
    mk({ id: "c", status: "accepted", replyCount: 1, lastReplyAt: 30, lastReplyAuthorEmail: "a@t.com", dueDate: "2026-07-25" }),
  ];
  const ev = diffSnapshot(prev, inbox, [], "2026-07-26", "b@t.com");
  const types = ev.map((e) => e.type).sort();
  assert.deepEqual(types, ["assigned", "overdue", "reply"]);
});

// ── SSE 라인 파서(sseFeed) — 청크 경계 안전성 ──

test("sseFeed: 완성된 이벤트 파싱(event+data, 값 선행 공백 제거)", () => {
  const r = sseFeed(sseInitialState(), 'event: changed\ndata: {"wm":123}\n\n');
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { event: "changed", data: '{"wm":123}' });
  assert.deepEqual(r.state, { buf: "", event: "", data: [] });
});

test("sseFeed: 라인 중간·이벤트 중간에서 잘린 청크를 상태로 이어 붙인다", () => {
  let st = sseInitialState();
  let all: ReturnType<typeof sseFeed>["events"] = [];
  // "event: changed\ndata: {"wm":1}\n\n"을 잔인하게 쪼갠다.
  for (const chunk of ["ev", "ent: chan", "ged\nda", 'ta: {"wm"', ":1}\n", "\n"]) {
    const r = sseFeed(st, chunk);
    st = r.state;
    all = all.concat(r.events);
  }
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], { event: "changed", data: '{"wm":1}' });
});

test("sseFeed: 한 청크에 여러 이벤트 + 코멘트(: ping)는 무시", () => {
  const chunk = "event: hello\ndata: {\"wm\":9}\n\n: ping\n\nevent: changed\ndata: {\"wm\":10}\n\n";
  const r = sseFeed(sseInitialState(), chunk);
  assert.deepEqual(r.events.map((e) => e.event), ["hello", "changed"]);
  assert.equal(r.events[1].data, '{"wm":10}');
});

test("sseFeed: CRLF 개행 + event 없는 data는 message + 이벤트 간 event명 리셋", () => {
  const r = sseFeed(sseInitialState(), "event: changed\r\ndata: a\r\n\r\ndata: b\r\n\r\n");
  assert.deepEqual(r.events, [
    { event: "changed", data: "a" },
    { event: "message", data: "b" }, // 앞 이벤트의 event명이 새지 않는다
  ]);
});

test("sseFeed: data 없는 빈 줄은 디스패치하지 않는다(keepalive 뒤 공백 등)", () => {
  const r = sseFeed(sseInitialState(), "\n\n: ping\n\n");
  assert.equal(r.events.length, 0);
});

test("sseFeed: data 여러 줄은 \\n으로 join", () => {
  const r = sseFeed(sseInitialState(), "data: l1\ndata: l2\n\n");
  assert.deepEqual(r.events, [{ event: "message", data: "l1\nl2" }]);
});

// ── tasksRenderKey — 열린 패널 자동 재렌더 판단 ──

test("tasksRenderKey: 동일 데이터 = 동일 키(불필요 재렌더 없음)", () => {
  const a = [mk({ id: "t1" }), mk({ id: "t2", status: "accepted" })];
  const b = [mk({ id: "t1" }), mk({ id: "t2", status: "accepted" })];
  assert.equal(tasksRenderKey(a), tasksRenderKey(b));
  assert.equal(tasksRenderKey([]), tasksRenderKey([]));
});

test("tasksRenderKey: 상태 전이·회신 수·제목·마감·건수 변화 = 키 변화(재렌더 트리거)", () => {
  const base = [mk({ id: "t1", status: "requested", replyCount: 0 })];
  const key0 = tasksRenderKey(base);
  assert.notEqual(tasksRenderKey([mk({ id: "t1", status: "accepted", replyCount: 0 })]), key0, "전이");
  assert.notEqual(tasksRenderKey([mk({ id: "t1", status: "requested", replyCount: 1, lastReplyAt: 5 })]), key0, "회신");
  assert.notEqual(tasksRenderKey([mk({ id: "t1", status: "requested", title: "수정됨" })]), key0, "제목 수정");
  assert.notEqual(tasksRenderKey([mk({ id: "t1", status: "requested", dueDate: "2026-08-01" })]), key0, "마감 변경");
  assert.notEqual(tasksRenderKey([...base, mk({ id: "t2" })]), key0, "신규 업무(건수)");
  assert.notEqual(tasksRenderKey([]), key0, "업무 소멸(철회 등)");
  // 읽음 변화도 재렌더 대상 — 빠지면 다른 기기(포털)에서 읽어도 열린 패널의 점이 안 꺼진다(2026-08-06 실기기 실측).
  assert.notEqual(tasksRenderKey([mk({ id: "t1", status: "requested", myReadAt: 999 })]), key0, "읽음 변화");
});

// ── 연구과제 귀속(프로젝트) 순수 함수 ──

test("matchesPatterns: 폴더 접두는 경로 세그먼트 경계 기준", () => {
  const ps = ["연구/촉매", "기타"];
  assert.ok(matchesPatterns("연구/촉매/실험1.md", ps), "하위 파일 매칭");
  assert.ok(!matchesPatterns("연구/촉매전지/x.md", ps), "부분 문자열 접두는 불가(세그먼트 경계)");
  assert.ok(matchesPatterns("기타/메모.md", ps));
  assert.ok(!matchesPatterns("연구/다른/x.md", ps));
  assert.ok(matchesPatterns("연구/촉매", ps), "패턴과 정확히 같은 경로");
  assert.ok(!matchesPatterns("연구/촉매/실험1.md", []), "빈 패턴은 아무것도 안 걸림");
});

test("parsePatterns: 줄바꿈 구분·trim·슬래시 테두리 제거·빈 줄 제외(서버 계약)", () => {
  assert.deepEqual(parsePatterns(" /연구/촉매/ \n\n기타 "), ["연구/촉매", "기타"]);
  assert.deepEqual(parsePatterns(""), []);
  assert.deepEqual(parsePatterns("\n  \n///\n"), [], "슬래시만 있는 줄도 빈 줄");
});

test("unreported: 로컬 캐시 diff — 미보고 항목만", () => {
  assert.deepEqual(unreported(["a", "b", "c"], new Set(["b"])), ["a", "c"]);
  assert.deepEqual(unreported(["a"], new Set()), ["a"]);
  assert.deepEqual(unreported([], new Set(["b"])), []);
});

// ── 팀 표준 구조(structure) 이원화 — 순수 함수 3종 ──

test("parseTeamStructure: 정상 구조 파싱 + 불량 원소 개별 무시(preset_kit_id는 반환값에 없음)", () => {
  const raw = {
    root: "테스트팀",
    folders: ["연구노트", "연구노트/실험일지", 42, ""],
    templates: [{ path: "연구노트/_t.md", body: "x" }, { path: 1 }, null],
    preset_kit_id: "bio-wetlab-eln",
  };
  assert.deepEqual(parseTeamStructure(raw), {
    root: "테스트팀",
    folders: ["연구노트", "연구노트/실험일지"],
    templates: [{ path: "연구노트/_t.md", body: "x" }],
  });
});

test("parseTeamStructure: undefined·비객체·빈 구조는 전부 null", () => {
  assert.equal(parseTeamStructure(undefined), null);
  assert.equal(parseTeamStructure("x"), null);
  assert.equal(parseTeamStructure({ folders: [], templates: [] }), null);
});

test("parseTeamStructure: 한쪽 키만 있어도 유효(누락 키는 빈 배열, root는 항상 필수)", () => {
  assert.deepEqual(parseTeamStructure({ root: "팀", folders: ["a"] }),
    { root: "팀", folders: ["a"], templates: [] });
  assert.deepEqual(parseTeamStructure({ root: "팀", templates: [{ path: "t.md", body: "x" }] }),
    { root: "팀", folders: [], templates: [{ path: "t.md", body: "x" }] });
});

test("isValidFolderName: 금지문자 8종·제어문자 Cc 전구간·공백/마침표 테두리·길이·의도적 허용(스펙 §3a-0 공유 테스트 벡터)", () => {
  assert.equal(isValidFolderName("나날랩스"), true);
  assert.equal(isValidFolderName("Team A_1-2"), true);
  assert.equal(isValidFolderName(""), false);
  assert.equal(isValidFolderName("연구소/팀A"), false);   // 슬래시 = 다단 루트 불허
  assert.equal(isValidFolderName("팀\\A"), false);
  assert.equal(isValidFolderName("팀:A"), false);
  assert.equal(isValidFolderName("팀*A"), false);
  assert.equal(isValidFolderName("팀?A"), false);
  assert.equal(isValidFolderName('팀"A'), false);
  assert.equal(isValidFolderName("팀<A"), false);
  assert.equal(isValidFolderName("팀>A"), false);
  assert.equal(isValidFolderName("팀|A"), false);
  // 제어문자 Cc 전 구간(U+0000–U+001F·U+007F–U+009F) — 경로·S3 키·리포트 표기를 깨뜨린다.
  assert.equal(isValidFolderName("팀\nA"), false);
  assert.equal(isValidFolderName("팀\tA"), false);
  assert.equal(isValidFolderName("팀\rA"), false);
  assert.equal(isValidFolderName("팀" + String.fromCharCode(0x7f) + "A"), false); // DEL
  assert.equal(isValidFolderName("팀" + String.fromCharCode(0x80) + "A"), false); // Cc 상단 구간
  assert.equal(isValidFolderName("."), false);
  assert.equal(isValidFolderName(".."), false);
  assert.equal(isValidFolderName(".숨김"), false);        // 선행 마침표 = Obsidian 숨김 폴더
  assert.equal(isValidFolderName("팀A."), false);
  assert.equal(isValidFolderName(" 팀A"), false);          // ASCII 공백(0x20) 테두리
  assert.equal(isValidFolderName("팀A "), false);
  // 공백류 테두리(2026-07-25 2차 개정) — 거부. 귀속 패턴 파서(parsePatterns)가 테두리를
  // trim하는데 과제 폴더는 projectPrefix로 원본 이름 그대로 만들어져, 테두리 NBSP/BOM을
  // 허용하면 생성된 폴더와 귀속 매칭이 갈린다(엑셀·웹 복붙에 흔한 선행 NBSP가 실제 사고 경로).
  assert.equal(isValidFolderName(String.fromCharCode(0xa0) + "팀A"), false);   // 선행 NBSP
  assert.equal(isValidFolderName("팀A" + String.fromCharCode(0xa0)), false);   // 후행 NBSP
  assert.equal(isValidFolderName(String.fromCharCode(0xfeff) + "팀A"), false); // 선행 BOM
  assert.equal(isValidFolderName("팀A" + String.fromCharCode(0xfeff)), false); // 후행 BOM
  // 의도적 허용(스펙 §3a-0) — **내부** 비ASCII 공백·BOM·Windows 예약 디바이스명은 세 런타임
  // 일관성이 개별 위험 차단보다 중요해서 막지 않는다(테두리와 달리 귀속 매칭에 영향 없음).
  assert.equal(isValidFolderName("팀" + String.fromCharCode(0xa0) + "A"), true);   // 내부 NBSP
  assert.equal(isValidFolderName("팀" + String.fromCharCode(0xfeff) + "A"), true); // 내부 BOM
  assert.equal(isValidFolderName("CON"), true);
  assert.equal(isValidFolderName("가".repeat(80)), true);
  assert.equal(isValidFolderName("가".repeat(81)), false);
  // max 파라미터 — 과제명(서버 1~100자)에도 이 함수를 쓴다.
  assert.equal(isValidFolderName("가".repeat(100), 100), true);
  assert.equal(isValidFolderName("가".repeat(101), 100), false);
});

test("parseKitManifest: root 없는 킷 응답도 정상 파싱, 빈 매니페스트는 null", () => {
  const m = parseKitManifest({ folders: ["00-Home", ""], templates: [{ path: "00-Home/a.md", body: "x" }, { path: 1 }] });
  assert.deepEqual(m, { folders: ["00-Home"], templates: [{ path: "00-Home/a.md", body: "x" }] });
  assert.equal(parseKitManifest({ folders: [], templates: [] }), null);
  assert.equal(parseKitManifest(null), null);
});

test("parseTeamStructure: root 필수(불량이면 null), 유효 root면 빈 트리도 구조 활성", () => {
  const s = parseTeamStructure({ root: "나날랩스", folders: ["연구노트"], templates: [{ path: "연구노트/_t.md", body: "b" }] });
  assert.deepEqual(s, { root: "나날랩스", folders: ["연구노트"], templates: [{ path: "연구노트/_t.md", body: "b" }] });
  // 루트가 곧 팀 영역 — 트리를 비워도 스코프는 유지된다.
  assert.deepEqual(parseTeamStructure({ root: "나날랩스", folders: [], templates: [] }),
    { root: "나날랩스", folders: [], templates: [] });
  // 해제 = root 빈 값
  assert.equal(parseTeamStructure({ root: "", folders: [], templates: [] }), null);
  assert.equal(parseTeamStructure({ folders: ["연구노트"] }), null);          // root 키 부재
  assert.equal(parseTeamStructure({ root: "연구소/팀A", folders: ["a"] }), null); // 불량 root
  assert.equal(parseTeamStructure({ root: 3, folders: ["a"] }), null);
  assert.equal(parseTeamStructure("x"), null);
  // trim하지 않는다(정규화 금지, 스펙 §3a-0) — 공백 테두리는 거부이지 정리 대상이 아니다.
  assert.equal(parseTeamStructure({ root: " 나날랩스 ", folders: [] }), null);
});

test("manifestPaths: 프리픽스 자체 + 프리픽스/폴더 + 프리픽스/템플릿", () => {
  const m = { folders: ["연구노트", "연구노트/실험"], templates: [{ path: "연구노트/_t.md", body: "b" }] };
  const p = manifestPaths("나날랩스", m);
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/연구노트", "나날랩스/연구노트/실험"]);
  assert.deepEqual(p.files, [{ path: "나날랩스/연구노트/_t.md", body: "b" }]);
  assert.deepEqual(p.allPaths,
    ["나날랩스", "나날랩스/연구노트", "나날랩스/연구노트/실험", "나날랩스/연구노트/_t.md"]);
  // 과제 프리픽스 = <root>/과제/<과제명> — 4계층 규약(projectPrefix 소유).
  // 조상 합성이 중간 층(`나날랩스/과제`)도 채운다 — 그러지 않으면 폴더 생성이 조용히 실패한다.
  const q = manifestPaths(projectPrefix("나날랩스", "촉매개발"), { folders: ["00-Home"], templates: [] });
  assert.deepEqual(q.folders,
    ["나날랩스/과제/촉매개발", "나날랩스/과제/촉매개발/00-Home"]);
});

test("manifestPaths: root 유효 + 빈 트리 = 구조 활성 불변식(prefix 자체 경로만 남는다)", () => {
  const p = manifestPaths("나날랩스", { folders: [], templates: [] });
  assert.deepEqual(p, { folders: ["나날랩스"], files: [], allPaths: ["나날랩스"] });
});

test("manifestPaths: 순서 유지 중복 제거 — folderStatus·creationPlan이 같은 집합을 보게 한다", () => {
  const p = manifestPaths("나날랩스", {
    folders: ["연구노트", "연구노트"],
    templates: [{ path: "연구노트/_t.md", body: "a" }, { path: "연구노트/_t.md", body: "덮어쓰기아님" }],
  });
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/연구노트"]);
  // 같은 경로가 중복되면 먼저 온 원소만 남는다(뒤 원소로 덮어쓰지 않음).
  assert.deepEqual(p.files, [{ path: "나날랩스/연구노트/_t.md", body: "a" }]);
});

test("manifestPaths: 세그먼트 깊이 오름차순 정렬 — 부모 폴더가 자식보다 먼저 온다(조상 합성으로 중간도 채워짐)", () => {
  const p = manifestPaths("나날랩스", { folders: ["a/b/c", "a"], templates: [] });
  // "a/b/c"만 있어도 조상 합성이 "a"·"a/b"를 채운다 — 정렬만으로는 이 중간 폴더를 만들 수 없다.
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/a", "나날랩스/a/b", "나날랩스/a/b/c"]);
});

test("manifestPaths: 조상 경로 합성 — 폴더 목록에 부모가 없어도 채운다(서버 validate_structure는 부모 존재를 요구 안 함)", () => {
  const p = manifestPaths("나날랩스", { folders: ["연구노트/실험"], templates: [] });
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/연구노트", "나날랩스/연구노트/실험"]);
});

test("manifestPaths: 조상 경로 합성 — 템플릿 부모 디렉터리도 folders에 채운다(폴더 선언 없이 템플릿만 있는 경우)", () => {
  const p = manifestPaths("나날랩스", { folders: [], templates: [{ path: "연구노트/실험/_t.md", body: "b" }] });
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/연구노트", "나날랩스/연구노트/실험"]);
  assert.deepEqual(p.files, [{ path: "나날랩스/연구노트/실험/_t.md", body: "b" }]);
});

test("manifestPaths: 조상 합성은 prefix 밖으로 새지 않는다(나날랩스보다 위는 없음)", () => {
  const p = manifestPaths("나날랩스", { folders: ["a"], templates: [{ path: "b/_t.md", body: "x" }] });
  assert.ok(p.allPaths.every((x) => x === "나날랩스" || x.startsWith("나날랩스/")));
  assert.deepEqual(p.folders, ["나날랩스", "나날랩스/a", "나날랩스/b"]);
});

test("manifestFields(경유): 트리 원소 세그먼트 검증 — 후행 공백·제어문자 원소만 개별 무시, 나머지는 유지", () => {
  // Windows는 디렉터리 생성 시 후행 공백/마침표를 잘라내 "연구노트 " ≠ 실제 폴더가 된다 — 거부.
  const s = parseTeamStructure({ root: "나날랩스", folders: ["연구노트 ", "정상", "제어\n문자"] });
  assert.deepEqual(s, { root: "나날랩스", folders: ["정상"], templates: [] });
});

test("manifestFields(경유): 템플릿 파일명은 선행 마침표 허용(.gitignore류), 디렉터리 세그먼트 후행 공백은 거부", () => {
  const s = parseTeamStructure({
    root: "나날랩스",
    templates: [
      { path: ".gitignore", body: "x" },        // 파일명 선행 마침표 — 허용
      { path: "폴더 /a.md", body: "y" },         // 디렉터리 세그먼트 후행 공백 — 거부
    ],
  });
  assert.deepEqual(s, { root: "나날랩스", folders: [], templates: [{ path: ".gitignore", body: "x" }] });
});

test("manifestFields(경유): 템플릿 파일명 예외로도 '..' 경로 탈출 불가(startsWith('..') 명시 차단)", () => {
  assert.deepEqual(parseTeamStructure({ root: "R", templates: [{ path: "../x.md", body: "b" }] }),
    { root: "R", folders: [], templates: [] });
});

test("manifestFields(경유): 트리 원소 중간 세그먼트 '..'도 탈출 불가", () => {
  assert.deepEqual(parseTeamStructure({ root: "R", folders: ["a/../b"] })?.folders, []);
});

test("manifestFields(경유): 세그먼트 255자 경계 초과는 개별 무시", () => {
  assert.deepEqual(parseTeamStructure({ root: "R", folders: ["가".repeat(256)] })?.folders, []);
});

// ── 4계층 규약(2026-07-31) ────────────────────────────────────────────────
// 과제와 팀 표준 폴더가 같은 층에 있으면 **어느 것이 과제인지 알 수 없다.**
// 과제명을 「연구노트」로 지으면 표준 폴더와 이름이 겹치고, 기계도 과제 목록과 대조해야만
// 가릴 수 있다. 두 번째 칸을 규약으로 고정해 경로만 보고 성격이 정해지게 한다.
test("projectPrefix: <root>/과제/<과제명> — 과제는 과제 층 아래", () => {
  assert.equal(projectPrefix("나날랩스", "촉매개발"), "나날랩스/과제/촉매개발");
  // 과제명이 표준 폴더 이름과 같아도 겹치지 않는다 — 이것이 층을 나눈 이유다.
  assert.equal(projectPrefix("나날랩스", "연구노트"), "나날랩스/과제/연구노트");
  assert.notEqual(projectPrefix("나날랩스", "연구노트"), commonPrefix("나날랩스") + "/연구노트");
});

test("commonPrefix: <root>/공통 — 과제에 매이지 않는 상시 자료", () => {
  assert.equal(commonPrefix("나날랩스"), "나날랩스/공통");
});

test("scopedPatterns: 과제명(루트-상대)에 과제 층을 끼워 절대 경로로", () => {
  assert.deepEqual(scopedPatterns("나날랩스", ["촉매개발", "전극소재"]),
    ["나날랩스/과제/촉매개발", "나날랩스/과제/전극소재"]);
  assert.deepEqual(scopedPatterns("나날랩스", []), []);
});

test("creationPlan: 미존재분만, 전부 존재 시 빈 계획(멱등)", () => {
  const p = manifestPaths("나날랩스", { folders: ["연구노트"], templates: [{ path: "연구노트/_t.md", body: "b" }] });
  const plan = creationPlan(p, new Set(["나날랩스", "연구노트"]));
  assert.deepEqual(plan.folders, ["나날랩스/연구노트"]);
  assert.deepEqual(plan.files, [{ path: "나날랩스/연구노트/_t.md", body: "b" }]);
  const done = creationPlan(p, new Set(["나날랩스", "나날랩스/연구노트", "나날랩스/연구노트/_t.md"]));
  assert.deepEqual(done, { folders: [], files: [] });
});

test("buildTaskCreatePayloads: assignees=[] → personal 1건, due_date는 항상 포함(마감기한 항상 필수, 2026-07-24)", () => {
  const base = { title: "T", body: "B", priority: "week", due: "2026-08-01", projectId: "" };
  const p0 = buildTaskCreatePayloads(base, []);
  assert.deepEqual(p0, [{ title: "T", body: "B", priority: "week", due_date: "2026-08-01" }]);
});

test("buildTaskCreatePayloads: 과제 지정 시 project_id 포함(personal·요청 공통)", () => {
  const base = { title: "T", body: "", priority: "now", due: "2026-08-01", projectId: "proj1" };
  assert.deepEqual(buildTaskCreatePayloads(base, []), [{ title: "T", body: "", priority: "now", project_id: "proj1", due_date: "2026-08-01" }]);
  assert.deepEqual(buildTaskCreatePayloads(base, ["u-a"]), [{ title: "T", body: "", priority: "now", project_id: "proj1", assignee_uid: "u-a", due_date: "2026-08-01" }]);
});

test("buildTaskCreatePayloads: 다중 수신자 — 인별 복제(assignee_uid만 다름, due_date 공통)", () => {
  const f = { title: "실험 결과 정리", body: "3차 배치", priority: "now", due: "2026-08-01", projectId: "proj1" };
  const payloads = buildTaskCreatePayloads(f, ["u-a", "u-b", "u-c"]);
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads, [
    { title: "실험 결과 정리", body: "3차 배치", priority: "now", project_id: "proj1", assignee_uid: "u-a", due_date: "2026-08-01" },
    { title: "실험 결과 정리", body: "3차 배치", priority: "now", project_id: "proj1", assignee_uid: "u-b", due_date: "2026-08-01" },
    { title: "실험 결과 정리", body: "3차 배치", priority: "now", project_id: "proj1", assignee_uid: "u-c", due_date: "2026-08-01" },
  ]);
});

test("summarizeFanout: 전부 성공 — okCount만, failed 없음", () => {
  const r = summarizeFanout([{ assignee: "u-a", label: "a@t.com", ok: true }, { assignee: "u-b", label: "b@t.com", ok: true }]);
  assert.deepEqual(r, { okCount: 2, failed: [] });
});

test("summarizeFanout: 일부 실패 — 실패 라벨 순서 보존, 성공분은 okCount에만 반영", () => {
  const r = summarizeFanout([
    { assignee: "u-a", label: "a@t.com", ok: true },
    { assignee: "u-b", label: "b@t.com", ok: false },
    { assignee: "u-c", label: "c@t.com", ok: false },
  ]);
  assert.deepEqual(r, { okCount: 1, failed: ["b@t.com", "c@t.com"] });
});

test("summarizeFanout: 빈 입력 → 0/빈 배열", () => {
  assert.deepEqual(summarizeFanout([]), { okCount: 0, failed: [] });
});

test("buildTaskCreatePayloads: memo 있으면 포함, 없으면(빈 문자열) 미포함", () => {
  const base = { title: "T", body: "B", priority: "week", due: "2026-08-01", projectId: "" };
  const p0 = buildTaskCreatePayloads({ ...base, memo: "" }, []);
  assert.deepEqual(p0, [{ title: "T", body: "B", priority: "week", due_date: "2026-08-01" }]);
  const p1 = buildTaskCreatePayloads({ ...base, memo: "실험 로그 별도 첨부 예정" }, []);
  assert.deepEqual(p1, [{ title: "T", body: "B", priority: "week", memo: "실험 로그 별도 첨부 예정", due_date: "2026-08-01" }]);
});

test("buildTaskCreatePayloads: startDate 있으면 start_date 포함(personal·요청 공통)", () => {
  const base = { title: "T", body: "", priority: "now", due: "2026-08-01", projectId: "" };
  const p0 = buildTaskCreatePayloads({ ...base, startDate: "2026-07-24" }, []);
  assert.deepEqual(p0, [{ title: "T", body: "", priority: "now", start_date: "2026-07-24", due_date: "2026-08-01" }]);
  const p1 = buildTaskCreatePayloads({ ...base, startDate: "2026-07-24" }, ["u-a"]);
  assert.deepEqual(p1, [
    { title: "T", body: "", priority: "now", start_date: "2026-07-24", assignee_uid: "u-a", due_date: "2026-08-01" },
  ]);
});

// ── 유형 통합·정렬·필터·그룹·보드(§1, 2026-07-25) ──

test("unifyTasks: received=inbox·sent=mine담당자有·personal=mine담당자無·id중복 received우선", () => {
  const inbox = [mk({ id: "a", assigneeUid: "me" })];
  const mine = [
    mk({ id: "a", assigneeUid: "me" }),      // 셀프할당 — 양쪽 등장, received 우선이라 sent로 안 들어감
    mk({ id: "b", assigneeUid: "u-b" }),     // 담당자 있음 → sent
    mk({ id: "c", assigneeUid: null }),      // 담당자 없음 → personal
  ];
  const out = unifyTasks(inbox, mine);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((t) => [t.id, t.taskType]), [["a", "received"], ["b", "sent"], ["c", "personal"]]);
  // 원본 불변(스프레드 복제).
  assert.equal(inbox[0].id, "a");
});

test("sortUnified: sorts=[] 기본(done 하단·마감초과 우선) + sorts 지정 시 done도 정렬 기준대로 섞임 + 3-state 방향", () => {
  const T = "2026-07-25";
  const over = mku({ id: "o", status: "accepted", dueDate: "2026-07-01" }); // 초과
  const soon = mku({ id: "s", status: "accepted", dueDate: "2026-07-30" }); // 미초과
  const done = mku({ id: "d", status: "done", dueDate: "2026-06-01" });     // 완료(마감일은 셋 중 가장 이름)
  // 기본(sorts=[]): done 하단, 열린 것 중 초과 먼저.
  const def = sortUnified([soon, done, over], [], T);
  assert.deepEqual(def.map((t) => t.id), ["o", "s", "d"]);

  // 마감 오름차순(단일 정렬): done도 dueDate 기준으로 섞인다 — done(06-01) < over(07-01) < soon(07-30).
  const asc = sortUnified([soon, over, done], [{ col: "dueDate", dir: "asc" }], T);
  assert.deepEqual(asc.map((t) => t.id), ["d", "o", "s"]);
  // 내림차순: 부호 반전 → soon(07-30) > over(07-01) > done(06-01) — 이 케이스는 done의 마감일이
  // 가장 이르므로 결과적으로 하단에 오지만, 하단 고정이 아니라 값 비교의 자연스러운 결과다.
  const desc = sortUnified([over, soon, done], [{ col: "dueDate", dir: "desc" }], T);
  assert.deepEqual(desc.map((t) => t.id), ["s", "o", "d"]);

  // null-마감 → dateSortCmp "빈 값 뒤로" 경로(정렬을 통한 검증). asc에서 값 있는 것(done 포함)은 날짜
  // 기준으로 섞이고, null-마감 task만 맨 뒤.
  const nul = mku({ id: "z", status: "accepted", dueDate: null });
  const ascNull = sortUnified([nul, soon, done, over], [{ col: "dueDate", dir: "asc" }], T);
  assert.deepEqual(ascNull.map((t) => t.id), ["d", "o", "s", "z"]);

  // done이 정렬 기준상 앞쪽 값을 가지면 실제로 맨 앞에 온다 — "하단 고정 아님"을 직접 증명.
  const doneNow = mku({ id: "dn", status: "done", priority: "now" });
  const openRef = mku({ id: "or", status: "accepted", priority: "ref" });
  const mixedPriority = sortUnified([openRef, doneNow], [{ col: "priority", dir: "asc" }], T);
  assert.deepEqual(mixedPriority.map((t) => t.id), ["dn", "or"], "정렬 지정 시 done도 우선순위 기준대로 섞여 맨 앞에 올 수 있다");

  // 우선순위 오름차순 = 긴급→보통→참고.
  const p = sortUnified([mku({ id: "r", priority: "ref" }), mku({ id: "n", priority: "now" }), mku({ id: "w", priority: "week" })], [{ col: "priority", dir: "asc" }], T);
  assert.deepEqual(p.map((t) => t.id), ["n", "w", "r"]);

  // 유형 정렬 = received→sent→personal.
  const ty = sortUnified([mku({ id: "p1", taskType: "personal" }), mku({ id: "r1", taskType: "received" }), mku({ id: "s1", taskType: "sent" })], [{ col: "type", dir: "asc" }], T);
  assert.deepEqual(ty.map((t) => t.id), ["r1", "s1", "p1"]);

  // 원본 불변.
  const src = [soon, over]; sortUnified(src, [{ col: "title", dir: "asc" }], T); assert.equal(src[0].id, "s");
});

test("sortUnified: 다중 정렬 — 1차가 같으면 2차 tiebreak, 각 컬럼 dir 독립", () => {
  const T = "2026-07-25";
  // 상태(1차) 같은 accepted끼리는 마감(2차)로 갈린다. 상태가 다르면 마감 무관하게 상태가 먼저.
  const a1 = mku({ id: "a1", status: "accepted", dueDate: "2026-08-10" });
  const a2 = mku({ id: "a2", status: "accepted", dueDate: "2026-07-05" });
  const r1 = mku({ id: "r1", status: "requested", dueDate: "2026-09-01" });
  // 상태 asc(requested < accepted per STATUS_ORDER? personal→requested→accepted…), 마감 asc.
  // STATUS_ORDER: personal, requested, accepted, declined, done, canceled → requested(1) < accepted(2).
  const s1 = sortUnified([a1, r1, a2], [{ col: "status", dir: "asc" }, { col: "dueDate", dir: "asc" }], T);
  assert.deepEqual(s1.map((t) => t.id), ["r1", "a2", "a1"], "1차 상태(requested 먼저) → 같은 accepted는 마감 이른 a2 먼저");

  // 2차 방향만 desc로 뒤집으면 accepted 그룹 내부 순서만 반전(1차 상태 순서는 유지).
  const s2 = sortUnified([a1, r1, a2], [{ col: "status", dir: "asc" }, { col: "dueDate", dir: "desc" }], T);
  assert.deepEqual(s2.map((t) => t.id), ["r1", "a1", "a2"], "2차 마감 desc → accepted 내부는 마감 늦은 a1 먼저");

  // 1차가 완전히 갈리면 2차는 관여 안 함 — 마감이 뒤죽박죽이어도 우선순위(1차)가 지배.
  const b1 = mku({ id: "b1", priority: "now", dueDate: "2026-12-31" });
  const b2 = mku({ id: "b2", priority: "week", dueDate: "2026-01-01" });
  const s3 = sortUnified([b2, b1], [{ col: "priority", dir: "asc" }, { col: "dueDate", dir: "asc" }], T);
  assert.deepEqual(s3.map((t) => t.id), ["b1", "b2"], "1차 우선순위(now<week)가 지배 — 2차 마감 무관");
});

test("taskPasses: types/statuses/priorities/projects 멀티체크 AND + titleText 부분일치 + due 범위 + overdue", () => {
  const T = "2026-07-25";
  const t1 = mku({ id: "x", taskType: "sent", status: "accepted", priority: "now", projectId: "p1", projectName: "연구A", title: "장비 점검 보고", dueDate: "2026-07-20" });
  // 빈 필터 = 통과.
  assert.equal(taskPasses(t1, {}, T), true);
  // 유형 멀티체크.
  assert.equal(taskPasses(t1, { types: ["received"] }, T), false);
  assert.equal(taskPasses(t1, { types: ["sent", "personal"] }, T), true);
  // 상태·우선순위·과제 AND.
  assert.equal(taskPasses(t1, { statuses: ["accepted"], priorities: ["now"], projects: ["p1"] }, T), true);
  assert.equal(taskPasses(t1, { statuses: ["accepted"], priorities: ["week"] }, T), false);
  // 과제 없음 버킷("") 매칭.
  assert.equal(taskPasses(mku({ id: "y", projectId: null }), { projects: [""] }, T), true);
  // 제목 부분일치(대소문자 무시).
  assert.equal(taskPasses(t1, { titleText: "점검" }, T), true);
  assert.equal(taskPasses(t1, { titleText: "없는말" }, T), false);
  // 마감 범위(문자열 비교) — 값 없으면 탈락.
  assert.equal(taskPasses(t1, { dueFrom: "2026-07-01", dueTo: "2026-07-31" }, T), true);
  assert.equal(taskPasses(t1, { dueFrom: "2026-07-25" }, T), false);
  assert.equal(taskPasses(mku({ id: "z", dueDate: null }), { dueTo: "2026-08-01" }, T), false);
  // overdue 파생 — accepted+과거 마감이면 초과.
  assert.equal(taskPasses(t1, { overdue: true }, T), true);
  assert.equal(taskPasses(mku({ id: "w", status: "accepted", dueDate: "2026-08-30" }), { overdue: true }, T), false);
});

test("taskPasses: assignees 멀티체크(uid 우선·email 폴백·담당없음 버킷)", () => {
  const T = "2026-07-25";
  const a1 = mku({ id: "a", assigneeUid: "u-b", assigneeEmail: "b@t.com", assigneeName: "박실험" });
  // assigneeUid 우선 키 매칭(AND — 목록 포함일 때만 통과).
  assert.equal(taskPasses(a1, { assignees: ["u-b"] }, T), true);
  assert.equal(taskPasses(a1, { assignees: ["u-x"] }, T), false);
  assert.equal(taskPasses(a1, { assignees: ["u-x", "u-b"] }, T), true);
  // uid 없고 email만 있으면 email:<주소> 키(로컬파트 아님).
  const a2 = mku({ id: "e", assigneeUid: null, assigneeEmail: "c@t.com", assigneeName: null });
  assert.equal(taskPasses(a2, { assignees: ["email:c@t.com"] }, T), true);
  assert.equal(taskPasses(a2, { assignees: ["c@t.com"] }, T), false);
  // 담당 없음("") 버킷 — personal만 통과.
  const a3 = mku({ id: "p", assigneeUid: null, assigneeEmail: null });
  assert.equal(taskPasses(a3, { assignees: [""] }, T), true);
  assert.equal(taskPasses(a1, { assignees: [""] }, T), false);
  // 빈 목록 = 통과.
  assert.equal(taskPasses(a1, { assignees: [] }, T), true);
});

test("taskPasses: memoText 부분일치(대소문자 무시·빈 비고 탈락)", () => {
  const T = "2026-07-25";
  const m1 = mku({ id: "m", memo: "장비 Calibration 필요" });
  assert.equal(taskPasses(m1, { memoText: "calibration" }, T), true);
  assert.equal(taskPasses(m1, { memoText: "장비" }, T), true);
  assert.equal(taskPasses(m1, { memoText: "없는말" }, T), false);
  assert.equal(taskPasses(mku({ id: "nm", memo: "" }), { memoText: "x" }, T), false);
});

test("taskPasses: startDate 범위(문자열 비교·값 없으면 탈락) + 담당·비고·시작 AND", () => {
  const T = "2026-07-25";
  const s1 = mku({ id: "s", assigneeUid: "u-b", memo: "장비 점검", startDate: "2026-07-10" });
  assert.equal(taskPasses(s1, { startFrom: "2026-07-01", startTo: "2026-07-31" }, T), true);
  assert.equal(taskPasses(s1, { startFrom: "2026-07-15" }, T), false);
  assert.equal(taskPasses(s1, { startTo: "2026-07-05" }, T), false);
  assert.equal(taskPasses(mku({ id: "ns", startDate: null }), { startFrom: "2026-01-01" }, T), false);
  // 담당·비고·시작일 동시 AND.
  assert.equal(taskPasses(s1, { assignees: ["u-b"], memoText: "장비", startFrom: "2026-07-01" }, T), true);
  assert.equal(taskPasses(s1, { assignees: ["u-b"], memoText: "장비", startFrom: "2026-07-20" }, T), false);
});

test("groupUnified: status/type/assignee/project 축 + 순서 + 그룹 내 기본 정렬", () => {
  const T = "2026-07-25";
  const tasks = [
    mku({ id: "a", status: "done", taskType: "sent", assigneeUid: "u1", assigneeName: "박실험", projectId: "p1", projectName: "연구A" }),
    mku({ id: "b", status: "requested", taskType: "received", assigneeUid: null, assigneeEmail: null, projectId: null }),
    mku({ id: "c", status: "personal", taskType: "personal", assigneeUid: null, assigneeEmail: null, projectId: "p1", projectName: "연구A" }),
  ];
  // status 축: STATUS_ORDER = personal→requested→…→done.
  const gs = groupUnified(tasks, "status", T);
  assert.deepEqual(gs.map((g) => g.key), ["personal", "requested", "done"]);
  // type 축: received→sent→personal.
  const gt = groupUnified(tasks, "type", T);
  assert.deepEqual(gt.map((g) => g.key), ["received", "sent", "personal"]);
  // assignee 축: 값 있는 그룹 먼저(별칭 라벨), 빈 그룹(담당자 없음)은 뒤 + label="".
  const ga = groupUnified(tasks, "assignee", T);
  assert.equal(ga[0].key, "u1");
  assert.equal(ga[0].label, "박실험");
  assert.equal(ga[ga.length - 1].key, "");
  assert.equal(ga[ga.length - 1].label, "");
  // project 축: 과제 있는 그룹 label=과제명, 없는 그룹은 뒤.
  const gp = groupUnified(tasks, "project", T);
  assert.equal(gp[0].key, "p1");
  assert.equal(gp[0].label, "연구A");
  assert.equal(gp[0].items.length, 2);
  assert.equal(gp[gp.length - 1].key, "");
});

test("boardColumns: 상태 컬럼 5종(requested·accepted·personal·declined·done) + 분류 + 기본 정렬", () => {
  const T = "2026-07-25";
  const tasks = [
    mku({ id: "r", status: "requested" }),
    mku({ id: "a1", status: "accepted", dueDate: "2026-08-01" }),
    mku({ id: "a2", status: "accepted", dueDate: "2026-07-01" }), // 초과 → accepted 컬럼 상단
    mku({ id: "p", status: "personal" }),
    mku({ id: "d", status: "done" }),
  ];
  const cols = boardColumns(tasks, T);
  assert.deepEqual(cols.map((c) => c.status), ["requested", "accepted", "personal", "declined", "done"]);
  assert.deepEqual(cols[1].items.map((t) => t.id), ["a2", "a1"]); // 초과 우선
  assert.equal(cols.find((c) => c.status === "declined")!.items.length, 0); // 빈 컬럼도 존재
  assert.equal(cols.find((c) => c.status === "done")!.items[0].id, "d");
});

test("빈 입력 경계: unifyTasks·groupUnified는 빈 배열, boardColumns는 5개 빈 컬럼", () => {
  const T = "2026-07-25";
  assert.deepEqual(unifyTasks([], []), []);
  assert.deepEqual(groupUnified([], "status", T), []);
  const cols = boardColumns([], T);
  assert.deepEqual(cols.map((c) => c.status), ["requested", "accepted", "personal", "declined", "done"]);
  assert.ok(cols.every((c) => c.items.length === 0), "모든 컬럼 items 빈 배열");
});

test("fallback 가드: priority 없는 task는 default \"week\"로 필터·assignee 축은 이메일 키로 묶임", () => {
  const T = "2026-07-25";
  // (a) priority 미지정(빈 문자열) → default "week"로 취급.
  const noPri = mku({ id: "np", priority: "" });
  assert.equal(taskPasses(noPri, { priorities: ["week"] }, T), true);
  assert.equal(taskPasses(noPri, { priorities: ["now"] }, T), false);
  // (b) assigneeUid=null·assigneeEmail 있음 → "email:..." 키로 묶임(uid 없어도 담당자 있음 그룹).
  const byEmail = mku({ id: "be", taskType: "sent", assigneeUid: null, assigneeEmail: "c@t.com", assigneeName: null });
  const g = groupUnified([byEmail], "assignee", T);
  assert.equal(g.length, 1);
  assert.equal(g[0].key, "email:c@t.com");
  assert.equal(g[0].label, "c@t.com"); // 별칭 없으면 이메일 전체
});

// kind 배열만 잠근다(라벨·실행 매퍼는 taskview 소관). 서버 전이 게이트(team_tasks.rs)와 1:1.
const kinds = (t: UnifiedTask) => taskActionDefs(t).map((d) => d.kind);

test("taskActionDefs: 유형×상태별 액션 집합(서버 전이 게이트 1:1)", () => {
  // received(담당자).
  assert.deepEqual(kinds(mku({ taskType: "received", status: "requested" })), ["accept", "decline", "report"]);
  assert.deepEqual(kinds(mku({ taskType: "received", status: "accepted" })), ["report"]);
  // sent(요청자) — selfUid 없이는 수정이 뜨지 않는다(모를 때는 막는다).
  assert.deepEqual(kinds(mku({ taskType: "sent", status: "requested" })), ["cancel", "recall"]);
  assert.deepEqual(kinds(mku({ taskType: "sent", status: "accepted" })), ["markDone"]);
  assert.deepEqual(kinds(mku({ taskType: "sent", status: "declined" })), ["rerequest"]);
  // personal(요청자).
  assert.deepEqual(kinds(mku({ taskType: "personal", status: "personal", assigneeUid: null })), ["request", "markDone"]);
  assert.deepEqual(kinds(mku({ taskType: "personal", status: "accepted", assigneeUid: null })), ["markDone"]);
  // 처리 없음 상태(예: declined received)는 빈 배열(취소선·되돌리기 없음).
  assert.deepEqual(kinds(mku({ taskType: "received", status: "declined" })), []);
  // variant 매핑 — accept=pri·report=done(라벨/색 파생용).
  const rec = taskActionDefs(mku({ taskType: "received", status: "requested" }));
  assert.deepEqual(rec.map((d) => d.variant), ["pri", undefined, "done"]);
});



// 표의 액션과 상세 모달이 **같은 함수**를 쓴다. 2026-07-29에 표만 고치고 상세를 빠뜨려
// "버튼은 떴는데 눌렀더니 요청자만 가능합니다"가 났다 — 판정이 한 곳이어야 하는 이유다.
test("canEditTask: 서버 게이트(creator_uid == uid · 완료·취소 전)와 1:1", () => {
  const T = (over) => ({ status: "accepted", creatorUid: "me", ...over });
  assert.equal(canEditTask(T({}), "me"), true, "요청자 본인");
  assert.equal(canEditTask(T({ creatorUid: "u-other" }), "me"), false, "남이 만든 업무");
  assert.equal(canEditTask(T({ status: "done" }), "me"), false, "완료");
  assert.equal(canEditTask(T({ status: "canceled" }), "me"), false, "취소");
  assert.equal(canEditTask(T({ status: "requested" }), "me"), true, "접수 대기");
  assert.equal(canEditTask(T({ status: "personal" }), "me"), true, "개인 업무");
  assert.equal(canEditTask(T({ status: "declined" }), "me"), true, "반려됨");
  // uid를 모르면 막는다 — 모를 때 열어 두면 403이 화면에 뜬다.
  assert.equal(canEditTask(T({}), ""), false);
  assert.equal(canEditTask(T({}), undefined), false);
  assert.equal(canEditTask(T({}), null), false);
});

test("taskActionDefs: 수정은 서버와 같은 기준 — creator_uid == 나일 때만", () => {
  const k = (t, self) => taskActionDefs(t, self).map((d) => d.kind);
  // 내가 요청자면 유형과 무관하게 수정이 뜬다 — **셀프할당(received)도 포함**.
  // 서버는 creator_uid만 보므로, 화면이 taskType으로 거르면 여기서 어긋난다.
  assert.ok(k(mku({ taskType: "sent", status: "accepted", creatorUid: "me" }), "me").includes("edit"));
  assert.ok(k(mku({ taskType: "received", status: "accepted", creatorUid: "me", assigneeUid: "me" }), "me").includes("edit"));
  // 남이 만든 업무는 내가 담당자여도 못 고친다.
  assert.ok(!k(mku({ taskType: "received", status: "accepted", creatorUid: "u-other", assigneeUid: "me" }), "me").includes("edit"));
  // 완료·취소는 요청자여도 불가(되돌린 뒤에).
  assert.ok(!k(mku({ taskType: "sent", status: "done", creatorUid: "me" }), "me").includes("edit"));
  assert.ok(!k(mku({ taskType: "sent", status: "canceled", creatorUid: "me" }), "me").includes("edit"));
  // selfUid를 모르면 띄우지 않는다.
  assert.ok(!k(mku({ taskType: "sent", status: "accepted", creatorUid: "me" }), undefined).includes("edit"));
});

test("taskActionDefs: reopen 게이트(done — is_doer/creator)", () => {
  // received(나=담당자): 완료 처리자(doneBy)가 담당자(assigneeUid=나)일 때만 되돌리기 노출.
  assert.deepEqual(kinds(mku({ taskType: "received", status: "done", assigneeUid: "me", doneBy: "me" })), ["reopen"]);
  // received인데 doneBy가 담당자가 아니면(요청자가 회수 종결 등) 미노출.
  assert.deepEqual(kinds(mku({ taskType: "received", status: "done", assigneeUid: "me", doneBy: "u-req" })), []);
  assert.deepEqual(kinds(mku({ taskType: "received", status: "done", assigneeUid: "me", doneBy: null })), []);
  // sent/personal(나=요청자)은 doneBy 무관 항상 노출.
  assert.deepEqual(kinds(mku({ taskType: "sent", status: "done", doneBy: "u-b" })), ["reopen"]);
  assert.deepEqual(kinds(mku({ taskType: "sent", status: "done", doneBy: null })), ["reopen"]);
  assert.deepEqual(kinds(mku({ taskType: "personal", status: "done", assigneeUid: null, doneBy: null })), ["reopen"]);
});

test("folderStatus: 전부 존재→done, 일부→partial(N/M), 전무→none, 빈→done", () => {
  assert.deepEqual(folderStatus(["a", "a/b", "a/t.md"], new Set(["a", "a/b", "a/t.md"])),
    { total: 3, existing: 3, missing: 0, state: "done" });
  assert.deepEqual(folderStatus(["a", "a/b", "a/t.md"], new Set(["a", "a/b"])),
    { total: 3, existing: 2, missing: 1, state: "partial" });
  assert.deepEqual(folderStatus(["a", "a/b"], new Set<string>()),
    { total: 2, existing: 0, missing: 2, state: "none" });
  // 중복 경로는 유일 집합 기준(root가 folders에도 나오는 경우 방어).
  assert.deepEqual(folderStatus(["a", "a", "a/b"], new Set(["a"])),
    { total: 2, existing: 1, missing: 1, state: "partial" });
  // 빈 매니페스트(경로 0) = done(만들 것 없음).
  assert.deepEqual(folderStatus([], new Set<string>()),
    { total: 0, existing: 0, missing: 0, state: "done" });
});

// ── 자동 생성 충돌 판정(2026-08-05) ────────────────────────────────────────────
// 팀 폴더 자동 생성이 남의 노트를 팀 범위로 끌어들이는 폴더를 찾는다(Task 10 자동 적용의 가드).

test("detectFolderConflicts — 아직 적용 안 된 자리에 남의 파일이 있으면 충돌", () => {
  // roots = 아직 팀 구조가 하나도 없는 자리들(호출부가 골라 넘긴다).
  const roots = ["나날랩스", "나날랩스/공통"];

  // 빈 vault — 충돌 없음
  assert.deepEqual(detectFolderConflicts(roots, []), []);

  // 개인 노트가 팀 루트 아래 있다 — 자동 생성이 곧 개인 노트를 팀 범위로 끌어들인다.
  assert.deepEqual(detectFolderConflicts(roots, ["나날랩스/내 메모.md"]), ["나날랩스"]);

  // 빈 폴더만 있는 경우는 파일 목록에 안 들어오므로 충돌이 아니다(호출부가 파일만 넘긴다).
  assert.deepEqual(detectFolderConflicts(roots, ["다른곳/글.md"]), []);
});

// ★ 실기기(2026-08-05)에서 잡은 거짓 양성 — 이 시험이 그때 없었다.
//   팀 폴더 **안에서 정상적으로 쓴 업무 노트**를 남의 것으로 보면, 일을 시작한 팀원 전원이
//   「이름 충돌」로 뜨고 폴더 생성까지 막힌다. 적용된 자리는 애초에 roots 에 들어오지 않는다.
test("detectFolderConflicts — 이미 적용된 자리의 업무 노트는 충돌이 아니다", () => {
  // 팀 구조가 이미 있는 대상은 호출부가 roots 에 넣지 않는다 → 검사 자체가 안 일어난다.
  assert.deepEqual(detectFolderConflicts([], ["나날랩스/공통/실험일지/2026-08-05 실험.md"]), []);
  // 다른 미적용 자리가 함께 있어도, 적용된 자리의 업무 노트는 그 자리에서 잡히지 않는다.
  assert.deepEqual(
    detectFolderConflicts(["나날랩스/과제/과제2"], ["나날랩스/공통/실험일지/업무.md"]), []);
});

// ★ 실기기에서 잡은 거짓 음성 — 팀 루트는 만들 폴더 목록(`<루트>/공통…`)에 안 들어가서
//   초안은 「팀 루트와 같은 이름의 개인 폴더」를 놓쳤다. 가장 위험한 경우가 그것이다.
test("detectFolderConflicts — 팀 루트 자체도 검사 대상이다", () => {
  assert.deepEqual(
    detectFolderConflicts(["나날랩스", "나날랩스/공통"], ["나날랩스/개인 메모.md"]),
    ["나날랩스"]);
});

test("detectFolderConflicts — 겹치면 가장 얕은 것만(한 사건을 두 번 보고하지 않는다)", () => {
  assert.deepEqual(
    detectFolderConflicts(["나날랩스", "나날랩스/공통"], ["나날랩스/공통/남의글.md"]),
    ["나날랩스"]);
});

test("detectFolderConflicts — 팀 루트 밖은 보지 않는다", () => {
  assert.deepEqual(detectFolderConflicts(["나날랩스"], ["개인/일기.md"]), []);
});

test("detectFolderConflicts — 접두어만 같은 형제 폴더는 걸리지 않는다(구분자 없는 startsWith 방지)", () => {
  assert.deepEqual(detectFolderConflicts(["나날랩스"], ["나날랩스백업/메모.md"]), []);
});

test("detectFolderConflicts — 조상-자손 사이에서는 길이 정렬이 깊이 정렬과 항상 일치한다" +
  "(자손 경로는 조상 문자열을 프리픽스로 포함하므로 이름이 얼마나 짧든 항상 더 길다)", () => {
  const roots = ["짧음", "짧음/중간이름폴더", "짧음/중간이름폴더/아주긴하위폴더이름입니다"];
  assert.deepEqual(
    detectFolderConflicts(roots, ["짧음/중간이름폴더/아주긴하위폴더이름입니다/남의글.md"]),
    ["짧음"]);
});

// ── 경로 유니코드 정규화(2026-08-05) ───────────────────────────────────────────
// 서버가 준 팀 구조 문자열(NFD일 수 있다)과 Obsidian vault 경로(NFC)를 같은 형태로 맞춘다.
// 안 맞추면 폴더가 이미 있는데도 folderStatus가 매번 없다고 판정해 자동 적용이 헛돈다.

test("nfcPath: NFD 한글을 NFC로 맞춘다 — 원래 NFC면 그대로", () => {
  const nfd = "나날랩스/공통".normalize("NFD");
  assert.notEqual(nfd, "나날랩스/공통");            // 전제 확인: 두 형태는 다른 문자열이다
  assert.equal(nfcPath(nfd), "나날랩스/공통");
  assert.equal(nfcPath("나날랩스/공통"), "나날랩스/공통"); // 멱등
  assert.equal(nfcPath("Projects/alpha"), "Projects/alpha"); // ASCII는 무변경
});

test("nfcPaths: folders·files.path·allPaths만 맞추고 body는 손대지 않는다", () => {
  const nfd = (s: string) => s.normalize("NFD");
  const out = nfcPaths({
    folders: [nfd("나날랩스/공통")],
    files: [{ path: nfd("나날랩스/공통/서식.md"), body: nfd("본문 나날"), url: "https://s3/x" }],
    allPaths: [nfd("나날랩스/공통"), nfd("나날랩스/공통/서식.md")],
  });
  assert.deepEqual(out.folders, ["나날랩스/공통"]);
  assert.deepEqual(out.allPaths, ["나날랩스/공통", "나날랩스/공통/서식.md"]);
  assert.equal(out.files[0].path, "나날랩스/공통/서식.md");
  assert.equal(out.files[0].url, "https://s3/x");
  // 본문은 파일 내용이다 — 정규화하면 봉인 해시가 서버가 준 원본과 달라진다.
  assert.equal(out.files[0].body, nfd("본문 나날"));
});

test("nfcPaths + folderStatus: 정규화하면 이미 있는 폴더를 '있다'고 본다", () => {
  const raw = { folders: ["나날랩스/공통".normalize("NFD")], files: [], allPaths: ["나날랩스/공통".normalize("NFD")] };
  const vault = new Set(["나날랩스/공통"]);                       // Obsidian이 주는 형태(NFC)
  assert.equal(folderStatus(raw.allPaths, vault).missing, 1);      // 정규화 전 — 없다고 오판
  assert.equal(folderStatus(nfcPaths(raw).allPaths, vault).missing, 0);
});

// ── 팀 폴더 이름 추적(2026-07-26) ──────────────────────────────────────────────
// 관리자가 포털에서 팀 루트나 과제명을 바꾸면 서버는 곧바로 새 이름을 내려준다. vault의 폴더는
// 옛 이름 그대로라 귀속이 끊긴다. 여기서는 "무엇을 어디로 옮겨야 하는가"만 계산한다 —
// 실제 이동 여부는 사용자가 모달에서 정한다(무단 vault 침습 방지, 2026-07-25 정책).
const SNAP = (root: string, projects: Record<string, string>) => ({ root, projects });

test("detectFolderRenames: 루트 이름이 바뀌면 루트 폴더 이동 하나", () => {
  assert.deepEqual(
    detectFolderRenames(SNAP("나날랩스", {}), SNAP("나날Labs", {})),
    [{ kind: "root", id: "", from: "나날랩스", to: "나날Labs" }]);
});

test("detectFolderRenames: 과제명이 바뀌면 루트 아래 과제 폴더 이동", () => {
  assert.deepEqual(
    detectFolderRenames(SNAP("나날랩스", { p1: "과제1" }), SNAP("나날랩스", { p1: "촉매개발" })),
    // 4계층 규약 — 과제 폴더는 `<루트>/과제/<이름>` 이다.
    [{ kind: "project", id: "p1", from: "나날랩스/과제/과제1", to: "나날랩스/과제/촉매개발" }]);
});

test("detectFolderRenames: 루트와 과제명이 함께 바뀌면 루트가 먼저, 과제는 새 루트 기준", () => {
  // 루트 이동이 먼저 실행되므로 그 시점에 과제 폴더는 이미 새 루트 아래에 있다.
  // 과제 경로를 옛 루트로 계산하면 존재하지 않는 경로를 옮기려다 실패한다.
  assert.deepEqual(
    detectFolderRenames(SNAP("A", { p1: "과제1" }), SNAP("B", { p1: "과제2" })),
    [{ kind: "root", id: "", from: "A", to: "B" },
     { kind: "project", id: "p1", from: "B/과제/과제1", to: "B/과제/과제2" }]);
});

test("taskPasses: 전 필드 검색(q)은 제목·설명·비고 중 하나만 걸려도 통과", () => {
  const base = { taskType: "personal", status: "personal", priority: "week" } as any;
  const mk = (o: any) => ({ ...base, ...o }) as UnifiedTask;
  const T = "2026-07-26";
  // 제목·설명·비고 각각에서 잡힌다.
  assert.equal(taskPasses(mk({ title: "촉매 캘리브레이션" }), { q: "캘리" }, T), true);
  assert.equal(taskPasses(mk({ title: "무관", body: "본문에 캘리브레이션" }), { q: "캘리" }, T), true);
  assert.equal(taskPasses(mk({ title: "무관", memo: "비고에 캘리브레이션" }), { q: "캘리" }, T), true);
  // 어디에도 없으면 탈락.
  assert.equal(taskPasses(mk({ title: "무관", body: "b", memo: "m" }), { q: "캘리" }, T), false);
  // 대소문자 무시(ASCII).
  assert.equal(taskPasses(mk({ title: "Calibration Run" }), { q: "calibration" }, T), true);
  // 컬럼 필터와는 AND — q가 걸려도 titleText가 안 맞으면 탈락한다.
  assert.equal(taskPasses(mk({ title: "A", body: "캘리브레이션" }), { q: "캘리", titleText: "Z" }, T), false);
  // 빈 q는 필터 미적용.
  assert.equal(taskPasses(mk({ title: "아무거나" }), { q: "" }, T), true);
});

test("detectFolderRenames: 첫 동기화(이전 스냅샷 없음)는 이동 없음", () => {
  // 옛 이름을 모르면 무엇을 옮길지도 알 수 없다 — 있지도 않은 폴더를 만들려 들면 안 된다.
  assert.deepEqual(detectFolderRenames(SNAP("", {}), SNAP("나날랩스", { p1: "과제1" })), []);
});

test("detectFolderRenames: 팀 루트 해제(새 루트가 빈 값)는 이동 없음", () => {
  assert.deepEqual(detectFolderRenames(SNAP("나날랩스", { p1: "과제1" }), SNAP("", {})), []);
});

test("detectFolderRenames: 신규·삭제된 과제는 이동 대상이 아니다", () => {
  assert.deepEqual(
    detectFolderRenames(SNAP("R", { old: "사라질과제" }), SNAP("R", { fresh: "새과제" })), []);
});

test("detectFolderRenames: 바뀐 것이 없으면 빈 배열", () => {
  assert.deepEqual(detectFolderRenames(SNAP("R", { p1: "과제1" }), SNAP("R", { p1: "과제1" })), []);
});

// ── 킷 샘플 분리(2026-07-27) ────────────────────────────────────────────────
// 샘플은 하지도 않은 실험·수업 기록이다. vault에 만들면 `.md`라 **봉인**되고 되돌릴 수 없다.
// 그래서 기본은 만들지 않는다 — 이 계약이 깨지면 허구 기록이 원장에 박힌다.
test("manifestPaths: 샘플은 기본으로 만들지 않는다", () => {
  const m = {
    folders: ["00-Home", "20-Lessons", "_samples/20-Lessons"],
    templates: [],
    files: [
      { path: "00-Home/홈.md", url: "u1", sample: false },
      { path: "90-Templates/새 학생.md", url: "u2", sample: false },
      { path: "_samples/20-Lessons/LS-1.md", url: "u3", sample: true },
      { path: "_samples/홈.md", url: "u4", sample: true },
    ],
  };
  const off = manifestPaths("나날랩스/과제1", m);
  const paths = off.files.map((f) => f.path);
  assert.ok(paths.includes("나날랩스/과제1/00-Home/홈.md"), "골격은 만들어야 한다");
  assert.ok(paths.includes("나날랩스/과제1/90-Templates/새 학생.md"), "템플릿은 만들어야 한다");
  assert.ok(!paths.some((p) => p.includes("_samples")), "샘플이 기본으로 만들어졌다");
  assert.ok(!off.folders.some((f) => f.includes("_samples")), "샘플 폴더가 기본으로 만들어졌다");

  const on = manifestPaths("나날랩스/과제1", m, { samples: true });
  const onPaths = on.files.map((f) => f.path);
  assert.ok(onPaths.includes("나날랩스/과제1/_samples/20-Lessons/LS-1.md"), "켜면 샘플도 만든다");
  assert.ok(on.folders.includes("나날랩스/과제1/_samples/20-Lessons"), "샘플 폴더도 만든다");
  assert.equal(onPaths.length, 4);
});

test("isKitSamplePath: 세그먼트 일치만 — 서버 is_sample과 같은 규칙", () => {
  assert.equal(isKitSamplePath("_samples/a.md"), true);
  assert.equal(isKitSamplePath("20-Lessons/_samples/a.md"), true);
  // 접두가 같을 뿐인 폴더는 샘플이 아니다 — 여기서 과하게 잡으면 실제 기록이 봉인에서 빠진다
  assert.equal(isKitSamplePath("_samples2/a.md"), false);
  assert.equal(isKitSamplePath("my_samples/a.md"), false);
  assert.equal(isKitSamplePath("20-Lessons/LS-1.md"), false);
});

test("manifestPaths: 팀 킷 files와 내장 킷 templates가 함께 와도 중복 없이", () => {
  const m = {
    folders: [],
    templates: [{ path: "90-Templates/t.md", body: "본문" }],
    files: [{ path: "90-Templates/t.md", url: "u", sample: false },
            { path: "00-Home/홈.md", url: "u2", sample: false }],
  };
  const r = manifestPaths("P", m);
  assert.equal(r.files.length, 2, "같은 경로는 한 번만");
  // templates가 먼저 — 본문 인라인이 URL 왕복보다 확실하다
  assert.equal(r.files[0].body, "본문");
  assert.equal(r.files[0].url, undefined);
  assert.equal(r.files[1].url, "u2");
});

test("isBinaryPath: 이미지·PDF는 바이너리, 마크다운은 아니다", () => {
  for (const p of ["a/logo.png", "b.PDF", "c.xlsx", "d.woff2"]) {
    assert.equal(isBinaryPath(p), true, p);
  }
  for (const p of ["a.md", "b.txt", "c.canvas", "d.json"]) {
    assert.equal(isBinaryPath(p), false, p);
  }
});

// ── 폴더별 기본 서식 (2026-08-02) ──────────────────────────────────────────
//
// 서식을 90-템플릿에 넣어 둬도 새 노트는 **빈 채로** 생긴다. 사람은 빈 화면을 못 채우고,
// 그러면 서식을 만든 의미가 없다. 새 노트가 놓인 폴더를 보고 서식을 골라 준다.

test("templateForFolder: 번호를 뗀 폴더 이름으로 서식을 고른다", () => {
  const st = {
    root: "나날랩스",
    folders: ["00-안내", "10-연구노트", "20-의사결정", "90-템플릿"],
    templates: [
      { path: "90-템플릿/주간 연구노트.md", body: "노트본문" },
      { path: "90-템플릿/의사결정 기록.md", body: "결정본문" },
    ],
  };
  const pick = (p: string) => templateForFolder(st, p);
  // 폴더 `20-의사결정` → 이름에 「의사결정」이 든 서식.
  assert.equal(pick("나날랩스/공통/20-의사결정/새 노트.md"), "결정본문");
  assert.equal(pick("나날랩스/공통/10-연구노트/2026-W32.md"), "노트본문");
  // 짝이 없으면 아무것도 넣지 않는다 — 엉뚱한 서식을 넣는 것보다 빈 노트가 낫다.
  assert.equal(pick("나날랩스/공통/00-안내/메모.md"), null);
  // 서식 폴더 자체에서 만든 새 노트는 건드리지 않는다(서식을 만드는 중이다).
  assert.equal(pick("나날랩스/공통/90-템플릿/새 서식.md"), null);
  // 팀 밖·과제 폴더는 대상이 아니다.
  assert.equal(pick("개인메모/오늘.md"), null);
  assert.equal(pick("나날랩스/과제/촉매개발/노트.md"), null);
  // 한 층 더 깊어도 **바로 위 폴더**로 고른다.
  assert.equal(pick("나날랩스/공통/20-의사결정/2026/007.md"), null);
});

test("templateForFolder: 번호 체계형처럼 중첩 폴더도 바로 위 이름으로", () => {
  const st = {
    root: "나날랩스",
    folders: ["20-연구", "20-연구/21-연구노트", "90-템플릿"],
    templates: [{ path: "90-템플릿/주간 연구노트.md", body: "본문" }],
  };
  assert.equal(templateForFolder(st, "나날랩스/공통/20-연구/21-연구노트/W32.md"), "본문");
});

// ── 팀 폴더의 새 노트 이름 (2026-08-02) ───────────────────────────────────
//
// 서식은 붙는데 제목이 「무제」로 남는다. 이름을 안 고치면 무제·무제 1·무제 2가 쌓이고,
// 그러면 목록에서 무엇이 무엇인지 알 수 없다. 폴더가 이미 성격을 말하고 있으니 그걸 쓴다.

test("teamFolderName: 번호를 뗀 팀 공통 폴더 이름", () => {
  const st = { root: "나날랩스", folders: ["10-연구노트", "20-연구", "20-연구/21-실험", "90-템플릿"], templates: [] };
  assert.equal(teamFolderName(st, "나날랩스/공통/10-연구노트/무제.md"), "연구노트");
  assert.equal(teamFolderName(st, "나날랩스/공통/20-연구/21-실험/무제.md"), "실험");
  assert.equal(teamFolderName(st, "나날랩스/공통/90-템플릿/무제.md"), null);   // 서식 폴더
  assert.equal(teamFolderName(st, "나날랩스/공통/딴폴더/무제.md"), null);       // 구조 밖
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매/무제.md"), null);         // 과제 층
  assert.equal(teamFolderName(st, "개인메모/무제.md"), null);
});

test("isUntitledName: 옵시디언 기본 이름만 갈아 끼운다", () => {
  for (const n of ["무제", "무제 1", "무제 12", "Untitled", "Untitled 3"]) {
    assert.equal(isUntitledName(n), true, n);
  }
  // 사람이 지은 이름은 건드리지 않는다.
  for (const n of ["연구노트", "무제의 발견", "Untitled Symphony", "0007-사슬 분리"]) {
    assert.equal(isUntitledName(n), false, n);
  }
});

test("nextNoteName: <폴더>-<날짜>, 겹치면 뒤에 번호", () => {
  const has = (n: string) => ["연구노트-2026-08-02", "연구노트-2026-08-02-2"].includes(n);
  assert.equal(nextNoteName("연구노트", "2026-08-02", () => false), "연구노트-2026-08-02");
  assert.equal(nextNoteName("연구노트", "2026-08-02", has), "연구노트-2026-08-02-3");
  assert.equal(nextNoteName("회의록", "2026-08-02", () => false), "회의록-2026-08-02");
});

test("teamFolderName: 과제 폴더에도 적용된다 (2026-08-02)", () => {
  const st = { root: "나날랩스", folders: ["10-연구노트", "90-템플릿"], templates: [] };
  // <루트>/과제/<과제명>/<숫자-이름>/ — 과제 킷이 깐 폴더도 같은 규칙을 받는다.
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매개발/20-실험/a.md"), "실험");
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매개발/10-Projects/a.md"), "Projects");
  // 과제 폴더 바로 밑(폴더 없음)은 대상이 아니다 — 과제 개요·계획서 자리다.
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매개발/개요.md"), null);
  // 번호 없는 폴더는 손대지 않는다 — 사용자가 스스로 만든 자리다.
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매개발/메모/a.md"), null);
  // 서식 폴더는 여기서도 제외.
  assert.equal(teamFolderName(st, "나날랩스/과제/촉매개발/90-Templates/a.md"), null);
  // 과제 층 자체(과제명이 없는 경로)는 아니다.
  assert.equal(teamFolderName(st, "나날랩스/과제/a.md"), null);
});

// ── 폴더별 규칙 (2026-08-02) ───────────────────────────────────────────────
//
// 이름 규약(서식 파일명 = 번호 뗀 폴더 이름)은 **우리가 만든 킷에서만** 통한다.
// 외부 킷 381개 폴더 중 짝지어지는 것은 0개였다. 그래서 관리자가 팀 설정에서
// 「이 폴더에는 이 서식, 제목은 이 접두로」를 정하고, 그것이 팀 전체에 배포된다.

test("parseFolderRules: 팀 구조가 실어 오는 폴더별 규칙", () => {
  const r = parseFolderRules({
    "20-Sessions": { template: "90-Templates/새 작성 세션.md", prefix: "작성세션" },
    "30-Sources": { template: "90-Templates/새 자료.md" },
    "40-Data": { prefix: "데이터" },
  });
  assert.equal(r["20-Sessions"].template, "90-Templates/새 작성 세션.md");
  assert.equal(r["20-Sessions"].prefix, "작성세션");
  assert.equal(r["30-Sources"].prefix, undefined);
  assert.equal(r["40-Data"].template, undefined);       // 접두만 정해도 된다
  // 모양이 다른 것은 버린다 — 하나가 잘못됐다고 새 노트 만들기가 실패하면 안 된다.
  assert.deepEqual(parseFolderRules(null), {});
  assert.deepEqual(parseFolderRules([1, 2]), {});
  assert.equal(parseFolderRules({ a: 3 }).a, undefined);
  // 킷 밖을 가리키는 경로는 버린다 — 규칙이 vault 아무 파일이나 읽게 하면 안 된다.
  assert.equal(parseFolderRules({ a: { template: "../비밀.md" } }).a, undefined);
  assert.equal(parseFolderRules({ a: { template: "/etc/passwd" } }).a, undefined);
});

test("kitRuleFor: 규칙이 있으면 그것, 없으면 이름 규약", () => {
  const rules = parseFolderRules({
    "20-Sessions": { template: "90-Templates/새 작성 세션.md", prefix: "작성세션" },
    "10-연구노트": { prefix: "주간노트" },
  });
  assert.deepEqual(kitRuleFor(rules, "20-Sessions"),
                   { template: "90-Templates/새 작성 세션.md", prefix: "작성세션" });
  assert.deepEqual(kitRuleFor(rules, "10-연구노트"), { template: null, prefix: "주간노트" });
  assert.deepEqual(kitRuleFor(rules, "30-의사결정"), { template: null, prefix: "의사결정" });
  assert.deepEqual(kitRuleFor({}, "30-의사결정"), { template: null, prefix: "의사결정" });
});

test("teamFolderSegment: 폴더 이름과 **킷 뿌리**를 함께 돌려준다", () => {
  const st = { root: "나날랩스", folders: ["10-연구노트", "90-템플릿"], templates: [] };
  // 규칙이 가리키는 서식 경로는 킷 뿌리 기준이라, 뿌리를 알아야 읽을 수 있다.
  assert.deepEqual(teamFolderSegment(st, "나날랩스/공통/10-연구노트/a.md"),
                   { folder: "10-연구노트", kitRoot: "나날랩스/공통" });
  assert.deepEqual(teamFolderSegment(st, "나날랩스/과제/촉매/20-Sessions/a.md"),
                   { folder: "20-Sessions", kitRoot: "나날랩스/과제/촉매" });
  assert.equal(teamFolderSegment(st, "개인메모/a.md"), null);
  // teamFolderName 은 이 함수 위에 서고, 이름만 돌려준다(호환 유지).
  assert.equal(teamFolderName(st, "나날랩스/공통/10-연구노트/a.md"), "연구노트");
});

// digest 폴더는 **팀 루트 아래**여야 한다(2026-08-02 실측으로 발견).
// 종전 기본값 `digests/` 는 팀 루트 밖이라 봉인 범위에 들지 않았다 — 봉인이 안 되면
// 등록부 보고도, 포털 목록도, WORM 원문도 없다. 절차 전체가 조용히 끊긴다.
test("digestFolderFor: 팀이면 <루트>/공통/digests, 개인이면 설정 그대로", () => {
  assert.strictEqual(digestFolderFor("사차연구소", "digests"), "사차연구소/공통/digests");
  assert.strictEqual(digestFolderFor("", "digests"), "digests");
  assert.strictEqual(digestFolderFor(null, "digests"), "digests");
  // 설정을 비우면 팀에서도 비운다(= digest 폴더 미사용 — 라우팅·판정 모두 꺼짐)
  assert.strictEqual(digestFolderFor("사차연구소", ""), "");
  // 이미 팀 루트로 시작하면 두 번 붙이지 않는다
  assert.strictEqual(digestFolderFor("사차연구소", "사차연구소/공통/digests"), "사차연구소/공통/digests");
});

// 상한 미만이면 손대지 않는다 — 정상 경로에서 매번 자르기 비용을 들이지 않는다.
test("capFolderReport: 상한 이하는 그대로 통과", () => {
  const r = capFolderReport(["a", "b"], [{ from: "x", to: "y" }]);
  assert.deepEqual(r.conflicts, ["a", "b"]);
  assert.deepEqual(r.pendingRenames, [{ from: "x", to: "y" }]);
});

// 배열은 앞에서부터 50개만 — conflicts는 얕은 순, pending_renames는 루트가 먼저이므로
// 앞쪽이 이미 가장 급한 항목이다(호출부가 그 순서로 넘긴다는 전제).
test("capFolderReport: 배열은 앞에서 50개로 자른다", () => {
  const conflicts = Array.from({ length: 60 }, (_, i) => `folder-${i}`);
  const renames = Array.from({ length: 60 }, (_, i) => ({ from: `a${i}`, to: `b${i}` }));
  const r = capFolderReport(conflicts, renames);
  assert.equal(r.conflicts.length, FOLDER_REPORT_MAX_ITEMS);
  assert.deepEqual(r.conflicts[0], "folder-0");
  assert.deepEqual(r.conflicts[49], "folder-49");
  assert.equal(r.pendingRenames.length, FOLDER_REPORT_MAX_ITEMS);
  assert.deepEqual(r.pendingRenames[0], { from: "a0", to: "b0" });
});

// 서버는 UTF-8 바이트로 400을 잰다(Rust String::len()) — 한글은 3바이트라 133자보다도
// 훨씬 앞에서 넘친다. JS .length(UTF-16 코드유닛)로만 재면 이 경우를 놓친다.
test("capFolderReport: 긴 한글 경로는 UTF-8 400바이트 기준으로 자른다", () => {
  const longKorean = "가".repeat(200); // 200자 × 3바이트 = 600바이트, .length로는 200 < 400
  const r = capFolderReport([longKorean], []);
  const bytes = new TextEncoder().encode(r.conflicts[0]).byteLength;
  assert.ok(bytes <= 400, `잘린 뒤에도 ${bytes}바이트`);
  assert.ok(r.conflicts[0].length < longKorean.length); // 실제로 잘렸다
  // 아스키 경로는 바이트=글자 수라 400자까지는 그대로다.
  const longAscii = "a".repeat(400);
  assert.equal(capFolderReport([longAscii], []).conflicts[0], longAscii);
  assert.equal(capFolderReport(["a".repeat(500)], []).conflicts[0].length, 400);
});
