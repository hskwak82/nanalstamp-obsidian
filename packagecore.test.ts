import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crc32, buildZip, chainCheckFile, fileSeqFile, blockInfoFile, otsFileName,
  splitByCoverage, latestCoveredSeq, packageFolderName, unixMode,
  partitionVerifiedAnchors, coverageOf, snapshotAt, endOfDayEpoch, tallyOrigins,
  fillReadme, readmeFields, dosStamp, reviewFile,
  expectedSeqs, dispositionFile, dispositionOf, Disposition, isFilePath,
  timelineRows, timelineFile, localDay,
  ChainEntry, AnchorInfo, PackageFile,
} from "./packagecore";

const enc = new TextEncoder();
const dec = new TextDecoder();

function entry(over: Partial<ChainEntry>): ChainEntry {
  return {
    seq: 0, prev_hash: "0".repeat(64), file_hash: "a".repeat(64),
    path: "p".repeat(64), received_at: 1785209779, entry_hash: "e".repeat(64), ...over,
  };
}

// ── zip ─────────────────────────────────────────────────────────────────────
// 검증기(웹·맥·윈도우)가 이 zip 을 열지 못하면 제출물이 통째로 무용지물이 된다.
// 그래서 "만들어졌다"가 아니라 **중앙 디렉터리를 되읽어** 확인한다.

test("crc32 — 알려진 값", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

/// check.js 의 해제기와 같은 방식으로 중앙 디렉터리를 읽는다.
function readZipNames(buf: Uint8Array): string[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "EOCD 를 찾지 못했다");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, "중앙 디렉터리 시그니처");
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    names.push(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return names;
}

test("buildZip — 중앙 디렉터리로 되읽을 수 있다", async () => {
  const z = await buildZip([
    { name: "증명/_사슬검사용.txt", data: enc.encode("0|a|b\n") },
    { name: "노트/연구노트/개발일지/메모.md", data: enc.encode("# 제목\n본문\n") },
  ]);
  assert.deepEqual(readZipNames(z), ["증명/_사슬검사용.txt", "노트/연구노트/개발일지/메모.md"]);
});

test("buildZip — 한글 파일명은 UTF-8 플래그(비트 11)를 세운다", async () => {
  // 이 비트가 없으면 윈도우 탐색기가 CP949 로 읽어 폴더명이 깨지고,
  // 검증기가 '증명/_사슬검사용.txt' 를 찾지 못해 "증명 파일이 없습니다"가 뜬다.
  const z = await buildZip([{ name: "노트/한글.md", data: enc.encode("x") }]);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, "로컬 헤더 UTF-8 플래그");
});

test("buildZip — 본문을 그대로 되읽을 수 있다(저장 방식)", async () => {
  // 압축이 없는 런타임에서도 결과물은 열려야 한다.
  const body = enc.encode("압축되지 않는 짧은 내용");
  const z = await buildZip([{ name: "a.txt", data: body }]);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const method = dv.getUint16(8, true);
  const csize = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  assert.equal(dv.getUint32(14, true), crc32(body), "CRC 는 원본 기준");
  assert.equal(dv.getUint32(22, true), body.length, "원본 크기");
  if (method === 0) assert.deepEqual(z.subarray(start, start + csize), body);
});

test("buildZip — 빈 목록도 유효한 zip", async () => {
  const z = await buildZip([]);
  assert.deepEqual(readZipNames(z), []);
});

// ── 증명 파일 형식 ──────────────────────────────────────────────────────────
// 형식은 검증기와의 계약이다. 열 순서가 바뀌면 심사자 화면에 "변조됨"이 뜬다.

test("chainCheckFile — 계산식을 첫머리에 적고 6열로 쓴다", () => {
  const s = chainCheckFile("uid-1", [entry({ seq: 0 }), entry({ seq: 1, prev_hash: "e".repeat(64) })]);
  const lines = s.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split("|").length, 6);
  assert.match(s, /계산식: 이기록 = SHA256\( uid-1\|순번\|앞기록\|내용해시\|경로해시\|시각 \)/);
});

test("fileSeqFile — 경로에 노트/ 접두가 붙는다(zip 안의 실제 위치)", () => {
  const s = fileSeqFile([
    { vaultPath: "연구노트/개발일지/메모.md", seq: 3, fileHash: "a".repeat(64), data: new Uint8Array() },
  ]);
  const line = s.split("\n").filter((l) => l && !l.startsWith("#"))[0];
  assert.equal(line, `3|${"a".repeat(64)}|노트/연구노트/개발일지/메모.md`);
});

test("blockInfoFile / otsFileName — 블록·머클루트·파일명이 맞물린다", () => {
  const a: AnchorInfo = {
    head_seq: 14, head_entry_hash: "e".repeat(64), block_height: 959948,
    merkle_root: "b".repeat(64), ots_b64: "",
  };
  assert.equal(otsFileName(a), "블록959948_head14.ots");
  const line = blockInfoFile([a]).split("\n").filter((l) => l && !l.startsWith("#"))[0];
  assert.equal(line, `959948|${"b".repeat(64)}|블록959948_head14.ots`);
});

test("blockInfoFile — 머클루트가 없으면 빈 칸으로 두되 열 수는 유지한다", () => {
  const line = blockInfoFile([{
    head_seq: 1, head_entry_hash: "", block_height: 900000, merkle_root: null, ots_b64: "",
  }]).split("\n").filter((l) => l && !l.startsWith("#"))[0];
  assert.equal(line.split("|").length, 3);
});

// ── 범위 ────────────────────────────────────────────────────────────────────

test("splitByCoverage — 앵커가 덮지 못한 파일은 넣지 않는다", () => {
  const files = [{ seq: 0 }, { seq: 14 }, { seq: 15 }];
  const { included, pending } = splitByCoverage(files, 14);
  assert.deepEqual(included.map((f) => f.seq), [0, 14]);
  assert.deepEqual(pending.map((f) => f.seq), [15]);
});

test("splitByCoverage — 확정 앵커가 없으면(-1) 아무것도 넣지 않는다", () => {
  const { included, pending } = splitByCoverage([{ seq: 0 }], -1);
  assert.equal(included.length, 0);
  assert.equal(pending.length, 1);
});

test("latestCoveredSeq — 같은 파일의 여러 봉인 중 덮인 범위의 마지막을 고른다", () => {
  const ph = "p".repeat(64), fh = "f".repeat(64);
  const chain = [
    entry({ seq: 1, path: ph, file_hash: fh }),
    entry({ seq: 5, path: ph, file_hash: fh }),
    entry({ seq: 9, path: ph, file_hash: fh }),
  ];
  assert.equal(latestCoveredSeq(chain, ph, fh, 14)?.seq, 9);
  // 앵커가 6까지만 덮으면 9번이 아니라 5번을 쓴다 — 그러지 않으면 멀쩡한 봉인본이
  // 있는데도 그 파일이 통째로 패키지에서 빠진다.
  assert.equal(latestCoveredSeq(chain, ph, fh, 6)?.seq, 5);
  assert.equal(latestCoveredSeq(chain, ph, fh, 0), null);
});

test("latestCoveredSeq — 내용이 다르면(현재 파일이 미봉인) 찾지 못한다", () => {
  const ph = "p".repeat(64);
  const chain = [entry({ seq: 1, path: ph, file_hash: "f".repeat(64) })];
  assert.equal(latestCoveredSeq(chain, ph, "9".repeat(64), 14), null);
});

test("latestCoveredSeq — 경로가 다르면 섞이지 않는다", () => {
  const fh = "f".repeat(64);
  const chain = [entry({ seq: 1, path: "a".repeat(64), file_hash: fh })];
  assert.equal(latestCoveredSeq(chain, "b".repeat(64), fh, 14), null);
});

test("packageFolderName — 파일 시스템이 거부하는 글자를 지운다", () => {
  assert.equal(packageFolderName("나날랩스", "2026-07-29"), "제출_나날랩스_2026-07-29");
  assert.equal(packageFolderName('a/b:c*?"<>|', "2026-07-29"), "제출_a_b_c_______2026-07-29");
  assert.equal(packageFolderName("  ", "2026-07-29"), "제출_제출_2026-07-29");
});

test("buildZip — '만든 곳'을 Unix 로 적는다(한글 파일명 해제의 조건)", async () => {
  // macOS 기본 unzip 은 UTF-8 플래그를 보지 않는다. 이 값이 0(MS-DOS)이면 한글 경로가
  // CP437 로 해석돼 "Illegal byte sequence" 로 **압축 해제가 통째로 실패**한다(실측).
  // 심사자가 압축조차 못 푸는 것은 검증기 결함보다 앞선 문제라 여기서 고정한다.
  const z = await buildZip([{ name: "노트/연구노트/한글 경로.md", data: enc.encode("x") }]);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let eocd = -1;
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  const cen = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint8(cen + 5), 3, "version made by 상위 바이트 = Unix");
  assert.equal(dv.getUint16(cen + 8, true) & 0x0800, 0x0800, "UTF-8 플래그도 유지");
});

test("unixMode — 검사 프로그램만 실행 권한", () => {
  assert.equal(unixMode("검증하기(맥·리눅스).command"), 0o100755);
  assert.equal(unixMode("공격시험.sh"), 0o100755);
  assert.equal(unixMode("00_먼저-읽어주세요.html"), 0o100644);
  assert.equal(unixMode("노트/연구노트/메모.md"), 0o100644);
});

test("buildZip — 유닉스 권한을 적는다(mode 000 으로 풀리지 않게)", async () => {
  // 비워 두면 압축을 푼 심사자가 **안내문조차 열지 못한다**(2026-07-29 실측).
  const z = await buildZip([
    { name: "a.md", data: enc.encode("x") },
    { name: "검증하기.command", data: enc.encode("y") },
  ]);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let eocd = -1;
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  let p = dv.getUint32(eocd + 16, true);
  const modes: number[] = [];
  for (let i = 0; i < 2; i++) {
    modes.push(dv.getUint32(p + 38, true) >>> 16);
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  assert.deepEqual(modes, [0o100644, 0o100755]);
});

// ── 앵커 실측 대조 ──────────────────────────────────────────────────────────
// 통과하지 못할 증거는 증거가 아니다. 만드는 쪽에서 걸러야 심사자 앞에서 실패하지 않는다.

function anc(over: Partial<AnchorInfo>): AnchorInfo {
  return { head_seq: 10, head_entry_hash: "e".repeat(64), block_height: 900000,
           merkle_root: "m".repeat(64), ots_b64: "", ...over };
}

test("partitionVerifiedAnchors — 실제 블록과 다른 앵커는 뺀다", () => {
  const ok = anc({ block_height: 1, merkle_root: "a".repeat(64) });
  const ng = anc({ block_height: 2, merkle_root: "b".repeat(64) });
  const real = new Map([[1, "a".repeat(64)], [2, "z".repeat(64)]]);
  const { good, bad } = partitionVerifiedAnchors([ok, ng], real);
  assert.deepEqual(good.map((a) => a.block_height), [1]);
  assert.deepEqual(bad.map((a) => a.block_height), [2]);
});

test("partitionVerifiedAnchors — 조회하지 못한 블록은 버리지 않는다", () => {
  // 인터넷이 막힌 곳에서 멀쩡한 증거를 떨어뜨리면 패키지를 아예 못 만든다.
  const a = anc({ block_height: 7 });
  assert.equal(partitionVerifiedAnchors([a], new Map([[7, null]])).good.length, 1);
  assert.equal(partitionVerifiedAnchors([a], new Map()).good.length, 1);
});

test("coverageOf — 걸러낸 뒤의 범위로 다시 계산한다", () => {
  // 뺀 앵커의 범위를 그대로 두면 "고정됨"으로 표시된 파일이 실제로는 덮이지 않는다.
  assert.equal(coverageOf([anc({ head_seq: 5 }), anc({ head_seq: 12 })]), 12);
  assert.equal(coverageOf([]), -1);
});

// ── 특정 날짜 시점 ──────────────────────────────────────────────────────────
// 연구노트 제출은 과제 기간 단위다. 지금 내용으로만 만들면 그 뒤 수정이 섞인다.

test("snapshotAt — 그날까지의 마지막 봉인 버전을 경로마다 하나씩", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const chain = [
    entry({ seq: 0, path: A, received_at: 100, file_hash: "1".repeat(64) }),
    entry({ seq: 1, path: A, received_at: 200, file_hash: "2".repeat(64) }),
    entry({ seq: 2, path: B, received_at: 150, file_hash: "3".repeat(64) }),
    entry({ seq: 3, path: A, received_at: 900, file_hash: "4".repeat(64) }),  // 기준 이후
  ];
  const snap = snapshotAt(chain, 300, 99);
  assert.equal(snap.size, 2);
  assert.equal(snap.get(A)?.seq, 1, "기준 시각 이전의 마지막 버전");
  assert.equal(snap.get(B)?.seq, 2);
});

test("snapshotAt — 앵커가 덮지 못한 기록은 제외한다", () => {
  const A = "a".repeat(64);
  const chain = [
    entry({ seq: 0, path: A, received_at: 100 }),
    entry({ seq: 5, path: A, received_at: 200 }),
  ];
  // 앵커가 0번까지만 덮으면 5번은 못 쓴다 — 그 시점의 최신이라도 증명되지 않는다.
  assert.equal(snapshotAt(chain, 300, 0).get(A)?.seq, 0);
  assert.equal(snapshotAt(chain, 300, -1).size, 0);
});

test("snapshotAt — 기준일 이전에 아무것도 없으면 빈 결과", () => {
  assert.equal(snapshotAt([entry({ received_at: 500 })], 100, 99).size, 0);
});

test("endOfDayEpoch — 그날 23:59:59 까지 포함한다", () => {
  const e = endOfDayEpoch("2026-03-31");
  const d = new Date(e * 1000);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 23);
});

test("tallyOrigins — 어디서 몇 개를 가져오는지 센다", () => {
  const t = tallyOrigins([{ from: "device" }, { from: "device" }, { from: "storage" }, { from: null }]);
  assert.deepEqual(t, { device: 2, storage: 1, missing: 1 });
});

// ── 안내문 채우기 ───────────────────────────────────────────────────────────
// 심사자가 가장 먼저 여는 문서가 사실과 다른 숫자를 말하면, 검증 결함보다 앞선 문제다.

test("fillReadme — 자리표시자를 실제 값으로 바꾸고, 없는 값은 비운다", () => {
  const out = fillReadme("파일 {{파일수}}개 · {{블록목록}} · {{없는키}}", { 파일수: "209", 블록목록: "#959,866" });
  assert.equal(out, "파일 209개 · #959,866 · ");
});

test("readmeFields — 담긴 파일 기준으로 기간과 블록을 뽑는다", () => {
  const chain = [
    entry({ seq: 1, received_at: 1785000000 }),
    entry({ seq: 2, received_at: 1785200000 }),
    entry({ seq: 9, received_at: 1785900000 }),   // 안 담긴 기록은 기간에 넣지 않는다
  ];
  const files: PackageFile[] = [
    { vaultPath: "a.md", seq: 1, fileHash: "x", data: new Uint8Array() },
    { vaultPath: "b.md", seq: 2, fileHash: "y", data: new Uint8Array() },
  ];
  const anchors: AnchorInfo[] = [{ head_seq: 2, head_entry_hash: "", block_height: 959866, merkle_root: null, ots_b64: "" }];
  const f = readmeFields(files, chain, anchors, undefined, "2026-07-29");
  assert.equal(f["파일수"], "2");
  assert.equal(f["블록목록"], "#959,866");
  assert.equal(f["기준시점"], "2026-07-29");
  assert.match(f["기준설명"], /만든 날/);
  assert.match(f["기간"], /~/);
});

test("readmeFields — 기준일을 주면 그 날짜와 설명이 바뀐다", () => {
  const f = readmeFields([], [], [], "2026-03-31", "2026-07-29");
  assert.equal(f["기준시점"], "2026-03-31");
  assert.match(f["기준설명"], /지정하신/);
  assert.equal(f["만든날"], "2026-07-29");
  assert.equal(f["기간"], "—");
  assert.equal(f["블록목록"], "—");
});

test("dosStamp — 봉인 시각이 zip 날짜로 들어간다(1980 고정이 아니다)", () => {
  // 비워 두면 심사자가 압축을 풀었을 때 연구노트가 전부 1980년 파일로 보인다(실측).
  const [time, date] = dosStamp(Math.floor(new Date(2026, 6, 28, 14, 30, 20).getTime() / 1000));
  assert.equal(date >> 9, 2026 - 1980);
  assert.equal((date >> 5) & 0xf, 7);
  assert.equal(date & 0x1f, 28);
  assert.equal(time >> 11, 14);
  assert.equal((time >> 5) & 0x3f, 30);
});

test("dosStamp — 1980년 이전 값도 포맷이 깨지지 않는다", () => {
  const [, date] = dosStamp(0);
  assert.ok(date >> 9 >= 0, "연도 필드가 음수가 되지 않는다");
});

test("fileSeqFile — 요약 PDF 는 '노트/' 접두 없이 목록 끝에 붙는다", () => {
  // 봉인하면 검증기가 노트와 같은 방식으로 대조한다 — 발급자 서명을 믿는 것보다 강하다.
  const s = fileSeqFile(
    [{ vaultPath: "연구노트/a.md", seq: 3, fileHash: "a".repeat(64), data: new Uint8Array() }],
    { seq: 1310, hash: "b".repeat(64) },
  );
  const lines = s.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines[0], `3|${"a".repeat(64)}|노트/연구노트/a.md`);
  assert.equal(lines[1], `1310|${"b".repeat(64)}|증명서(요약).pdf`);
});

test("fileSeqFile — PDF 봉인이 실패하면 목록에 넣지 않는다", () => {
  const s = fileSeqFile([{ vaultPath: "a.md", seq: 1, fileHash: "c".repeat(64), data: new Uint8Array() }]);
  assert.equal(s.split("\n").filter((l) => l && !l.startsWith("#")).length, 1);
});

// ── 점검자 서명 ─────────────────────────────────────────────────────────────

test("reviewFile — 묶음·판정 정보까지 9열로 쓴다(스크립트가 읽을 표)", () => {
  const s = reviewFile([
    { seq: 12, statement: "approved", reviewer_user_id: "u1", reviewer_email: "a@b.c",
      reviewed_at: 1785000000, payload_hash: "p".repeat(64), signature: "sig",
      merkle_root: "r".repeat(64), viewed_root: "v".repeat(64), item_count: 7,
      verdict_root: "d".repeat(64) },
    { seq: 13, statement: "reviewed", reviewer_user_id: "u2", reviewer_email: null,
      reviewed_at: 1785000001, payload_hash: "q".repeat(64), signature: "sig" },
  ]);
  const lines = s.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines[0],
    `12|approved|a@b.c|1785000000|${"p".repeat(64)}|${"v".repeat(64)}|${"r".repeat(64)}|7|${"d".repeat(64)}`);
  // 이메일이 없으면 uid, 없는 값은 '-', 건수는 기본 1 — 열 수는 항상 같아야 한다.
  assert.equal(lines[1], `13|reviewed|u2|1785000001|${"q".repeat(64)}|-|-|1|-`);
  assert.match(s, /nsrd1\|묶음루트\|점검자\|시각\|판정\|열람루트\|판정루트/);
});

// ── 처분내역 ────────────────────────────────────────────────────────
// 이 자료는 사슬의 부분집합이다. 빠진 것을 침묵하면 **불리한 기록을 빼도 구별할 수 없다** —
// 그래서 사슬의 모든 순번에 처분을 매기고, 검증기가 그중 셋을 스스로 다시 계산한다.
// path 는 **경로 해시**(64자 hex)다 — 평문이면 서버가 만든 기록으로 판정되므로 형식을 지킨다.
const PA = "a".repeat(64), PB = "b".repeat(64), PC = "c".repeat(64), PD = "d".repeat(64);
const DCHAIN: ChainEntry[] = [
  // seq, prev, file, path(해시), received_at, entry
  { seq: 1, prev_hash: "p", file_hash: "f1", path: PA, received_at: 100, entry_hash: "e1" },
  { seq: 2, prev_hash: "p", file_hash: "f2", path: PB, received_at: 200, entry_hash: "e2" },
  { seq: 3, prev_hash: "p", file_hash: "f3", path: PA, received_at: 300, entry_hash: "e3" }, // A의 최신
  { seq: 4, prev_hash: "p", file_hash: "f4", path: PC, received_at: 400, entry_hash: "e4" }, // 기준시점 이후
  { seq: 5, prev_hash: "p", file_hash: "f5", path: PD, received_at: 350, entry_hash: "e5" }, // 앵커 대기
];

test("expectedSeqs: snapshotAt 과 같은 집합", () => {
  const at = 380, cov = 4;
  const viaSnap = new Set(Array.from(snapshotAt(DCHAIN, at, cov).values()).map((e) => e.seq));
  assert.deepEqual(Array.from(expectedSeqs(DCHAIN, at, cov)).sort(), Array.from(viaSnap).sort());
});

test("처분: 대체됨·기준시점이후·앵커대기는 사슬만으로 정해진다", () => {
  const at = 380, cov = 4;
  const exp = expectedSeqs(DCHAIN, at, cov);
  const inc = new Set([2, 3]);
  const d = (seq: number) => dispositionOf(DCHAIN.find((e) => e.seq === seq)!, at, cov, exp, inc, new Map());
  assert.equal(d(1), "대체됨");        // 같은 경로 A 의 seq 3 이 더 나중
  assert.equal(d(2), "포함");
  assert.equal(d(3), "포함");
  assert.equal(d(4), "기준시점이후");  // received_at 400 > 380
  assert.equal(d(5), "앵커대기");      // seq 5 > covered 4
});

test("처분: 담기지 않은 것은 사유가 있으면 그 사유, 없으면 원본없음", () => {
  const at = 380, cov = 4;
  const exp = expectedSeqs(DCHAIN, at, cov);
  const reasons = new Map<number, Disposition>([[2, "범위밖"]]);
  const d = (seq: number, inc: Set<number>) =>
    dispositionOf(DCHAIN.find((e) => e.seq === seq)!, at, cov, exp, inc, reasons);
  assert.equal(d(2, new Set()), "범위밖");
  assert.equal(d(3, new Set()), "원본없음");   // 사유가 없으면 숨기지 않고 원본없음으로 드러낸다
});

test("dispositionFile: 사슬의 모든 순번이 정확히 한 번씩 나온다", () => {
  const out = dispositionFile(DCHAIN, 380, 4, new Set([2, 3]), new Map());
  const rows = out.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(rows.length, DCHAIN.length);
  assert.deepEqual(rows.map((r) => Number(r.split("|")[0])), [1, 2, 3, 4, 5]);
  assert.equal(rows[1].split("|")[1], "포함");
  assert.equal(rows[0].split("|")[1], "대체됨");
});

test("dispositionFile: 머리글에 기준시점·덮는 순번이 기계가 읽을 수 있게 들어간다", () => {
  const out = dispositionFile(DCHAIN, 380, 4, new Set(), new Map());
  assert.match(out, /^# 기준시점 380 · 비트코인이 덮는 순번 4 · 사슬 5건$/m);
});

test("dispositionFile: 아무것도 담지 못해도 사슬 전부를 드러낸다", () => {
  const out = dispositionFile(DCHAIN, 380, 4, new Set(), new Map());
  const rows = out.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((r) => r.split("|")[1] === "원본없음").length, 2); // seq 2,3
});

test("처분: 담긴 것은 앵커 밖이어도 포함(요약 PDF 경로)", () => {
  const at = 380, cov = 4;
  const exp = expectedSeqs(DCHAIN, at, cov);
  // seq 5 는 covered(4) 밖이지만 파일이 담겨 있다 — "앵커대기"라 적으면 모순이 된다.
  const d = dispositionOf(DCHAIN.find((e) => e.seq === 5)!, at, cov, exp, new Set([5]), new Map());
  assert.equal(d, "포함");
});

test("isFilePath: 평문 경로는 서버가 만든 기록이다", () => {
  assert.equal(isFilePath("a".repeat(64)), true);
  assert.equal(isFilePath("_task/3748c827/amend/725"), false);
  assert.equal(isFilePath("연구노트/a.md"), false);   // 플러그인은 경로를 늘 해시해 보낸다
});

test("스냅샷·처분: 시스템 기록은 '있어야 할 것'에서 빠지고 대상아님으로 표시된다", () => {
  const withTask: ChainEntry[] = [
    ...DCHAIN,
    { seq: 6, prev_hash: "p", file_hash: "f6", path: "_task/x/amend/1", received_at: 100, entry_hash: "e6" },
  ];
  const at = 380, cov = 6;
  const exp = expectedSeqs(withTask, at, cov);
  assert.equal(exp.has(6), false, "시스템 기록은 기대 목록에 없다");
  const d = dispositionOf(withTask[5], at, cov, exp, new Set(), new Map());
  assert.equal(d, "대상아님");
  // 그리고 처분내역에는 여전히 한 줄로 남는다 — 침묵하지 않는다
  const out = dispositionFile(withTask, at, cov, new Set(), new Map());
  assert.match(out, /^6\|대상아님\|/m);
});

// ── 처분 사유는 사실이어야 한다 ──────────────────────────────────────────────
//
// 2026-07-31 실측: 확정된 노트의 **제목만 바꿨더니** 원본이 패키지에서 통째로 빠지고,
// 처분내역에는 "범위밖"이라 적혔다. 범위 안에 있는데도.
//
//   개명 전  담김 6건 · 빠짐 27건
//   개명 후  담김 5건 · 빠짐 28건 · 그 노트의 사유 = "범위밖"
//
// 이건 성능 문제가 아니라 **거짓말**이고, 불리한 기록을 흔적 없이 빼는 길이 된다.
// 이름을 못 찾은 것과 범위 밖인 것은 다른 사실이므로 다르게 적어야 한다.
test("처분 사유 — 이름을 모르는 것과 범위 밖인 것을 구분한다", () => {
  const mk = (seq: number, path: string): ChainEntry => ({
    user: "u", seq, prev_hash: "0".repeat(64), file_hash: `${seq}`.repeat(64).slice(0, 64),
    path, received_at: 1000, entry_hash: "e".repeat(64), signature: "s",
  });
  const chain = [mk(1, "a".repeat(64)), mk(2, "b".repeat(64)), mk(3, "c".repeat(64))];
  const expected = new Set([1, 2, 3]);
  const included = new Set<number>();
  const reasons = new Map<number, Disposition>([
    [1, "경로미상"],   // 제목이 바뀌어 어느 파일이었는지 모른다
    [2, "범위밖"],     // 이름은 아는데 발급자가 고른 범위 밖
    [3, "원본없음"],   // 이름도 알고 범위 안인데 원본을 못 찾았다
  ]);
  const d = (seq: number) => dispositionOf(chain[seq - 1], 2000, 3, expected, included, reasons);
  assert.equal(d(1), "경로미상");
  assert.equal(d(2), "범위밖");
  assert.equal(d(3), "원본없음");

  // 사유는 처분내역 파일에 그대로 실려야 한다 — 검증기와 사람이 읽는 것이 이 파일이다.
  const out = dispositionFile(chain, 2000, 3, included, reasons);
  assert.match(out, /^1\|경로미상\|/m);
  assert.match(out, /^2\|범위밖\|/m);
  assert.match(out, /^3\|원본없음\|/m);
  // "모른다"를 "범위 밖"이라고 바꿔 적지 않는다.
  assert.ok(!/^1\|범위밖/m.test(out), "이름을 모르는 것을 범위밖이라 적으면 안 된다");
});

// ── 변경 이력 표 ────────────────────────────────────────────────────────────
const tlEntry = (seq: number, path: string, at: number): ChainEntry => ({
  user: "u", seq, prev_hash: "0".repeat(64), file_hash: `${seq}`.padStart(64, "0"),
  path, received_at: at, entry_hash: "e".repeat(64), signature: "s",
});
const DAY = 86400;
const T = (d: number, h = 12) => Math.floor(new Date(2026, 6, 27 + d, h).getTime() / 1000);

test("변경 이력 — 하루 단위로 접고, 첫 등장을 표시한다", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const chain = [
    tlEntry(1, A, T(0)),            // 7/27 A 1회
    tlEntry(2, A, T(1, 9)),         // 7/28 A 3회
    tlEntry(3, A, T(1, 13)),
    tlEntry(4, A, T(1, 17)),
    tlEntry(5, B, T(1, 18)),        // 7/28 B 첫 등장
  ];
  const names = new Map([[A, "연구노트/A.md"], [B, "연구노트/B.md"]]);
  const rows = timelineRows(chain, T(9), names);
  assert.equal(rows.length, 3, "7/27 A · 7/28 A · 7/28 B");
  assert.deepEqual(rows.map((r) => [r.day, r.name, r.seals, r.firstEver]), [
    [localDay(T(0)), "연구노트/A.md", 1, true],
    [localDay(T(1)), "연구노트/A.md", 3, false],
    [localDay(T(1)), "연구노트/B.md", 1, true],
  ]);
});

test("변경 이력 — 서버가 만든 기록과 기준시점 이후는 담지 않는다", () => {
  const A = "a".repeat(64);
  const chain = [
    tlEntry(1, A, T(0)),
    tlEntry(2, `_move/${A}`, T(0)),   // 서버 기록 — 노트의 변경 이력이 아니다
    tlEntry(3, A, T(5)),              // 기준 시점 이후
  ];
  const rows = timelineRows(chain, T(1), new Map([[A, "연구노트/A.md"]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seals, 1);
});

test("변경 이력 — 이름을 모르면 모른다고 적는다", () => {
  const A = "a".repeat(64);
  const rows = timelineRows([tlEntry(1, A, T(0))], T(9), new Map());
  assert.equal(rows[0].name, null, "모르는 것을 지어내지 않는다");
  const out = timelineFile(rows, new Set());
  assert.match(out, /이름 모름 · 경로해시 aaaaaaaaaaaa…/);
});

test("변경 이력 — 기기 상태는 사슬과 다른 자리에 다른 표시로 적는다", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const chain = [tlEntry(1, A, T(0)), tlEntry(2, B, T(0))];
  const names = new Map([[A, "연구노트/A.md"], [B, "연구노트/B.md"]]);
  const out = timelineFile(timelineRows(chain, T(9), names), new Set([A]));

  // 봉인 줄은 [사슬] — 검증기가 다시 계산해 대조할 수 있다.
  assert.match(out, /연구노트\/A\.md\t봉인 1회 · 순번 1 · 첫 등장\t\[사슬\]/);
  // 사라짐은 [기기] — 이 자료 안에서는 확인할 수 없다는 것을 문서가 스스로 말한다.
  assert.match(out, /연구노트\/A\.md\t마지막 봉인 이후 기기에서 사라짐\t\[기기\]/);
  assert.match(out, /\[기기\] 는 자료를 만든 기기의 상태이며 \*\*이 자료 안에서는 확인할 수 없습니다/);
  // 사라지지 않은 것에는 그 줄이 없다.
  assert.ok(!/연구노트\/B\.md\t마지막 봉인 이후/.test(out));
});

test("변경 이력 — 같은 노트가 여러 날 사라졌다고 반복하지 않는다", () => {
  const A = "a".repeat(64);
  const chain = [tlEntry(1, A, T(0)), tlEntry(2, A, T(1)), tlEntry(3, A, T(2))];
  const out = timelineFile(timelineRows(chain, T(9), new Map([[A, "연구노트/A.md"]])), new Set([A]));
  const hits = out.split("\n").filter((l) => l.includes("기기에서 사라짐")).length;
  assert.equal(hits, 1, "경로마다 한 번만 — 날마다 반복하면 표가 묻힌다");
});

test("처분 사유 — 발급자가 뺀 것은 「제외함」으로 남는다", () => {
  // 증거를 전부 낼 의무는 없다. 다만 **뺐다는 사실까지 숨기면** 그때부터 위변조다.
  const mk = (seq: number, path: string): ChainEntry => ({
    user: "u", seq, prev_hash: "0".repeat(64), file_hash: `${seq}`.padStart(64, "0"),
    path, received_at: 1000, entry_hash: "e".repeat(64), signature: "s",
  });
  const chain = [mk(1, "a".repeat(64)), mk(2, "b".repeat(64))];
  const out = dispositionFile(chain, 2000, 2, new Set([2]),
    new Map<number, Disposition>([[1, "제외함"]]));
  assert.match(out, /^1\|제외함\|/m, "뺀 사실이 처분내역에 남아야 한다");
  assert.match(out, /^2\|포함\|/m);
  assert.match(out, /봉인 사실은 사슬에 남아 있습니다/, "무엇이 남는지 문서가 스스로 말해야 한다");
});
