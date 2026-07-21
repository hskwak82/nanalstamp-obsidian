import { addIcon, arrayBufferToBase64, App, FileSystemAdapter, ItemView, MarkdownRenderer, MarkdownView, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, RequestUrlResponse, Setting, TFile, ViewStateResult, WorkspaceLeaf, requestUrl, setIcon } from "obsidian";
import * as git from "isomorphic-git";
import { PitVerify, pitVerifyReadme, pitCertificateHtml } from "./certgen";
import * as QRCode from "qrcode";
import { ArchiveEntry, parseArchiveCommit, coverage, gaps, timeline, heatmapCounts, syncStatus, certCandidates, Gap, topFolder } from "./dashcore";
import { isSealableFile, isOverSizeLimit, isMarkdownPath } from "./sealscope";
import { buildArchiveMsg, parseArchiveMsg } from "./archivemsg";
import { hexToBase64, blobExt, blobContentType, PROOF_EXT, bodyByteSize, fmtBytes, storageEndpoint } from "./storagecore";
import { cdcChunks, buildManifest, parseManifest, CHUNK_THRESHOLD } from "./chunkcore";
import { encryptBlob, decryptBlob, isEncrypted } from "./cryptocore";

// 5.2: 월간 digest 자동 통계 — 로컬 아카이브 원장(ArchiveEntry[])을 대상 월(YYYY-MM, 로컬)로 필터 집계.
// 순수 함수(타임존·테스트 결정성): ts→로컬 YYYY-MM-DD 변환기를 호출자가 주입한다(서버 호출 없음).
// seals=봉인(앵커) 건수, activeDays=봉인한 날 수, artifacts=서로 다른 노트 수, topFolders=상위 3개 폴더(건수).
type DigestStats = { seals: number; activeDays: number; artifacts: number; topFolders: { folder: string; count: number }[] };
function computeDigestStats(entries: ArchiveEntry[], ym: string, ymdOf: (ts: number) => string): DigestStats {
  const days = new Set<string>();
  const notes = new Set<string>();
  const folders = new Map<string, number>();
  let seals = 0;
  for (const e of entries) {
    if (ymdOf(e.ts).slice(0, 7) !== ym) continue;
    seals++;
    days.add(ymdOf(e.ts));
    notes.add(e.notePath);
    const f = topFolder(e.notePath);
    folders.set(f, (folders.get(f) ?? 0) + 1);
  }
  const topFolders = [...folders.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
    .slice(0, 3);
  return { seals, activeDays: days.size, artifacts: notes.size, topFolders };
}

// ── Node 접근(데스크탑 Electron 전용) ────────────────────────────────────────
// 아카이브는 vault 밖 절대경로라 Obsidian vault API가 아니라 Node fs로 다룬다.
// window.require는 데스크탑에만 존재 → 모듈 로드 시 정적 접근하면 모바일에서 플러그인
// 전체 로드가 깨진다. 그래서 lazy로 필요 시점에만 require한다.
function nodeReq(mod: string): any {
  const r = (window as unknown as { require?: (m: string) => any }).require;
  if (!r) throw new Error("Node require unavailable (desktop only)");
  return r(mod);
}
// 기본 아카이브 경로: 홈 아래 nanalStamp-archive/ (동기화 폴더 밖 권장).
function defaultArchivePath(): string {
  const os = nodeReq("os");
  const path = nodeReq("path");
  return path.join(os.homedir(), "nanalStamp-archive");
}
// 플레이스홀더 표시용(실패해도 렌더가 안 깨지게 "" 반환).
function defaultArchivePathSafe(): string {
  try { return defaultArchivePath(); } catch { return ""; }
}

// 로고는 플러그인 폴더의 icon.png(평면 이미지)를 표시합니다. 로고 교체 시 icon.png만 바꾸면 됩니다.
// 아래는 파일 로드 실패 시 폴백.
const ICON_ID = "nanalstamp-seal";
// 나날 도장 아이콘(branding/nanal-seal-clean.svg 인라인) — 탭·메뉴 아이콘용. viewBox 0 0 100 100 규격.
const ICON_FALLBACK = `<rect x="7" y="7" width="86" height="86" rx="16" fill="#D32A2A"/><g fill="#fff" transform="translate(50.0 51.0) scale(0.0508 -0.0508) translate(-669.0 -155.0)"><path transform="translate(0.0 0)" d="M408 404Q403 372 400.0 333.5Q397 295 395 253Q411 258 433.5 261.0Q456 264 479.5 264.5Q503 265 524.5 263.5Q546 262 560 259Q568 257 577.5 253.0Q587 249 593 247Q605 242 607 239Q583 231 553.5 226.0Q524 221 494.5 218.0Q465 215 438.5 213.0Q412 211 394 210Q393 172 393.0 136.5Q393 101 393.5 70.5Q394 40 395.5 17.0Q397 -6 399 -18Q393 -15 390.0 -8.0Q387 -1 382 7Q374 21 366.5 42.5Q359 64 357 78Q349 132 347.0 186.0Q345 240 349 294Q327 252 300.0 209.0Q273 166 242.5 128.5Q212 91 178.5 61.0Q145 31 109 14Q97 14 85.5 20.0Q74 26 66 34Q60 40 59.0 45.5Q58 51 56 57Q54 66 49.5 76.5Q45 87 44 96Q39 156 46.0 211.0Q53 266 64 314Q65 316 68.5 318.5Q72 321 74 321Q76 319 77.5 314.5Q79 310 81 307Q85 301 88.0 295.0Q91 289 92 284Q88 239 88.0 192.0Q88 145 93 103Q114 110 149.0 133.0Q184 156 222.0 189.0Q260 222 295.5 261.5Q331 301 353 341Q355 355 357.5 370.0Q360 385 363 399Q363 402 368.0 404.5Q373 407 379 412Q384 415 387.5 419.5Q391 424 395 424Q399 424 403.5 425.0Q408 426 410 424Z"/><path transform="translate(610.0 0)" d="M396 175Q378 179 353.5 178.0Q329 177 305.0 173.0Q281 169 259.5 164.0Q238 159 226 155Q220 153 216.5 149.5Q213 146 208 142Q202 137 197.0 130.5Q192 124 192 116Q194 112 197.0 110.0Q200 108 208 103Q212 101 218.0 97.0Q224 93 230 90Q235 88 238.5 87.5Q242 87 246 87Q263 89 283.5 91.0Q304 93 325.0 95.0Q346 97 366.0 98.0Q386 99 403 99Q397 85 385.0 68.5Q373 52 359.0 35.5Q345 19 332.5 6.0Q320 -7 314 -13Q306 -17 298.5 -22.0Q291 -27 284 -32Q279 -36 271.0 -43.0Q263 -50 260 -54Q255 -61 257.5 -64.0Q260 -67 260 -74Q260 -91 270.5 -93.5Q281 -96 296 -94Q331 -88 364.5 -82.5Q398 -77 432 -73Q424 -87 407.5 -111.5Q391 -136 373.5 -164.0Q356 -192 341.0 -220.5Q326 -249 321 -271L319 -281V-290Q319 -293 321.5 -295.0Q324 -297 325 -302Q331 -311 349 -310Q364 -308 374 -304Q425 -287 477.0 -258.5Q529 -230 574 -203Q589 -193 605.0 -181.0Q621 -169 635 -155Q648 -144 651.0 -137.5Q654 -131 662 -122Q669 -114 679.0 -104.0Q689 -94 688 -92L668 -104Q608 -139 527.5 -182.5Q447 -226 350 -261Q368 -233 388.0 -205.0Q408 -177 427.5 -150.5Q447 -124 464.5 -100.5Q482 -77 494 -58Q511 -32 502.0 -11.5Q493 9 454 9Q437 9 413.0 6.0Q389 3 370 -2Q378 6 389.5 18.5Q401 31 413.0 45.0Q425 59 434.5 73.0Q444 87 448 99Q450 107 453.5 116.5Q457 126 455 134Q453 143 444.0 149.5Q435 156 426 162Q421 166 413.5 169.5Q406 173 396 175ZM338 266Q336 288 335.5 311.5Q335 335 337.0 363.5Q339 392 343.5 427.0Q348 462 356 506Q348 493 341.0 483.0Q334 473 329 465Q324 457 322.0 447.5Q320 438 315 430Q281 375 248.5 333.0Q216 291 188.5 262.5Q161 234 139.0 219.0Q117 204 104 203Q88 202 74 211Q69 215 66.5 222.0Q64 229 60 236Q57 241 52.0 246.0Q47 251 45 258Q40 279 38.5 306.0Q37 333 38.0 361.0Q39 389 42.5 416.5Q46 444 51 467Q53 481 60.5 487.5Q68 494 73 501Q74 502 76.0 503.5Q78 505 79 504Q81 502 79.5 495.0Q78 488 79 482L76 456Q72 423 70.0 385.0Q68 347 69 308Q69 297 77.5 292.0Q86 287 97 287Q113 287 141.0 308.5Q169 330 203.5 363.5Q238 397 277.5 438.5Q317 480 356 519L358 522Q360 536 363.0 550.0Q366 564 369 580Q371 591 374.0 603.0Q377 615 383 619Q385 621 389.5 617.5Q394 614 397 611Q399 609 403.0 607.0Q407 605 409 603Q413 592 417.0 585.0Q421 578 420 565Q417 521 411.0 479.0Q405 437 399.0 397.0Q393 357 388.5 319.0Q384 281 384 245Q384 234 380.5 226.0Q377 218 372.0 211.5Q367 205 362.5 200.0Q358 195 356 190Q348 208 344.0 227.0Q340 246 338 266ZM678 428Q651 440 620.5 444.0Q590 448 557.0 447.0Q524 446 489.5 440.5Q455 435 421 428Q412 426 413 416Q414 408 419.5 404.5Q425 401 431.5 399.5Q438 398 445.5 398.0Q453 398 458 397Q479 393 505.5 393.0Q532 393 559.5 395.5Q587 398 613.0 403.0Q639 408 659 414Q670 417 676.0 418.0Q682 419 682 423Q682 425 678 428Z"/></g>`;
// ── GitHub OAuth Device Flow ────────────────────────────────────────────────
// 오너가 등록한 OAuth App의 Client ID(공개값 — 배포 빌드에 포함해도 안전). 비어 있으면
// "GitHub 연결" 모달이 "관리자 미설정" 안내 후 닫힌다. 설정법: docs/2026-07-04-github-oauth-setup.html
const GITHUB_OAUTH_CLIENT_ID = "Ov23li0iVNifj2mknRee";
const GITHUB_DEFAULT_REPO = "nanalstamp-vault";
// 상태바 인장도 동일 아이콘(ICON_ID)을 setIcon으로 렌더.
// ── i18n: Obsidian UI 언어 감지(기본 영어, 한국어면 ko) ──────────────────────
type Lang = "en" | "ko";
// Obsidian 언어 자동 감지: 여러 신호(localStorage·moment 로케일·html lang)를 시도.
function pickLang(): Lang {
  const w = window as unknown as { localStorage?: Storage; moment?: { locale?: () => string } };
  const cands = [
    w.localStorage?.getItem?.("language"),
    w.moment?.locale?.(),
    document.documentElement?.lang,
  ];
  for (const c of cands) {
    if (typeof c === "string" && c.toLowerCase().startsWith("ko")) return "ko";
  }
  return "en";
}
const STR = {
  en: {
    off: "🔒 nanalStamp off",
    overview: (streak: number, total: number) => streak > 0 ? `🔏 ${streak}-day streak · ${total} sealed` : `🔏 nanalStamp · ${total} sealed`,
    sealed: (seq: number) => `Sealed · seq ${seq}`,
    unsealed: (name: string) => `○ Unsealed · ${name}`,
    pending: "Pending",
    pendingEta: (mmss: string) => ` · ${mmss}`,
    pendingSoon: " · on pause",
    pendingTitle: (name: string) => `${name} — seals after the countdown while idle; instant on switch/blur/quit`,
    unsent: (name: string) => `⚠ Unsent · ${name}`,
    outScope: (name: string) => `– Out of scope · ${name}`,
    base: (total: number, streak: number, m: number, url: string) =>
      `${total} sealed${streak > 0 ? ` · ${streak}-day streak` : ""} · max 1 per ${m} min per note (on pause) · instant on close/quit · ${url}`,
    offTitle: "Sealing is off",
    sealedTitle: (name: string, seq: number, at: string) => `${name} — sealed · seq ${seq} @ ${at}`,
    unsealedTitle: (name: string) => `${name} — not sealed yet (or changed since sealed)`,
    unsentTitle: (name: string) => `${name} — send failed, retrying automatically`,
    outScopeTitle: "This folder is outside the configured scope (settings).",
    queryFail: (base: string) => `${base} (server query failed)`,
    noticeSealed: (name: string, seq: number, reason: string) => `🔏 Sealed: ${name} (seq ${seq}) · ${reason}`,
    noticeFail: (name: string, err: string) => `⚠️ Seal failed: ${name} — ${err} (will retry)`,
    noNote: "No note is open",
    reason: { settle: "pause", leave: "left note", manual: "manual", unload: "quit", retry: "retry" } as Record<string, string>,
    ribbon: "nanalStamp: seal current note",
    anchorCmd: "Anchor to Bitcoin now",
    anchorOk: "⛓ Submitted to Bitcoin (confirms in a few hours)",
    anchorFail: (e: string) => `⚠️ Anchor failed: ${e}`,
    btc: (h: number) => ` · ₿#${h}`,
    anchoring: " · ⛓ anchoring",
    exportCmd: "Export proof (.nanalproof)",
    exportOk: (p: string) => `📄 Proof saved: ${p}`,
    exportNone: (n: string) => `Not sealed yet: ${n}`,
    exportFail: (e: string) => `⚠️ Export failed: ${e}`,
    catchupNotice: (n: number) => `🔏 Caught up: sealed ${n} note(s) on startup`,
    settIntro: "When a note settles, only its SHA-256 hash is sent to the server — the note's content and its file path are both hashed on your device, so neither the text nor readable folder/file names ever leave your device.",
    langName: "Language",
    langDesc: "Plugin language (Auto follows Obsidian). Reload to update command names.",
    langReload: "Reload Obsidian to update command names.",
    apiKeyMissing: "🔑 Sign in required (settings)",
    includeName: "Include folders",
    includeDesc: "Only seal notes under these folders (one per line). Empty = entire vault.",
    excludeName: "Exclude folders",
    excludeDesc: "Never seal notes under these folders (one per line).",
    scopeAllVault: "Currently sealing: entire vault",
    scopeSomeFolders: (n: number) => `Currently sealing: ${n} folder(s) only`,
    excludeNone: "Currently: no exclusions",
    excludeSome: (n: number) => `Currently excluding: ${n} folder(s)`,
    tplEnableName: "Enable dev-note templates",
    tplEnableDesc: "Optional convenience. The plugin still seals any note — this just adds commands to insert structured dev-note entries.",
    tplFolderName: "New dev-note folder",
    tplFolderDesc: "Folder for 'New dev note (today)'. Empty = vault root.",
    tplOff: "Dev-note templates are off (enable in settings).",
    tplNewCmd: "New dev note (today)",
    tplInsCmd: (l: string) => `Insert ${l} entry`,
    digestCmd: "Create monthly digest",
    digestFolderName: "Monthly digest folder",
    digestFolderDesc: "Folder where monthly digest notes are saved and recognized. Default: digests",
    digestExists: "Already exists — opening.",
    digestCreated: (p: string) => `📋 Monthly digest created: ${p}`,
    digestOutOfScope: "This folder is outside the seal scope — include it in settings so the digest gets sealed.",
    digestErr: (m: string) => `Couldn't create digest: ${m}`,
    digestScaffold: (ym: string, s: DigestStats) => {
      const folders = s.topFolders.length
        ? s.topFolders.map((f) => `${f.folder}(${f.count})`).join(", ")
        : "(none)";
      return (
        `# ${ym} Monthly Research Digest\n\n` +
        `> This document is a shared summary for your organization. The statistics below are auto-generated; write the narrative yourself.\n` +
        `> When you're done, use the "Request review of this note" command to get a reviewer's signature.\n\n` +
        `## Auto statistics\n` +
        `- Seals: ${s.seals} / Active days: ${s.activeDays} / Artifacts: ${s.artifacts}\n` +
        `- Top folders: ${folders}\n\n` +
        `## Key progress this month (write yourself)\n-\n\n` +
        `## Next month's plan (write yourself)\n-\n`
      );
    },
    teamTplPrefix: "Team: ",
    teamProfileHead: "Team profile",
    teamProfileEnableName: "Apply team profile",
    teamProfileEnableDesc: "Your team profile manages folder filters and attachment settings, and adds your organization's templates. Turn off to keep your local settings.",
    teamProfileRefetchBtn: "Fetch now",
    teamProfileApplied: "Team profile applied",
    teamProfileNotMember: "You're not part of a team",
    teamProfileFail: "Couldn't fetch team profile",
    teamProfileLastReceived: (w: string) => `Last received: ${w}`,
    teamProfileNever: "not received yet",
    certCmd: "Issue certificate (PDF)",
    publicCmd: "Create public verification link",
    pricingCmd: "View pricing",
    accountCmd: "My account & subscription",
    subscribeCmd: "Subscription",
    subDesc: "Compare plans and subscribe on the pricing page.",
    subTierDesc: (tier: string) => `Current plan: ${tier} — compare or change plans on the pricing page.`,
    manageSubBtn: "Manage subscription",
    buyCreditCmd: "Buy certificate credit",
    buyCreditDesc: "One credit issues one certificate (PDF) — used by the 'Issue certificate' command.",
    certOk: (p: string) => `📄 Certificate saved: ${p}`,
    certFail: (m: string) => `Certificate failed: ${m}`,
    certPay: "Credit required — opening pricing",
    proOnly: "Pro feature — opening pricing",
    linkOk: (u: string) => `🔗 Public link copied: ${u}`,
    linkFail: (m: string) => `Link failed: ${m}`,
    checkoutFail: (m: string) => `Checkout failed: ${m}`,
    loginName: "Account sign-in (free)",
    loginDesc: "Sign in with email/password to auto-fetch your API key.",
    loginBtn: "Sign in",
    loginOk: (tier: string) => `Signed in (${tier})`,
    loginFail: (m: string) => `Login failed: ${m}`,
    registerBtn: "Sign up",
    registerSent: (e: string) => `Verification email sent to ${e}. Click the link, then sign in.`,
    registerFail: (m: string) => `Sign-up failed: ${m}`,
    acctName: "Account",
    acctLoading: "Loading account…",
    acctInfo: (tier: string, credits: number, pro: boolean) => `Plan: ${tier}${pro ? " (Pro)" : ""} · certificate credits: ${credits}`,
    pastDueBadge: "⚠️ payment failed — check your card",
    pastDueNotice: "nanalStamp: your subscription renewal failed. Service continues during the grace period — please update your payment method at nanalstamp.com/account.",
    acctConnected: "Connected with API key",
    logoutBtn: "Log out",
    logoutConfirm: "Log out? Sealing and cloud storage will pause on this device until you sign in again (your data is unaffected).",
    acctHead: "Account & subscription",
    sealScopeHead: "Sealing scope",
    miscHead: "Other",
    sealCmd: "Seal current note now",
    apiKeyRejected: "🔑 API key rejected (settings)",
    authFail: "API key was rejected (401/403). Sealing is paused until you update the key in settings.",
    rateLimited: "⏳ Rate limited — backing off, will retry.",
    sealFirst: (n: string) => `Seal “${n}” first — it isn't sealed yet.`,
    devNoteCreated: (p: string) => `📝 ${p}`,
    tplErr: (e: string) => `⚠️ ${e}`,
    emailPlaceholder: "email",
    pwPlaceholder: "password",
    // Onboarding (first run)
    welcomeTitle: "Welcome to nanalStamp",
    welcomeBody: "nanalStamp seals your notes with a Bitcoin-anchored timestamp — day by day. Its value isn't “this file existed once”; it's a continuous, unbroken proof that can't be back-dated. You can only prove time from the moment you start sealing forward.",
    welcomeSealNow: "Seal now — you can't prove the past retroactively. Every day you wait is a day of provable history you can't get back.",
    welcomeKeyHint: "To begin, add your API key or sign in.",
    welcomeOpenSettings: "Open settings",
    welcomeLater: "Got it",
    // Proof / timeline modal
    proofCmd: "Show note proof / timeline",
    proofTitle: "Note proof",
    proofChecking: "Checking with the server…",
    proofSealedHead: "Sealed",
    proofUnsealedHead: "○ Not sealed yet",
    proofChangedHead: "✍️ Changed since last seal",
    proofPendingHead: "… Pending (waiting to seal)",
    proofOutScopeHead: "– Out of sealing scope",
    proofSeq: (n: number) => `Sequence: #${n}`,
    proofReceived: (at: string) => `Sealed at: ${at}`,
    proofAnchorConfirmed: (h: number) => `Bitcoin anchor: confirmed · block #${h}`,
    proofAnchorPending: "Bitcoin anchor: submitted, awaiting confirmation (a few hours)",
    proofAnchorNone: "Bitcoin anchor: not yet anchored",
    proofUnsealedBody: "This exact content has no seal on the server yet. Seal it to start its proof.",
    proofChangedBody: "The note was sealed before, but the current content differs — seal again to cover the new version.",
    proofStreakLine: (streak: number, total: number) => `${streak}-day seal streak · ${total} seals total`,
    proofWhy: "Your proof only covers the period from when you started sealing. Keep the streak going — the past can't be sealed retroactively.",
    proofErr: "Could not query the server. Check your connection and API key.",
    proofClose: "Close",
    // Review (counter-signature)
    reviewReqCmd: "Request review of this note",
    reviewReqSent: "Review requested — the reviewer's signature will show up here once they sign.",
    reviewReqFail: "Not sealed yet, or you're not on a team.",
    reviewSectionTitle: "Review",
    reviewReviewed: "reviewed",
    reviewApproved: "approved",
    reviewSigned: (verdict: string, email: string, when: string) => `✓ Reviewed — ${verdict} (${email}, ${when})`,
    reviewPending: "Awaiting review",
    reviewDeclined: (note: string) => note ? `Declined (${note})` : "Declined",
    // Password reset
    resetCmd: "Reset password",
    resetName: "Forgot your password?",
    resetDesc: "Send a reset link to your email, then set a new password on the web page.",
    resetModalTitle: "Reset password",
    resetSendBtn: "Send reset email",
    resetOpenBtn: "Open reset page",
    resetNeedEmail: "Enter your email first.",
    resetSent: (e: string) => `If ${e} has an account, a reset link was sent. Check your inbox, open the link, then sign in with the new password.`,
    resetFail: (m: string) => `Reset request failed: ${m}`,
    // Durability: local proof ledger (P1) + GitHub mirror (P2)
    ledgerHead: "Proof ledger & certificates",
    ledgerName: "Auto-save proofs (local)",
    ledgerDesc: "When an anchor is confirmed on Bitcoin, save that note's self-verifying proof into a vault folder — so proofs survive even if our server/DB disappears.",
    ledgerFolderName: "Proof archive folder",
    ledgerFolderDesc: "Vault folder for auto-saved proofs (default nanalStamp/proofs).",
    ledgerSaved: (p: string) => `🗂 Proof archived: ${p}`,
    ledgerSweepDone: (n: number) => `🗂 ${n} proof(s) archived locally`,
    // Local git archive (all tiers) — preserve content + proof history
    archiveName: "Preserve content history (local git)",
    archiveDesc: "On confirmation, commit the note's original text + proof into a local git repo outside your vault — so you can restore past versions even after editing (works on FREE too). Desktop only.",
    archiveMobile: "This runs on desktop only — mobile skips the archive.",
    archivePathName: "Archive folder",
    archivePathDesc: "Absolute path for the local git archive. Keep it OUTSIDE any sync folder (Dropbox/iCloud/OneDrive) — a half-synced .git can corrupt the history.",
    archivePickBtn: "Choose folder",
    archiveMigrated: (a: string, b: string) => `📦 Archive moved (history preserved): ${a} → ${b}. The old folder was kept as a backup — delete it yourself when ready.`,
    archiveExists: "The new folder already contains an archive — not copying automatically to avoid mixing histories. Move/merge it manually if needed.",
    archiveSet: (p: string) => `📦 Archive folder set: ${p}`,
    archiveNotWritable: (p: string) => `⚠️ Can't write to that folder: ${p}`,
    archiveDesktopOnly: "Local archive is desktop-only.",
    githubHead: "GitHub mirror (PRO/TEAM)",
    githubLocked: "Requires a PRO or TEAM subscription",
    githubProNote: "Mirror your original notes + proofs to your own GitHub repo so they survive even if the vault is deleted. Available on PRO/TEAM.",
    githubMirrorName: "Mirror to GitHub",
    githubMirrorDesc: "On confirmation, push the note's original .md + proof to your GitHub repo (notes/ + proofs/). Runs directly from the plugin — the server never sees your content.",
    githubPatName: "GitHub token (PAT)",
    githubPatDesc: "Fine-grained personal access token with Contents: Read and write on the target repo.",
    githubRepoName: "Target repo (owner/repo)",
    githubRepoDesc: "e.g. yourname/nanalstamp-vault. Create it (private recommended) on GitHub first.",
    mirrorOk: (r: string) => `☁️ Mirrored to ${r}`,
    mirrorFail: (m: string) => `⚠️ GitHub mirror failed: ${m}`,
    storageHead: "Storage & backup",
    storageProNote: "Keep sealed originals off-site — a GitHub mirror or nanalStamp append-only storage. Pro required.",
    storageBackendName: "Use nanalStamp storage",
    storageBackendDesc: "Where sealed originals + proofs are kept off-site. nanalStamp storage is append-only — nobody, including you, can modify or delete after sealing.",
    storageGithub: "GitHub mirror (my repo)",
    storageNanalDesc: "Each sealed version's original and proof are uploaded straight to WORM storage (S3 Object Lock) — the server never sees your content, and nothing can be edited or deleted during the retention period.",
    nanalQuotaFull: "nanalStamp storage is full — uploads paused. Upgrade your plan to continue (existing data is safe).",
    nanalDekGone: "nanalStamp storage key has been destroyed — cloud archiving is unavailable (local seals keep working).",
    nanalProofExportCmd: "Export proof from nanalStamp storage (self-verifying)",
    nanalProofExportOk: (rel: string) => `Exported: ${rel} — verify offline at np-verify`,
    storageAdvHead: "Advanced: GitHub export",
    githubExportName: "Export to my GitHub",
    githubExportDesc: "Push sealed originals + proofs to your own GitHub repo as well — your exit hatch: even if nanalStamp disappears, your evidence lives in your repo (verify offline with np-verify). Runs alongside nanalStamp storage.",
    storageUsageName: "Storage usage",
    storageUsageVal: (u: string, q: string) => `${u} / ${q}`,
    storageUsageLoading: "Checking…",
    nanalMirrorOk: "🛢 Stored in nanalStamp storage",
    nanalMirrorFail: (e: string) => `⚠️ nanalStamp storage failed: ${e} (will retry)`,
    nanalRestoreCmd: "Restore sealed original from nanalStamp storage",
    nanalRestoreNone: "No sealed version of this note is in nanalStamp storage yet.",
    nanalRestoreFail: (e: string) => `⚠️ Restore failed: ${e}`,
    nanalRestoreBadHash: "⚠️ Downloaded content does not match the sealed hash — not saved.",
    nanalRestoreOk: (p: string) => `📥 Restored to: ${p}`,
    nanalViewTitle: (name: string) => `${name} - nanalStamp copy`,
    nanalViewBanner: (name: string, h8: string) => `Read-only · sealed original stored in nanalStamp (tamper-proof) — ${name} · sha256 ${h8}…`,
    // 4.3: organization GitHub App custody (server-managed mirror)
    teamCustodyName: "Team custody",
    teamCustodyActive: (org: string, repo: string) => `Mirroring to your organization's GitHub (${org}/${repo}) — managed by your team.`,
    teamCustodyPersonalUnused: "Your team manages the mirror destination, so the personal GitHub settings below aren't used while team custody is active.",
    teamCustodyOn: "Team custody is active — mirroring to your organization's GitHub.",
    teamCustodyOff: "Team custody is not active.",
    // C2: team custody storage forced (independent of teamCustody/GitHub — server mirror/info's team_storage field)
    teamStorageForced: "Managed by your team — sealed notes are stored in your organization's nanalStamp storage.",
    teamPoolFullDesc: "Team storage grows by adding seats — contact your team admin.",
    // GitHub OAuth Device Flow connect
    githubConnectName: "Connect GitHub",
    githubConnectDesc: "One click here + one approval on GitHub — no personal access token to create. We fetch a token, create a private nanalstamp-vault repo, and turn mirroring on automatically.",
    githubConnectBtn: "Connect GitHub",
    githubConnectedName: "GitHub connection",
    githubConnectedDesc: (user: string, repo: string) => `Connected: @${user} · ${repo}`,
    githubDisconnectBtn: "Disconnect",
    githubAdvancedName: "Advanced (manual token)",
    githubAdvancedDesc: "Power users: set the target repo, or paste a fine-grained PAT (Contents: read & write) instead of connecting.",
    ghModalTitle: "Connect GitHub",
    ghNoClient: "The administrator hasn't set up the GitHub OAuth App yet, so one-click connect isn't available. Use Advanced (manual token) below, or ask the owner to configure it.",
    ghRequesting: "Requesting a device code from GitHub…",
    ghStep1: "① This code has been copied to your clipboard:",
    ghStep2: "② Open GitHub and paste the code",
    ghStep2Btn: "Open GitHub",
    ghStep3: "③ Approve it there — this window finishes automatically.",
    ghWaiting: "⏳ Waiting for approval…",
    ghPreparing: "Getting your token and preparing the repo…",
    ghSuccess: (user: string, repo: string) => `✅ Connected: @${user} · ${repo}`,
    ghDenied: "Approval was denied. You can try again.",
    ghExpired: "The code expired. Please try again.",
    ghDeviceFail: "Couldn't get a device code from GitHub. Check your connection and try again.",
    ghUserFail: "Got a token, but couldn't read your GitHub account. Try reconnecting.",
    ghRepoFail: "Connected, but couldn't create the repo automatically. Set the target repo manually in Advanced.",
    ghRetryBtn: "Try again",
    ghCloseBtn: "Close",
    ghErr: (m: string) => `Error: ${m}`,
    // Point-in-time certificate (P6) — read an archived version via git, verify offline, export
    pitCmd: "Point-in-time certificate (from archive)",
    pitDesktopOnly: "Point-in-time certificates are desktop-only — they read your local git archive.",
    pitNoArchive: "Turn on the local git archive in settings first — it keeps the version history these certificates are made from.",
    pitNoHistory: (n: string) => `No archived versions yet for “${n}”. Once its Bitcoin anchor is confirmed, each version is committed to the archive.`,
    pitAttachmentUnsupported: "Viewing archived versions of attachments isn't supported yet — but they are saved in your archive.",
    pitModalTitle: "Point-in-time certificate",
    pitPick: "Pick a version to certify. The current note is never touched — this reads past versions straight from git.",
    pitVersionDesc: (seq: string, block: string) =>
      block === "?" ? `seq #${seq} · awaiting anchor` : `seq #${seq} · Bitcoin block #${block}`,
    // 증빙 상태 대시보드 (PRO)
    dashCmd: "Attestation dashboard",
    dashTitle: "Attestation dashboard",
    dashSub: "How solid is your evidence — not how much you wrote.",
    dashCoverage: "Attestation coverage",
    dashGaps: "Protection gaps",
    dashTimeline: "IP timeline — first anchor per folder",
    dashHeatmap: "Sealing continuity (12 weeks)",
    dashSync: "Anchor & sync status",
    dashCands: "Certificate candidates",
    dashCovered: (c: number, n: number) => `${c}/${n} notes covered`,
    dashKindModified: "changed since seal",
    dashKindUnsealed: "never sealed",
    dashSealNow: "Seal",
    dashOpenVersions: "Versions…",
    dashConfirmed: (n: number) => `${n} confirmed proofs`,
    dashArcPending: (n: number) => `${n} awaiting local archive`,
    dashMirPending: (n: number) => `${n} awaiting GitHub mirror`,
    dashLatestBlock: (b: number) => `Latest Bitcoin block #${b}`,
    dashCandDesc: (v: number, d: number, b: number) => `${v} versions · ${d}-day span · since ₿#${b}`,
    dashTlDesc: (b: number, from: string, n: number) => `since ₿#${b} (${from}) · ${n} records`,
    dashLockedGaps: (n: number) => `${n} protection gaps found — unlock details with PRO`,
    dashLockedDesc: "Full dashboard is a PRO feature.",
    dashBuyPro: "Upgrade to PRO",
    dashRefresh: "Refresh",
    dashEmpty: "Nothing sealed yet — the dashboard fills in as you write and seal.",
    dashNoArchive: "Local git archive is off — timeline and candidates need it (settings).",
    dashSkipped: (n: number) => `${n} notes skipped (large vault cap)`,
    dashKpiConfirmed: "Confirmed proofs",
    dashKpiLatestBlock: "Latest ₿ block",
    dashKpiSealDays: "Seal days (12w)",
    dashDaysOf: (d: number, total: number) => `of ${total} days: ${d}`,
    dashLegendCovered: "Covered", dashLegendModified: "Changed", dashLegendUnsealed: "Unsealed", dashLegendPending: "Awaiting anchor",
    dashFunnelConfirmed: "₿ confirmed", dashFunnelArchive: "Local archive", dashFunnelMirror: "GitHub mirror",
    dashAgoDays: (n: number) => `changed ${n}d ago`,
    dashAgoHours: (n: number) => `changed ${n}h ago`,
    dashMore: (n: number) => `+${n} more`,
    dashWeekdays: ["Mon", "Wed", "Fri", "Sun"],
    dashGaugeLabel: "coverage",
    dashKindPending: "sealed · awaiting ₿ anchor",
    alreadySealed: "This content is already sealed",
    dashExpand: "Expand",
    dashCollapse: "← Back",
    dashHeatTotal: (n: number) => `${n} seals in the last 12 weeks`,
    dashHeatCellTip: (d: string, n: number) => `${d} · ${n} seal${n === 1 ? "" : "s"}`,
    dashHeatLess: "Less",
    dashHeatMore: "More",
    dashMonthLbl: (m: number) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1],
    dashBackfillLeft: (n: number) => `Background backfill running — ${n} notes queued (a few per minute)`,
    backfillName: "Background backfill",
    backfillDesc: "Slowly seal pre-existing notes that were never sealed (one every 3s, well under the server limit). Turn off if you don't want old notes sealed automatically.",
    attachName: "Seal attachments",
    attachDesc: "Also seal every attachment your sealed notes reference (embed or link) — any file type. Same hash-only privacy: only the SHA-256 leaves your device.",
    attachSkippedWarn: (n: number, mb: number, team: boolean) => `⚠️ ${n} attachment(s) sealed but not stored in cloud — over the ${team ? `team policy limit of ${mb} MB` : `5 GB per-file server limit`}. Their hash proofs remain valid.`,
    uploadSkipTeam: (name: string, mb: number) => `⚠️ “${name}” sealed, but not stored in cloud — over your team's ${mb} MB attachment policy.`,
    uploadSkipHardCap: (name: string) => `⚠️ “${name}” sealed, but not stored in cloud — over the 5 GB per-file limit.`,
    largeUploadNotice: (name: string, size: string, pct: number | null) => `Uploading large file “${name}” (${size}${pct != null ? ` — ${pct}% of your quota` : ""}) to nanal storage.`,
    uploadProgress: (done: number, total: number) => `☁ Storing ${done}/${total}`,
    pitSelectBtn: "Select",
    pitBackBtn: "Back",
    pitReading: "Reading that version from the archive…",
    pitReadFail: "Couldn't read that version from the archive.",
    pitVerifyOk: "✅ Verified offline: this version's content matches its proof, anchored to a confirmed Bitcoin block.",
    pitVerifyHashBad: "⚠️ The archived content does not match the hash in its proof — the archive entry may be corrupted.",
    pitVerifyNoBlock: "⚠️ This version's proof has no confirmed Bitcoin block yet.",
    pitAnchorHint: "This is the sealed-time archive copy — its proof is stored before the anchor confirms. Check the current anchor status in the online history (click the status bar).",
    pitDetailDate: (d: string) => `Archived: ${d}`,
    pitDetailSeq: (s: string) => `Sequence: #${s}`,
    pitDetailBlock: (b: string) => `Bitcoin block: #${b}`,
    pitDetailHash: (h: string) => `Content hash: ${h}`,
    pitExportBundle: "Export self-verifying bundle (free)",
    pitExportCert: "Export formatted certificate (PRO)",
    pitBundleOk: (p: string) => `📦 Bundle exported: ${p}`,
    pitCertOk: (p: string) => `📜 Certificate exported: ${p}`,
    pitExportFail: (e: string) => `⚠️ Export failed: ${e}`,
    pitClose: "Close",
    histSectionTitle: (total: number) => `Seal history (${total.toLocaleString()})`,
    histLoadingMore: "Loading more…",
    histRowConfirmed: (when: string, seq: number, block: number) => `${when} · seq ${seq} · ₿#${block}`,
    histRowPending: (when: string, seq: number) => `${when} · seq ${seq} · awaiting anchor`,
    histAnchorWait: "awaiting anchor",
    histViewSource: "View original",
    histSrcLocal: "Local",
    histSrcGithub: "GitHub",
    histSrcNanal: "nanalStamp",
    histSaveFile: "Save file",
    histSaveHint: "This attachment type can't be previewed — save it to view.",
    // B: Excalidraw archive view — offer a copy that opens as a drawing (Excalidraw plugin required)
    excalidrawOpenCopy: "Open in Excalidraw (copy)",
    excalidrawCopyNotice: (path: string) => `Copy created at ${path} — the original and archive remain unchanged.`,
    excalidrawCopySuffix: "archive",
    histSourceTitle: "Original (archived version)",
    histSourceMeta: (seq: string, block: string) => `seq #${seq} · Bitcoin block #${block}`,
    histNone: "No seal history yet.",
    histTabTitle: (name: string, seq: string) => `${name} @ seq ${seq}`,
    histBanner: (name: string, seq: string, block: string, when: string) =>
      `🔒 Sealed version (read-only) · ${name} · seq ${seq} · ${block === "?" ? "awaiting anchor" : "₿#" + block} · ${when}`,
    histSourceStale: "Couldn't read this archived version — the archive may have moved or been removed.",
    // 2026-07 settings v2 — card UI (start / account / integrations / collapsed advanced)
    startIntro: "nanalStamp automatically seals your notes with Bitcoin-anchored timestamps as you write — tamper-proof evidence that can't be back-dated. Sign in and everything just works.",
    integrationsHead: "Integrations",
    acctCreditsLabel: (n: number) => `Certificate credits: ${n}`,
    githubRowName: "GitHub backup",
    teamRowName: "Team",
    advancedSummary: "Advanced settings — most of these never need changing",
  },
  ko: {
    off: "🔒 nanalStamp 꺼짐",
    overview: (streak: number, total: number) => streak > 0 ? `🔏 ${streak}일 연속 · 총 ${total}건` : `🔏 nanalStamp · 총 ${total}건`,
    sealed: (seq: number) => `봉인됨 · seq ${seq}`,
    unsealed: (name: string) => `○ 미봉인 · ${name}`,
    pending: "봉인 대기",
    pendingEta: (mmss: string) => ` · ${mmss}`,
    pendingSoon: " · 멈추면 봉인",
    pendingTitle: (name: string) => `${name} — 카운트다운 후 멈추면 봉인 · 전환·이탈·종료 시 즉시`,
    unsent: (name: string) => `⚠ 미전송 · ${name}`,
    outScope: (name: string) => `– 범위 밖 · ${name}`,
    base: (total: number, streak: number, m: number, url: string) => `봉인 ${total}건${streak > 0 ? ` · ${streak}일 연속` : ""} · 노트당 최대 1회/${m}분(멈출 때) · 닫기·종료 시 즉시 · ${url}`,
    offTitle: "봉인 꺼짐",
    sealedTitle: (name: string, seq: number, at: string) => `${name} — 봉인됨 · seq ${seq} @ ${at}`,
    unsealedTitle: (name: string) => `${name} — 아직 봉인 전(또는 봉인 후 변경됨)`,
    unsentTitle: (name: string) => `${name} — 전송 실패, 자동 재시도 중`,
    outScopeTitle: "이 폴더는 설정된 범위 밖입니다(설정에서 변경).",
    queryFail: (base: string) => `${base} (서버 조회 실패)`,
    noticeSealed: (name: string, seq: number, reason: string) => `🔏 봉인됨: ${name} (seq ${seq}) · ${reason}`,
    noticeFail: (name: string, err: string) => `⚠️ 봉인 실패: ${name} — ${err} (재시도 예정)`,
    noNote: "열린 노트가 없습니다",
    reason: { settle: "멈춤", leave: "노트 떠남", manual: "수동", unload: "종료", retry: "재시도" } as Record<string, string>,
    ribbon: "nanalStamp: 현재 노트 봉인",
    anchorCmd: "지금 비트코인에 앵커",
    anchorOk: "⛓ 비트코인에 제출됨(몇 시간 내 확정)",
    anchorFail: (e: string) => `⚠️ 앵커 실패: ${e}`,
    btc: (h: number) => ` · ₿#${h}`,
    anchoring: " · ⛓ 앵커 중",
    exportCmd: "증명 내보내기 (.nanalproof)",
    exportOk: (p: string) => `📄 증명 저장됨: ${p}`,
    exportNone: (n: string) => `아직 봉인 안 됨: ${n}`,
    exportFail: (e: string) => `⚠️ 내보내기 실패: ${e}`,
    catchupNotice: (n: number) => `🔏 따라잡기: 시작 시 ${n}개 봉인`,
    settIntro: "노트가 정착되면 SHA-256 해시만 서버로 보냅니다. 노트 내용과 파일 경로 모두 기기에서 해시화되어, 본문은 물론 읽을 수 있는 폴더·파일명도 전송되지 않습니다.",
    langName: "언어",
    langDesc: "플러그인 언어(Auto는 Obsidian 따름). 명령 이름은 새로고침 후 반영.",
    langReload: "명령 이름을 반영하려면 Obsidian을 새로고침하세요.",
    apiKeyMissing: "🔑 로그인 필요 (설정)",
    includeName: "포함 폴더",
    includeDesc: "이 폴더들 아래 노트만 봉인합니다(한 줄에 하나). 비우면 vault 전체.",
    excludeName: "제외 폴더",
    excludeDesc: "이 폴더들 아래 노트는 봉인하지 않습니다(한 줄에 하나).",
    scopeAllVault: "현재: vault 전체 봉인",
    scopeSomeFolders: (n: number) => `현재: ${n}개 폴더만 봉인`,
    excludeNone: "현재: 제외 없음",
    excludeSome: (n: number) => `현재: ${n}개 폴더 제외`,
    tplEnableName: "개발노트 템플릿 켜기",
    tplEnableDesc: "선택적 편의 기능. 플러그인은 여전히 아무 노트나 봉인합니다 — 이건 구조화된 개발노트 항목을 삽입하는 명령만 추가합니다.",
    tplFolderName: "새 개발노트 폴더",
    tplFolderDesc: "'새 개발노트(오늘)'가 만들 폴더. 비우면 vault 루트.",
    tplOff: "개발노트 템플릿이 꺼져 있습니다(설정에서 켜기).",
    tplNewCmd: "새 개발노트(오늘)",
    tplInsCmd: (l: string) => `${l} 항목 삽입`,
    digestCmd: "월간 digest 작성 (Create monthly digest)",
    digestFolderName: "월간 digest 폴더",
    digestFolderDesc: "월간 digest 노트가 저장·인식되는 폴더. 기본값: digests",
    digestExists: "이미 있습니다 — 엽니다.",
    digestCreated: (p: string) => `📋 월간 digest 생성됨: ${p}`,
    digestOutOfScope: "이 폴더는 봉인 범위 밖입니다 — 설정에서 포함하세요.",
    digestErr: (m: string) => `digest 생성 실패: ${m}`,
    digestScaffold: (ym: string, s: DigestStats) => {
      const folders = s.topFolders.length
        ? s.topFolders.map((f) => `${f.folder}(${f.count}건)`).join(", ")
        : "(없음)";
      return (
        `# ${ym} 월간 연구 정리 (Digest)\n\n` +
        `> 이 문서는 조직 공유용 정리본입니다. 아래 통계는 자동 생성됐고, 서술은 직접 작성하세요.\n` +
        `> 작성 완료 후 "이 노트 점검 요청" 명령으로 점검자 서명을 받을 수 있습니다.\n\n` +
        `## 자동 통계\n` +
        `- 봉인: ${s.seals}건 / 활동일: ${s.activeDays}일 / 아티팩트: ${s.artifacts}개\n` +
        `- 주요 폴더: ${folders}\n\n` +
        `## 이번 달 주요 진행 (직접 작성)\n-\n\n` +
        `## 다음 달 계획 (직접 작성)\n-\n`
      );
    },
    teamTplPrefix: "팀: ",
    teamProfileHead: "팀 프로파일",
    teamProfileEnableName: "팀 프로파일 자동 적용",
    teamProfileEnableDesc: "팀 프로파일이 폴더 필터·첨부 설정을 관리하고, 조직 템플릿을 추가합니다. 끄면 로컬 설정을 유지합니다.",
    teamProfileRefetchBtn: "지금 다시 받기",
    teamProfileApplied: "팀 프로파일 적용됨",
    teamProfileNotMember: "팀에 소속돼 있지 않습니다",
    teamProfileFail: "팀 프로파일을 받지 못했습니다",
    teamProfileLastReceived: (w: string) => `마지막 수신: ${w}`,
    teamProfileNever: "아직 받은 적 없음",
    certCmd: "증명서 발급 (PDF)",
    publicCmd: "공개 검증 링크 만들기",
    pricingCmd: "요금제 보기",
    accountCmd: "내 계정·구독 관리",
    subscribeCmd: "구독",
    subDesc: "요금제 페이지에서 플랜을 비교하고 구독하세요.",
    subTierDesc: (tier: string) => `현재 요금제: ${tier} — 요금제 페이지에서 플랜을 비교·변경할 수 있습니다.`,
    manageSubBtn: "구독 관리",
    buyCreditCmd: "증명서 크레딧 구매",
    buyCreditDesc: "크레딧 1개 = 증명서(PDF) 1건 발급 — '증명서 발급' 명령에서 사용됩니다.",
    certOk: (p: string) => `📄 증명서 저장됨: ${p}`,
    certFail: (m: string) => `증명서 발급 실패: ${m}`,
    certPay: "크레딧이 필요합니다 — 요금제 페이지를 엽니다",
    proOnly: "Pro 전용 기능 — 요금제 페이지를 엽니다",
    linkOk: (u: string) => `🔗 공개 링크 복사됨: ${u}`,
    linkFail: (m: string) => `링크 생성 실패: ${m}`,
    checkoutFail: (m: string) => `결제 시작 실패: ${m}`,
    loginName: "계정 로그인 (무료)",
    loginDesc: "이메일/비번으로 로그인하면 API 키를 자동으로 받습니다.",
    loginBtn: "로그인",
    loginOk: (tier: string) => `로그인됨 (${tier})`,
    loginFail: (m: string) => `로그인 실패: ${m}`,
    registerBtn: "회원가입",
    registerSent: (e: string) => `${e} 로 인증 메일을 보냈습니다. 메일의 링크를 클릭한 뒤 로그인하세요.`,
    registerFail: (m: string) => `회원가입 실패: ${m}`,
    acctName: "계정",
    acctLoading: "계정 정보 불러오는 중…",
    acctInfo: (tier: string, credits: number, pro: boolean) => `요금제: ${tier}${pro ? " (Pro)" : ""} · 증명서 크레딧: ${credits}`,
    pastDueBadge: "⚠️ 결제 실패 — 카드 확인 필요",
    pastDueNotice: "nanalStamp: 구독 갱신 결제가 실패했습니다. 유예 기간 동안 서비스는 유지됩니다 — nanalstamp.com/account 에서 결제 수단을 확인해 주세요.",
    acctConnected: "API 키로 연결됨",
    logoutBtn: "로그아웃",
    logoutConfirm: "로그아웃할까요? 다시 로그인할 때까지 이 기기의 봉인·클라우드 보관이 중단됩니다(데이터에는 영향 없음).",
    acctHead: "계정·구독",
    sealScopeHead: "봉인 범위",
    miscHead: "기타",
    sealCmd: "현재 노트 지금 봉인",
    apiKeyRejected: "🔑 API 키 거부됨 (설정)",
    authFail: "API 키가 거부되었습니다(401/403). 설정에서 키를 갱신하기 전까지 봉인이 중단됩니다.",
    rateLimited: "⏳ 요청 제한 — 잠시 후 자동 재시도합니다.",
    sealFirst: (n: string) => `먼저 “${n}”을(를) 봉인하세요 — 아직 봉인되지 않았습니다.`,
    devNoteCreated: (p: string) => `📝 ${p}`,
    tplErr: (e: string) => `⚠️ ${e}`,
    emailPlaceholder: "이메일",
    pwPlaceholder: "비밀번호",
    // 온보딩(첫 실행)
    welcomeTitle: "nanalStamp에 오신 것을 환영합니다",
    welcomeBody: "nanalStamp은 노트를 비트코인에 앵커된 타임스탬프로 날마다 봉인합니다. 핵심은 “이 파일이 한 번 존재했다”가 아니라, 소급 생성할 수 없는 끊김 없는 연속 증명입니다. 증명 가능한 기간은 봉인을 시작하는 순간부터 앞으로만 쌓입니다.",
    welcomeSealNow: "지금 봉인하세요 — 과거는 소급 증명할 수 없습니다. 늦어지는 하루하루가 되찾을 수 없는 증명 가능한 역사입니다.",
    welcomeKeyHint: "시작하려면 API 키를 입력하거나 로그인하세요.",
    welcomeOpenSettings: "설정 열기",
    welcomeLater: "확인",
    // 증명 / 타임라인 모달
    proofCmd: "노트 증명 / 타임라인 보기",
    proofTitle: "노트 증명",
    proofChecking: "서버에 조회 중…",
    proofSealedHead: "봉인됨",
    proofUnsealedHead: "○ 아직 봉인 안 됨",
    proofChangedHead: "✍️ 봉인 후 변경됨",
    proofPendingHead: "… 봉인 대기 중",
    proofOutScopeHead: "– 봉인 범위 밖",
    proofSeq: (n: number) => `순번: #${n}`,
    proofReceived: (at: string) => `봉인 시각: ${at}`,
    proofAnchorConfirmed: (h: number) => `비트코인 앵커: 확정됨 · 블록 #${h}`,
    proofAnchorPending: "비트코인 앵커: 제출됨, 확정 대기 중(몇 시간)",
    proofAnchorNone: "비트코인 앵커: 아직 앵커 안 됨",
    proofUnsealedBody: "현재 내용과 정확히 일치하는 봉인이 서버에 없습니다. 봉인하면 증명이 시작됩니다.",
    proofChangedBody: "이전에 봉인된 노트이지만 현재 내용이 달라졌습니다 — 새 버전을 덮으려면 다시 봉인하세요.",
    proofStreakLine: (streak: number, total: number) => `${streak}일 연속 봉인 · 총 ${total}건`,
    proofWhy: "증명은 봉인을 시작한 시점부터의 기간만 커버합니다. 연속 기록을 이어가세요 — 과거는 소급 봉인할 수 없습니다.",
    proofErr: "서버 조회에 실패했습니다. 연결과 API 키를 확인하세요.",
    proofClose: "닫기",
    // 점검(카운터서명)
    reviewReqCmd: "이 노트 점검 요청 (Request review)",
    reviewReqSent: "점검 요청을 보냈습니다 — 점검자가 서명하면 상태에 표시됩니다.",
    reviewReqFail: "아직 봉인되지 않았거나 팀에 소속돼 있지 않습니다.",
    reviewSectionTitle: "점검",
    reviewReviewed: "점검함",
    reviewApproved: "승인함",
    reviewSigned: (verdict: string, email: string, when: string) => `✓ 점검 완료 — ${verdict} (${email}, ${when})`,
    reviewPending: "점검 대기 중",
    reviewDeclined: (note: string) => note ? `반려됨 (${note})` : "반려됨",
    // 비밀번호 재설정
    resetCmd: "비밀번호 재설정",
    resetName: "비밀번호를 잊으셨나요?",
    resetDesc: "이메일로 재설정 링크를 보낸 뒤, 웹 페이지에서 새 비밀번호를 설정하세요.",
    resetModalTitle: "비밀번호 재설정",
    resetSendBtn: "재설정 메일 보내기",
    resetOpenBtn: "재설정 페이지 열기",
    resetNeedEmail: "이메일을 먼저 입력하세요.",
    resetSent: (e: string) => `${e} 계정이 있으면 재설정 링크를 보냈습니다. 메일함에서 링크를 열어 새 비밀번호로 바꾼 뒤 로그인하세요.`,
    resetFail: (m: string) => `재설정 요청 실패: ${m}`,
    // 내구성: 로컬 증명 원장(P1) + GitHub 미러(P2)
    ledgerHead: "증명 원장·증명서",
    ledgerName: "증명 자동 저장(로컬)",
    ledgerDesc: "비트코인 앵커가 확정되면 그 노트의 자기검증 증명을 vault 폴더에 저장합니다 — 서버/DB가 사라져도 증명이 생존합니다.",
    ledgerFolderName: "증명 원장 폴더",
    ledgerFolderDesc: "자동 저장 증명이 쌓일 vault 폴더(기본 nanalStamp/proofs).",
    ledgerSaved: (p: string) => `🗂 증명 원장 저장: ${p}`,
    ledgerSweepDone: (n: number) => `🗂 증명 ${n}개 로컬 저장됨`,
    // 로컬 git 아카이브(전 티어) — 원문+증명 이력 보존
    archiveName: "내용 이력 보존(로컬 git)",
    archiveDesc: "확정되면 노트 원문과 증명을 vault 밖 로컬 git repo에 커밋합니다 — 편집해도 과거 버전을 복원할 수 있습니다(FREE 포함 전 티어). 데스크탑 전용.",
    archiveMobile: "데스크탑에서만 동작합니다 — 모바일은 아카이브를 건너뜁니다.",
    archivePathName: "아카이브 폴더",
    archivePathDesc: "로컬 git 아카이브의 절대경로. 동기화 폴더(Dropbox/iCloud/OneDrive) 밖에 두세요 — 반쯤 동기화된 .git은 이력을 손상시킬 수 있습니다.",
    archivePickBtn: "폴더 선택",
    archiveMigrated: (a: string, b: string) => `📦 아카이브 이동됨(이력 보존): ${a} → ${b}. 기존 폴더는 백업으로 남겨뒀습니다 — 확인 후 직접 삭제하세요.`,
    archiveExists: "새 폴더에 이미 아카이브가 있어 자동 복사하지 않습니다(이력 섞임 방지). 필요하면 직접 이동/병합하세요.",
    archiveSet: (p: string) => `📦 아카이브 폴더 설정됨: ${p}`,
    archiveNotWritable: (p: string) => `⚠️ 폴더에 쓸 수 없습니다: ${p}`,
    archiveDesktopOnly: "로컬 아카이브는 데스크탑 전용입니다.",
    githubHead: "GitHub 미러 (PRO/TEAM)",
    githubLocked: "PRO/TEAM 구독이 필요합니다",
    githubProNote: "원본 노트와 증명을 본인 GitHub repo로 미러해 vault가 삭제돼도 생존합니다. PRO/TEAM에서 사용할 수 있습니다.",
    githubMirrorName: "GitHub 미러",
    githubMirrorDesc: "확정 시 노트의 원본 .md와 증명을 본인 GitHub repo(notes/ + proofs/)로 push합니다. 플러그인이 직접 실행 — 서버는 내용을 보지 않습니다.",
    githubPatName: "GitHub 토큰(PAT)",
    githubPatDesc: "대상 repo에 Contents 읽기·쓰기 권한을 가진 fine-grained personal access token.",
    githubRepoName: "대상 repo (owner/repo)",
    githubRepoDesc: "예: yourname/nanalstamp-vault. GitHub에서 먼저 생성하세요(private 권장).",
    mirrorOk: (r: string) => `☁️ GitHub 미러됨: ${r}`,
    mirrorFail: (m: string) => `⚠️ GitHub 미러 실패: ${m}`,
    storageHead: "보관·백업",
    storageProNote: "봉인 원문을 외부에 보존합니다 — GitHub 미러 또는 nanalStamp 추가전용 스토리지. Pro 필요.",
    storageBackendName: "nanalStamp 스토리지 사용",
    storageBackendDesc: "봉인 원문+증명을 어디에 보존할지 선택합니다. nanalStamp 스토리지는 추가전용 — 봉인 후에는 본인을 포함해 누구도 수정·삭제할 수 없습니다.",
    storageGithub: "GitHub 미러 (내 repo)",
    storageNanalDesc: "봉인되는 각 버전의 원문과 증명이 WORM 스토리지(S3 Object Lock)로 직접 업로드됩니다 — 서버는 내용을 보지 않고, 보존기간 동안 수정·삭제가 불가능합니다.",
    nanalQuotaFull: "nanalStamp 스토리지 용량이 가득 찼습니다 — 업로드가 중단됩니다. 플랜을 업그레이드하면 이어서 저장됩니다(기존 데이터는 안전).",
    nanalDekGone: "nanalStamp 저장 키가 파기되어 클라우드 보관을 사용할 수 없습니다(로컬 봉인은 계속 동작).",
    nanalProofExportCmd: "nanalStamp 보관 증명 내보내기 (자가검증형)",
    nanalProofExportOk: (rel: string) => `내보냈습니다: ${rel} — np-verify에서 오프라인 검증 가능`,
    storageAdvHead: "고급: GitHub 내보내기",
    githubExportName: "내 GitHub으로 내보내기",
    githubExportDesc: "봉인 원문+증명을 내 GitHub repo에도 push합니다 — 탈출구: nanalStamp가 사라져도 증거는 내 repo에 남습니다(np-verify로 오프라인 검증). nanalStamp 스토리지와 병행 동작합니다.",
    storageUsageName: "스토리지 사용량",
    storageUsageVal: (u: string, q: string) => `${u} / ${q}`,
    storageUsageLoading: "확인 중…",
    nanalMirrorOk: "🛢 nanalStamp 스토리지에 보존됨",
    nanalMirrorFail: (e: string) => `⚠️ nanalStamp 스토리지 실패: ${e} (재시도합니다)`,
    nanalRestoreCmd: "nanalStamp 스토리지에서 봉인 원문 복원",
    nanalRestoreNone: "이 노트의 봉인 버전이 아직 nanalStamp 스토리지에 없습니다.",
    nanalRestoreFail: (e: string) => `⚠️ 복원 실패: ${e}`,
    nanalRestoreBadHash: "⚠️ 내려받은 내용이 봉인 해시와 일치하지 않습니다 — 저장하지 않았습니다.",
    nanalRestoreOk: (p: string) => `📥 복원됨: ${p}`,
    nanalViewTitle: (name: string) => `${name} - nanalStamp 보관본`,
    nanalViewBanner: (name: string, h8: string) => `읽기 전용 · nanalStamp에 보관된 봉인 원문(위변조 불가) — ${name} · sha256 ${h8}…`,
    // 4.3: 조직 GitHub App custody(서버가 관리하는 미러)
    teamCustodyName: "팀 custody",
    teamCustodyActive: (org: string, repo: string) => `조직 GitHub(${org}/${repo})로 미러 중 — 팀이 관리합니다.`,
    teamCustodyPersonalUnused: "미러 대상은 팀이 관리합니다. 팀 custody 활성 중에는 아래 개인 GitHub 설정이 사용되지 않습니다.",
    teamCustodyOn: "팀 custody 활성 — 조직 GitHub로 미러합니다.",
    teamCustodyOff: "팀 custody가 활성 상태가 아닙니다.",
    // C2: 팀 custody 스토리지 강제(teamCustody/GitHub와 독립 — 서버 mirror/info의 team_storage 필드)
    teamStorageForced: "팀이 관리합니다 — 봉인 원문이 조직의 nanalStamp 스토리지에 저장됩니다.",
    teamPoolFullDesc: "팀 용량은 시트 추가로 늘어납니다 — 팀 관리자에게 문의하세요.",
    // GitHub OAuth Device Flow 연결
    githubConnectName: "GitHub 연결",
    githubConnectDesc: "여기서 클릭 한 번 + GitHub에서 승인 한 번 — PAT를 만들 필요가 없습니다. 토큰을 받아 private repo nanalstamp-vault를 자동 생성하고 미러를 켭니다.",
    githubConnectBtn: "GitHub 연결",
    githubConnectedName: "GitHub 연결",
    githubConnectedDesc: (user: string, repo: string) => `연결됨: @${user} · ${repo}`,
    githubDisconnectBtn: "연결 해제",
    githubAdvancedName: "고급(수동 PAT)",
    githubAdvancedDesc: "파워 유저용: 연결 대신 대상 repo를 직접 지정하거나 fine-grained PAT(Contents 읽기·쓰기)를 붙여넣습니다.",
    ghModalTitle: "GitHub 연결",
    ghNoClient: "관리자가 GitHub OAuth App을 아직 설정하지 않아 원클릭 연결을 쓸 수 없습니다. 아래 '고급(수동 PAT)'을 쓰거나 오너에게 설정을 요청하세요.",
    ghRequesting: "GitHub에 디바이스 코드를 요청하는 중…",
    ghStep1: "① 아래 코드가 클립보드에 복사됐습니다:",
    ghStep2: "② GitHub를 열고 코드를 붙여넣으세요",
    ghStep2Btn: "GitHub 열기",
    ghStep3: "③ 그곳에서 승인하면 이 창이 자동으로 완료됩니다.",
    ghWaiting: "⏳ 승인 대기 중…",
    ghPreparing: "토큰을 받고 repo를 준비하는 중…",
    ghSuccess: (user: string, repo: string) => `✅ 연결 완료: @${user} · ${repo}`,
    ghDenied: "승인이 거부되었습니다. 다시 시도할 수 있습니다.",
    ghExpired: "코드가 만료되었습니다. 다시 시도하세요.",
    ghDeviceFail: "GitHub에서 디바이스 코드를 받지 못했습니다. 연결을 확인하고 다시 시도하세요.",
    ghUserFail: "토큰은 받았지만 GitHub 계정을 읽지 못했습니다. 다시 연결해 보세요.",
    ghRepoFail: "연결됐지만 repo를 자동 생성하지 못했습니다. '고급'에서 대상 repo를 직접 지정하세요.",
    ghRetryBtn: "다시 시도",
    ghCloseBtn: "닫기",
    ghErr: (m: string) => `오류: ${m}`,
    // 특정 시점 증명서(P6) — git 아카이브의 그 버전을 읽어 오프라인 검증 후 내보내기
    pitCmd: "특정 시점 증명서(아카이브에서)",
    pitDesktopOnly: "특정 시점 증명서는 데스크탑 전용입니다 — 로컬 git 아카이브를 읽습니다.",
    pitNoArchive: "먼저 설정에서 로컬 git 아카이브를 켜세요 — 이 증명서가 만들어지는 버전 이력을 보존합니다.",
    pitNoHistory: (n: string) => `“${n}”의 아카이브 버전이 아직 없습니다. 비트코인 앵커가 확정되면 각 버전이 아카이브에 커밋됩니다.`,
    pitAttachmentUnsupported: "첨부의 아카이브 이력 보기는 아직 지원되지 않습니다(아카이브에는 저장되어 있습니다).",
    pitModalTitle: "특정 시점 증명서",
    pitPick: "증명할 버전을 고르세요. 현재 노트는 건드리지 않습니다 — 과거 버전을 git에서 바로 읽습니다.",
    pitVersionDesc: (seq: string, block: string) =>
      block === "?" ? `seq #${seq} · 앵커 대기` : `seq #${seq} · 비트코인 블록 #${block}`,
    // 증빙 상태 대시보드 (PRO)
    dashCmd: "증빙 상태 대시보드",
    dashTitle: "증빙 상태 대시보드",
    dashSub: "얼마나 썼는가가 아니라, 증거가 얼마나 단단한가.",
    dashCoverage: "증빙 커버리지",
    dashGaps: "보호 공백",
    dashTimeline: "IP 타임라인 — 폴더별 최초 앵커",
    dashHeatmap: "봉인 연속성 (12주)",
    dashSync: "앵커·동기화 상태",
    dashCands: "증명서 후보",
    dashCovered: (c: number, n: number) => `${n}개 중 ${c}개 보호됨`,
    dashKindModified: "봉인 후 수정됨",
    dashKindUnsealed: "봉인 이력 없음",
    dashSealNow: "봉인",
    dashOpenVersions: "버전 보기…",
    dashConfirmed: (n: number) => `확정 증명 ${n}건`,
    dashArcPending: (n: number) => `로컬 아카이브 대기 ${n}건`,
    dashMirPending: (n: number) => `GitHub 미러 대기 ${n}건`,
    dashLatestBlock: (b: number) => `최신 비트코인 블록 #${b}`,
    dashCandDesc: (v: number, d: number, b: number) => `${v}개 버전 · ${d}일 스팬 · ₿#${b}부터`,
    dashTlDesc: (b: number, from: string, n: number) => `₿#${b}부터 (${from}) · 기록 ${n}건`,
    dashLockedGaps: (n: number) => `보호 공백 ${n}건 발견 — PRO에서 상세 확인`,
    dashLockedDesc: "전체 대시보드는 PRO 기능입니다.",
    dashBuyPro: "PRO 업그레이드",
    dashRefresh: "새로고침",
    dashEmpty: "아직 봉인된 노트가 없습니다 — 쓰고 봉인하면 채워집니다.",
    dashNoArchive: "로컬 git 아카이브가 꺼져 있습니다 — 타임라인·후보는 아카이브가 필요합니다(설정).",
    dashSkipped: (n: number) => `${n}개 노트 미계산(대용량 vault 상한)`,
    dashKpiConfirmed: "확정 증명",
    dashKpiLatestBlock: "최신 ₿ 블록",
    dashKpiSealDays: "12주 봉인일",
    dashDaysOf: (d: number, total: number) => `${total}일 중 ${d}일`,
    dashLegendCovered: "보호됨", dashLegendModified: "수정됨", dashLegendUnsealed: "미봉인", dashLegendPending: "확정 대기",
    dashFunnelConfirmed: "₿ 확정", dashFunnelArchive: "로컬 아카이브", dashFunnelMirror: "GitHub 미러",
    dashAgoDays: (n: number) => `수정 ${n}일 경과`,
    dashAgoHours: (n: number) => `수정 ${n}시간 경과`,
    dashMore: (n: number) => `외 ${n}건`,
    dashWeekdays: ["월", "수", "금", "일"],
    dashGaugeLabel: "커버리지",
    dashKindPending: "봉인됨 · ₿ 확정 대기",
    alreadySealed: "이미 봉인된 내용입니다",
    dashExpand: "크게 보기",
    dashCollapse: "← 돌아가기",
    dashHeatTotal: (n: number) => `최근 12주 봉인 ${n}건`,
    dashHeatCellTip: (d: string, n: number) => `${d} · ${n}건`,
    dashHeatLess: "적게",
    dashHeatMore: "많이",
    dashMonthLbl: (m: number) => `${m}월`,
    dashBackfillLeft: (n: number) => `백그라운드 백필 진행 중 — 대기 ${n}건 (분당 몇 건씩 자동 처리)`,
    backfillName: "백그라운드 백필",
    backfillDesc: "봉인 이력이 없는 기존 노트를 천천히(3초에 1건) 자동 봉인합니다 — 서버 한도에 여유 있게 동작. 예전 노트의 자동 봉인을 원치 않으면 끄세요.",
    attachName: "첨부 봉인",
    attachDesc: "봉인된 노트가 참조(임베드·링크)하는 모든 첨부를 형식과 무관하게 함께 봉인합니다. 동일한 해시 전용 방식 — SHA-256 해시만 기기를 떠납니다.",
    attachSkippedWarn: (n: number, mb: number, team: boolean) => `⚠️ 첨부 ${n}건 — 봉인은 됐지만 클라우드 보관 제외(${team ? `팀 정책 상한 ${mb}MB` : `파일당 5GB 서버 한도`} 초과). 해시 증명은 유효합니다.`,
    uploadSkipTeam: (name: string, mb: number) => `⚠️ "${name}" 봉인됨 — 팀 정책 첨부 상한 ${mb}MB 초과로 클라우드 보관은 제외됩니다.`,
    uploadSkipHardCap: (name: string) => `⚠️ "${name}" 봉인됨 — 파일당 5GB 한도 초과로 클라우드 보관은 제외됩니다.`,
    largeUploadNotice: (name: string, size: string, pct: number | null) => `대용량 파일 "${name}"(${size}${pct != null ? ` — 쿼터의 ${pct}%` : ""})을 nanal 스토리지에 업로드합니다.`,
    uploadProgress: (done: number, total: number) => `☁ 보관 중 ${done}/${total}`,
    pitSelectBtn: "선택",
    pitBackBtn: "뒤로",
    pitReading: "아카이브에서 해당 버전을 읽는 중…",
    pitReadFail: "아카이브에서 그 버전을 읽지 못했습니다.",
    pitVerifyOk: "✅ 오프라인 검증됨: 이 버전의 내용이 증명과 일치하며, 확정된 비트코인 블록에 앵커됨.",
    pitVerifyHashBad: "⚠️ 아카이브된 내용이 증명 속 해시와 일치하지 않습니다 — 아카이브 항목이 손상됐을 수 있습니다.",
    pitVerifyNoBlock: "⚠️ 이 버전의 증명에 아직 확정된 비트코인 블록이 없습니다.",
    pitAnchorHint: "봉인 시점 아카이브 사본입니다 — 앵커 확정 전에 저장된 증명이라 여기선 대기로 보입니다. 현재 앵커 상태는 온라인 이력(상태바 클릭)에서 확인하세요.",
    pitDetailDate: (d: string) => `아카이브 시각: ${d}`,
    pitDetailSeq: (s: string) => `시퀀스: #${s}`,
    pitDetailBlock: (b: string) => `비트코인 블록: #${b}`,
    pitDetailHash: (h: string) => `내용 해시: ${h}`,
    pitExportBundle: "자기검증 번들 내보내기 (무료)",
    pitExportCert: "포맷된 증명서 내보내기 (PRO)",
    pitBundleOk: (p: string) => `📦 번들 내보냄: ${p}`,
    pitCertOk: (p: string) => `📜 증명서 내보냄: ${p}`,
    pitExportFail: (e: string) => `⚠️ 내보내기 실패: ${e}`,
    pitClose: "닫기",
    histSectionTitle: (total: number) => `봉인 이력 (${total.toLocaleString()}건)`,
    histLoadingMore: "더 불러오는 중…",
    histRowConfirmed: (when: string, seq: number, block: number) => `${when} · seq ${seq} · ₿#${block}`,
    histRowPending: (when: string, seq: number) => `${when} · seq ${seq} · 앵커 대기`,
    histAnchorWait: "앵커 대기",
    histViewSource: "원문 보기",
    histSrcLocal: "로컬",
    histSrcGithub: "GitHub",
    histSrcNanal: "nanalStamp",
    histSaveFile: "파일로 저장",
    histSaveHint: "이 첨부 형식은 미리보기를 지원하지 않습니다 — 저장해서 확인하세요.",
    // B: Excalidraw 아카이브 뷰 — 그림으로 열 수 있는 사본 제공(Excalidraw 플러그인 필요)
    excalidrawOpenCopy: "Excalidraw로 열기(사본)",
    excalidrawCopyNotice: (path: string) => `사본이 ${path}에 생성되었습니다 — 원본·아카이브는 불변입니다.`,
    excalidrawCopySuffix: "아카이브",
    histSourceTitle: "원문 (아카이브 버전)",
    histSourceMeta: (seq: string, block: string) => `seq #${seq} · 비트코인 블록 #${block}`,
    histNone: "봉인 이력이 아직 없습니다.",
    histTabTitle: (name: string, seq: string) => `${name} @ seq ${seq}`,
    histBanner: (name: string, seq: string, block: string, when: string) =>
      `🔒 봉인 버전 (읽기 전용) · ${name} · seq ${seq} · ${block === "?" ? "앵커 대기" : "₿#" + block} · ${when}`,
    histSourceStale: "이 아카이브 버전을 읽을 수 없습니다 — 아카이브가 이동/삭제되었을 수 있습니다.",
    // 2026-07 설정 2차 단순화 — 카드형 UI(시작/계정/연동/접힌 고급)
    startIntro: "nanalStamp는 쓰는 동안 노트를 비트코인 앵커 타임스탬프로 자동 봉인합니다 — 위변조·소급이 불가능한 증거가 쌓입니다. 로그인만 하면 바로 작동합니다.",
    integrationsHead: "연동",
    acctCreditsLabel: (n: number) => `증명서 크레딧: ${n}개`,
    githubRowName: "GitHub 백업",
    teamRowName: "팀",
    advancedSummary: "고급 설정 — 대부분 바꿀 필요 없습니다",
  },
};
let t = STR[pickLang()];

// ── 개발노트 템플릿(선택적 편의 + 증빙-인지 #nanal/<cat> 태그) ─────────────────
const TPL = {
  en: {
    title: (d: string) => `# Dev log — ${d}`,
    cats: {
      bug: { emoji: "🐛", label: "Bug", fields: ["Symptom", "Cause", "Fix"] },
      decision: { emoji: "⚖️", label: "Decision", fields: ["What", "Why", "Alternatives considered"] },
      trap: { emoji: "⚠️", label: "Pitfall", fields: ["Pitfall", "How to avoid"] },
      cont: { emoji: "✅", label: "Continue", fields: ["Done", "Next"] },
    } as Record<string, { emoji: string; label: string; fields: string[] }>,
  },
  ko: {
    title: (d: string) => `# 개발노트 — ${d}`,
    cats: {
      bug: { emoji: "🐛", label: "버그", fields: ["증상", "원인", "해결"] },
      decision: { emoji: "⚖️", label: "결정", fields: ["무엇", "왜", "검토한 대안"] },
      trap: { emoji: "⚠️", label: "함정", fields: ["함정", "회피"] },
      cont: { emoji: "✅", label: "이어하기", fields: ["한 일", "다음"] },
    } as Record<string, { emoji: string; label: string; fields: string[] }>,
  },
};
let tpl = TPL[pickLang()];

// 언어 적용: 설정이 auto면 자동감지, 아니면 강제(en/ko). t/tpl 재설정.
function applyLang(s: AttestSettings) {
  const lang: Lang = s.lang === "auto" ? pickLang() : (s.lang as Lang);
  t = STR[lang];
  tpl = TPL[lang];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 점검 서명 시각 표기 — np-verify와 동일한 UTC 포맷("YYYY-MM-DD HH:MM:SS UTC").
// 비숫자(변조 번들 등)면 new Date(NaN)이 RangeError를 던지므로 "—"로 방어.
function fmtUtc(unixSec: number): string {
  return Number.isFinite(unixSec) ? new Date(unixSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";
}
// statement("reviewed"|"approved") → 현재 언어 라벨(np-verify: 점검함/승인함).
function reviewVerdictLabel(statement: string): string {
  if (statement === "approved") return t.reviewApproved;
  if (statement === "reviewed") return t.reviewReviewed;
  return statement;
}
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

interface AttestSettings {
  lang: "auto" | "en" | "ko";
  serverUrl: string;
  apiKey: string;
  accountEmail: string;        // 설정 2차: 로그인한 이메일(계정 카드 표시용) — 로그아웃 시 함께 비움
  enabled: boolean;            // UI 제거됨 — loadSettings에서 항상 true 강제. 내부 게이트는 향후 원격 비활성화 훅 대비로 잔존
  lastSeenMtime: number;
  includeFolders: string;
  excludeFolders: string;
  templatesEnabled: boolean;
  noteFolder: string;
  digestFolder: string;        // 5.2: 월간 digest 노트가 저장·인식되는 폴더(미러 시 digests/로 라우팅)
  onboarded: boolean;          // 첫 실행 환영 모달 표시 여부
  failedPaths: string[];       // 전송 실패 큐(재시작 후에도 재시도)
  sealDays: string[];          // 봉인 성공한 로컬 날짜(YYYY-MM-DD) — 연속일 계산용
  sealDayCounts: Record<string, number>; // 일별 봉인 횟수 — 히트맵 농도(GitHub 잔디)용
  lifetimeCount: number;       // 누적 봉인 횟수(세션 간 유지)
  autoLedger: boolean;         // P1: 확정 증명을 로컬 vault 폴더에 자동 저장
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
  localArchive: boolean;       // P1.5: 확정 원문+증명을 로컬 git 이력에 커밋(전 티어, 데스크탑만)
  archivePath: string;         // P1.5: 아카이브 절대경로(빈 값 → 로드 시 defaultArchivePath로 채움)
  archiveIndex: Record<string, string>; // 노트경로 → 로컬 git 아카이브에 커밋된 확정 해시
  sealAttachments: boolean;    // 0.2: 첨부도 봉인 대상에 포함(끄면 .md만). 대상 = 범위 내 노트가 참조하는 첨부(형식 무관)
  teamAttachmentMaxMB: number | null; // 3.2: 팀 프로파일이 배포한 첨부 상한(MiB, 0=무제한) — 업로드 유효 상한 = uploadLimitMB() 참조(개인 설정 UI 없음)
  attachSkipped: string[];     // 클라우드 보관(업로드)에서 제외된 첨부 경로 — 팀 정책 또는 5GB 하드캡 초과(봉인·해시 증명은 항상 됨). 침묵 누락 방지로 설정탭에 노출
  teamProfileEnabled: boolean; // 3.2: 팀 프로파일 자동 적용(폴더 필터·첨부 설정을 팀 정책이 관리). 끄면 로컬 값 유지
  teamTemplates: { name: string; body: string }[]; // 3.2: 팀 프로파일에서 수신한 조직 템플릿 캐시(삽입 명령으로 노출)
  teamProfileUpdatedAt: number; // 3.2: 마지막으로 팀 프로파일을 수신·적용한 로컬 시각(ms) — 설정탭 표시용
  teamCustody: { org: string; repo: string } | null; // 4.3: 조직 GitHub App custody. 서버 mirror/info로 수신·캐시. 있으면 개인 GitHub 대신 서버 프록시로 미러. null이면 기존 개인 미러 동작
  teamStorage: "nanal" | null; // C2: 팀 custody nanal — mirror/info로 수신·캐시. 'nanal'이면 개인 storageBackend와 무관하게 팀 스토리지 강제(팀 설정이 우선)
  storageBackend: "off" | "nanal"; // C1: nanal 택일(권장 기본). 기존 "github" 선택은 로드 시 githubExport로 이관
  githubExport: boolean;           // C1: 고급 — GitHub 내보내기(탈출구, nanal과 병행 가능). 기존 미러 코드 경로 재사용
  nanalIndex: Record<string, string>;         // 노트경로 → nanal 스토리지 업로드 완료된 봉인 해시(mirrorIndex와 동형)
}

const DEFAULTS: AttestSettings = {
  lang: "auto",
  serverUrl: "https://api.nanalstamp.com",
  apiKey: "",
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
  sealDays: [],
  sealDayCounts: {},
  lifetimeCount: 0,
  autoLedger: true,
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
  localArchive: true,
  archivePath: "",
  archiveIndex: {},
  sealAttachments: true,
  teamAttachmentMaxMB: null,
  attachSkipped: [],
  teamProfileEnabled: true,
  teamTemplates: [],
  teamProfileUpdatedAt: 0,
  teamCustody: null,
  teamStorage: null,
  storageBackend: "nanal", // 기본 on — Pro 구독 즉시 클라우드 보관 동작(free는 isPro 게이트가 차단)
  githubExport: false,
  nanalIndex: {},
};

// ── 내부 파라미터(상수) — 사용자가 조정할 값이 아니라서 설정 UI에서 제거하고 고정(2026-07 설정 재구성) ──
const SETTLE_MS = 5000;          // 정착 디바운스: 입력이 이 시간 멈추면 '멈춤'으로 간주
const MIN_INTERVAL_MS = 300000;  // 노트당 최소 봉인 간격(5분) — 그 사이 수정은 합침
const RETRY_MS = 30000;          // 전송 실패 노트 재시도 주기
const UPLOAD_HARD_CAP_MB = 5120;    // 클라우드 보관 파일당 서버 하드캡(5GB) — 초과 presign은 400이므로 클라에서 선차단(봉인은 크기 무관)
const LARGE_UPLOAD_NOTICE_MB = 100; // 이 크기 이상 업로드는 진행하되 1회 정보성 알림 — 쿼터 소모 인지용(차단 아님)
const UPLOAD_CONCURRENCY = 3;       // 청크 병렬 업로드 동시성 — 대역폭 독점 방지·모바일 고려(과한 병렬은 체감 역효과)

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

function parseFolders(s: string): string[] {
  return s.split(/[\n,]/).map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}

export default class NanalStampPlugin extends Plugin {
  settings!: AttestSettings;
  private states = new Map<string, FileState>();
  private failed = new Set<string>(); // 전송 실패 → 재시도 대기
  private sealArchiveRetry = new Set<string>(); // 봉인 시점 아카이브·미러 일시 실패 → 재시도(메모리만, persist 안 함)
  private nanalUploading = new Set<string>(); // v2a: 같은 파일의 청크 업로드가 재시도 인터벌과 겹치지 않게
  private storageQuotaBackoffUntil = 0; // C1: 402(쿼터 초과) 후 1시간 presign 중단 — 30초 재시도 루프의 무의미한 402 방지
  lastUsage: { used: number; quota: number } | null = null; // C1: 설정탭 사용량 바 캐시
  private usageFetchedAt = 0;
  private dekCache = new Map<string, Promise<string | null>>(); // Phase D: "user" | "team" → DEK 조회 Promise(in-flight 공유 — 콜드 캐시 병렬 GET 중복 방지, 세션 메모리만·디스크 비저장)
  private dekDeny = new Map<string, { until: number; gone: boolean }>(); // Phase D: DEK 네거티브 캐시 — 410(파기, gone)은 1시간, 일시 실패는 60초
  private dekGoneNotified = false; // Phase D: 410(파기 — 종결 상태) Notice는 세션당 1회
  private activeFile: TFile | null = null;
  private statusEl!: HTMLElement;
  private retryTimer?: number;        // 재시도 인터벌 id(설정 변경 시 재등록)
  private backfillTimer?: number;     // 1회성 백필 티커 id(백로그 소진 시 스스로 종료)
  private countdownTimer?: number;    // 봉인 대기 카운트다운(활성 노트가 dirty일 때만 1초 틱, 텍스트만 갱신)
  private authFailed = false;         // 401/403 → 키 교체 전까지 봉인 중단
  private backoffUntil = 0;           // 429 백오프 종료 시각(ms)
  private lastApiKey = "";            // 키 변경 감지(authFailed 리셋용)
  private pastDueNotified = false;    // past_due 알림 세션당 1회 가드
  entitlement: { tier: string; cert_credits: number; is_pro: boolean; status?: string } | null = null;
  // 해시별 verify 결과 캐시 + 노트 전환 디바운스 타이머(같은 해시 재조회/연타 전환 시 서버 호출 절감)
  private verifyCache = new Map<string, { result: any; ts: number }>();
  private statusDebounceTimer?: number;
  // 활성 노트가 '앵커 중'(anchored지만 ₿ 미확정)이면 true → 주기 재검증으로 확정 자동 반영.
  // 노트를 열어둔 채 앵커가 확정되면 상태바가 전환 없이도 따라오게 한다.
  private activeAnchorPending = false;
  private ledgerSweeping = false;     // 원장 sweep 중복 실행 방지
  // 참조 기반 첨부 판정: 범위 내 .md 노트가 임베드/링크하는 비-md 파일의 vault 경로 집합.
  // resolvedLinks(metadataCache) 스냅샷 — "resolved" 이벤트(디바운스) + 각 스윕 진입 시 재계산.
  private referencedAttachments = new Set<string>();
  private refSetTimer?: number;       // resolved 이벤트 디바운스(SETTLE_MS 트레일링 — 대량 인덱싱 중 과호출 방지)
  private largeUploadNotified = new Set<string>(); // 대형 파일 업로드 정보성 알림의 세션 내 1회 가드(경로 기준)
  // 청크 업로드 진행률(상태바 표시용) — nanalPutChunked가 세팅·해제. null이면 진행 중 아님.
  uploadProgress: { path: string; done: number; total: number } | null = null;
  // P1.5: git 연산 직렬화 락 — sweep과 활성노트가 동시에 아카이브를 만지면 repo가 손상될 수
  // 있으므로 모든 git(init/add/commit) 연산을 이 Promise 체인에 태워 겹치지 않게 한다.
  private archiveBusy: Promise<unknown> = Promise.resolve();

  private iconUrl = "";

  async onload() {
    await this.loadSettings();
    this.failed = new Set(this.settings.failedPaths); // 실패 큐 복원(재시작 후에도 재시도)
    this.lastApiKey = this.settings.apiKey;
    applyLang(this.settings); // 설정/감지에 맞춰 언어 적용(명령·UI 이름 등록 전에)
    // 로고는 icon.png(평면 이미지) — 필터 없이 어디서나 동일하게 표시. 교체 시 icon.png만 바꾸면 됨.
    try {
      const buf = await this.app.vault.adapter.readBinary(`${this.app.vault.configDir}/plugins/${this.manifest.id}/icon.png`);
      this.iconUrl = "data:image/png;base64," + arrayBufferToBase64(buf);
    } catch (e) { this.iconUrl = ""; }
    addIcon(ICON_ID, ICON_FALLBACK); // 탭·메뉴 아이콘(나날 도장 SVG)
    // 리본 클릭 → 액션 메뉴(항상 시각 피드백). 좌클릭 즉시 봉인 대신 메뉴로 기능 노출.
    const ribbonEl = this.addRibbonIcon(ICON_ID, "nanalStamp", (evt: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle(t.sealCmd).setIcon(ICON_ID).onClick(() => {
        const f = this.app.workspace.getActiveFile();
        if (f) this.flush(f, "manual");
        else new Notice(t.noNote);
      }));
      menu.addItem((i) => i.setTitle(t.proofCmd).setIcon("file-search").onClick(() => this.showProof()));
      menu.addItem((i) => i.setTitle(t.anchorCmd).setIcon("anchor").onClick(() => this.anchorNow()));
      // 보관·공유 그룹 — 팔레트 전용이던 명령들을 리본에서도(2026-07-15 사용자 요청).
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t.nanalRestoreCmd).setIcon("archive-restore").onClick(() => void this.restoreFromNanal()));
      menu.addItem((i) => i.setTitle(t.nanalProofExportCmd).setIcon("shield-check").onClick(() => void this.exportNanalProof()));
      menu.addItem((i) => i.setTitle(t.exportCmd).setIcon("download").onClick(() => this.exportProof()));
      menu.addItem((i) => i.setTitle(t.publicCmd).setIcon("link").onClick(() => this.makePublicLink()));
      menu.addItem((i) => i.setTitle(t.reviewReqCmd).setIcon("stamp").onClick(() => {
        const f = this.app.workspace.getActiveFile();
        if (f && this.isSealable(f) && this.settings.apiKey) void this.requestReview(f);
        else new Notice(t.noNote);
      }));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t.certCmd).setIcon("file-badge").onClick(() => this.issueCertificate()));
      menu.addItem((i) => i.setTitle(t.pitCmd).setIcon("history").onClick(() => this.pointInTimeCertificate()));
      menu.addItem((i) => i.setTitle(t.dashCmd).setIcon("layout-dashboard").onClick(() => void this.openDashboard()));
      menu.addItem((i) => i.setTitle(t.pricingCmd).setIcon("credit-card").onClick(() => this.openExternal("/pricing")));
      menu.addItem((i) => i.setTitle(t.accountCmd).setIcon("user").onClick(() => this.openExternal("/account")));
      menu.showAtMouseEvent(evt);
    });
    // 리본은 Obsidian이 아이콘을 단색으로 강제 렌더 → 컬러 SVG를 직접 주입해 브랜드 빨강 유지.
    ribbonEl.empty();
    ribbonEl.insertAdjacentHTML("afterbegin", `<img src="${this.iconUrl}" width="18" height="18" style="display:block" alt="nanalStamp">`);
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable"); // 호버 어포던스(Obsidian 상태바 클릭 스타일)
    this.registerDomEvent(this.statusEl, "click", () => this.showProof()); // 클릭 → 증명/이력 모달
    void this.updateActiveStatus();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isSealable(file)) this.onModify(file);
      })
    );
    // 참조 첨부 집합: 링크 인덱스가 갱신될 때마다(초기 인덱싱 완료 포함) 디바운스 재계산.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefRebuild()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
    // 파일 이동/삭제 시 states·failed 키를 이관/정리(무한 증식 방지)
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) void this.onRename(file, oldPath); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file instanceof TFile) void this.onDelete(file); }));
    this.activeFile = this.app.workspace.getActiveFile();
    // 포커스가 창 밖으로(다른 앱/클릭)·앱 비활성화 시 → 변경분 즉시 봉인(5분 무시)
    this.registerDomEvent(window, "blur", () => this.flushAllDirty());
    this.registerDomEvent(document, "visibilitychange", () => { if (document.hidden) this.flushAllDirty(); });
    // 앱 종료(X) 직전: 비동기 전송은 못 끝나므로 sendBeacon으로 확실히 보냄
    this.registerDomEvent(window, "beforeunload", () => this.beaconDirty());
    this.registerDomEvent(window, "pagehide", () => this.beaconDirty());

    // 전송 실패 큐 재시도(주기) — 설정 변경 시 재등록되도록 id 추적
    this.restartRetryInterval();
    // 자격(요금제·크레딧) 주기 갱신(1시간) — 결제/구독 변동 반영
    this.registerInterval(window.setInterval(() => void this.refreshEntitlement(), 60 * 60 * 1000));
    // '앵커 중' 활성 노트만 주기 재검증(10분) — 비트코인 확정이 나면 전환 없이 상태바가 따라온다.
    // 확정은 몇 시간짜리이고 서버 확정표시도 hourly 워커라, 서버 상태는 잘해야 1h에 한 번 바뀐다.
    // → 클라이언트를 자주 두드릴 이유가 없어 10분으로. verify 캐시 TTL(60s) < 주기라 자동 재조회됨.
    this.registerInterval(window.setInterval(() => {
      if (this.activeAnchorPending) void this.updateActiveStatus();
    }, 600_000));
    // P1: 증명 원장 sweep — 하루 1회(확정된 새 앵커를 로컬 원장/미러에 반영). 로드 직후 1회는 onLayoutReady에서.
    this.registerInterval(window.setInterval(() => void this.ledgerSweep(), 24 * 60 * 60 * 1000));

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
    this.addCommand({ id: "export-proof", name: t.exportCmd, callback: () => this.exportProof() });
    this.addCommand({
      id: "nanal-storage-restore",
      name: t.nanalRestoreCmd,
      callback: () => void this.restoreFromNanal(),
    });
    this.addCommand({ id: "nanal-proof-export", name: t.nanalProofExportCmd, callback: () => void this.exportNanalProof() });
    this.addCommand({ id: "issue-certificate", name: t.certCmd, callback: () => this.issueCertificate() });
    this.addCommand({ id: "point-in-time-cert", name: t.pitCmd, callback: () => this.pointInTimeCertificate() });
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
    this.addCommand({ id: "open-dashboard", name: t.dashCmd, callback: () => void this.openDashboard() });
    this.addCommand({ id: "create-monthly-digest", name: t.digestCmd, callback: () => void this.createMonthlyDigest() });

    this.addSettingTab(new NanalStampSettingTab(this.app, this));
    // 온보딩은 자동 팝업 대신 설정 화면 상단 소개 섹션으로 노출(팝업 제거).
    void this.refreshEntitlement();
    // 재시작 따라잡기: 워크스페이스 준비 후, 마지막 실행 이후 수정된 노트를 봉인(강제종료 복구)
    this.app.workspace.onLayoutReady(() => {
      void this.ensureArchive(); // P1.5: 아카이브 폴더 보장 + .git init(데스크탑만)
      // 3.2: 로드 시 키가 있고 자동 적용이 켜져 있으면 팀 프로파일 1회 수신(비동기·실패 무시).
      if (this.settings.teamProfileEnabled && this.settings.apiKey) void this.fetchTeamProfile();
      // 4.3: custody 미러 정보도 같은 타이밍에 1회 수신(팀 프로파일 토글과 무관 — custody는 별개 정책).
      if (this.settings.apiKey) void this.fetchTeamMirrorInfo();
      void this.catchUp();
      void this.ledgerSweep(); // P1: 로드 직후 1회 — 확정된 증명을 로컬 원장/미러에 반영
      this.startBackfill(); // 초기 백필: 기존 미봉인 노트를 백그라운드에서 천천히(3초 1건) 봉인
      // create 이벤트는 layout-ready 이후에 등록한다.
      // (Obsidian은 초기 vault 로드 시 기존 모든 파일에도 create를 발생시키므로,
      //  여기서 등록해야 "이후 새로 생기는 .md"(외부 AI·도구 포함)만 봉인 대상이 된다.)
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && this.isSealable(file)) this.onModify(file);
        })
      );
    });
  }

  onunload() {
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

  // M2: 폴더 범위 — include 비면 전체, exclude 우선
  private inScope(p: string): boolean {
    const inc = parseFolders(this.settings.includeFolders);
    const exc = parseFolders(this.settings.excludeFolders);
    const under = (folder: string) => p === folder || p.startsWith(folder + "/");
    if (exc.some(under)) return false;
    if (inc.length > 0) return inc.some(under);
    return true;
  }

  // 봉인 대상인가 — .md는 항상, 첨부는 범위 내 노트가 참조할 때만(형식 무관, 확장자 필터 없음).
  // 폴더 범위(inScope)와는 별개(첨부 자체의 경로가 아니라 "참조하는 노트"의 범위가 기준).
  private isSealable(file: TFile): boolean {
    return isSealableFile(file.extension, this.settings.sealAttachments, this.referencedAttachments.has(file.path));
  }

  // 참조 첨부 집합 재계산: resolvedLinks(해석 완료 링크 인덱스, 순수 메모리)를 순회해
  // "범위 내 .md 노트가 참조하는 비-md 경로"를 수집한다. 파일 I/O 없음 — 대형 vault(수만 링크)에서도 ms 단위.
  private rebuildReferencedSet() {
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
  private isBinary(file: TFile): boolean {
    return file.extension.toLowerCase() !== "md";
  }
  // 업로드(클라우드 보관) 유효 상한(MiB) — 쿼터가 유일한 비용 경계, 파일당은 팀 거버넌스와 서버 하드캡뿐.
  // 팀 정책(teamAttachmentMaxMB, 0=무제한)이 있으면 그것(단, 서버 하드캡 5GB를 넘을 순 없음), 없으면 5GB.
  // 봉인(해시)에는 상한이 없다 — 이 값은 원본 클라우드 보관에만 적용된다.
  uploadLimitMB(): number {
    const team = this.settings.teamAttachmentMaxMB;
    if (team != null && team > 0) return Math.min(team, UPLOAD_HARD_CAP_MB);
    return UPLOAD_HARD_CAP_MB; // 팀 상한 없음(null) 또는 0(무제한)이어도 서버 presign 하드캡은 존재
  }
  // 이 첨부가 클라우드 보관(업로드) 대상에서 제외되는가(.md는 상한 없음). 봉인 여부와는 무관.
  private overUploadLimit(file: TFile): boolean {
    return this.isBinary(file) && isOverSizeLimit(file.stat.size, this.uploadLimitMB());
  }
  // 업로드 스킵 사유가 팀 정책인가(안내 문구 분기) — 팀 상한이 하드캡보다 좁을 때만 팀 정책이 원인.
  uploadSkipByTeam(): boolean {
    const team = this.settings.teamAttachmentMaxMB;
    return team != null && team > 0 && team < UPLOAD_HARD_CAP_MB;
  }
  // 업로드 정책 스킵 기록: attachSkipped(설정탭 노출) + 최초 1회 Notice(사유: 팀 정책 vs 5GB 하드캡).
  // 봉인은 이미 유효하므로 문구도 "보관 제외"로만 말한다.
  private async noteUploadSkip(file: TFile): Promise<void> {
    if (this.settings.attachSkipped.includes(file.path)) return;
    this.settings.attachSkipped.push(file.path);
    await this.persist();
    new Notice(this.uploadSkipByTeam() ? t.uploadSkipTeam(file.name, this.uploadLimitMB()) : t.uploadSkipHardCap(file.name));
  }
  // 한도 이내로 돌아왔거나 정책이 완화됐으면 스킵 기록 해제(업로드 경로에서 게이트 통과 시 호출).
  private async clearUploadSkip(path: string): Promise<void> {
    if (!this.settings.attachSkipped.includes(path)) return;
    this.settings.attachSkipped = this.settings.attachSkipped.filter((p) => p !== path);
    await this.persist();
  }
  // 대형 파일(LARGE_UPLOAD_NOTICE_MB 이상) 업로드는 진행하되 1회 정보성 알림 — 쿼터 소모를 인지시킨다(차단 아님).
  private maybeNoticeLargeUpload(file: TFile): void {
    if (file.stat.size < LARGE_UPLOAD_NOTICE_MB * 1024 * 1024) return;
    if (this.largeUploadNotified.has(file.path)) return; // 세션 내 같은 파일 반복 알림 방지
    this.largeUploadNotified.add(file.path);
    const pct = this.lastUsage && this.lastUsage.quota > 0 ? Math.round((file.stat.size / this.lastUsage.quota) * 100) : null;
    new Notice(t.largeUploadNotice(file.name, fmtBytes(file.stat.size), pct));
  }
  // 청크 업로드 진행률 세팅+상태바 즉시 반영(1초 틱에 의존하지 않음 — 조각 완료마다 텍스트만 갱신, 서버 호출 없음).
  // null이면 진행 종료 → 정식 상태 갱신으로 복원.
  private setUploadProgress(p: { path: string; done: number; total: number } | null): void {
    this.uploadProgress = p;
    if (p) this.setStatus(t.uploadProgress(p.done, p.total), p.path, "faded");
    else void this.updateActiveStatus();
  }
  // 0.2: 봉인용 해시 — .md는 UTF-8 텍스트, 첨부는 원바이트. 봉인·검증·백필이 모두 이걸 써 커밋먼트가 일치한다.
  private async hashOf(file: TFile, cached = false): Promise<string> {
    if (this.isBinary(file)) {
      const buf = await this.app.vault.readBinary(file);
      return sha256HexBytes(buf);
    }
    const content = cached ? await this.app.vault.cachedRead(file) : await this.app.vault.read(file);
    return sha256Hex(content);
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
    if (!this.settings.enabled || !this.inScope(file.path)) return;
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

  // 노트를 떠나는 순간 → dirty면 무조건 봉인
  private onLeafChange() {
    const now = this.app.workspace.getActiveFile();
    const prev = this.activeFile;
    if (prev && (!now || now.path !== prev.path)) {
      const s = this.states.get(prev.path);
      if (s?.dirty) this.flush(prev, "leave");
    }
    this.activeFile = now;
    this.scheduleStatusUpdate(); // 빠른 연속 전환 시 마지막 것만 verify 조회
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
    this.retryTimer = window.setInterval(() => { this.retryFailed(); this.retrySealArchive(); this.sweepSeals(); }, RETRY_MS);
    this.registerInterval(this.retryTimer); // unload 시 정리 보장
  }

  // 재시작 따라잡기: 마지막 실행 이후 수정된 노트를 봉인(강제종료로 놓친 것 복구).
  // 서버가 같은 (user, file_hash)는 멱등 처리하므로 이미 봉인된 내용 재전송도 안전.
  private async catchUp() {
    if (!this.settings.enabled || !this.settings.apiKey) return;
    const since = this.settings.lastSeenMtime || 0;
    this.rebuildReferencedSet(); // 스윕 진입 시 최신화(디바운스 대기 중이어도 지금 상태로 판정)
    const files = this.app.vault.getFiles().filter((f) => this.isSealable(f));
    let maxMtime = since;
    let targets: TFile[] = [];
    for (const f of files) {
      if (f.stat.mtime > maxMtime) maxMtime = f.stat.mtime;
      // 첫 실행(since=0)이면 과거 전체를 봉인하지 않고 워터마크만 기록
      if (since > 0 && f.stat.mtime > since && this.inScope(f.path)) targets.push(f);
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
    if (n > 0) new Notice(t.catchupNotice(n));
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
        navigator.sendBeacon(url, payload); // 문자열=text/plain(simple request) → preflight 없이 전송 보장
        s.lastHash = hash;
      }
    } catch (e) {
      console.error("[nanalstamp] beacon error", e);
    }
  }

  // 작업 경계(창 blur·앱 비활성화): 변경된 노트 전부 즉시 봉인(throttle 무시)
  private flushAllDirty() {
    if (!this.settings.enabled) return;
    for (const [path, s] of this.states) {
      if (s.dirty) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile && this.inScope(path)) this.flush(f, "leave");
      }
    }
  }

  // 주기 검사: 5분 지났고 + 지금 안 치고 있는(idle) 변경 노트를 봉인.
  // (타이핑 중이면 s.timer가 살아있어 건너뜀 → "수정중이면 조금 뒤에")
  private sweepSeals() {
    if (!this.settings.enabled) return;
    const now = Date.now();
    for (const [path, s] of this.states) {
      if (s.dirty && !s.timer && now - s.dirtyAt >= MIN_INTERVAL_MS) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile && this.inScope(path)) this.flush(f, "settle");
      }
    }
  }

  // 실제 봉인(throttle 무시): 현재 내용 해시만 전송. dedup 포함.
  async flush(file: TFile, reason: string) {
    if (!this.settings.enabled || !this.inScope(file.path)) return;
    if (!this.settings.apiKey) return; // API 키 미설정 → 전송 안 함(상태바가 안내)
    if (this.authFailed) return;       // 키 거부됨 → 갱신 전까지 재시도 중단(무한루프 방지)
    const s = this.stateOf(file.path);
    if (s.timer) {
      window.clearTimeout(s.timer);
      s.timer = undefined;
    }
    // 봉인(해시)은 크기 무관 항상 — 해시는 비용 0이므로 크기 게이트 없음(원본 완전성).
    // 파일당 상한은 클라우드 보관(업로드) 경로에서만 적용된다(overUploadLimit — 팀 정책·5GB 하드캡).
    const interactive = reason !== "retry" && reason !== "catchup";
    try {
      const hash = await this.hashOf(file);
      if (hash === s.lastHash) {
        s.dirty = false;
        if (this.failed.delete(file.path)) void this.persistFailed();
        if (reason === "manual") new Notice(t.alreadySealed); // 수동 클릭엔 "이미 봉인됨"을 말해준다(조용한 no-op 방지)
        return;
      }
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/attest`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ hash, path: await hashPath(file.path), client_ts: new Date().toISOString() }),
        throw: false,
      });
      // 401/403: 키가 나쁘거나 만료 — 무한 재시도 중단하고 사용자에게 알림
      if (res.status === 401 || res.status === 403) {
        this.authFailed = true;
        if (this.failed.delete(file.path)) void this.persistFailed();
        void this.updateActiveStatus();
        new Notice(t.authFail);
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
      s.lastHash = hash;
      s.lastAttestAt = Date.now();
      s.dirty = false;
      s.dirtyAt = 0; // 대기 종료 — 다음 수정에서 5분 카운트가 새로 시작
      this.settings.sealedIndex[file.path] = hash; // 전송 성공 기록(확정 대기 표시·백필 중복 방지) — 아래 persist()로 저장
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
      void this.recordSealProof(file, hash, res.json.seq); // 봉인 시점 원문 아카이브·미러(비동기, 봉인 흐름 안 막음)
      if (interactive) new Notice(t.noticeSealed(file.basename, res.json.seq, t.reason[reason] ?? reason));
    } catch (e: any) {
      this.failed.add(file.path); // 재시도 큐
      void this.persistFailed();
      void this.updateActiveStatus();
      if (interactive) new Notice(t.noticeFail(file.basename, e?.message ?? String(e)));
      console.error("[nanalstamp] seal error", file.path, e);
    }
  }

  // M3: 체인 head를 비트코인(OTS)에 앵커
  private async anchorNow() {
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
  private async requestReview(file: TFile) {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    let hash: string;
    try { hash = await this.hashOf(file); } catch { return new Notice(t.reviewReqFail); }
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/review/request`,
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
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
        headers: { "x-nanal-api-key": this.settings.apiKey },
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
      await this.app.workspace.getLeaf(false).openFile(file as TFile);
      const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      if (ed) ed.setCursor(ed.lineCount(), 0);
    } catch (e: any) {
      new Notice(t.tplErr(e?.message ?? String(e)));
      console.error("[nanalstamp] newDevNote error", e);
    }
  }

  // 5.2: 경로가 digest 폴더 아래인가(미러 라우팅용). 설정이 비었으면 항상 false(라우팅 없음).
  private digestFolderPath(): string {
    return (this.settings.digestFolder || "").trim().replace(/^\/+|\/+$/g, "");
  }
  private isDigestPath(path: string): boolean {
    const df = this.digestFolderPath();
    return df !== "" && (path === df || path.startsWith(df + "/"));
  }

  // 5.2: 월간 digest 스캐폴드 — 직전 달(로컬)의 봉인 통계를 자동 삽입한 조직 공유용 정리본을 만든다.
  // 통계는 로컬 아카이브 원장(archiveLog)만 사용(서버 호출 없음). 서술은 사용자가 직접 작성한다.
  private async createMonthlyDigest() {
    try {
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1); // 직전 달 1일(로컬)
      const ym = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`;
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
      const stats = computeDigestStats(entries, ym, (ts) => fmtDate(new Date(ts)));
      file = await this.app.vault.create(fpath, t.digestScaffold(ym, stats));
      new Notice(t.digestCreated(fpath));
      if (!this.inScope(fpath)) new Notice(t.digestOutOfScope); // 봉인 범위 밖이면 경고만(자동 변경 안 함)
      await this.app.workspace.getLeaf(false).openFile(file as TFile);
      const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      if (ed) ed.setCursor(ed.lineCount(), 0);
    } catch (e: any) {
      new Notice(t.digestErr(e?.message ?? String(e)));
      console.error("[nanalstamp] createMonthlyDigest error", e);
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
  private async exportProof() {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    const f = this.app.workspace.getActiveFile();
    if (!f) return new Notice(t.noNote);
    try {
      const content = await this.app.vault.read(f);
      const hash = await sha256Hex(content);
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/attest/bundle?hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200 || !res.json?.found) {
        return new Notice(t.exportNone(f.basename));
      }
      const dir = f.parent && f.parent.path && f.parent.path !== "/" ? `${f.parent.path}/` : "";
      const path = `${dir}${f.basename}.nanalproof`;
      const body = JSON.stringify(res.json, null, 2);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modify(existing, body);
      else await this.app.vault.create(path, body);
      new Notice(t.exportOk(path));
    } catch (e: any) {
      new Notice(t.exportFail(e?.message ?? String(e)));
    }
  }

  // ── P1: 자동 증명 원장(로컬 vault) + P2: PRO GitHub 미러 ─────────────────────
  // tier 게이트: entitlement가 pro/team이면 미러 허용(편의 기능이라 클라 게이트로 충분).
  isPro(): boolean {
    const e = this.entitlement;
    return !!e && (e.is_pro || e.tier === "pro" || e.tier === "team");
  }

  // P2/4.3/C1: GitHub 미러가 동작하는 조건 — Pro이고, 고급 'GitHub 내보내기' 토글이 켜져 있거나 팀 custody가 활성.
  // 팀 custody는 조직이 관리하므로 멤버의 backend 선택과 무관하게 미러를 켠다(멤버 무설정 보장).
  mirrorActive(): boolean {
    // C1: GitHub 내보내기(고급 토글) 또는 팀 custody. nanal과 병행 가능(mirrorIndex/nanalIndex 분리).
    return this.isPro() && (this.settings.githubExport || !!this.settings.teamCustody);
  }

  // B/C1/C2: nanalStamp WORM 스토리지가 동작하는 조건. C1부터 githubExport와 병행 가능(택일 아님).
  // C2: 팀 custody가 nanal이면 멤버의 개인 storageBackend 선택과 무관하게 강제 활성(팀 설정이 우선).
  nanalActive(): boolean {
    return this.isPro() && (this.settings.storageBackend === "nanal" || this.settings.teamStorage === "nanal");
  }

  // C2: 팀 custody 스토리지가 nanal인지 — 스토리지 엔드포인트를 개인/팀 라우트 중 어디로 보낼지 결정.
  private teamNanal(): boolean { return this.settings.teamStorage === "nanal"; }

  // 봉인 시점(flush 성공 직후) 아카이브·미러. 확정 전이라 block=undefined(커밋 메시지 pending).
  // 원문 보존이 목적 — 확정 여부와 무관하게 그 순간 내용을 git에 박아 중간 봉인 버전이 유실되지 않게 한다.
  // 봉인 흐름을 막지 않도록 fire-and-forget(void)으로 호출된다. 실패는 삼킨다(봉인 자체는 성공 유지).
  // 일시 실패(bundle found:false·github 429·네트워크)면 sealArchiveRetry에 넣어 재시도 인터벌이 재포착한다
  // (봉인 순간이 그 버전 원문의 유일한 포착 지점이라 조용한 유실을 막는다).
  private async recordSealProof(file: TFile, hash: string, seq?: number): Promise<void> {
    if (!this.settings.autoLedger) return; // 자동 보존 off면 로컬 커밋·미러도 안 함(recordConfirmedProof·ledgerSweep과 일관)
    if (!this.settings.enabled || !this.settings.apiKey || this.authFailed) return;
    if (!this.inScope(file.path)) return;
    const archiveNeeded = this.archiveEnabled();
    const mirrorNeeded = this.mirrorActive();
    let nanalNeeded = this.nanalActive();
    // 업로드 게이트(파일당 상한은 팀 정책·5GB 하드캡뿐): 초과 파일은 클라우드 보관만 제외하고
    // nanalNeeded를 접는다 — 재시도 셋에 남아 30초마다 대용량 재읽기를 반복하지 않게(봉인·아카이브·미러는 그대로).
    if (nanalNeeded && this.overUploadLimit(file)) { void this.noteUploadSkip(file); nanalNeeded = false; }
    if (!archiveNeeded && !mirrorNeeded && !nanalNeeded) { this.sealArchiveRetry.delete(file.path); return; }
    // 이미 이 해시로 아카이브·미러·스토리지 완료면 스킵(내용 무변경 재봉인 이중 커밋 방지).
    const archived = this.settings.archiveIndex[file.path] === hash;
    const mirrored = this.settings.mirrorIndex[file.path] === hash;
    const nanaled = this.settings.nanalIndex[file.path] === hash;
    if ((!archiveNeeded || archived) && (!mirrorNeeded || mirrored) && (!nanalNeeded || nanaled)) { this.sealArchiveRetry.delete(file.path); return; }

    // C1: 쿼터 초과 backoff 중이고 나머지(아카이브·미러)는 이미 끝났다면 — bundle fetch·파일 읽기도
    // 낭비다. 경로만 재시도 셋에 남겨두고 backoff 만료 후 재포착("결제 전 재시도는 무의미"의 완결).
    if (Date.now() < this.storageQuotaBackoffUntil &&
        (!archiveNeeded || archived) && (!mirrorNeeded || mirrored)) {
      this.sealArchiveRetry.add(file.path); return;
    }

    // 미확정 번들: /attest/bundle 은 확정 전에도 segment(해시체인)+pubkey 반환(anchor 없음/pending).
    let body = "";
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/bundle?hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status !== 200 || !res.json?.found) { this.sealArchiveRetry.add(file.path); return; } // 서버가 아직 이 해시를 모름 → 재시도로 재포착
      body = JSON.stringify(res.json, null, 2);
      // seq 미전달(재시도 경로)이면 번들의 matched_seq로 복원 — 커밋 메시지 seq 품질 유지.
      if (seq == null && typeof res.json.matched_seq === "number") seq = res.json.matched_seq;
    } catch { this.sealArchiveRetry.add(file.path); return; } // 네트워크 실패 → 재시도

    // 원문/바이트 읽기(현재 파일). 비동기 사이에 파일이 또 바뀌었으면 이 봉인 해시와 불일치 →
    // 잘못된 내용을 seq에 붙이지 않도록 스킵(그 새 내용은 자기 자신의 봉인에서 아카이브된다).
    // 이 경우 원문은 이미 파일에서 사라져 재시도해도 못 잡으므로 셋에서 제거한다.
    let original: string | ArrayBuffer;
    try {
      if (this.isBinary(file)) {
        original = await this.app.vault.readBinary(file);
        if (await sha256HexBytes(original) !== hash) { this.sealArchiveRetry.delete(file.path); return; }
      } else {
        original = await this.app.vault.read(file);
        if (await sha256Hex(original) !== hash) { this.sealArchiveRetry.delete(file.path); return; }
      }
    } catch { this.sealArchiveRetry.add(file.path); return; } // read 실패(일시) → 재시도

    try {
      if (archiveNeeded && !archived) {
        await this.archiveVersion(safeName(file.path), file.path, original, body, seq, undefined);
        this.settings.archiveIndex[file.path] = hash;
      }
      if (mirrorNeeded && !mirrored) {
        if (await this.mirrorToGithub(file, body, seq, undefined, true, original)) {
          this.settings.mirrorIndex[file.path] = hash;
        }
      }
      if (nanalNeeded && !nanaled) {
        if (await this.mirrorToNanal(file, hash, body, true, original)) {
          this.settings.nanalIndex[file.path] = hash;
        }
      }
      await this.persist();
    } catch (e) { console.error("[nanalstamp] seal-time archive error", file.path, e); }

    // 아카이브·미러·스토리지가 이 해시로 모두 완료됐으면 재시도 셋에서 제거, 하나라도 미완(예: mirror 429)이면 재시도로 남긴다.
    const nowArchived = !archiveNeeded || this.settings.archiveIndex[file.path] === hash;
    const nowMirrored = !mirrorNeeded || this.settings.mirrorIndex[file.path] === hash;
    const nowNanaled = !nanalNeeded || this.settings.nanalIndex[file.path] === hash;
    if (nowArchived && nowMirrored && nowNanaled) this.sealArchiveRetry.delete(file.path);
    else this.sealArchiveRetry.add(file.path);
  }

  // 봉인 시점 아카이브·미러의 일시 실패 재시도(메모리만 — 재시작하면 catchUp/ledgerSweep이 현재 상태를 다시 커버).
  // 각 path의 현재 해시가 아직 sealedIndex와 같으면(그 봉인 유지 중) recordSealProof 재호출; 편집돼 달라졌으면
  // 그 중간 버전은 이미 새 봉인이 recordSealProof를 다시 부르므로 셋에서 제거.
  private retrySealArchive() {
    if (!this.settings.enabled || this.authFailed || this.sealArchiveRetry.size === 0) return;
    if (this.backoffUntil > Date.now()) return; // 429 백오프 존중
    for (const p of Array.from(this.sealArchiveRetry)) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) { this.sealArchiveRetry.delete(p); continue; }
      void (async () => {
        let hash: string;
        try { hash = await this.hashOf(f); } catch { return; }
        if (hash !== this.settings.sealedIndex[p]) { this.sealArchiveRetry.delete(p); return; } // 편집됨 → 새 봉인이 커버
        await this.recordSealProof(f, hash); // 성공/완료 시 recordSealProof가 셋에서 스스로 제거
      })();
    }
  }

  // 확정(비트코인 블록 존재)된 노트의 자기검증 번들을 로컬 원장에 저장하고,
  // Pro·미러 on이면 원본+증명을 GitHub에 push. 이미 같은 해시로 저장돼 있으면 아무 것도 안 함.
  // verify(옵션)를 주면 서버 재조회를 아낀다(확정 판정·seq·블록고에 사용).
  private async recordConfirmedProof(file: TFile, hash: string, verify?: any, silent = false): Promise<boolean> {
    if (!this.settings.autoLedger) return false;
    if (!this.settings.enabled || !this.settings.apiKey || this.authFailed) return false;
    if (!this.inScope(file.path)) return false;

    const mirrorNeeded = this.mirrorActive();
    const archiveNeeded = this.archiveEnabled();
    let nanalNeeded = this.nanalActive();
    // 업로드 게이트: 한도 초과 첨부는 스토리지만 제외(원장·아카이브·미러는 진행) — 사유는 attachSkipped에 기록.
    if (nanalNeeded && this.overUploadLimit(file)) { void this.noteUploadSkip(file); nanalNeeded = false; }
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
        headers: { "x-nanal-api-key": this.settings.apiKey },
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
      let original: string | ArrayBuffer | null = null;
      if ((archiveNeeded && !archived) || (mirrorNeeded && !mirrored) || (nanalNeeded && !nanaled)) {
        try { original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file); } catch { original = null; }
      }
      // P1.5: 로컬 git 아카이브(전 티어, 데스크탑만) — 원문+증명을 git 이력에 커밋. 실패는 삼킴(크래시 금지).
      if (archiveNeeded && !archived && original != null) {
        try {
          await this.archiveVersion(safeName(file.path), file.path, original, body, seq, block);
          this.settings.archiveIndex[file.path] = hash;
          changed = true;
        } catch (e) {
          console.error("[nanalstamp] archive commit error", file.path, e);
        }
      }
      // P2: PRO GitHub 미러(원본 + 증명) — 로컬과 별도 추적. 실패 시 인덱스 미갱신 → 다음 sweep 재시도.
      if (mirrorNeeded && !mirrored && original != null) {
        if (await this.mirrorToGithub(file, body, seq, block, silent, original)) {
          this.settings.mirrorIndex[file.path] = hash;
          changed = true;
        }
      }
      // B: nanal 스토리지 — 봉인 시점에 업로드가 안 된 경우(당시 실패·backend 후속 활성화)의 보충 경로.
      // 정상 수명주기에선 봉인 시점 업로드가 nanalIndex를 채워 이 분기는 스킵된다 — S3 proof는 pending 고정
      // (블록 확정은 온라인 이력으로 확인). S3에 pending proof가 이미 있을 수 있어 force로 새 버전을 쌓는다.
      if (nanalNeeded && !nanaled && original != null) {
        if (await this.mirrorToNanal(file, hash, body, silent, original)) {
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
    if (!this.settings.autoLedger || !this.settings.enabled || !this.settings.apiKey || this.authFailed) return;
    this.ledgerSweeping = true;
    try {
      this.rebuildReferencedSet(); // 스윕 진입 시 최신화 — 참조 기반 첨부 판정
      let done = 0, examined = 0;
      const mirrorNeeded = this.mirrorActive();
      const archiveNeeded = this.archiveEnabled();
      const nanalNeeded = this.nanalActive();
      for (const f of this.app.vault.getFiles()) {
        if (done >= LEDGER_SWEEP_BATCH || examined >= SWEEP_EXAMINE_CAP) break;
        if (!this.isSealable(f) || !this.inScope(f.path)) continue;
        // 업로드 게이트(파일 단위): 한도 초과 첨부는 스토리지만 제외 — 봉인·원장·아카이브·미러는 그대로 진행.
        // fNanal=false로 접어야 nanalIndex 미존재가 "미완"으로 읽혀 매 sweep 대용량 재해시를 반복하지 않는다.
        const fNanal = nanalNeeded && !this.overUploadLimit(f);
        if (nanalNeeded && !fNanal) void this.noteUploadSkip(f);
        // mtime 스킵: 이 파일 버전을 이미 '안정'(완료 or 미봉인)으로 판정했으면 read·hash·verify 생략.
        // → 대용량 vault에서 매 sweep마다 전체 재스캔·재검증하는 과부하를 없앤다.
        // 단, mtime-안정이어도 미러/아카이브가 아직 안 된 노트는 스킵하지 않는다(P1.5 등 신규 요구가
        // 추가되면 예전 mtime 마킹이 '완료'를 뜻하지 않으므로 — archiveIndex/mirrorIndex 존재로 판정).
        if (this.settings.ledgerMtime[f.path] === f.stat.mtime &&
            (!mirrorNeeded || this.settings.mirrorIndex[f.path] !== undefined) &&
            (!archiveNeeded || this.settings.archiveIndex[f.path] !== undefined) &&
            (!fNanal || this.settings.nanalIndex[f.path] !== undefined)) continue;
        examined++;
        let hash: string;
        try { hash = await this.hashOf(f); } catch { continue; }
        const fullyDone = this.settings.ledgerIndex[f.path] === hash &&
                          (!mirrorNeeded || this.settings.mirrorIndex[f.path] === hash) &&
                          (!archiveNeeded || this.settings.archiveIndex[f.path] === hash) &&
                          (!fNanal || this.settings.nanalIndex[f.path] === hash);
        if (fullyDone) { this.settings.ledgerMtime[f.path] = f.stat.mtime; continue; }
        const v = await this.cachedVerify(hash);
        if (!v?.found) { this.settings.ledgerMtime[f.path] = f.stat.mtime; continue; } // 미봉인 = 안정, 스킵 등록
        const block = v?.bitcoin?.block_height ?? v?.matches?.[0]?.bitcoin?.block_height;
        if (!block) continue; // 미확정(pending) = 다음 sweep 재검사(mtime 미기록)
        if (await this.recordConfirmedProof(f, hash, v, true)) done++; // 개별 알림 억제
        // 완전 완료(로컬+미러+아카이브+스토리지)면 mtime 등록해 스킵. 미완이면 미등록 → 다음 sweep 재시도.
        if (this.settings.ledgerIndex[f.path] === hash &&
            (!mirrorNeeded || this.settings.mirrorIndex[f.path] === hash) &&
            (!archiveNeeded || this.settings.archiveIndex[f.path] === hash) &&
            (!fNanal || this.settings.nanalIndex[f.path] === hash)) this.settings.ledgerMtime[f.path] = f.stat.mtime;
      }
      await this.persist(); // ledgerMtime 저장
      if (done > 0) new Notice(t.ledgerSweepDone(done)); // sweep당 요약 알림 1개
      // 아직 안 훑은 파일이 남았으면(검사 상한 도달) 30초 뒤 조용히 이어받아 가볍게 드레인. 다 훑으면 멈춤.
      if (examined >= SWEEP_EXAMINE_CAP) window.setTimeout(() => void this.ledgerSweep(), 30000);
    } catch (e) {
      console.error("[nanalstamp] ledger sweep error", e);
    } finally {
      this.ledgerSweeping = false;
    }
  }

  // vault 폴더 보장(중첩 경로 포함). 이미 있으면 무시. (ArchiveSourceView의 Excalidraw 사본 생성도 재사용)
  async ensureVaultFolder(folder: string) {
    const clean = folder.replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    let cur = "";
    for (const p of clean.split("/")) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur).catch(() => {});
      }
    }
  }

  // vault 파일 쓰기(있으면 덮어쓰기, 없으면 생성).
  private async writeVaultFile(path: string, body: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
  }

  // ── P1.5: 로컬 git 아카이브(전 티어 내용 보존, isomorphic-git) ────────────────
  // 데스크탑만. archivePath는 vault 밖 절대경로라 Node fs로 다룬다. 모든 git 연산은
  // archiveBusy 락에 태워 sweep·활성노트 동시 호출 시 repo 손상을 막는다.
  private archiveEnabled(): boolean {
    return this.settings.localArchive && Platform.isDesktopApp;
  }

  // git 연산 직렬화: 이전 작업이 끝난 뒤(성공/실패 무관) 다음 작업을 실행.
  private runArchive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.archiveBusy.then(fn, fn);
    this.archiveBusy = next.then(() => undefined, () => undefined);
    return next;
  }

  // 아카이브 폴더 보장 + .git 없으면 git init + README 최초 커밋. 로드 시 1회 호출.
  async ensureArchive(): Promise<void> {
    if (!this.archiveEnabled()) return;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return;
    await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(path.join(dir, ".git"))) return;
      await git.init({ fs, dir, defaultBranch: "main" });
      const readme =
        "# nanalStamp local archive\n\n" +
        "This is an automatic **local git archive** created by the nanalStamp Obsidian plugin.\n" +
        "Every time a note's Bitcoin anchor is confirmed, its exact original text and proof are\n" +
        "committed here — so past versions survive even after you edit the note.\n\n" +
        "- `notes/` — original note content (the exact bytes that were hashed).\n" +
        "- `proofs/` — one `.nanalproof` per note: a self-verifying bundle (signature, Merkle path, OpenTimestamps proof, Bitcoin block, public key).\n\n" +
        "## Restore a past version\n\n" +
        "`git log -- notes/<name>.md` then `git show <commit>:notes/<name>.md`.\n\n" +
        "## Verify (no nanalStamp servers required)\n\n" +
        "1. SHA-256 the file in `notes/` and compare it against the hash in the matching proof.\n" +
        "2. Verify the OpenTimestamps proof against Bitcoin: `ots verify` — or use the `np-verify` helper.\n\n" +
        "The trust anchor is Bitcoin, not nanalStamp. Even if nanalStamp disappears, these stand on their own.\n";
      fs.writeFileSync(path.join(dir, "README.md"), readme, "utf8");
      await git.add({ fs, dir, filepath: "README.md" });
      await git.commit({
        fs, dir,
        message: "nanalStamp: initialize local archive",
        author: { name: "nanalStamp", email: "archive@nanalstamp.local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
    });
  }

  // 확정된 한 버전을 아카이브에 커밋: notes/<safe>.md = content, proofs/<safe>.nanalproof = proofBody.
  // 내용 변경이 있을 때만 커밋(같은 내용이면 스킵). throw 가능 — 호출부에서 삼킨다.
  private async archiveVersion(safe: string, notePath: string, content: string | ArrayBuffer, proofBody: string, seq?: number, block?: number): Promise<void> {
    if (!this.archiveEnabled()) return;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return;
    await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      // .git이 없으면(사용자가 폴더 지웠거나 최초 호출 전) 먼저 초기화.
      if (!fs.existsSync(path.join(dir, ".git"))) {
        fs.mkdirSync(dir, { recursive: true });
        await git.init({ fs, dir, defaultBranch: "main" });
      }
      // .md는 notes/<safe>.md(텍스트), 첨부는 attachments/<safe>(원바이트, safe에 실제 확장자 포함).
      const isBin = typeof content !== "string";
      const contentRel = isBin ? `attachments/${safe}` : `notes/${safe}.md`;
      const proofRel = `proofs/${safe}.nanalproof`;
      fs.mkdirSync(path.join(dir, path.dirname(contentRel)), { recursive: true });
      fs.mkdirSync(path.join(dir, "proofs"), { recursive: true });
      if (isBin) fs.writeFileSync(path.join(dir, contentRel), new Uint8Array(content as ArrayBuffer));
      else fs.writeFileSync(path.join(dir, contentRel), content as string, "utf8");
      fs.writeFileSync(path.join(dir, proofRel), proofBody, "utf8");
      await git.add({ fs, dir, filepath: contentRel });
      await git.add({ fs, dir, filepath: proofRel });
      // 변경 없으면(같은 내용) 커밋 스킵 — 두 파일 모두 unmodified면 새 커밋 불필요.
      const s1 = await git.status({ fs, dir, filepath: contentRel });
      const s2 = await git.status({ fs, dir, filepath: proofRel });
      if (s1 === "unmodified" && s2 === "unmodified") return;
      await git.commit({
        fs, dir,
        message: buildArchiveMsg(notePath, seq, block), // block undefined → 봉인 시점(pending, ₿# 미포함)
        author: { name: "nanalStamp", email: "archive@nanalstamp.local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
    });
  }

  // 설정에서 아카이브 경로 변경 적용(+ 필요 시 이관). 렌더 밖(버튼 onClick)에서만 호출.
  // 기존 .git이 있고 새 경로가 비어 있으면 .git 포함 전체 복사로 이력을 옮긴다.
  async applyArchivePath(rawNew: string): Promise<{ status: "migrated" | "exists" | "set" | "error" | "same"; a?: string; b?: string }> {
    if (!Platform.isDesktopApp) return { status: "error" };
    const newPath = (rawNew || "").trim();
    if (!newPath) return { status: "error" };
    const oldPath = (this.settings.archivePath || "").trim();
    if (newPath === oldPath) return { status: "same" };
    try {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      const oldHasGit = !!oldPath && fs.existsSync(path.join(oldPath, ".git"));
      const newExists = fs.existsSync(newPath);
      const newHasArchive = newExists && fs.existsSync(path.join(newPath, ".git"));
      const newIsEmpty = !newExists || fs.readdirSync(newPath).length === 0;
      let status: "migrated" | "exists" | "set" = "set";
      if (oldHasGit && !newHasArchive && newIsEmpty) {
        // 이력 보존: 기존 폴더 전체(.git 포함)를 새 경로로 재귀 복사. 원본은 백업으로 남김.
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.cpSync(oldPath, newPath, { recursive: true });
        status = "migrated";
      } else if (newHasArchive) {
        status = "exists"; // 새 경로에 이미 아카이브 → 자동 복사 안 함(경고)
      }
      // 쓰기가능 검증: 폴더 생성 후 W_OK 확인.
      fs.mkdirSync(newPath, { recursive: true });
      try { fs.accessSync(newPath, fs.constants.W_OK); }
      catch { return { status: "error", b: newPath }; }
      this.settings.archivePath = newPath;
      await this.saveSettings();
      await this.ensureArchive(); // 새 경로가 비어 있으면 init + README
      return { status, a: oldPath, b: newPath };
    } catch (e) {
      console.error("[nanalstamp] archive path change error", e);
      return { status: "error", b: newPath };
    }
  }

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

  // 아카이브 전체 커밋 로그 → 확정 기록 목록. 커밋 메시지에 notePath가 있어 git.log 1회로
  // 전 노트 이력이 나온다(archiveVersions의 filepath log를 노트마다 도는 것보다 훨씬 싸다).
  async archiveLog(): Promise<ArchiveEntry[]> {
    if (!this.archiveEnabled()) return [];
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return [];
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return [];
      let commits: any[] = [];
      try { commits = await git.log({ fs, dir }); } catch { return []; }
      const out: ArchiveEntry[] = [];
      for (const c of commits) {
        // isomorphic-git timestamp는 초 → ms 변환
        const e = parseArchiveCommit(String(c.commit?.message || "").trim(), (c.commit?.author?.timestamp ?? 0) * 1000);
        if (e) out.push(e);
      }
      return out;
    });
  }

  // 대시보드 카드 6 → P6 버전 모달 재사용(활성 노트가 아니어도 열 수 있게).
  async openArchiveModalFor(file: TFile): Promise<void> {
    if (!this.dashboardArchiveOn()) { new Notice(t.pitNoArchive); return; }
    const safe = safeName(file.path);
    // .md는 notes/<safe>.md → 검증·증명서 내보내기까지 되는 ArchiveVersionModal.
    // 첨부는 attachments/<safe>에 원바이트로 커밋돼 있으므로 버전 목록 → 미리보기/저장 모달로 연결.
    if (isMarkdownPath(file.path)) {
      const versions = await this.archiveVersions(safe);
      if (!versions.length) { new Notice(t.pitNoHistory(file.basename)); return; }
      new ArchiveVersionModal(this.app, this, file, safe, versions).open();
    } else {
      const rel = `attachments/${safe}`;
      const versions = await this.archiveVersionsOf(rel);
      if (!versions.length) { new Notice(t.pitNoHistory(file.basename)); return; }
      new AttachmentVersionModal(this.app, this, file, safe, rel, versions).open();
    }
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
    this.app.workspace.revealLeaf(leaf);
  }

  async openDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      if (existing[0].view instanceof DashboardView) void existing[0].view.render();
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  dashboardArchiveOn(): boolean { return this.archiveEnabled(); }

  dashInScope(p: string): boolean { return this.inScope(p); }

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
    if (!this.settings.autoBackfill) { this.stopBackfill(); return; } // 기능 꺼짐 → 종료(켜면 startBackfill로 재시작)
    if (!this.settings.enabled || !this.settings.apiKey) return;      // 준비 안 됨 → 대기(스캔 없이 즉시 반환)
    if (this.authFailed || Date.now() < this.backoffUntil) return;    // 일시 장애 → 대기
    this.rebuildReferencedSet(); // 스윕 진입 시 최신화(3초 틱이지만 순수 메모리 순회 — 파일 스캔 대비 미미)
    for (const f of this.app.vault.getFiles()) {
      if (!this.isSealable(f) || !this.inScope(f.path)) continue;
      // 편집 파이프라인이 소유한 노트는 백로그가 아니다 — 백필이 가로채면 5분 합치기가 무력화된다.
      const st = this.states.get(f.path);
      if (st?.dirty || st?.timer) continue;
      // 전송 실패 큐 소유분은 retryFailed(백오프 존중)가 처리 — 백필이 3초마다 재타격하지 않는다.
      if (this.failed.has(f.path)) continue;
      const h = await this.currentHashCached(f);
      if (!h) continue;
      if (this.settings.ledgerIndex[f.path] === h) continue; // 확정 완료
      if (this.settings.sealedIndex[f.path] === h) continue; // 전송됨(확정 대기)
      await this.flush(f, "catchup"); // 조용히 1건만 — 다음 후보는 다음 틱에
      return;
    }
    this.stopBackfill(); // 한 바퀴 돌아 할 일 없음 = 백로그 소진 → 다음 (재)활성화까지 다시 돌지 않는다
  }

  // ── P6: 특정 시점 증명서 — 아카이브의 그 버전을 git으로 읽어 오프라인 검증 ────────
  // 현재 파일은 절대 건드리지 않는다(readBlob = 읽기 전용). 모든 git 접근은 archive 락에 태운다.

  // 이 노트가 아카이브에 남긴 확정 버전들(최신 → 과거). 커밋 메시지에서 seq·블록을 파싱해 표시용으로 곁들인다.
  async archiveVersions(safe: string): Promise<Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>> {
    return this.archiveVersionsOf(`notes/${safe}.md`);
  }

  // archiveVersions의 일반형: 임의의 아카이브 상대경로(notes/<safe>.md 또는 attachments/<safe>)의 커밋 이력.
  // 첨부(attachments/)도 동일 파이프라인으로 버전 목록을 얻기 위해 filepath를 매개변수화한다.
  async archiveVersionsOf(rel: string): Promise<Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>> {
    if (!this.archiveEnabled()) return [];
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return [];
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return [];
      let commits: any[] = [];
      try { commits = await git.log({ fs, dir, filepath: rel }); }
      catch { return []; } // 이 파일이 아카이브에 없으면 log가 throw → 버전 없음
      return commits.map((c) => {
        const p = parseArchiveMsg(String(c.commit?.message || ""));
        return {
          oid: String(c.oid),
          ts: c.commit?.author?.timestamp ?? 0,
          tzo: c.commit?.author?.timezoneOffset ?? 0,
          seq: p?.seq ?? "?",
          block: p?.block ?? "?", // 봉인 시점(미확정) 커밋은 block null → "?" (표시에서 pending 취급)
        };
      });
    });
  }

  // 특정 커밋 시점의 파일 내용을 읽는다(현재 워킹트리 불변). 없으면 null.
  private async archiveReadBlob(oid: string, rel: string): Promise<string | null> {
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return null;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel });
        return new TextDecoder("utf-8").decode(blob);
      } catch { return null; }
    });
  }

  // archiveReadBlob의 바이너리 변형: 원바이트(Uint8Array)를 그대로 반환(첨부 미리보기/저장용). 없으면 null.
  async archiveReadBytes(oid: string, rel: string): Promise<Uint8Array | null> {
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return null;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel });
        return blob as Uint8Array;
      } catch { return null; }
    });
  }

  // 한 버전의 원문 + 증명을 아카이브에서 읽어온다. 둘 중 하나라도 없으면 null.
  async readArchivedVersion(oid: string, safe: string): Promise<{ note: string; proofRaw: string; proof: any } | null> {
    const note = await this.archiveReadBlob(oid, `notes/${safe}.md`);
    const proofRaw = await this.archiveReadBlob(oid, `proofs/${safe}.nanalproof`);
    if (note == null || proofRaw == null) return null;
    let proof: any = null;
    try { proof = JSON.parse(proofRaw); } catch { /* 손상된 proof여도 note 해시 표시는 가능 */ }
    return { note, proofRaw, proof };
  }

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

  // 커맨드 엔트리: 현재 노트의 아카이브 버전 목록을 띄운다.
  private async pointInTimeCertificate() {
    if (!Platform.isDesktopApp) return new Notice(t.pitDesktopOnly);
    const f = this.app.workspace.getActiveFile();
    if (!f) return new Notice(t.noNote);
    return this.openArchiveModalFor(f);
  }

  // B: 봉인된 버전의 원문+proof를 nanalStamp WORM 스토리지(S3 Object Lock)에 업로드.
  // 키는 서버가 만든다: u/<uid>/sha256-<원문해시>.<ext|proof> — proof도 '원문 해시' 키라 조회가 해시 하나로 끝난다.
  // presign에 x-amz-checksum-sha256이 서명돼 내용≠해시 업로드는 S3가 거부. 업로드는 플러그인↔S3 직접(서버는 내용 안 봄).
  // 확정 proof는 내용이 갱신되므로 force 재업로드(버저닝 버킷 → 새 버전, append-only 유지).
  // 부분 실패 시 false → nanalIndex 미갱신 → sealArchiveRetry/sweep이 재시도.
  private async mirrorToNanal(file: TFile, hash: string, proofBody: string, silent = false, original?: string | ArrayBuffer): Promise<boolean> {
    if (!this.nanalActive()) return false;
    // 업로드 게이트(최종 방어선): 팀 정책 또는 서버 하드캡(5GB — 초과 presign은 400) 초과면 선차단·스킵 기록.
    // 봉인(해시 증명)은 이미 유효 — 여기서 걸려도 원본 클라우드 보관만 빠진다(attachSkipped로 노출).
    if (this.overUploadLimit(file)) { void this.noteUploadSkip(file); return false; }
    void this.clearUploadSkip(file.path); // 한도 이내(파일 축소·정책 완화 포함) — 과거 스킵 기록 해제
    this.maybeNoticeLargeUpload(file);    // 대형 파일 정보성 안내(차단 아님, 세션당 1회)
    if (this.nanalUploading.has(file.path)) return false; // 업로드 진행 중 — 재시도가 재포착
    this.nanalUploading.add(file.path);
    try {
      if (original == null) original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
      const ext = this.isBinary(file) ? blobExt(file.path) : "md";
      const origBytes = typeof original === "string" ? new TextEncoder().encode(original) : new Uint8Array(original);
      // Phase D 계약 가드: 암호화 키·nonce가 hash에서 파생되므로 내용≠hash 업로드는 GCM 붕괴.
      // 과거엔 S3 평문 checksum이 이를 거부했지만 이제 checksum은 암호문 해시라 여기서 직접 막는다.
      // (재읽기 경로에서 봉인 후 파일이 바뀐 레이스 — false 반환이면 기존 재시도가 재봉인분을 재포착.)
      if ((await sha256HexBytes(origBytes)) !== hash) return false;
      // v2a: 대형 원본(>512KB)은 CDC 조각+manifest — 변경분만 업로드·과금. 이하는 단일 객체.
      // Phase D: 원문은 항상 암호화 업로드(NSE1). DEK 조회 실패·410(파기)이면 업로드 중단 —
      // 평문 폴백 금지(크립토-슈레딩 보장). 암호문이므로 content-type은 octet-stream.
      // 키·게이트는 평문 해시(hash) 그대로 — 수렴 암호화라 dedup·exists도 평문 해시로 정합.
      let okOriginal = false;
      let dekMissing = false; // Phase D: 실패 사유 구분 — DEK 부재는 "upload 실패(재시도)"와 다른 안내가 필요
      if (origBytes.byteLength > CHUNK_THRESHOLD) {
        okOriginal = await this.nanalPutChunked(hash, ext, origBytes, file.path);
      } else {
        const dek = await this.nanalDek(this.teamNanal());
        if (dek) {
          const encBody = await encryptBlob(dek, hash, "blob", origBytes); // 계약: hash === sha256(origBytes)
          const encHash = await sha256HexBytes(encBody);
          okOriginal = await this.nanalPutBlob(hash, hash, ext, "application/octet-stream", encBody.buffer as ArrayBuffer, false, encHash);
        } else dekMissing = true;
      }
      if (!okOriginal) {
        // 402 backoff가 원인이면 nanalQuotaFull Notice가 이미 떴다 — "재시도 예정" 오해 문구 중복 방지
        // backoff 중 수동(비-silent) 동작은 무피드백 대신 쿼터 안내 — "재시도 예정" 오해 문구만 회피
        // Phase D: DEK 부재는 사유를 드러낸다 — 특히 410(파기)은 종결 상태라 "재시도합니다"로 오도하지 않는다.
        if (!silent) {
          const dekGone = this.dekDeny.get(this.teamNanal() ? "team" : "user")?.gone === true;
          if (dekMissing) new Notice(dekGone ? t.nanalDekGone : t.nanalMirrorFail("storage key"));
          else new Notice(Date.now() < this.storageQuotaBackoffUntil ? t.nanalQuotaFull : t.nanalMirrorFail("upload"));
        }
        return false;
      }
      // v2b: nanal 저장용 proof는 청크 참조 v2 — 체인 구간 중복을 .chain 청크가 대신한다.
      // 구서버는 v 파라미터를 무시하고 v1을 반환 — 그대로 업로드(우아한 강등).
      let nanalProofBody = proofBody;
      try {
        const v2 = await requestUrl({
          url: `${this.base()}/attest/bundle?hash=${hash}&v=2`, method: "GET",
          headers: { "x-nanal-api-key": this.settings.apiKey }, throw: false,
        });
        if (v2.status === 200 && v2.json?.found) nanalProofBody = JSON.stringify(v2.json, null, 2);
      } catch { /* v1 폴백 */ }
      const proofHash = await sha256Hex(nanalProofBody);
      if (!(await this.nanalPutBlob(hash, proofHash, PROOF_EXT, "application/json", nanalProofBody, true))) {
        if (!silent) new Notice(Date.now() < this.storageQuotaBackoffUntil ? t.nanalQuotaFull : t.nanalMirrorFail("proof upload"));
        return false;
      }
      if (!silent) new Notice(t.nanalMirrorOk);
      return true;
    } catch (e: any) {
      console.error("[nanalstamp] nanal storage error", file.path, e);
      if (!silent) new Notice(t.nanalMirrorFail(e?.message ?? String(e)));
      return false;
    } finally {
      this.nanalUploading.delete(file.path);
    }
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
  async openNanalView(notePath: string, hash: string, isMd: boolean): Promise<void> {
    const state: ArchiveSourceState = {
      oid: `nanal:${hash}`,
      rel: isMd ? "md" : blobExt(notePath),
      safe: safeName(notePath),
      isMd,
      notePath,
      seq: "?",
      block: "?",
      ts: 0,
    };
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: ARCHIVE_SOURCE_VIEW_TYPE, active: true, state: state as unknown as Record<string, unknown> });
    this.app.workspace.revealLeaf(leaf);
  }

  // B: blob 존재 일괄 확인(/storage/exists) — 증빙 모달이 '실제 저장된 곳만' 버튼을 노출할 때 쓴다.
  // 실패·미지원 서버는 null(버튼 생략 — 잡음 금지).
  async nanalExists(items: Array<{ sha256: string; ext: string }>): Promise<boolean[] | null> {
    if (!this.settings.apiKey || items.length === 0) return null;
    try {
      const res = await requestUrl({
        url: storageEndpoint(this.base(), this.teamNanal(), "exists"),
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ items }),
        throw: false,
      });
      if (res.status !== 200 || !Array.isArray(res.json?.exists)) return null;
      return res.json.exists.map((x: any) => x === true);
    } catch { return null; }
  }

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
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status === 200 && typeof res.json?.used_bytes === "number") {
        // C2: 팀 모드 응답은 pool_bytes(팀 풀 쿼터), 개인은 quota_bytes — 라벨은 그대로, 값만 팀 풀로.
        this.lastUsage = { used: res.json.used_bytes, quota: res.json.pool_bytes ?? res.json.quota_bytes ?? 0 };
      }
    } catch { /* 캐시 유지 */ }
  }

  // C1: 설정탭이 최근 60초 내 조회가 없을 때만 재조회하도록(실패 루프 방지).
  usageStale(): boolean {
    return Date.now() - this.usageFetchedAt > 60_000;
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

  // C2 폴백 읽기 래퍼: geturl(팀/개인 라우트) → presigned GET. 팀 모드에서 404(라우트 404 또는 S3 404)면
  // 개인 라우트(/storage/geturl)로 1회 재시도 — 팀 전환 전 개인 네임스페이스(u/)에 저장된 기존 blob의
  // 열람을 보장한다(전환 갭 — "자기 데이터 회수 보장" 원칙, 2026-07-15 결정). 모든 읽기(nanalFetch 단일·
  // manifest 재조립·proof/chain)가 이 래퍼를 지난다. 쓰기·exists는 폴백 없음(쓰기는 팀 단독 저장 결정 유지,
  // exists는 HEAD 2배 비용이라 생략 — 열람 버튼 미노출은 수용).
  // Phase D: 본문은 항상 바이트로 받고, NSE1 프레임이면 '실제로 서빙한 라우트'(팀 폴백 결과)의 DEK로 복호해
  // 평문 바이트를 돌려준다 — 호출부의 기존 평문 해시 검증·재조립은 무변경. plainHash는 이 blob의 키인 sha256
  // 인자 그대로(단일·조각·manifest 모두 그 해시로 암호화됐다), 도메인은 ext로 구분.
  // encHash(암호화 manifest의 chash)가 있으면 복호 전에 암호문 해시를 대조해 조기 검증한다.
  // 복호 실패는 '우연히 NSE1로 시작하는 구 평문'일 수 있으므로 원본 바이트로 폴백 — 최종 게이트는 호출부의
  // 평문 해시 대조. DEK 조회 실패(410 파기 등)는 throw → 호출부 catch가 nanalRestoreFail로 표면화.
  private async nanalGetObject(sha256: string, ext: string, encHash?: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number }> {
    const attempt = async (team: boolean): Promise<{ ok: true; dl: RequestUrlResponse; team: boolean } | { ok: false; status: number }> => {
      const res = await requestUrl({
        url: storageEndpoint(this.base(), team, "geturl"), method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
        body: JSON.stringify({ sha256, ext }), throw: false,
      });
      if (res.status !== 200) return { ok: false, status: res.status };
      const dl = await requestUrl({ url: res.json.url, method: "GET", throw: false });
      if (dl.status !== 200) return { ok: false, status: dl.status };
      return { ok: true, dl, team };
    };
    let got = await attempt(this.teamNanal());
    if (!got.ok && got.status === 404 && this.teamNanal()) got = await attempt(false);
    if (!got.ok) return got;
    let bytes: Uint8Array = new Uint8Array(got.dl.arrayBuffer);
    if (isEncrypted(bytes)) {
      if (encHash && (await sha256HexBytes(bytes)) !== encHash) throw new Error("hash");
      const dek = await this.nanalDek(got.team);
      if (!dek) throw new Error("storage key unavailable");
      try {
        bytes = await decryptBlob(dek, sha256, ext === "manifest" ? "manifest" : "blob", bytes);
      } catch { /* 구 평문이 우연히 NSE1로 시작한 경우 — 원본 바이트 유지, 평문 해시 검증이 판정 */ }
    }
    return { ok: true, bytes };
  }

  // B: 스토리지 blob 다운로드 + sha256 재검증(스토리지가 오염됐어도 해시 불일치로 감지 — 신뢰 앵커는 해시).
  // 실패는 사용자에게 보여줄 i18n 문자열로 반환(404 = 봉인됐지만 아직 업로드 안 된 버전).
  async nanalFetch(hash: string, ext: string, isMd: boolean): Promise<{ data: string | ArrayBuffer } | { error: string }> {
    if (!this.settings.apiKey) return { error: t.apiKeyMissing };
    try {
      const got = await this.nanalGetObject(hash, ext);
      if (!got.ok) {
        if (got.status === 404) return await this.nanalFetchChunked(hash, isMd); // v2a: 대형 원본은 manifest로 저장됨
        return { error: t.nanalRestoreFail(String(got.status)) };
      }
      // Phase D: 복호(또는 평문 통과)된 바이트의 해시가 봉인 해시와 일치해야 한다 — 신뢰 앵커는 해시.
      if ((await sha256HexBytes(got.bytes)) !== hash) return { error: t.nanalRestoreBadHash };
      if (isMd) return { data: new TextDecoder().decode(got.bytes) };
      return { data: got.bytes.buffer.slice(got.bytes.byteOffset, got.bytes.byteOffset + got.bytes.byteLength) as ArrayBuffer };
    } catch (e: any) {
      return { error: t.nanalRestoreFail(e?.message ?? String(e)) };
    }
  }

  // v2a: manifest 재조립 복원 — 조각별 해시 검증 + 전체 해시 == 봉인 해시 재검증(뷰의 기존 원칙).
  private async nanalFetchChunked(hash: string, isMd: boolean): Promise<{ data: string | ArrayBuffer } | { error: string }> {
    try {
      const got = await this.nanalGetObject(hash, "manifest"); // C2: 개인 네임스페이스 폴백 포함
      if (!got.ok) return got.status === 404 ? { error: t.nanalRestoreNone } : { error: t.nanalRestoreFail(String(got.status)) };
      const m = parseManifest(new TextDecoder().decode(got.bytes));
      if (!m) return { error: t.nanalRestoreBadHash };
      // 할당 전 합계 검증 — 손상된 manifest의 거대 total_size가 먼저 할당을 시도하지 않도록.
      const offsets: number[] = [];
      let acc = 0;
      for (const c of m.chunks) { offsets.push(acc); acc += c.size; }
      if (acc !== m.totalSize) return { error: t.nanalRestoreBadHash };
      // 손상·악성 manifest의 거대 할당 조기 차단(자기 버킷 한정이지만 fail-fast)
      if (m.totalSize > 1024 * 1024 * 1024) return { error: t.nanalRestoreBadHash };
      const out = new Uint8Array(m.totalSize);
      // 5개 단위 병렬 다운로드(순서는 오프셋으로 보존)
      for (let i = 0; i < m.chunks.length; i += 5) {
        const batch = m.chunks.slice(i, i + 5).map(async (c, j) => {
          // Phase D: enc manifest면 chash로 다운로드 암호문을 복호 전에 조기 검증(래퍼 내부) — 최종은 평문 해시.
          const cg = await this.nanalGetObject(c.hash, "chunk", m.enc ? c.chash : undefined); // C2: 개인 네임스페이스 폴백 포함
          if (!cg.ok) throw new Error(String(cg.status));
          if (cg.bytes.byteLength !== c.size || (await sha256HexBytes(cg.bytes)) !== c.hash) throw new Error("hash");
          out.set(cg.bytes, offsets[i + j]);
        });
        try { await Promise.all(batch); }
        catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return msg === "hash" ? { error: t.nanalRestoreBadHash } : { error: t.nanalRestoreFail(msg) };
        }
      }
      if (isMd) {
        const text = new TextDecoder().decode(out);
        if ((await sha256Hex(text)) !== hash) return { error: t.nanalRestoreBadHash };
        return { data: text };
      }
      const full = out.buffer as ArrayBuffer;
      if ((await sha256HexBytes(full)) !== hash) return { error: t.nanalRestoreBadHash };
      return { data: full };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: t.nanalRestoreFail(msg) };
    }
  }

  // v2b: nanal 오브젝트 텍스트 다운로드(geturl → GET). proof/chain 전용 경량 헬퍼.
  private async nanalDownloadText(sha256: string, ext: string): Promise<{ text: string } | { error: string }> {
    try {
      const got = await this.nanalGetObject(sha256, ext); // C2: 개인 네임스페이스 폴백 포함
      if (!got.ok) return got.status === 404 ? { error: t.nanalRestoreNone } : { error: t.nanalRestoreFail(String(got.status)) };
      return { text: new TextDecoder().decode(got.bytes) }; // proof/chain은 비암호화(검증 표면) — 래퍼는 평문 통과
    } catch (e: unknown) {
      return { error: t.nanalRestoreFail(e instanceof Error ? e.message : String(e)) };
    }
  }

  // v2b: nanal 보관 proof를 자기완결 v1로 재조립 — np-verify에 그대로 넣을 수 있는 형태.
  // v1이 저장돼 있으면 그대로 반환. v2면 chain_refs의 .chain 청크를 받아(해시 검증) segment를 복원.
  private async nanalProofAsV1(hash: string): Promise<{ data: string } | { error: string }> {
    const got = await this.nanalDownloadText(hash, PROOF_EXT);
    if ("error" in got) return got;
    let proof: any;
    try { proof = JSON.parse(got.text); } catch { return { error: t.nanalRestoreBadHash }; }
    if (proof?.version !== 2) return { data: got.text }; // v1 — 이미 자기완결
    const entries: any[] = [];
    for (const ref of proof.chain_refs ?? []) {
      const c = await this.nanalDownloadText(String(ref.sha256), "chain");
      if ("error" in c) return c;
      if ((await sha256Hex(c.text)) !== String(ref.sha256)) return { error: t.nanalRestoreBadHash };
      try { entries.push(...JSON.parse(c.text)); } catch { return { error: t.nanalRestoreBadHash }; }
    }
    entries.push(...(proof.tail ?? []));
    const headSeq: number = typeof proof.anchor?.head_seq === "number" ? proof.anchor.head_seq : Number.MAX_SAFE_INTEGER;
    const matched: number = typeof proof.matched_seq === "number" ? proof.matched_seq : 0;
    const segment = entries
      .filter((e) => typeof e?.seq === "number" && e.seq >= matched && e.seq <= headSeq)
      .sort((a, b) => a.seq - b.seq);
    const v1 = {
      version: 1, found: true, issuer: proof.issuer ?? "nanalStamp",
      file_hash: proof.file_hash, matched_seq: proof.matched_seq, matched_path: proof.matched_path,
      segment, anchor: proof.anchor ?? null, reviews: proof.reviews ?? [], pubkey_b64: proof.pubkey_b64,
    };
    return { data: JSON.stringify(v1, null, 2) };
  }

  // v2b: 명령 — 활성 노트의 nanal 보관 proof를 v1로 내보내기(vault에 파일 생성).
  private async exportNanalProof(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice(t.noNote); return; }
    if (!this.settings.apiKey) { new Notice(t.apiKeyMissing); return; }
    const hash = this.settings.nanalIndex[file.path] ?? this.settings.sealedIndex[file.path];
    if (!hash) { new Notice(t.nanalRestoreNone); return; }
    const got = await this.nanalProofAsV1(hash);
    if ("error" in got) { new Notice(got.error); return; }
    const folder = this.settings.ledgerFolder.replace(/^\/+|\/+$/g, "") || "nanalStamp/proofs";
    const rel = `${folder}/${safeName(file.path)}.nanal.nanalproof`;
    await this.ensureVaultFolder(folder);
    await this.writeVaultFile(rel, got.data);
    new Notice(t.nanalProofExportOk(rel));
  }

  /** Phase D: DEK 조회(세션 캐시 — 디스크 비저장). 실패·410(파기됨) 시 null —
   * 호출부는 업로드를 중단한다(평문 폴백 금지: DEK 없는 채 평문을 올리면 크립토-슈레딩이 무력화된다).
   * 402 쿼터 backoff와 대칭인 실패 처리: 410(파기 — 종결 상태)은 1시간 네거티브 캐시 + 세션당 1회 Notice,
   * 일시 실패(네트워크·5xx)는 60초 네거티브 캐시(한 sweep의 파일별 중복 GET 방지). 성공은 기존대로 영구 캐시.
   * 콜드 캐시 병렬 호출(조각 복원 5개 배치 등)은 in-flight Promise 공유로 GET 1회. */
  private nanalDek(team: boolean): Promise<string | null> {
    const k = team ? "team" : "user";
    const deny = this.dekDeny.get(k);
    if (deny && Date.now() < deny.until) return Promise.resolve(null);
    const hit = this.dekCache.get(k);
    if (hit) return hit;
    const p = this.fetchDek(k, team);
    this.dekCache.set(k, p);
    return p;
  }

  private async fetchDek(k: string, team: boolean): Promise<string | null> {
    let status = 0;
    try {
      const r = await requestUrl({
        url: storageEndpoint(this.base(), team, "key"),
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
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

  // presign → (exists면 스킵) → presigned URL로 S3 직접 PUT.
  // sealedHash=게이트·키용 원문 해시, blobHash=업로드 본문 자체 해시(원문이면 동일).
  // C1: size가 Content-Length로 서명되므로 body 크기와 정확히 일치해야 한다.
  // 402(쿼터 초과)는 1시간 backoff — 결제 전 재시도는 무의미(업그레이드 후 sweep이 재포착).
  // Phase D: encSha256이 있으면 body는 암호문 — S3 checksum만 암호문 해시로 서명하고
  // 키·게이트·exists(sha256/blob_sha256)는 평문 해시를 유지한다(콘텐츠주소·dedup 불변).
  // 일시 오류만 500ms 후 1회 즉시 재시도: 네트워크 예외(throw)·5xx. 4xx는 재시도 무의미(402 backoff·검증 오류)라 그대로 반환.
  // 재시도도 실패하면 null(예외) 또는 그 응답을 돌려주고, 상위의 기존 30초 스윕·재시도 경로가 재포착한다(여기서 루프 금지).
  private async requestWithOneRetry(req: () => Promise<RequestUrlResponse>): Promise<RequestUrlResponse | null> {
    const attempt = async (): Promise<RequestUrlResponse | null> => {
      try { return await req(); } catch { return null; }
    };
    let res = await attempt();
    if (res && res.status < 500) return res;
    await new Promise((r) => window.setTimeout(r, 500));
    return (await attempt()) ?? res;
  }

  private async nanalPutBlob(sealedHash: string, blobHash: string, ext: string, contentType: string, body: string | ArrayBuffer, force: boolean, encSha256?: string): Promise<boolean> {
    if (Date.now() < this.storageQuotaBackoffUntil) return false;
    const size = bodyByteSize(body);
    const pre = await this.requestWithOneRetry(() => requestUrl({
      url: storageEndpoint(this.base(), this.teamNanal(), "presign"),
      method: "POST",
      headers: { "content-type": "application/json", "x-nanal-api-key": this.settings.apiKey },
      body: JSON.stringify({ sha256: sealedHash, blob_sha256: blobHash, ext, content_type: contentType, force, size, enc_sha256: encSha256 }),
      throw: false,
    }));
    if (!pre) { console.error("[nanalstamp] storage presign network fail"); return false; }
    if (pre.status === 402) {
      // 병렬 업로드 중 여러 조각이 동시에 402를 받아도 Notice는 최초 1회만(backoff 선점 여부로 판정).
      const first = Date.now() >= this.storageQuotaBackoffUntil;
      this.storageQuotaBackoffUntil = Date.now() + 3_600_000;
      if (first) new Notice(t.nanalQuotaFull);
      return false;
    }
    if (pre.status !== 200) { console.error("[nanalstamp] storage presign", pre.status, pre.json?.error ?? ""); return false; }
    if (pre.json?.exists) return true; // 이미 저장됨(콘텐츠주소 중복제거)
    const put = await this.requestWithOneRetry(() => requestUrl({
      url: pre.json.url,
      method: "PUT",
      headers: { "content-type": contentType, "x-amz-checksum-sha256": hexToBase64(encSha256 ?? blobHash) },
      body,
      throw: false,
    }));
    if (!put) { console.error("[nanalstamp] storage put network fail"); return false; }
    if (put.status < 200 || put.status >= 300) { console.error("[nanalstamp] storage put", put.status, put.text?.slice?.(0, 200) ?? ""); return false; }
    return true;
  }

  // v2a: 대형 원본 CDC 업로드. 조각은 자기 해시 키(공유), manifest는 원문 해시 키(완료 마커 — 마지막 업로드).
  // 부분 실패 시 manifest 부재 = 미완료 → 기존 재시도가 재포착하고, 올라간 조각은 exists 스킵(이어올리기).
  // Phase D: 조각·manifest 모두 NSE1 암호화 업로드. exists 확인은 평문 해시 그대로(수렴 암호화 정합).
  private async nanalPutChunked(sealedHash: string, ext: string, data: Uint8Array, path: string): Promise<boolean> {
    if (Date.now() < this.storageQuotaBackoffUntil) return false;
    try {
      // 원문 수준 dedup: 같은 내용이 이미 단일 객체(.ext) 또는 manifest로 저장돼 있으면 즉시 완료
      // (단일 객체 경로의 presign HEAD dedup에 대응 — 없으면 동일 내용을 조각으로 중복 업로드하게 된다)
      const whole = await this.nanalExists([{ sha256: sealedHash, ext }]);
      if (whole && whole[0]) return true;
      const dek = await this.nanalDek(this.teamNanal());
      if (!dek) return false; // 평문 폴백 금지 — DEK 없이는(파기 포함) 업로드 중단
      const parts = cdcChunks(data);
      const hashes: string[] = [];
      for (const p of parts) {
        const buf = p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) as ArrayBuffer;
        hashes.push(await sha256HexBytes(buf));
      }
      // 존재 일괄 확인(서버 상한 50/호출) — 있는 조각은 업로드·쿼터 0
      const have: boolean[] = new Array(parts.length).fill(false);
      for (let i = 0; i < hashes.length; i += 50) {
        const res = await this.nanalExists(hashes.slice(i, i + 50).map((h) => ({ sha256: h, ext: "chunk" })));
        if (res) for (let j = 0; j < res.length; j++) have[i + j] = res[j];
      }
      // 존재하는 조각도 chash·csize는 manifest에 필요 — 수렴 암호화라 재암호화 결과가 결정적으로 동일.
      // 업로드는 UPLOAD_CONCURRENCY(3)개 제한 병렬: 인덱스 공유 워커 풀 — 각 워커가 다음 조각을 집어
      // 암호화(경량 CPU)→업로드. 조각 하나라도 최종 실패면 failed를 세워 새 조각을 집지 않고 전체 false
      // (manifest는 전 조각 성공 후에만 — 기존 시맨틱 유지. 이미 올라간 조각은 다음 재시도의 exists가 스킵).
      const encMeta: { chash: string; csize: number }[] = new Array(parts.length);
      const toUpload = have.reduce((n, h) => n + (h ? 0 : 1), 0);
      let uploaded = 0;
      if (toUpload > 0) this.setUploadProgress({ path, done: 0, total: toUpload });
      let nextIdx = 0;
      let failed = false;
      const worker = async (): Promise<void> => {
        while (!failed) {
          const i = nextIdx++;
          if (i >= parts.length) return;
          const encChunk = await encryptBlob(dek, hashes[i], "blob", parts[i]); // 계약: hashes[i] === sha256(parts[i])
          const chash = await sha256HexBytes(encChunk);
          encMeta[i] = { chash, csize: encChunk.byteLength };
          if (have[i]) continue;
          if (!(await this.nanalPutBlob(sealedHash, hashes[i], "chunk", "application/octet-stream", encChunk.buffer as ArrayBuffer, false, chash))) { failed = true; return; }
          uploaded++;
          if (this.uploadProgress?.path === path) this.setUploadProgress({ path, done: uploaded, total: toUpload });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, parts.length) }, () => worker()));
      if (failed) return false;
      // manifest는 결정적(같은 원문 = 같은 내용·같은 DEK = 같은 암호문)이라 force 불필요 — 재시도 시 HEAD dedup이 스킵.
      // blob_sha256은 평문 manifest 해시 유지(재시도 dedup의 근거), 암호화 plainHash는 sealedHash + "manifest" 도메인
      // (원문 blob의 "blob" 도메인과 분리 — 같은 sealedHash라도 키·nonce가 다르다).
      const manifest = buildManifest(hashes.map((h, i) => ({ hash: h, size: parts[i].byteLength, chash: encMeta[i].chash, csize: encMeta[i].csize })), data.byteLength, true);
      const manifestBytes = new TextEncoder().encode(manifest);
      const encManifest = await encryptBlob(dek, sealedHash, "manifest", manifestBytes);
      // content-type도 octet-stream — 본문이 JSON이 아니라 NSE1 암호문이므로(단일 객체 경로와 일관)
      return await this.nanalPutBlob(sealedHash, await sha256HexBytes(manifestBytes), "manifest", "application/octet-stream", encManifest.buffer as ArrayBuffer, false, await sha256HexBytes(encManifest));
    } catch (e) {
      console.error("[nanalstamp] chunked upload", e);
      return false;
    } finally {
      // 완료·실패 공통: 이 파일의 진행 표시 해제(다른 파일의 동시 업로드 진행 표시는 건드리지 않음)
      if (this.uploadProgress?.path === path) this.setUploadProgress(null);
    }
  }

  // ── P2: GitHub Contents API 미러(원본 notes/ + 증명 proofs/) ─────────────────
  private async mirrorToGithub(file: TFile, proofBody: string, seq?: number, block?: number, silent = false, original?: string | ArrayBuffer): Promise<boolean> {
    if (!this.mirrorActive()) return false;
    const team = this.settings.teamCustody;
    // 팀 custody가 아니면 개인 GitHub 연결(토큰·repo)이 있어야 한다. custody면 서버가 대행하므로 불필요.
    if (!team && (!this.settings.githubPat || !this.settings.githubRepo)) return false;
    try {
      const safe = safeName(file.path);
      if (original == null) original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
      const msg = buildArchiveMsg(file.path, seq, block); // block undefined → 봉인 시점(pending) 미러 커밋
      // .md는 notes/<safe>.md, 첨부는 attachments/<safe>(로컬 아카이브와 동일 배치).
      // 5.2: digest 폴더 아래 .md는 조직 repo digests/<safe>로 라우팅(개인·custody 공통). proofs는 그대로.
      const contentPath = this.isBinary(file)
        ? `attachments/${safe}`
        : this.isDigestPath(file.path) ? `digests/${safe}.md` : `notes/${safe}.md`;
      const proofPath = `proofs/${safe}.nanalproof`;
      // 팀 custody 우선: 개인 GitHub 연결 여부와 무관하게 서버 프록시로 조직 repo에 미러.
      if (team) {
        const okNote = await this.proxyPut(contentPath, original);
        if (okNote !== true) return false; // false(재시도) 또는 오프보딩(proxyPut이 teamCustody 정리·중단)
        const okProof = await this.proxyPut(proofPath, proofBody);
        if (okProof !== true) return false;
        if (!silent) new Notice(t.mirrorOk(`${team.org}/${team.repo}`));
        return true;
      }
      await this.ensureGithubReadme();
      const okNote = await this.githubPut(contentPath, original, msg);
      const okProof = await this.githubPut(proofPath, proofBody, msg);
      if (okNote && okProof) { if (!silent) new Notice(t.mirrorOk(this.settings.githubRepo)); return true; }
      return false; // 부분 실패 → mirrorIndex 미갱신, 다음 sweep에서 재시도
    } catch (e: any) {
      new Notice(t.mirrorFail(e?.message ?? String(e)));
      console.error("[nanalstamp] github mirror error", file.path, e);
      return false;
    }
  }

  // repo 최초 1회 README push(무엇인지 + 검증법). 이미 있으면(또는 이 repo에 한번 했으면) 건너뜀.
  private async ensureGithubReadme() {
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
  private async githubPut(path: string, content: string | ArrayBuffer, message: string): Promise<boolean> {
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
  private async proxyPut(path: string, content: string | ArrayBuffer): Promise<boolean> {
    const content_b64 = typeof content === "string" ? toBase64(content) : arrayBufferToBase64(content);
    const res = await requestUrl({
      url: `${this.base()}/attest/team/mirror`,
      method: "PUT",
      headers: { "x-nanal-api-key": this.settings.apiKey, "content-type": "application/json" },
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

  private base() { return this.settings.serverUrl.replace(/\/$/, ""); }
  // 사용자 페이지 도메인: API(api.nanalstamp.com)와 분리 → nanalstamp.com
  private webBase() { return this.base().replace("://api.", "://"); }

  openExternal(path: string) {
    const url = path.startsWith("http") ? path : this.webBase() + path;
    window.open(url, "_blank");
  }

  // 공식 증명서 PDF 발급 → 노트 옆에 저장(Free는 크레딧 필요·402면 요금제로 안내)
  private async issueCertificate() {
    if (!this.settings.apiKey) return new Notice(t.apiKeyMissing);
    const f = this.app.workspace.getActiveFile();
    if (!f) return new Notice(t.noNote);
    try {
      const content = await this.app.vault.read(f);
      const hash = await sha256Hex(content);
      const v = await this.queryVerify(hash);
      if (!v?.found) return new Notice(t.sealFirst(f.basename)); // 미봉인이면 먼저 봉인 안내
      const res = await requestUrl({
        url: `${this.base()}/attest/certificate?hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status === 402) { new Notice(t.certPay); this.openExternal("/pricing"); return; }
      if (res.status !== 200) { new Notice(t.certFail(String(res.status))); return; }
      // 증명물은 전부 nanalStamp/certificates/ 한 곳에(P6 HTML과 동일 규칙 — safeName으로 경로 평탄화)
      await this.ensureVaultFolder("nanalStamp/certificates");
      const path = `nanalStamp/certificates/${safeName(f.path)}-certificate.pdf`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, res.arrayBuffer);
      else await this.app.vault.createBinary(path, res.arrayBuffer);
      new Notice(t.certOk(path));
    } catch (e: any) { new Notice(t.certFail(e?.message ?? String(e))); }
  }

  // 공개 검증 링크 생성(Pro) → 클립보드 복사
  private async makePublicLink() {
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

  // 3.2: 팀 프로파일 수신 — GET /attest/team/profile (멤버 키). 404(팀 미소속)·비200·네트워크 오류는
  // 조용히 스킵(호출부가 결과 상태로 Notice를 결정). 200이면 applyTeamProfile로 반영.
  async fetchTeamProfile(): Promise<"applied" | "not-member" | "no-key" | "error"> {
    if (!this.settings.apiKey) return "no-key";
    let res: any;
    try {
      res = await requestUrl({
        url: `${this.base()}/attest/team/profile`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
    } catch (_) { return "error"; }
    if (res.status === 404) return "not-member";
    if (res.status !== 200) return "error";
    const profile = res.json?.profile;
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
        headers: { "x-nanal-api-key": this.settings.apiKey },
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
    // include/exclude: 문자열 배열 → 폴더 필터 설정 형식(줄바꿈 구분 문자열). parseFolders가 다시 파싱.
    if (Array.isArray(profile.include)) {
      s.includeFolders = (profile.include as unknown[]).filter((x): x is string => typeof x === "string").join("\n");
    }
    if (Array.isArray(profile.exclude)) {
      s.excludeFolders = (profile.exclude as unknown[]).filter((x): x is string => typeof x === "string").join("\n");
    }
    if (typeof profile.seal_attachments === "boolean") s.sealAttachments = profile.seal_attachments;
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
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/verify?hash=${hash}`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status === 200) return res.json;
    } catch (_) { /* ignore */ }
    return null;
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
    // P1-F: 결제 실패(past_due) 유예 중 — 세션당 1회 알림(기능은 유예 동안 유지됨).
    if (this.entitlement?.status === "past_due" && !this.pastDueNotified) {
      this.pastDueNotified = true;
      new Notice(t.pastDueNotice, 10000);
    } else if (this.entitlement && this.entitlement.status !== "past_due") {
      this.pastDueNotified = false; // 회복 후 재발 시 다시 알림
    }
  }

  // 현재 API 키의 요금제·크레딧 조회(설정 화면 표시용)
  async fetchEntitlement(): Promise<{ tier: string; cert_credits: number; is_pro: boolean; status?: string } | null> {
    if (!this.settings.apiKey) return null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/attest/pricing`,
        method: "GET",
        headers: { "x-nanal-api-key": this.settings.apiKey },
        throw: false,
      });
      if (res.status === 200 && res.json?.entitlement) return res.json.entitlement;
    } catch (_) { /* ignore */ }
    return null;
  }

  private setStatus(text: string, title: string, seal: "solid" | "faded" | "none" = "none") {
    this.statusEl.empty();
    if (seal !== "none") {
      const ic = this.statusEl.createSpan({ cls: "nanalstamp-status-icon" });
      if (seal === "faded") ic.addClass("is-faded");
      // 로고 SVG(러프 필터 포함)를 그대로 직접 주입 — setIcon은 filter를 제거하므로 사용하지 않음.
      ic.insertAdjacentHTML("afterbegin", `<img src="${this.iconUrl}" width="22" height="22" style="display:inline-block;vertical-align:middle" alt="nanalStamp">`);
    }
    this.statusEl.createSpan({ text });
    this.statusEl.setAttribute("aria-label", title);
  }

  private async updateActiveStatus() {
    this.stopPendingCountdown(); // 대기 카운트다운은 아래 dirty 분기에서만 다시 켠다
    this.activeAnchorPending = false; // 아래에서 '앵커 중'으로 확인되면 다시 켠다(주기 재검증 대상)
    const m = Math.round(MIN_INTERVAL_MS / 60000);
    const total = this.settings.lifetimeCount;
    const streak = computeStreak(this.settings.sealDays);
    const base = t.base(total, streak, m, this.settings.serverUrl);
    if (!this.settings.enabled) return this.setStatus(t.off, t.offTitle);
    if (this.authFailed) return this.setStatus(t.apiKeyRejected, t.authFail);
    if (!this.settings.apiKey) return this.setStatus(t.apiKeyMissing, t.loginDesc);
    // 청크 업로드 진행 중이면 진행률 우선 표시(탭 전환 등 다른 갱신이 덮지 않게 — 종료 시 setUploadProgress(null)가 복원).
    if (this.uploadProgress) { const p = this.uploadProgress; return this.setStatus(t.uploadProgress(p.done, p.total), p.path, "faded"); }

    const f = this.app.workspace.getActiveFile();
    if (!f || !this.isSealable(f)) return this.setStatus(t.overview(streak, total), base);
    if (!this.inScope(f.path)) return this.setStatus(t.outScope(f.basename), t.outScopeTitle);
    if (this.failed.has(f.path)) return this.setStatus(t.unsent(f.basename), t.unsentTitle(f.basename));

    const s = this.stateOf(f.path);
    if (s.dirty) {
      this.startPendingCountdown();
      return this.setStatus(t.pending + this.pendingEtaText(s), t.pendingTitle(f.basename), "faded");
    }
    try {
      // 0.2: 첨부도 verify로 봉인/대기 상태 표시. currentHashCached(mtime 캐시)로 — .md는 cachedRead,
      // 첨부는 readBinary. 탭 전환마다 대용량 첨부를 재해시하지 않도록 캐시 경유한다.
      const hash = await this.currentHashCached(f);
      if (!hash) { this.setStatus(t.overview(streak, total), t.queryFail(base)); return; }
      const v = await this.cachedVerify(hash); // 해시별 캐시 경유(연타 전환·재방문 시 서버 호출 절감)
      if (v === null) { this.setStatus(t.overview(streak, total), t.queryFail(base)); return; }
      if (v.found) {
        const seq = v.seq;
        const at = v.received_at ?? v.matches?.[0]?.received_at ?? "";
        const suffix = v.bitcoin?.block_height ? t.btc(v.bitcoin.block_height) : v.anchored ? t.anchoring : "";
        // '앵커 중'(anchored지만 ₿ 블록고 미확정)이면 주기 재검증 대상으로 표시.
        this.activeAnchorPending = !v.bitcoin?.block_height && !!v.anchored;
        this.setStatus(t.sealed(seq) + suffix, t.sealedTitle(f.basename, seq, at), "solid");
        // P1/P2/P1.5: 확정(₿ 블록 존재)을 처음 감지하는 순간 로컬 원장 + (Pro)미러 + 로컬 git 아카이브
        // 로컬 미저장이거나, 미러/아카이브 대상인데 아직 안 됐으면 처리(실패분 재시도 포함).
        const mirrorPending = this.mirrorActive() && this.settings.mirrorIndex[f.path] !== hash;
        const archivePending = this.archiveEnabled() && this.settings.archiveIndex[f.path] !== hash;
        if (v.bitcoin?.block_height && this.settings.autoLedger &&
            (this.settings.ledgerIndex[f.path] !== hash || mirrorPending || archivePending)) {
          void this.recordConfirmedProof(f, hash, v);
        }
      } else {
        this.setStatus(t.unsealed(f.basename), t.unsealedTitle(f.basename));
      }
    } catch {
      this.setStatus(t.overview(streak, total), t.queryFail(base));
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
    if (!this.isSealable(file)) return;
    const si = this.settings.attachSkipped.indexOf(oldPath);
    if (si !== -1) this.settings.attachSkipped[si] = file.path; // 스킵 표시도 새 경로로 이관
    const s = this.states.get(oldPath);
    if (s) {
      this.states.delete(oldPath);
      s.dirty = true; // 경로 커밋먼트 변경 → 재봉인 필요
      if (!s.dirtyAt) s.dirtyAt = Date.now(); // 대기 시작점(이미 대기 중이면 유지)
      this.states.set(file.path, s);
    }
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
    delete this.settings.sealedIndex[file.path];
    if (this.settings.attachSkipped.includes(file.path)) {
      this.settings.attachSkipped = this.settings.attachSkipped.filter((p) => p !== file.path);
      await this.persist();
    }
    if (this.failed.delete(file.path)) await this.persistFailed();
  }

  // 플러그인 데이터 저장(상태 갱신 없이 — flush 등 잦은 호출용)
  private async persist() { await this.saveData(this.settings); }
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
    if (!this.inScope(file.path)) return { status: "outscope" };
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
    this.settings.ledgerIndex = { ...(this.settings.ledgerIndex || {}) }; // DEFAULTS와 공유 참조 방지
    this.settings.mirrorIndex = { ...(this.settings.mirrorIndex || {}) };
    this.settings.ledgerMtime = { ...(this.settings.ledgerMtime || {}) };
    this.settings.archiveIndex = { ...(this.settings.archiveIndex || {}) };
    this.settings.nanalIndex = { ...(this.settings.nanalIndex || {}) };
    this.settings.sealedIndex = { ...(this.settings.sealedIndex || {}) };
    this.settings.sealDayCounts = { ...(this.settings.sealDayCounts || {}) };
    this.settings.attachSkipped = [...(this.settings.attachSkipped || [])]; // DEFAULTS 배열 공유 참조 방지
    delete (this.settings as unknown as Record<string, unknown>)["attachmentExtensions"]; // 폐기(참조 기반 전환) — 예전 저장분이 계속 영속되지 않게 제거
    this.settings.teamTemplates = (this.settings.teamTemplates || []).map((tt) => ({ ...tt })); // DEFAULTS 배열 공유 참조 방지
    // 아카이브 경로 기본값 채우기(데스크탑만) — 빈 값이면 홈 아래 nanalStamp-archive/
    if (!this.settings.archivePath && Platform.isDesktopApp) {
      try { this.settings.archivePath = defaultArchivePath(); } catch { /* Node 미가용 */ }
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
    // API 키가 바뀌면 거부 상태 해제(새 키로 재시도 허용)
    if (this.settings.apiKey !== this.lastApiKey) {
      this.lastApiKey = this.settings.apiKey;
      this.pastDueNotified = false; // 계정 전환 시 past_due 알림 가드 리셋
      this.authFailed = false;
      this.dekCache.clear(); // Phase D: 계정 전환 시 이전 계정 DEK로 암·복호하지 않도록
      this.dekDeny.clear(); // 이전 계정의 410·일시 실패 backoff도 새 키에는 무효
      this.dekGoneNotified = false;
      void this.refreshEntitlement();
    }
    void this.updateActiveStatus();
  }
}

// ArrayBufferView(제네릭 기본 ArrayBufferLike)도 받도록 — Uint8Array<ArrayBufferLike>(TextEncoder·복호 출력)의 캐스트 잡음 제거
async function sha256HexBytes(buf: ArrayBuffer | ArrayBufferView): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

// 파일 경로도 원문 대신 해시로만 전송 → 서버에 폴더/파일명이 남지 않음.
// 도메인 분리 프리픽스로 콘텐츠 해시와 혼동 방지. 경로 공개 시 동일하게 재계산해 커밋먼트 검증 가능.
const PATH_HASH_PREFIX = "nanalstamp/path/v1\n";
async function hashPath(p: string): Promise<string> {
  return sha256Hex(PATH_HASH_PREFIX + p);
}

// UTF-8 문자열 → base64(GitHub Contents API content 필드용). btoa는 유니코드를 못 다뤄 사용 불가.
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
}

// 노트 경로를 파일/URL 안전한 평면 이름으로 변환(폴더 구분은 __로 평탄화, .md 제거).
// 로컬 원장 파일명과 GitHub notes//proofs/ 하위 경로에 공통으로 쓴다(원본·증명 이름 정렬).
// 경로 문자열에서 파일명/확장자만 뽑는다(TFile 없이 leaf state의 notePath로 작업할 때 사용).
function basenameOf(p: string): string {
  const name = p.split(/[\\/]/).pop() || p;
  return name.replace(/\.[^.]+$/, "") || name;
}
function extOf(p: string): string {
  const name = p.split(/[\\/]/).pop() || p;
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1] : "";
}

// B: Excalidraw 노트 감지 — 경로가 .excalidraw(.md)로 끝나거나, frontmatter 블록 안에 excalidraw-plugin: 키가 있으면.
// 내용 스니핑은 첫 --- ... --- 블록으로 한정 — 본문 코드블록에 인용된 "excalidraw-plugin:" 오탐 방지.
// ArchiveSourceView가 "Excalidraw로 열기(사본)" 버튼을 낼지 판단하는 데 쓴다.
function isExcalidrawNote(notePath: string, content?: string): boolean {
  if (/\.excalidraw(\.md)?$/i.test(notePath)) return true;
  if (!content || !content.startsWith("---")) return false;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return !!m && m[1].includes("excalidraw-plugin:");
}

// B: Excalidraw 사본 파일명 분리 — .excalidraw.md 같은 복합 확장자를 하나로 취급(일반 확장자는 마지막 점 기준).
function splitExcalidrawName(fullName: string): { base: string; ext: string } {
  const m = /^(.*?)(\.excalidraw\.md|\.excalidraw|\.md)$/i.exec(fullName);
  if (m) return { base: m[1], ext: m[2] };
  const i = fullName.lastIndexOf(".");
  return i > 0 ? { base: fullName.slice(0, i), ext: fullName.slice(i) } : { base: fullName, ext: "" };
}

function safeName(notePath: string): string {
  const noExt = notePath.replace(/\.md$/i, "");
  return (
    noExt
      .replace(/[\\/]+/g, "__") // 폴더 구분 평탄화
      .replace(/[:*?"<>|#%]/g, "_") // 파일시스템/URL 위험 문자
      .replace(/\s+/g, " ")
      .trim() || "note"
  );
}


class NanalStampSettingTab extends PluginSettingTab {
  private advOpen = false; // 고급 <details> 열림 상태 — 토글 변경 등으로 display()가 재실행돼도 유지
  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app, plugin);
  }
  private text(parent: HTMLElement, name: string, desc: string, key: keyof AttestSettings) {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((tx) =>
        tx.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
          (this.plugin.settings as any)[key] = v.trim();
          await this.plugin.saveSettings();
        })
      );
  }
  private area(parent: HTMLElement, name: string, desc: string, key: "includeFolders" | "excludeFolders") {
    // 빈 값 = vault 전체가 화면에서 안 보이던 문제 — 현재 상태를 설명 맨 앞에 명시하고 입력 즉시 갱신.
    const current = () => {
      const n = this.plugin.settings[key].split("\n").map((x) => x.trim()).filter(Boolean).length;
      if (key === "includeFolders") return n === 0 ? t.scopeAllVault : t.scopeSomeFolders(n);
      return n === 0 ? t.excludeNone : t.excludeSome(n);
    };
    const st = new Setting(parent).setName(name).setDesc(`${current()} · ${desc}`);
    st.addTextArea((ta) =>
      ta.setValue(this.plugin.settings[key]).onChange(async (v) => {
        this.plugin.settings[key] = v;
        await this.plugin.saveSettings();
        st.setDesc(`${current()} · ${desc}`);
      })
    );
  }

  // 2026-07 설정 2차: "가입·로그인만 하면 작동" — 미로그인은 시작 카드 하나,
  // 로그인 후는 계정·연동 카드 2장 + 접힌 고급(<details>)만 보여준다. 기본값이 곧 동작이다.
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("nanalstamp-settings"); // 카드·배지·고급 접기 스타일(styles.css)
    if (!this.plugin.settings.apiKey) {
      this.renderStartCard(containerEl); // (A) 미로그인 — 이 카드 외에는 아무것도 렌더하지 않는다(언어 포함)
      return;
    }
    this.renderAccountCard(containerEl);      // (B)-1 계정
    this.renderIntegrationsCard(containerEl); // (B)-2 연동(GitHub·팀)
    this.renderAdvanced(containerEl);         // (B)-3 고급 — 기본 닫힘
  }

  // (A) 시작 카드: 한 줄 소개 + 이메일/비밀번호 + [가입][로그인] + 재설정 텍스트 링크
  private renderStartCard(containerEl: HTMLElement) {
    const card = containerEl.createDiv({ cls: "nanalstamp-card nanalstamp-start-card" });
    card.createDiv({ cls: "nanalstamp-card-title", text: t.welcomeTitle });
    card.createEl("p", { text: t.startIntro, cls: "nanalstamp-card-desc" });
    // 수동 API 키 입력칸은 없음 — 로그인이 키를 자동 발급한다(1차 개편 결정 유지).
    let loginEmail = "", loginPw = "";
    new Setting(card)
      .setName(t.loginName)
      .setDesc(t.loginDesc)
      .addText((tx) => tx.setPlaceholder(t.emailPlaceholder).onChange((v) => (loginEmail = v)))
      .addText((tx) => { tx.setPlaceholder(t.pwPlaceholder).onChange((v) => (loginPw = v)); (tx.inputEl as HTMLInputElement).type = "password"; })
      .addButton((b) => b.setButtonText(t.registerBtn).onClick(async () => {
        try { await this.plugin.accountRegister(loginEmail, loginPw); new Notice(t.registerSent(loginEmail)); }
        catch (e: any) { new Notice(t.registerFail(e?.message ?? String(e))); }
      }))
      .addButton((b) => b.setButtonText(t.loginBtn).setCta().onClick(async () => {
        try { const tier = await this.plugin.accountLogin(loginEmail, loginPw); new Notice(t.loginOk(tier)); this.display(); }
        catch (e: any) { new Notice(t.loginFail(e?.message ?? String(e))); }
      }));
    // 비밀번호 재설정 — 작은 텍스트 링크: 이메일이 입력돼 있으면 재설정 메일 발송, 아니면 웹 재설정 페이지로.
    const reset = card.createEl("a", { text: t.resetName, cls: "nanalstamp-reset-link" });
    reset.onclick = async () => {
      if (loginEmail.trim()) {
        try { await this.plugin.accountResetRequest(loginEmail); new Notice(t.resetSent(loginEmail)); }
        catch (e: any) { new Notice(t.resetFail(e?.message ?? String(e))); }
      } else {
        this.plugin.openExternal("/reset");
      }
    };
  }

  // (B)-1 계정 카드: 이메일 · 티어 배지 · 크레딧 · (Pro) 사용량 바 + [요금제 보기][구독 관리][로그아웃]
  private renderAccountCard(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "nanalstamp-card" });
    const titleRow = card.createDiv({ cls: "nanalstamp-card-title-row" });
    titleRow.createDiv({ cls: "nanalstamp-card-title", text: t.acctName });
    const badge = titleRow.createSpan({ cls: "nanalstamp-tier-badge", text: "…" });
    card.createEl("p", { text: s.accountEmail || t.acctConnected, cls: "nanalstamp-card-desc" });
    const creditsEl = card.createEl("p", { cls: "nanalstamp-card-desc", text: t.acctLoading });
    const showEnt = (e: { tier: string; cert_credits: number; is_pro: boolean; status?: string } | null) => {
      if (!e) { badge.setText("—"); creditsEl.setText(t.acctConnected); return; }
      badge.setText(e.tier.toUpperCase());
      badge.toggleClass("is-pro", e.is_pro);
      creditsEl.setText(t.acctCreditsLabel(e.cert_credits) + (e.status === "past_due" ? " · " + t.pastDueBadge : ""));
      creditsEl.toggleClass("mod-warning", e.status === "past_due");
    };
    if (this.plugin.entitlement) showEnt(this.plugin.entitlement); // 캐시 즉시 표시

    // C1: 스토리지 사용량 바(Pro & nanal 스토리지 활성) — 캐시 즉시, 오래됐으면 백그라운드 재조회 후 재렌더.
    const teamNanal = s.teamStorage === "nanal";
    if (this.plugin.isPro() && (s.storageBackend === "nanal" || teamNanal)) {
      const u = this.plugin.lastUsage;
      const wrap = card.createDiv({ cls: "nanalstamp-usage" });
      const label = wrap.createDiv({ cls: "nanalstamp-usage-label" });
      label.createSpan({ text: t.storageUsageName });
      label.createSpan({ cls: "v", text: u ? t.storageUsageVal(fmtBytes(u.used), u.quota > 0 ? fmtBytes(u.quota) : "—") : t.storageUsageLoading });
      const fill = wrap.createDiv({ cls: "nanalstamp-usage-bar" }).createDiv({ cls: "nanalstamp-usage-fill" });
      if (u && u.quota > 0) {
        fill.style.width = `${Math.min(100, Math.round((u.used / u.quota) * 100))}%`;
        if (u.used >= u.quota * 0.9) {
          fill.addClass("is-full");
          // C2: 팀 풀은 개인 PRO 구매로 안 늘어난다 — 팀 모드는 결제 CTA 대신 관리자 문의 안내.
          if (teamNanal) wrap.createEl("p", { text: t.teamPoolFullDesc, cls: "nanalstamp-card-desc" });
        }
      }
      if (this.plugin.usageStale()) {
        // 재렌더는 setTimeout+isConnected 가드 — 렌더 중 microtask 재진입 프리즈 방지(entitlement 갱신과 동일 패턴)
        void this.plugin.fetchStorageUsage().then(() => {
          window.setTimeout(() => { if (this.containerEl.isConnected) this.display(); }, 0);
        });
      }
    }

    // 버튼 행 — 구독 단일화 유지: 직접 결제 버튼 없음(요금제 SSOT는 웹 /pricing).
    new Setting(card)
      .setClass("nanalstamp-card-btns")
      .addButton((b) => b.setButtonText(t.pricingCmd).setCta().onClick(() => this.plugin.openExternal("/pricing")))
      .addButton((b) => b.setButtonText(t.manageSubBtn).onClick(() => this.plugin.openExternal("/account")))
      // 로그아웃 = 저장된 API 키 삭제(파괴적) — 오클릭 방지 확인 창 필수(1차 개편 결정 유지).
      .addButton((b) => b.setButtonText(t.logoutBtn).setWarning().onClick(async () => {
        if (!confirm(t.logoutConfirm)) return;
        this.plugin.settings.apiKey = "";
        this.plugin.settings.accountEmail = "";
        await this.plugin.saveSettings();
        this.display();
      }));

    // 최신값 갱신: .then 콜백(마이크로태스크)에서 DOM을 만지면 Obsidian 설정 렌더와 재진입해 UI가
    // 멈추는 문제가 있었다. 매크로태스크(setTimeout 0)로 미루고, 탭이 닫혔으면 스킵한다(기존 패턴).
    void this.plugin.refreshEntitlement().then(() => {
      window.setTimeout(() => {
        if (!this.containerEl.isConnected) return;
        showEnt(this.plugin.entitlement);
      }, 0);
    });
  }

  // (B)-2 연동 카드: GitHub 백업(연결 상태 + 클릭 몇 번 연결) · 팀(소속일 때만 한 줄 + 새로고침)
  private renderIntegrationsCard(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "nanalstamp-card" });
    card.createDiv({ cls: "nanalstamp-card-title", text: t.integrationsHead });

    // GitHub 백업 — 연결/해제만 카드에. 토글·수동 PAT 등 부속 옵션은 전부 고급으로 내렸다.
    // Device Flow 모달이 성공 시 githubExport까지 켜므로 여기서 연결만 하면 백업이 동작한다.
    if (!this.plugin.isPro()) {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubLocked)
        .addButton((b) => b.setButtonText(t.pricingCmd).onClick(() => this.plugin.openExternal("/pricing")));
    } else if (!s.githubPat) {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubConnectDesc)
        .addButton((b) =>
          b.setButtonText(t.githubConnectBtn).setCta().onClick(() => {
            new GitHubConnectModal(this.app, this.plugin, () => this.display()).open();
          })
        );
    } else {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubConnectedDesc(s.githubUser || "?", s.githubRepo || "?"))
        .addButton((b) =>
          b.setButtonText(t.githubDisconnectBtn).setWarning().onClick(async () => {
            s.githubPat = "";
            s.githubUser = "";
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    // 팀 — custody·팀 스토리지·프로파일 수신 흔적이 하나도 없으면(=팀 미소속) 행 자체를 숨긴다.
    const custody = s.teamCustody;
    if (custody || s.teamStorage === "nanal" || s.teamProfileUpdatedAt > 0) {
      const desc = custody
        ? t.teamCustodyActive(custody.org, custody.repo)
        : s.teamStorage === "nanal"
          ? t.teamStorageForced
          : t.teamProfileLastReceived(fmtDateTime(new Date(s.teamProfileUpdatedAt)));
      const row = new Setting(card).setName(t.teamRowName).setDesc(desc);
      // 자동 적용이 꺼져 있으면 수동 재수신 버튼도 숨긴다(끈 상태에서는 트래픽 없음 — 기존 결정 유지).
      if (s.teamProfileEnabled) {
        row.addButton((b) =>
          b.setButtonText(t.dashRefresh).onClick(async () => {
            const r = await this.plugin.fetchTeamProfile();
            // 4.3: 같은 버튼에서 custody 미러 정보도 갱신(연결·오프보딩 반영).
            const c = await this.plugin.fetchTeamMirrorInfo();
            if (r === "applied") new Notice(t.teamProfileApplied);
            else if (r === "not-member") new Notice(t.teamProfileNotMember);
            else if (r === "no-key") new Notice(t.apiKeyMissing);
            else new Notice(t.teamProfileFail);
            if (c === "enabled") new Notice(t.teamCustodyOn);
            else if (c === "disabled" || c === "not-member") new Notice(t.teamCustodyOff);
            this.display(); // 마지막 수신 시각·custody 상태 갱신
          })
        );
      }
    }
  }

  // (B)-3 고급 설정 — 기본 닫힘 <details>. 기본값이 곧 권장값이라 대부분 열 일이 없다.
  private renderAdvanced(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const det = containerEl.createEl("details", { cls: "nanalstamp-advanced" });
    det.open = this.advOpen;
    det.addEventListener("toggle", () => { this.advOpen = det.open; });
    det.createEl("summary", { text: t.advancedSummary });
    const body = det.createDiv({ cls: "nanalstamp-advanced-body" });
    body.createEl("p", { text: t.settIntro, cls: "setting-item-description" });

    // ── 봉인 범위(기본: 전체 볼트) + 첨부 봉인(기본 켜짐) ─────────────────
    new Setting(body).setName(t.sealScopeHead).setHeading();
    this.area(body, t.includeName, t.includeDesc, "includeFolders");
    this.area(body, t.excludeName, t.excludeDesc, "excludeFolders");
    new Setting(body)
      .setName(t.attachName)
      .setDesc(t.attachDesc)
      .addToggle((tg) =>
        tg.setValue(s.sealAttachments).onChange(async (v) => {
          s.sealAttachments = v;
          await this.plugin.saveSettings();
          this.display(); // 하위 경고(크기 초과 스킵) 표시/숨김 갱신
        })
      );
    if (s.sealAttachments) {
      // 업로드 한도(팀 정책 또는 5GB 하드캡) 초과로 클라우드 보관에서 제외된 첨부는 경고로 노출(침묵 누락 방지).
      if (s.attachSkipped.length > 0) {
        new Setting(body)
          .setName(t.attachSkippedWarn(s.attachSkipped.length, this.plugin.uploadLimitMB(), this.plugin.uploadSkipByTeam()))
          .setDesc(s.attachSkipped.join(", "))
          .setClass("mod-warning");
      }
    }

    // ── 보관·백업: 오프사이트 스토리지(B·C1) + 로컬 git 아카이브(P1.5, 기본 켜짐) ──
    new Setting(body).setName(t.storageHead).setHeading();
    if (!this.plugin.isPro()) {
      // 비-Pro: 잠금 안내만(결제 CTA는 계정 카드에 이미 있다)
      new Setting(body).setName(t.githubLocked).setDesc(t.storageProNote);
    } else {
      // C2: 팀 custody 스토리지가 nanal이면 멤버의 개인 선택과 무관하게 강제 활성 — 드롭다운 잠금 + 안내로 대체.
      const teamNanal = s.teamStorage === "nanal";
      new Setting(body)
        .setName(t.storageBackendName)
        .setDesc(teamNanal ? t.teamStorageForced : t.storageBackendDesc)
        .addToggle((tg) => {
          // off|nanal 이지선다라 드롭다운일 이유가 없다 — on/off 토글로.
          tg.setValue(teamNanal || s.storageBackend === "nanal").onChange(async (v) => {
            s.storageBackend = v ? "nanal" : "off";
            await this.plugin.saveSettings();
            this.display(); // 하위 설명 + 계정 카드 사용량 바 표시/숨김
          });
          tg.setDisabled(teamNanal);
        });
      if (s.storageBackend === "nanal" || teamNanal) {
        new Setting(body).setDesc(t.storageNanalDesc); // 사용량 바는 계정 카드로 이동
      }
    }

    // P1.5: 로컬 git 아카이브(전 티어, 데스크탑만) — 렌더는 전부 동기(프리즈 방지). 폴더선택/이관/git은 버튼 onClick에서만.
    if (!Platform.isDesktopApp) {
      new Setting(body).setName(t.archiveName).setDesc(t.archiveMobile);
    } else {
      new Setting(body)
        .setName(t.archiveName)
        .setDesc(t.archiveDesc)
        .addToggle((tg) =>
          tg.setValue(s.localArchive).onChange(async (v) => {
            s.localArchive = v;
            await this.plugin.saveSettings();
            if (v) void this.plugin.ensureArchive(); // 켜는 순간 폴더/.git 보장(렌더 밖)
          })
        );
      // 경로칸(기본값 채워 표시) + "폴더 선택" 버튼. 텍스트 입력은 draft에만 담고
      // 실제 적용(이관 포함)은 버튼 onClick에서 applyArchivePath로만 한다.
      let draftPath = s.archivePath;
      new Setting(body)
        .setName(t.archivePathName)
        .setDesc(t.archivePathDesc)
        .addText((tx) => {
          tx.setValue(s.archivePath).setPlaceholder(defaultArchivePathSafe());
          tx.onChange((v) => (draftPath = v));
        })
        .addButton((b) =>
          b.setButtonText(t.archivePickBtn).onClick(async () => {
            // 네이티브 폴더 다이얼로그 best-effort → 실패/없으면 경로칸 직접입력 폴백.
            let chosen = "";
            try {
              const remote = nodeReq("@electron/remote");
              const r = await remote?.dialog?.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
              if (r && !r.canceled && r.filePaths?.[0]) chosen = r.filePaths[0];
            } catch { /* 폴백: 아래 draftPath 사용 */ }
            const target = chosen || draftPath;
            const res = await this.plugin.applyArchivePath(target);
            if (res.status === "migrated") new Notice(t.archiveMigrated(res.a || "", res.b || ""));
            else if (res.status === "exists") new Notice(t.archiveExists);
            else if (res.status === "set") new Notice(t.archiveSet(res.b || ""));
            else if (res.status === "error") new Notice(t.archiveNotWritable(res.b || target));
            this.display(); // 경로칸 갱신
          })
        );
    }

    // ── P1: 증명 원장(로컬, 전 티어, 기본 켜짐) + 백필 + 증명서 크레딧 ────
    new Setting(body).setName(t.ledgerHead).setHeading();
    new Setting(body)
      .setName(t.ledgerName)
      .setDesc(t.ledgerDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoLedger).onChange(async (v) => {
          s.autoLedger = v;
          await this.plugin.saveSettings();
        })
      );
    this.text(body, t.ledgerFolderName, t.ledgerFolderDesc, "ledgerFolder");
    new Setting(body)
      .setName(t.backfillName)
      .setDesc(t.backfillDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoBackfill).onChange(async (v) => {
          s.autoBackfill = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.startBackfill(); // 재활성화 = 1회성 배수 다시 시작(소진되면 스스로 종료)
        })
      );
    // 증명서 크레딧 구매 — 증명서(PDF) 발급에 쓰이는 단건 크레딧(구독과 별개로 유지)
    new Setting(body)
      .setName(t.buyCreditCmd)
      .setDesc(t.buyCreditDesc)
      .addButton((b) => b.setButtonText(t.buyCreditCmd).onClick(() => this.plugin.startCheckout("cert_single")));

    // ── C1 고급: GitHub 내보내기 세부(토글·수동 repo/PAT) — 연결/해제 자체는 연동 카드에 ──
    if (this.plugin.isPro()) {
      new Setting(body).setName(t.storageAdvHead).setHeading();
      // 4.3: 팀 custody 활성이면 개인 GitHub 설정은 쓰이지 않음을 안내.
      if (s.teamCustody) new Setting(body).setDesc(t.teamCustodyPersonalUnused);
      new Setting(body)
        .setName(t.githubExportName)
        .setDesc(t.githubExportDesc)
        .addToggle((tg) =>
          tg.setValue(s.githubExport).onChange(async (v) => {
            s.githubExport = v;
            await this.plugin.saveSettings();
            this.display();
          })
        );
      if (s.githubExport) {
        // 고급(수동 PAT) — 파워 유저용 repo칸 + PAT칸(보조)
        new Setting(body).setName(t.githubAdvancedName).setDesc(t.githubAdvancedDesc);
        this.text(body, t.githubRepoName, t.githubRepoDesc, "githubRepo");
        new Setting(body)
          .setName(t.githubPatName)
          .setDesc(t.githubPatDesc)
          .addText((tx) => {
            tx.setValue(s.githubPat).onChange(async (v) => {
              s.githubPat = v.trim();
              await this.plugin.saveSettings();
            });
            (tx.inputEl as HTMLInputElement).type = "password";
          });
      }
    }

    // ── 팀 프로파일 자동 적용(기본 켜짐) — 상태·재수신은 연동 카드에 ──────
    new Setting(body).setName(t.teamProfileHead).setHeading();
    new Setting(body)
      .setName(t.teamProfileEnableName)
      .setDesc(t.teamProfileEnableDesc)
      .addToggle((tg) =>
        tg.setValue(s.teamProfileEnabled).onChange(async (v) => {
          s.teamProfileEnabled = v;
          await this.plugin.saveSettings();
          this.display(); // 연동 카드의 재수신 버튼 노출 여부 갱신
        })
      );

    // ── 기타(템플릿·언어) ────────────────────────────────────────────────
    new Setting(body).setName(t.miscHead).setHeading();
    new Setting(body)
      .setName(t.tplEnableName)
      .setDesc(t.tplEnableDesc)
      .addToggle((tg) =>
        tg.setValue(s.templatesEnabled).onChange(async (v) => {
          s.templatesEnabled = v;
          await this.plugin.saveSettings();
        })
      );
    this.text(body, t.tplFolderName, t.tplFolderDesc, "noteFolder");
    this.text(body, t.digestFolderName, t.digestFolderDesc, "digestFolder");
    new Setting(body)
      .setName(t.langName)
      .setDesc(t.langDesc)
      .addDropdown((d) =>
        d
          .addOption("auto", "Auto")
          .addOption("en", "English")
          .addOption("ko", "한국어")
          .setValue(s.lang)
          .onChange(async (v) => {
            s.lang = v as AttestSettings["lang"];
            await this.plugin.saveSettings();
            applyLang(s);
            new Notice(t.langReload);
            this.display();
          })
      );
  }
}

// 첫 실행 온보딩: "지금 봉인 — 과거는 소급 증명 불가" 안내 + 설정 유도
// 증명/타임라인 모달: 활성 노트의 봉인 상태·seq·received_at·비트코인 앵커 + 연속 지표
class ProofModal extends Modal {
  private histObserver: IntersectionObserver | null = null;
  constructor(app: App, private plugin: NanalStampPlugin, private file: TFile) {
    super(app);
  }
  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("nanalstamp-proof-modal"); // 확대·외곽·정돈은 styles.css
    contentEl.empty();
    contentEl.addClass("nanalstamp-proof-content"); // flex column: 헤더 / 스크롤 본문 / 고정 푸터
    // 고정 헤더 — 스크롤과 무관하게 항상 상단
    const header = contentEl.createDiv({ cls: "nanalstamp-proof-header" });
    header.createEl("h2", { text: t.proofTitle });
    header.createEl("div", { text: this.file.basename, cls: "nanalstamp-proof-file" });
    // 스크롤 본문
    const body = contentEl.createDiv({ cls: "nanalstamp-proof-body" });
    body.createEl("p", { text: t.proofChecking, cls: "setting-item-description" });

    const info = await this.plugin.proofFor(this.file);
    body.empty();

    const head = body.createEl("div", { cls: `nanalstamp-proof-chip is-${info.status}` });
    switch (info.status) {
      case "sealed": head.setText(t.proofSealedHead); break;
      case "changed": head.setText(t.proofChangedHead); break;
      case "pending": head.setText(t.proofPendingHead); break;
      case "outscope": head.setText(t.proofOutScopeHead); break;
      default: head.setText(t.proofUnsealedHead);
    }

    if (info.error) body.createEl("p", { text: t.proofErr, cls: "mod-warning" });

    if (info.status === "sealed") {
      // 상태 정보를 라벨:값 2열 그리드로(라벨 muted, 값 normal·tabular-nums). "라벨: 값" 문구를 첫 ": "로 분리.
      const status = body.createDiv({ cls: "nanalstamp-proof-status" });
      const statRow = (text: string) => {
        const idx = text.indexOf(": ");
        if (idx > 0) {
          status.createSpan({ cls: "k", text: text.slice(0, idx) });
          status.createSpan({ cls: "v", text: text.slice(idx + 2) });
        } else {
          status.createSpan({ cls: "k", text: "" });
          status.createSpan({ cls: "v", text });
        }
      };
      if (typeof info.seq === "number") statRow(t.proofSeq(info.seq));
      if (info.receivedAt) statRow(t.proofReceived(info.receivedAt));
      if (info.blockHeight) statRow(t.proofAnchorConfirmed(info.blockHeight));
      else if (info.anchored) statRow(t.proofAnchorPending);
      else statRow(t.proofAnchorNone);
    } else if (info.status === "changed") {
      body.createEl("p", { text: t.proofChangedBody, cls: "setting-item-description" });
    } else if (info.status === "unsealed") {
      body.createEl("p", { text: t.proofUnsealedBody, cls: "setting-item-description" });
    }

    // (전체 통계 '연속 봉인·총 N건'은 노트 단위 창에 부적절해 제거 — 노트별 총 봉인수는 이력 제목에 표시.)

    // 점검 상태 배지 — 봉인·팀 소속 사용자만 리뷰가 있다. 404·403·네트워크는 null → 섹션 생략.
    const reviews = await this.plugin.fetchReviewStatus(this.file);
    if (reviews && reviews.length > 0) {
      body.createEl("hr");
      body.createEl("p", { text: t.reviewSectionTitle, cls: "setting-item-name" });
      for (const r of reviews) {
        if (r.status === "signed") {
          const when = fmtUtc(r.reviewed_at);
          body.createEl("p", { text: t.reviewSigned(reviewVerdictLabel(r.statement ?? ""), r.reviewer_email || "—", when) });
        } else if (r.status === "pending") {
          body.createEl("p", { text: t.reviewPending, cls: "setting-item-description" });
        } else if (r.status === "declined") {
          body.createEl("p", { text: t.reviewDeclined(r.decline_note ?? ""), cls: "setting-item-description" });
        }
      }
    }

    // 봉인 이력 섹션 placeholder — 이력 조회가 모달 오픈을 막지 않도록 먼저 현재 정보/닫기 버튼을 렌더한 뒤
    // 비동기로 채운다. 실패·비어있음이면 아무것도 추가하지 않는다(잡음 금지).
    const histHost = body.createEl("div");

    // 고정 푸터 — 닫기 버튼은 스크롤과 무관하게 항상 하단에 보인다.
    const footer = contentEl.createDiv({ cls: "nanalstamp-proof-footer" });
    const closeBtn = footer.createEl("button", { cls: "mod-cta", text: t.proofClose });
    closeBtn.onclick = () => this.close();

    void this.appendHistory(histHost);
  }

  // 봉인 이력 섹션(전체 + 무한 스크롤)을 비동기로 append. 첫 페이지 20건 렌더 후 하단 sentinel 노출 시
  // 다음 페이지를 이어 로드한다. 각 행에 아카이브 확정 버전이 있으면 "원문 보기" 버튼. 폴백(구서버)은 전량 1회.
  private async appendHistory(host: HTMLElement) {
    const first = await this.plugin.fetchHistoryPage(this.file);
    if (!first || first.rows.length === 0) return; // 잡음 금지: 실패·비어있음이면 섹션 생략

    const isMd = isMarkdownPath(this.file.path);
    const safe = safeName(this.file.path);
    const rel = isMd ? `notes/${safe}.md` : `attachments/${safe}`;
    // 아카이브 대응표(seq→커밋)는 첫 로드 때 1회만 만들어 재사용 — 이후 새 페이지 행도 같은 map으로 "원문 보기" 판단.
    const archiveOn = this.plugin.dashboardArchiveOn();
    const bySeq = new Map<string, { oid: string; ts: number; tzo: number; seq: string; block: string }>();
    if (archiveOn) {
      // git.log 는 최신순 → 같은 seq 가 여러 커밋에 있으면 첫(=최신) 것만 채택(확정 커밋이 pending 을 덮어쓰지 않게).
      for (const v of await this.plugin.archiveVersionsOf(rel)) if (!bySeq.has(v.seq)) bySeq.set(v.seq, v);
    }

    host.createEl("hr");
    host.createEl("p", { text: t.histSectionTitle(first.total ?? first.rows.length), cls: "setting-item-name" });
    const scroller = host.createEl("div", { cls: "nanalstamp-hist-scroll" });
    const rowsHost = scroller.createEl("div");
    const sentinel = scroller.createEl("div", { cls: "nanalstamp-hist-sentinel" });

    // B: '원문 보기'를 저장처별 버튼으로 — 실제 저장된 곳만 노출한다.
    // 로컬(git 아카이브 seq 대응 커밋) / GitHub(현재 미러본과 해시 일치 시) / nanalStamp(존재 일괄 확인 후 비동기 추가).
    const nanalExt = isMd ? "md" : blobExt(this.file.path);
    const renderRow = (row: { seq: number; receivedAt: number; fileHash: string; confirmed: boolean; block?: number }): { hash: string; el: HTMLElement } | null => {
      const when = fmtDateTime(new Date(row.receivedAt * 1000)); // received_at 은 epoch(초)
      const isConfirmed = row.confirmed && typeof row.block === "number";
      // 확정(비트코인 앵커됨) / 대기 를 클래스로 시각 구분. 확정만 ₿ 블록·색 강조, 대기는 흐리게.
      const item = rowsHost.createDiv({ cls: `nanalstamp-hist-row ${isConfirmed ? "is-confirmed" : "is-pending"}` });
      const main = item.createDiv({ cls: "nanalstamp-hist-main" });
      main.createSpan({ cls: "nanalstamp-hist-when", text: when });
      const meta = main.createSpan({ cls: "nanalstamp-hist-meta" });
      meta.createSpan({ cls: "nanalstamp-hist-seq", text: `seq ${row.seq}` });
      if (isConfirmed) {
        meta.createSpan({ cls: "nanalstamp-hist-btc", text: `₿ ${(row.block as number).toLocaleString()}` });
      } else {
        meta.createSpan({ cls: "nanalstamp-hist-wait", text: t.histAnchorWait });
      }
      const btns = item.createDiv({ cls: "nanalstamp-hist-srcs" });
      const ver = bySeq.get(String(row.seq));
      if (archiveOn && ver) {
        const btn = btns.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcLocal, attr: { title: t.histViewSource } });
        btn.onclick = () => {
          void this.plugin.openArchiveSource(this.file.path, ver, safe, rel, isMd);
          this.close();
        };
      }
      // GitHub 미러는 최신본만 파일로 유지(과거 버전은 repo 커밋 이력) — 이 행 해시가 현재 미러본일 때만 링크.
      if (row.fileHash && this.plugin.settings.mirrorIndex[this.file.path] === row.fileHash) {
        const url = this.plugin.githubMirrorUrl(this.file);
        if (url) {
          const btn = btns.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcGithub, attr: { title: t.histViewSource } });
          btn.onclick = () => { window.open(url); };
        }
      }
      return row.fileHash ? { hash: row.fileHash, el: btns } : null;
    };

    // nanalStamp 버튼은 서버에 존재를 일괄 확인한 뒤(페이지당 1회) 있는 행에만 붙인다.
    const fillNanal = async (slots: Array<{ hash: string; el: HTMLElement }>) => {
      if (slots.length === 0) return;
      const uniq = [...new Set(slots.map((s) => s.hash))];
      const exists = await this.plugin.nanalExists(uniq.map((h) => ({ sha256: h, ext: nanalExt })));
      if (!exists) return; // 실패·구서버 → 버튼 생략(잡음 금지)
      const ok = new Set(uniq.filter((_, i) => exists[i]));
      for (const s of slots) {
        if (!ok.has(s.hash)) continue;
        const btn = s.el.createEl("button", { cls: "nanalstamp-hist-btn", text: t.histSrcNanal, attr: { title: t.histViewSource } });
        btn.onclick = () => {
          void this.plugin.openNanalView(this.file.path, s.hash, isMd);
          this.close();
        };
      }
    };

    const firstSlots = first.rows.map(renderRow).filter((s): s is { hash: string; el: HTMLElement } => s !== null);
    void fillNanal(firstSlots);

    // 폴백(구서버)이거나 더 없으면 무한 스크롤 불필요 — 전량 렌더 완료.
    if (first.fallback || !first.hasMore) return;

    let lastSeq = first.rows[first.rows.length - 1].seq;
    let hasMore: boolean = first.hasMore;
    let loading = false; // 중복 로드 가드(in-flight)

    const loadNext = async () => {
      if (loading || !hasMore) return;
      loading = true;
      // 로딩 중 한 줄 표시(로드 완료 시 제거) — sentinel 바로 위에.
      const loadingEl = scroller.createEl("p", { text: t.histLoadingMore, cls: "setting-item-description nanalstamp-hist-loading" });
      scroller.insertBefore(loadingEl, sentinel);
      const page = await this.plugin.fetchHistoryPage(this.file, lastSeq);
      loadingEl.remove();
      loading = false;
      if (!page) { hasMore = false; this.histObserver?.unobserve(sentinel); return; }
      const pageSlots = page.rows.map(renderRow).filter((s): s is { hash: string; el: HTMLElement } => s !== null);
      void fillNanal(pageSlots);
      if (page.rows.length > 0) lastSeq = page.rows[page.rows.length - 1].seq;
      hasMore = page.hasMore && page.rows.length > 0;
      if (!hasMore) { this.histObserver?.unobserve(sentinel); return; }
      // 새 행 추가 후에도 sentinel 이 여전히 보이면(짧은 목록) 재관측으로 이어서 로드.
      this.histObserver?.unobserve(sentinel);
      this.histObserver?.observe(sentinel);
    };

    // 스크롤은 이제 본문(.nanalstamp-proof-body)이 담당 — sentinel 관측 root 를 그 스크롤 컨테이너로.
    const scrollRoot = host.closest(".nanalstamp-proof-body") as HTMLElement | null;
    this.histObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) void loadNext();
    }, { root: scrollRoot });
    this.histObserver.observe(sentinel);
  }

  onClose() {
    this.histObserver?.disconnect();
    this.histObserver = null;
    this.contentEl.empty();
  }
}

// P6: 아카이브 버전 선택 모달 — 이 노트가 git 아카이브에 남긴 확정 버전들을 나열,
// 하나를 고르면 그 시점 원문+증명을 readBlob으로 읽어 오프라인 검증 후 번들(FREE)/증명서(PRO)로 내보낸다.
// 현재 노트는 절대 건드리지 않는다.
class ArchiveVersionModal extends Modal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private file: TFile,
    private safe: string,
    private versions: Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>,
  ) {
    super(app);
  }

  onOpen() {
    this.renderList();
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderList() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pitModalTitle });
    contentEl.createEl("div", { text: this.file.basename, cls: "setting-item-name" });
    contentEl.createEl("p", { text: t.pitPick, cls: "setting-item-description" });
    for (const ver of this.versions) {
      const when = fmtDateTime(new Date(ver.ts * 1000));
      new Setting(contentEl)
        .setName(when)
        .setDesc(t.pitVersionDesc(ver.seq, ver.block))
        .addButton((b) => b.setButtonText(t.pitSelectBtn).setCta().onClick(() => void this.renderDetail(ver)));
    }
    new Setting(contentEl).addButton((b) => b.setButtonText(t.pitClose).onClick(() => this.close()));
  }

  private async renderDetail(ver: { oid: string; ts: number; tzo: number; seq: string; block: string }) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pitModalTitle });
    contentEl.createEl("div", { text: this.file.basename, cls: "setting-item-name" });
    const loading = contentEl.createEl("p", { text: t.pitReading, cls: "setting-item-description" });

    const read = await this.plugin.readArchivedVersion(ver.oid, this.safe);
    loading.remove();
    if (!read) {
      contentEl.createEl("p", { text: t.pitReadFail, cls: "mod-warning" });
      new Setting(contentEl).addButton((b) => b.setButtonText(t.pitClose).onClick(() => this.renderList()));
      return;
    }
    const v = await this.plugin.selfVerifyArchived(read.note, read.proof);
    const dateLabel = fmtDate(new Date(ver.ts * 1000));

    const verdict = contentEl.createEl("p");
    verdict.addClass(v.ok ? "setting-item-name" : "mod-warning");
    verdict.setText(v.ok ? t.pitVerifyOk : !v.hashMatch ? t.pitVerifyHashBad : t.pitVerifyNoBlock);
    // 내용은 일치하나 블록만 없음(=봉인 시점 pending 사본) → "미앵커"로 오해 않도록 온라인 이력 안내.
    if (!v.ok && v.hashMatch) contentEl.createEl("p", { text: t.pitAnchorHint, cls: "setting-item-description" });

    contentEl.createEl("p", { text: t.pitDetailDate(fmtDateTime(new Date(ver.ts * 1000))) });
    if (v.seq != null) contentEl.createEl("p", { text: t.pitDetailSeq(String(v.seq)) });
    if (v.block != null) contentEl.createEl("p", { text: t.pitDetailBlock(String(v.block)) });
    contentEl.createEl("p", { text: t.pitDetailHash(v.expected || v.computed), cls: "setting-item-description" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.pitExportBundle).setCta().onClick(async () => {
        try {
          const p = await this.plugin.exportPitBundle(this.safe, dateLabel, ver.oid, read.note, read.proofRaw, v);
          new Notice(t.pitBundleOk(p));
        } catch (e: any) { new Notice(t.pitExportFail(e?.message ?? String(e))); }
      }))
      .addButton((b) => b.setButtonText(t.pitExportCert).onClick(async () => {
        try {
          const p = await this.plugin.exportPitCertificate(this.safe, this.file.basename, read.note, dateLabel, ver.oid, v, read.proofRaw);
          if (p) new Notice(t.pitCertOk(p));
        } catch (e: any) { new Notice(t.pitExportFail(e?.message ?? String(e))); }
      }));
    new Setting(contentEl).addButton((b) => b.setButtonText(t.pitBackBtn).onClick(() => this.renderList()));
  }
}

// 확정 버전의 원문 열람 뷰(팝업 아님) — 현재 노트와 같은 편집 영역 크기의 탭. 분할 배치 가능.
// 상태(oid·rel·safe·isMd·notePath·seq·block·ts)는 leaf state로 받아 스스로 아카이브에서 읽는다(runArchive 락 경유).
// 앱 재시작 시 stale 상태로 복원돼도 읽기 실패면 안내 문구만 — 현재 노트를 절대 건드리지 않는다.
const ARCHIVE_SOURCE_VIEW_TYPE = "nanalstamp-archive-source";

interface ArchiveSourceState {
  oid: string;
  rel: string;
  safe: string;
  isMd: boolean;
  notePath: string;
  seq: string;
  block: string;
  ts: number;
}

class ArchiveSourceView extends ItemView {
  private st: ArchiveSourceState | null = null;
  private objectUrl: string | null = null;
  // render() 재진입 가드 — setState가 겹치면 오래된 호출이 새 DOM을 덮어쓰지 않도록.
  private renderGen = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: NanalStampPlugin) { super(leaf); }

  getViewType(): string { return ARCHIVE_SOURCE_VIEW_TYPE; }
  getIcon(): string { return ICON_ID; }
  getDisplayText(): string {
    if (!this.st) return t.histSourceTitle;
    // nanal 소스는 seq를 모른다 — 경로·해시 없이 노트 이름만으로 깔끔한 탭 제목.
    if (this.st.oid.startsWith("nanal:")) return t.nanalViewTitle(basenameOf(this.st.notePath));
    return t.histTabTitle(basenameOf(this.st.notePath), this.st.seq);
  }

  // leaf state 왕복 — getState로 저장돼 앱 재시작 후 setState로 복원된다.
  getState(): Record<string, unknown> {
    return this.st ? { ...this.st } : {};
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<ArchiveSourceState> | null;
    if (s && typeof s.oid === "string" && typeof s.notePath === "string") {
      this.st = {
        oid: s.oid,
        rel: String(s.rel ?? ""),
        safe: String(s.safe ?? ""),
        isMd: !!s.isMd,
        notePath: s.notePath,
        seq: String(s.seq ?? "?"),
        block: String(s.block ?? "?"),
        ts: typeof s.ts === "number" ? s.ts : 0,
      };
    }
    await super.setState(state, result);
    void this.render();
  }

  async onOpen(): Promise<void> { await this.render(); }
  async onClose(): Promise<void> { this.releaseUrl(); this.contentEl.empty(); }

  private releaseUrl() {
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
  }

  private async render(): Promise<void> {
    const gen = ++this.renderGen;
    this.releaseUrl();
    const el = this.contentEl;
    el.empty();
    el.addClass("nanalstamp-archive-source");
    const st = this.st;
    if (!st) { el.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }

    const nanalHash = st.oid.startsWith("nanal:") ? st.oid.slice("nanal:".length) : null;

    // 읽기 전용 배너 — 현재 노트와의 혼동 방지가 목적.
    const banner = el.createDiv({ cls: "nanalstamp-archive-banner" });
    if (nanalHash) {
      banner.setText(t.nanalViewBanner(basenameOf(st.notePath), nanalHash.slice(0, 8)));
    } else {
      const when = fmtDateTime(new Date(st.ts * 1000));
      banner.setText(t.histBanner(basenameOf(st.notePath), st.seq, st.block, when));
    }

    const host = el.createDiv({ cls: "nanalstamp-archive-body" });
    const loading = host.createEl("p", { text: t.pitReading, cls: "nanalstamp-archive-note" });

    // Excalidraw 사본 열기 버튼용 원문 텍스트(md 또는 텍스트형 첨부만 채워짐 — 채워져야 버튼을 낸다).
    let restoreText: string | null = null;

    // B: nanal 스토리지 소스 — 뷰가 직접 내려받아 해시 재검증 후 렌더(첨부는 renderAttachment 재사용).
    if (nanalHash) {
      const r = await this.plugin.nanalFetch(nanalHash, st.rel, st.isMd);
      if (gen !== this.renderGen) return;
      loading.remove();
      if ("error" in r) { host.createEl("p", { text: r.error, cls: "nanalstamp-archive-note" }); return; }
      if (st.isMd) {
        restoreText = r.data as string;
        const md = host.createDiv({ cls: "nanalstamp-archive-md markdown-rendered" });
        await MarkdownRenderer.render(this.app, restoreText, md, st.notePath, this);
        this.lockInputs(md);
      } else {
        const bytes = new Uint8Array(r.data as ArrayBuffer);
        if (isExcalidrawNote(st.notePath)) restoreText = new TextDecoder("utf-8").decode(bytes);
        this.renderAttachment(host, bytes, st);
      }
    } else if (st.isMd) {
      const read = await this.plugin.readArchivedVersion(st.oid, st.safe);
      if (gen !== this.renderGen) return; // 더 새로운 render가 시작됨
      loading.remove();
      if (!read) { host.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }
      restoreText = read.note;
      // 리딩뷰처럼 렌더 — pre보다 노트답게 보인다. 내부 링크는 무해하게 둔다(sourcePath로 상대경로 해석).
      const md = host.createDiv({ cls: "nanalstamp-archive-md markdown-rendered" });
      await MarkdownRenderer.render(this.app, restoreText, md, st.notePath, this);
      this.lockInputs(md);
    } else {
      const bytes = await this.plugin.archiveReadBytes(st.oid, st.rel);
      if (gen !== this.renderGen) return;
      loading.remove();
      if (!bytes) { host.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }
      if (isExcalidrawNote(st.notePath)) restoreText = new TextDecoder("utf-8").decode(bytes);
      this.renderAttachment(host, bytes, st);
    }

    // MarkdownRenderer.render await 사이 새 render()가 시작됐을 수 있다 — 스테일 렌더가 라이브 el에
    // 버튼을 주입하지 않도록 재검사(위 fetch 후 가드와 같은 원칙).
    if (gen !== this.renderGen) return;

    // Excalidraw 노트 — 압축 JSON+경고를 그대로 보여줘봐야 무의미하므로, vault 사본을 만들어
    // Excalidraw 플러그인이 설치돼 있으면 그림으로 열리도록 안내 버튼을 배너 아래에 추가한다.
    if (restoreText != null && isExcalidrawNote(st.notePath, restoreText)) {
      new Setting(el).addButton((b) =>
        b.setButtonText(t.excalidrawOpenCopy).setCta().onClick(async () => {
          try {
            const file = await this.writeExcalidrawCopy(st.notePath, restoreText as string);
            new Notice(t.excalidrawCopyNotice(file.path));
            await this.app.workspace.getLeaf("tab").openFile(file);
          } catch (e: unknown) {
            // vault.create 실패(권한·동시 생성 레이스 등) — 조용한 무반응 대신 실패를 알린다.
            new Notice(t.nanalRestoreFail(e instanceof Error ? e.message : String(e)));
          }
        })
      );
    }
  }

  // Excalidraw 사본을 nanalStamp/restore/<원본파일명>에 새 파일로 쓴다(동명 존재 시 타임스탬프 접미).
  // 원본·아카이브는 절대 건드리지 않는다 — 여기서 만드는 건 항상 새 파일.
  private async writeExcalidrawCopy(notePath: string, content: string): Promise<TFile> {
    const folder = "nanalStamp/restore";
    await this.plugin.ensureVaultFolder(folder);
    const fullName = notePath.split(/[\\/]/).pop() || notePath;
    const { base, ext } = splitExcalidrawName(fullName);
    let target = `${folder}/${fullName}`;
    if (this.app.vault.getAbstractFileByPath(target)) {
      const now = new Date();
      const stamp = `${fmtDate(now)} ${pad2(now.getHours())}${pad2(now.getMinutes())}`;
      target = `${folder}/${base} (${t.excalidrawCopySuffix} ${stamp})${ext}`;
    }
    return await this.app.vault.create(target, content);
  }

  // 렌더된 체크박스 등 입력 요소를 잠근다 — 클릭 토글이 보관본을 편집하는 듯한 착시 방지(저장은 원래 안 됨).
  private lockInputs(md: HTMLElement) {
    md.querySelectorAll("input").forEach((el) => { (el as HTMLInputElement).disabled = true; });
  }

  // git.readBlob의 Uint8Array를 Blob이 받는 순수 ArrayBuffer로 복사(SharedArrayBuffer 유니온 회피).
  private toBlob(bytes: Uint8Array, type?: string): Blob {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return type ? new Blob([ab], { type }) : new Blob([ab]);
  }

  // 첨부 렌더: 이미지는 Blob URL <img>(가운데 정렬), 텍스트형은 디코딩해 <pre>, 그 외(pdf/xlsx 등)는 저장 버튼만.
  private renderAttachment(host: HTMLElement, bytes: Uint8Array, st: ArchiveSourceState) {
    const ext = (extOf(st.notePath) || "").toLowerCase();
    const imgExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
    const textExts = ["csv", "json", "canvas", "excalidraw", "txt", "md"];
    if (imgExts.includes(ext)) {
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      this.objectUrl = URL.createObjectURL(this.toBlob(bytes, mime));
      const img = host.createEl("img", { cls: "nanalstamp-archive-img" });
      img.src = this.objectUrl;
    } else if (textExts.includes(ext)) {
      const text = new TextDecoder("utf-8").decode(bytes);
      host.createEl("pre", { cls: "nanalstamp-source-view" }).createEl("code", { text });
    } else {
      // pdf/xlsx 등 미리보기 비대상 — "파일로 저장"만(임시 Blob URL은 클릭 직후 revoke).
      new Setting(host).setName(t.histSaveHint).addButton((b) => b.setButtonText(t.histSaveFile).setCta().onClick(() => {
        const url = URL.createObjectURL(this.toBlob(bytes));
        const a = document.createElement("a");
        a.href = url;
        a.download = basenameOf(st.notePath);
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }));
    }
  }
}

// 첨부 아카이브 버전 목록 모달 — ArchiveVersionModal(.md 전제: 검증·증명서)과 달리
// 첨부는 버전을 고르면 바로 원문 뷰(ArchiveSourceView)로 넘긴다.
class AttachmentVersionModal extends Modal {
  constructor(
    app: App,
    private plugin: NanalStampPlugin,
    private file: TFile,
    private safe: string,
    private rel: string,
    private versions: Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.pitModalTitle });
    contentEl.createEl("div", { text: this.file.basename, cls: "setting-item-name" });
    contentEl.createEl("p", { text: t.pitPick, cls: "setting-item-description" });
    for (const ver of this.versions) {
      const when = fmtDateTime(new Date(ver.ts * 1000));
      new Setting(contentEl)
        .setName(when)
        .setDesc(t.pitVersionDesc(ver.seq, ver.block))
        .addButton((b) => b.setButtonText(t.histViewSource).setCta().onClick(() => {
          void this.plugin.openArchiveSource(this.file.path, ver, this.safe, this.rel, false);
          this.close();
        }));
    }
    new Setting(contentEl).addButton((b) => b.setButtonText(t.pitClose).onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── 증빙 상태 대시보드(PRO) ──────────────────────────────────────────────────
// 원칙: (1) nanalStamp만 아는 데이터(원장·아카이브·앵커)만 (2) 전부 로컬 계산 — 서버 호출 없음
// (3) 점수·독려 없음("증거가 얼마나 단단한가"만). 스펙: docs/2026-07-09-pro-dashboard-v1-spec.md
const DASHBOARD_VIEW_TYPE = "nanalstamp-dashboard";
const DASH_HASH_CAP = 2000;   // 1회 렌더당 해시 계산 상한(대용량 vault 보호 — 초과분은 표기)
const DASH_GAP_ROWS = 8;      // 보호 공백 표시 행 수
const DASH_TL_ROWS = 6;       // 타임라인 표시 폴더 수

class DashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: NanalStampPlugin) { super(leaf); }
  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return t.dashTitle; }
  getIcon(): string { return ICON_ID; }

  // render() 재진입 가드 — refresh 클릭/reveal이 겹치면 오래된 호출이 새 DOM을 덮어쓰지 않도록.
  private renderGen = 0;

  async onOpen(): Promise<void> { await this.render(); }
  async onClose(): Promise<void> { this.contentEl.empty(); }

  // 카드 확대 상태 — 값이 있으면 그 카드만 전체 폭으로 렌더(행 수 상한도 늘어남)
  private zoom: "gaps" | "timeline" | "heat" | "cands" | null = null;

  private card(parent: HTMLElement, title: string, extraCls?: string, zoomKey?: "gaps" | "timeline" | "heat" | "cands"): HTMLElement {
    const zoomed = zoomKey != null && this.zoom === zoomKey;
    const cls = ["nanalstamp-card"];
    if (extraCls) cls.push(extraCls);
    if (zoomed) cls.push("span3", "is-zoom");
    const c = parent.createDiv({ cls: cls.join(" ") });
    const h = c.createEl("h3", { text: title });
    if (zoomKey) {
      const b = h.createEl("button", { cls: "nanalstamp-dash-zoombtn" });
      setIcon(b, zoomed ? "minimize-2" : "maximize-2");
      b.setAttr("aria-label", zoomed ? t.dashCollapse : t.dashExpand);
      b.setAttr("title", zoomed ? t.dashCollapse : t.dashExpand);
      b.onclick = () => { this.zoom = zoomed ? null : zoomKey; void this.render(); };
    }
    return c;
  }

  // 링 게이지(SVG) — 값이 숫자(pct)뿐이라 innerHTML 대신 DOM API(createElementNS)로 직접 구성.
  private buildGauge(pct: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "nanalstamp-dash-gauge";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("width", "148");
    svg.setAttribute("height", "148");
    const track = document.createElementNS(ns, "circle");
    track.setAttribute("cx", "60"); track.setAttribute("cy", "60"); track.setAttribute("r", "50");
    track.setAttribute("fill", "none"); track.setAttribute("stroke", "var(--ns-empty)"); track.setAttribute("stroke-width", "11");
    const arc = document.createElementNS(ns, "circle");
    arc.setAttribute("cx", "60"); arc.setAttribute("cy", "60"); arc.setAttribute("r", "50");
    arc.setAttribute("fill", "none"); arc.setAttribute("stroke", "var(--ns-seal)"); arc.setAttribute("stroke-width", "11");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", `${pct * 3.14} 314`);
    arc.setAttribute("transform", "rotate(-90 60 60)");
    svg.appendChild(track);
    svg.appendChild(arc);
    wrap.appendChild(svg);
    const center = document.createElement("div");
    center.className = "nanalstamp-dash-gauge-center";
    const pctEl = document.createElement("div");
    pctEl.className = "nanalstamp-dash-gauge-pct num";
    pctEl.textContent = `${pct}%`;
    const lblEl = document.createElement("div");
    lblEl.className = "nanalstamp-dash-gauge-lbl";
    lblEl.textContent = t.dashGaugeLabel;
    center.appendChild(pctEl);
    center.appendChild(lblEl);
    wrap.appendChild(center);
    return wrap;
  }

  private monthLabel(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  async render(): Promise<void> {
    const gen = ++this.renderGen;
    const el = this.contentEl;
    el.empty();
    el.addClass("nanalstamp-dash");
    const head = el.createDiv({ cls: "nanalstamp-dash-head" });
    const headText = head.createDiv();
    headText.createEl("p", { text: t.dashTitle, cls: "nanalstamp-dash-title" });
    headText.createEl("p", { text: t.dashSub, cls: "nanalstamp-dash-sub" });
    const refresh = head.createEl("button", { text: t.dashRefresh });
    refresh.onclick = () => void this.render();

    // ── 데이터 수집(전부 로컬) ────────────────────────────────────────────
    const all = this.plugin.app.vault.getMarkdownFiles().filter((f) => this.plugin.dashInScope(f.path));
    const files = all.slice(0, DASH_HASH_CAP);
    const skipped = all.length - files.length;
    const hashes = new Map<string, string>();
    for (const f of files) {
      const h = await this.plugin.currentHashCached(f);
      if (h) hashes.set(f.path, h);
    }
    if (gen !== this.renderGen) return; // 재진입 가드 ① — 해시 계산 중 새 render()가 시작됐으면 중단
    const metas = files.map((f) => ({ path: f.path, mtime: f.stat.mtime }));
    const ledger = this.plugin.settings.ledgerIndex;
    const hashOf = (p: string) => hashes.get(p);
    const cov = coverage(metas, ledger, hashOf);
    const gapList = gaps(metas, ledger, hashOf);

    const entries = await this.plugin.archiveLog();
    if (gen !== this.renderGen) return; // 재진입 가드 ② — 아카이브 로그 조회 중 새 render()가 시작됐으면 중단

    // rename/삭제된 노트의 원장 항목은 표시에서만 제외(원장 자체는 불변) — 아니면
    // 아카이브/미러가 따라잡을 수 없는 "대기 N건" 경고가 영구히 남는다.
    const ledgerLive: Record<string, string> = {};
    for (const [p, h] of Object.entries(ledger)) {
      if (this.plugin.app.vault.getAbstractFileByPath(p)) ledgerLive[p] = h;
    }
    const s = this.plugin.settings;
    const sync = syncStatus(ledgerLive, s.archiveIndex, s.mirrorIndex, entries);
    // 히트맵 카운트: 신규 sealDayCounts 우선, 카운트 도입 전 날짜(sealDays)는 1건으로 보정
    const sealCounts: Record<string, number> = { ...s.sealDayCounts };
    for (const d of s.sealDays) if (!(d in sealCounts)) sealCounts[d] = 1;
    const heatWeeks = heatmapCounts(sealCounts, fmtDate(new Date()), 12);

    // 봉인 전송은 됐지만 아직 ₿ 확정 전인 노트 — 히어로·공백 목록에서 "확정 대기"로 구분 표시.
    // (히어로 미봉인/수정 수치와 "모두 봉인" 수가 안 맞아 보이는 혼동 방지: 959 = 대기 13 + 나머지 946)
    const pendingSeals = new Set<string>();
    let pendModified = 0, pendUnsealed = 0;
    for (const g of gapList) {
      const ph = this.plugin.pendingSealHash(g.path);
      if (ph && ph === hashes.get(g.path)) {
        pendingSeals.add(g.path);
        if (g.kind === "modified") pendModified++; else pendUnsealed++;
      }
    }

    // 확대 모드: 선택한 카드 하나만 전체 폭으로 (히어로·다른 카드 생략, 헤더의 새로고침은 유지)
    if (this.zoom && this.plugin.isPro()) {
      const zgrid = el.createDiv({ cls: "nanalstamp-dash-grid3" });
      if (this.zoom === "gaps") this.renderGapsCard(zgrid, gapList, pendingSeals);
      else if (this.zoom === "timeline") this.renderTimelineCard(zgrid, entries);
      else if (this.zoom === "heat") this.renderHeatmapCard(zgrid, heatWeeks);
      else if (this.zoom === "cands") this.renderCandidatesCard(zgrid, entries);
      return;
    }

    this.renderHero(el, cov, sync, heatWeeks, skipped, pendModified, pendUnsealed);

    const grid = el.createDiv({ cls: "nanalstamp-dash-grid3" });
    if (this.plugin.isPro()) {
      this.renderGapsCard(grid, gapList, pendingSeals);
      this.renderFunnelCard(grid, sync);
      // 잔디는 내용 폭(12주)에 딱 맞게, 타임라인이 그 줄의 남는 폭 전부 — 여백 없는 한 줄
      const row2 = grid.createDiv({ cls: "nanalstamp-dash-row2 span3" });
      this.renderHeatmapCard(row2, heatWeeks);
      this.renderTimelineCard(row2, entries);
      this.renderCandidatesCard(grid, entries);
    } else {
      // FREE 티저: 히어로(커버리지·KPI)는 그대로 보여주고, 카드 5장 자리는 잠금 + 상태 문장으로 훅.
      // 봉인·검증은 게이트하지 않는다 — 잠기는 건 '보기 좋은 집계'뿐(가격 철학과 일치).
      const locked = grid.createDiv({ cls: "nanalstamp-card is-locked" });
      locked.createEl("h3", { text: `${t.dashGaps} · ${t.dashTimeline} · ${t.dashCands}` });
      locked.createDiv({ cls: "nanalstamp-dash-warn", text: t.dashLockedGaps(gapList.length) });
      locked.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashLockedDesc });
      const btn = locked.createEl("button", { cls: "mod-cta", text: t.dashBuyPro });
      btn.onclick = () => this.plugin.openExternal("/pricing");
    }
  }

  // 히어로 카드: 링 게이지 + KPI 4개 + 조성(스택) 바. FREE/PRO 공통으로 항상 보인다.
  private renderHero(
    el: HTMLElement,
    cov: ReturnType<typeof coverage>,
    sync: ReturnType<typeof syncStatus>,
    heatWeeks: ReturnType<typeof heatmapCounts>,
    skipped: number,
    pendModified: number,
    pendUnsealed: number,
  ): void {
    const hero = el.createDiv({ cls: "nanalstamp-card nanalstamp-dash-hero" });
    hero.appendChild(this.buildGauge(cov.pct));

    const right = hero.createDiv({ cls: "nanalstamp-dash-hero-right" });
    const kpis = right.createDiv({ cls: "nanalstamp-dash-kpis" });

    // "확정 대기"(전송됨·미확정)를 수정/미봉인에서 분리해 표시 — 공백 총수와 "모두 봉인" 수가 눈으로 맞아떨어지게.
    const pending = pendModified + pendUnsealed;
    const modLeft = cov.modified - pendModified;
    const unsLeft = cov.unsealed - pendUnsealed;
    const gapCount = cov.modified + cov.unsealed;
    const kGap = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kGap.createDiv({ cls: "k", text: t.dashGaps });
    kGap.createDiv({ cls: "v num nanalstamp-dash-warn", text: `${gapCount}` });
    kGap.createDiv({ cls: "d", text: pending > 0
      ? `${t.dashLegendPending} ${pending} · ${t.dashKindModified} ${modLeft} · ${t.dashKindUnsealed} ${unsLeft}`
      : `${t.dashKindModified} ${cov.modified} · ${t.dashKindUnsealed} ${cov.unsealed}` });

    const kConfirmed = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kConfirmed.createDiv({ cls: "k", text: t.dashKpiConfirmed });
    kConfirmed.createDiv({ cls: "v num", text: `${sync.confirmed}` });

    const kBlock = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kBlock.createDiv({ cls: "k", text: t.dashKpiLatestBlock });
    kBlock.createDiv({ cls: "v num", text: sync.latestBlock ? `#${sync.latestBlock}` : "—" });

    const flatDays = heatWeeks.flat().filter((c) => !c.future);
    const sealedDays = flatDays.filter((c) => c.count > 0).length;
    const kSeal = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kSeal.createDiv({ cls: "k", text: t.dashKpiSealDays });
    kSeal.createDiv({ cls: "v num", text: `${sealedDays}` });
    kSeal.createDiv({ cls: "d", text: t.dashDaysOf(sealedDays, flatDays.length) });

    const comp = right.createDiv({ cls: "nanalstamp-dash-comp" });
    const total = cov.total || 1;
    const c1 = comp.createDiv({ cls: "c1" }); c1.style.width = `${(cov.covered / total) * 100}%`;
    if (pending > 0) { const cp = comp.createDiv({ cls: "cp" }); cp.style.width = `${(pending / total) * 100}%`; }
    const c2 = comp.createDiv({ cls: "c2" }); c2.style.width = `${(modLeft / total) * 100}%`;
    const c3 = comp.createDiv({ cls: "c3" }); c3.style.width = `${(unsLeft / total) * 100}%`;

    const legend = right.createDiv({ cls: "nanalstamp-dash-comp-legend" });
    const addLegend = (color: string, label: string, n: number) => {
      const item = legend.createSpan({ cls: "nanalstamp-dash-legend-item" });
      const sw = item.createSpan({ cls: "nanalstamp-dash-sw" });
      sw.style.background = color;
      item.createSpan({ text: `${label} ` });
      item.createEl("b", { cls: "num", text: `${n}` });
    };
    addLegend("var(--ns-seal)", t.dashLegendCovered, cov.covered);
    if (pending > 0) addLegend("var(--ns-info)", t.dashLegendPending, pending);
    addLegend("var(--ns-warn)", t.dashLegendModified, modLeft);
    addLegend("var(--ns-empty)", t.dashLegendUnsealed, unsLeft);

    if (skipped > 0) right.createDiv({ cls: "nanalstamp-dash-hero-skip", text: t.dashSkipped(skipped) });
  }

  // 카드 1(span2) — 보호 공백: 수정됨 먼저, 미봉인 다음(gaps()가 이미 그 순서로 정렬).
  // pendingSeals: 봉인 전송은 됐지만 ₿ 확정 전 — "확정 대기"로 표시하고 일괄/개별 봉인 대상에서 제외.
  private renderGapsCard(grid: HTMLElement, gapList: Gap[], pendingSeals: Set<string>): void {
    const c = this.card(grid, `${t.dashGaps} (${gapList.length})`, this.zoom === "gaps" ? undefined : "span2", "gaps");
    if (!gapList.length) { c.createDiv({ cls: "nanalstamp-dash-mut", text: "✓" }); return; }
    // 일괄 봉인 버튼은 제거 — 백그라운드 백필이 자동으로 처리하므로 잉여(병목은 어차피 앵커 확정 시간).
    const toSeal = gapList.filter((g) => !pendingSeals.has(g.path));
    if (this.plugin.settings.autoBackfill && toSeal.length > 0) {
      c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashBackfillLeft(toSeal.length) });
    }
    const now = Date.now();
    const rowCap = this.zoom === "gaps" ? 100 : DASH_GAP_ROWS;
    for (const g of gapList.slice(0, rowCap)) {
      const pending = pendingSeals.has(g.path);
      const r = c.createDiv({ cls: "nanalstamp-dash-gaprow" });
      r.createDiv({ cls: `nanalstamp-dash-stripe ${g.kind === "modified" && !pending ? "warn" : "empty"}` });
      const name = r.createSpan({ cls: "path", text: g.path });
      name.onclick = () => {
        const f = this.plugin.app.vault.getAbstractFileByPath(g.path);
        if (f instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(f);
      };
      if (pending) {
        r.createSpan({ cls: "nanalstamp-dash-chip info", text: t.dashKindPending });
        continue; // 이미 전송됨 — 봉인 버튼 없음
      }
      const chip = r.createSpan({ cls: `nanalstamp-dash-chip ${g.kind === "modified" ? "warn" : "gray"}` });
      if (g.kind === "modified") {
        const hrs = (now - g.mtime) / 3_600_000;
        chip.setText(hrs < 24 ? t.dashAgoHours(Math.max(1, Math.round(hrs))) : t.dashAgoDays(Math.round(hrs / 24)));
      } else {
        chip.setText(t.dashKindUnsealed);
      }
      const btn = r.createEl("button", { text: t.dashSealNow });
      btn.onclick = () => {
        if (!this.plugin.settings.apiKey) { new Notice(t.apiKeyMissing); return; }
        if (!this.plugin.settings.enabled) { new Notice(t.offTitle); return; }
        const f = this.plugin.app.vault.getAbstractFileByPath(g.path);
        if (f instanceof TFile) {
          btn.disabled = true;
          // 봉인 완료 후 재렌더 — 행이 "확정 대기" 칩으로 즉시 바뀌게(수동 새로고침 불필요)
          void this.plugin.flush(f, "manual").then(() => void this.render());
        }
      };
    }
    if (gapList.length > rowCap) {
      c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashMore(gapList.length - rowCap) });
    }
  }

  // 카드 2 — 앵커 파이프라인: ₿ 확정 → 로컬 아카이브 → GitHub 미러.
  private renderFunnelCard(grid: HTMLElement, sync: ReturnType<typeof syncStatus>): void {
    const c = this.card(grid, t.dashSync, "nanalstamp-dash-funnel");
    const archiveOn = this.plugin.dashboardArchiveOn();
    const mirrorOn = this.plugin.mirrorActive();
    const archived = Math.max(0, sync.confirmed - sync.archivePending);
    const mirrored = Math.max(0, sync.confirmed - sync.mirrorPending);
    const max = Math.max(sync.confirmed, 1);
    const row = (label: string, value: number, color: string) => {
      const fr = c.createDiv({ cls: "frow" });
      fr.createSpan({ cls: "fk", text: label });
      const bar = fr.createDiv({ cls: "fbar" });
      bar.style.width = `${(value / max) * 100}%`;
      bar.style.background = color;
      fr.createSpan({ cls: "fv num", text: `${value}` });
    };
    row(t.dashFunnelConfirmed, sync.confirmed, "#6da7ec");
    if (archiveOn) row(t.dashFunnelArchive, archived, "#3987e5");
    else c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive });
    if (mirrorOn) row(t.dashFunnelMirror, mirrored, "#1c5cab");

    const chips = c.createDiv({ cls: "nanalstamp-dash-chips" });
    if (archiveOn) chips.createSpan({ cls: `nanalstamp-dash-chip ${sync.archivePending ? "warn" : "gray"}`, text: t.dashArcPending(sync.archivePending) });
    if (mirrorOn) chips.createSpan({ cls: `nanalstamp-dash-chip ${sync.mirrorPending ? "warn" : "gray"}`, text: t.dashMirPending(sync.mirrorPending) });
  }

  // 카드 3 — IP 타임라인: 폴더별 가로 스팬 바(최초 앵커 ~ 최근 활동), 축은 시작 월 ~ 현재 월.
  private renderTimelineCard(grid: HTMLElement, entries: ArchiveEntry[]): void {
    const c = this.card(grid, t.dashTimeline, undefined, "timeline");
    if (!this.plugin.dashboardArchiveOn()) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive }); return; }
    if (!entries.length) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashEmpty }); return; }
    const rows = timeline(entries).slice(0, this.zoom === "timeline" ? 24 : DASH_TL_ROWS);
    const withTs = rows.filter((r) => r.firstTs > 0);
    const now = Date.now();
    const globalMin = withTs.length ? Math.min(...withTs.map((r) => r.firstTs)) : now;
    const span = Math.max(now - globalMin, 1);
    const tl = c.createDiv({ cls: "nanalstamp-dash-tl" });
    for (const row of rows) {
      tl.createSpan({ cls: "name", text: row.folder });
      const track = tl.createDiv({ cls: "track" });
      if (row.firstTs > 0) {
        const left = Math.min(Math.max(((row.firstTs - globalMin) / span) * 100, 0), 98);
        const rawWidth = ((Math.max(row.lastTs, row.firstTs) - row.firstTs) / span) * 100;
        const width = Math.min(Math.max(rawWidth, 2), 100 - left);
        const barEl = track.createDiv({ cls: "span" });
        barEl.style.left = `${left}%`;
        barEl.style.width = `${width}%`;
        // 라벨은 바가 충분히 넓을 때만 안에, 좁으면 바 밖(오른쪽, 끝에 붙으면 왼쪽)에 잉크색으로.
        const labelText = `₿#${row.firstBlock}`;
        if (width >= 30) {
          barEl.createSpan({ cls: "blk num", text: labelText });
        } else {
          const out = track.createSpan({ cls: "blk-out num", text: labelText });
          if (left + width <= 60) out.style.left = `calc(${left + width}% + 6px)`;
          else out.style.right = `calc(${100 - left}% + 6px)`;
        }
      }
    }
    const axis = tl.createDiv({ cls: "axis" });
    axis.createSpan({ text: this.monthLabel(new Date(globalMin)) });
    axis.createSpan({ text: this.monthLabel(new Date(now)) });
  }

  // 카드 4 — 봉인 연속성 히트맵(이진: 그날 봉인 있었나), 좌측 요일 레일.
  // GitHub 잔디 스타일: 열=달력 주, 상단 월 라벨, 좌측 월/수/금 라벨, 5단계 농도 + 범례.
  private renderHeatmapCard(grid: HTMLElement, heatWeeks: ReturnType<typeof heatmapCounts>): void {
    const c = this.card(grid, t.dashHeatmap, undefined, "heat");
    const totalSeals = heatWeeks.flat().reduce((a, x) => a + x.count, 0);
    c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashHeatTotal(totalSeals) });
    const wrap = c.createDiv({ cls: "nanalstamp-dash-heat-wrap" });
    const days = wrap.createDiv({ cls: "nanalstamp-dash-heat-days" });
    // 행 0/2/4(월·수·금)에만 라벨 — GitHub 방식
    for (let r = 0; r < 7; r++) days.createSpan({ text: r === 0 ? t.dashWeekdays[0] : r === 2 ? t.dashWeekdays[1] : r === 4 ? t.dashWeekdays[2] : "" });
    const right = wrap.createDiv({ cls: "nanalstamp-dash-heat-right" });
    const months = right.createDiv({ cls: "nanalstamp-dash-heat-months" });
    let prevMonth = "";
    for (const week of heatWeeks) {
      const m = week[0].date.slice(5, 7);
      const slot = months.createSpan();
      if (m !== prevMonth) { slot.setText(t.dashMonthLbl(parseInt(m, 10))); prevMonth = m; }
    }
    const heat = right.createDiv({ cls: "nanalstamp-dash-heat" });
    for (const week of heatWeeks) {
      const col = heat.createDiv({ cls: "wk" });
      for (const cell of week) {
        const d = col.createDiv({ cls: `cell l${cell.level}` + (cell.future ? " is-future" : "") });
        if (!cell.future) d.setAttr("title", t.dashHeatCellTip(cell.date, cell.count));
      }
    }
    const legend = c.createDiv({ cls: "nanalstamp-dash-heat-legend" });
    legend.createSpan({ cls: "nanalstamp-dash-mut", text: t.dashHeatLess });
    for (let l = 0; l <= 4; l++) legend.createDiv({ cls: `cell l${l}` });
    legend.createSpan({ cls: "nanalstamp-dash-mut", text: t.dashHeatMore });
  }

  // 카드 5 — 증명서 후보(봉인 이력이 깊은 노트 → P6 버전 모달). 미니바는 최대 8칸.
  private renderCandidatesCard(grid: HTMLElement, entries: ArchiveEntry[]): void {
    const c = this.card(grid, t.dashCands, "nanalstamp-dash-cand span3", "cands");
    if (!this.plugin.dashboardArchiveOn()) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive }); return; }
    const cands = certCandidates(entries, this.zoom === "cands" ? 20 : 5);
    if (!cands.length) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashEmpty }); return; }
    for (const cand of cands) {
      // 파일명을 앞세우고(경로는 툴팁·보조줄) 이력 요약을 곁들인다 — 긴 폴더 경로가 전부 같아 보이는 문제 방지.
      const base = cand.notePath.split("/").pop() ?? cand.notePath;
      const slash = cand.notePath.lastIndexOf("/");
      const folder = slash === -1 ? "(root)" : cand.notePath.slice(0, slash);
      const nm = c.createDiv({ cls: "nm" });
      nm.setAttr("title", cand.notePath);
      nm.createDiv({ text: base });
      nm.createDiv({ cls: "nanalstamp-dash-mut", text: `${folder} · ${t.dashCandDesc(cand.versions, cand.spanDays, cand.firstBlock)}` });
      const depth = c.createDiv({ cls: "depth" });
      const filled = Math.min(cand.versions, 8);
      for (let i = 0; i < 8; i++) {
        const dot = depth.createDiv();
        dot.setAttr("title", t.dashCandDesc(cand.versions, cand.spanDays, cand.firstBlock));
        if (i >= filled) dot.addClass("e");
      }
      const btn = c.createEl("button", { text: t.dashOpenVersions });
      btn.onclick = () => {
        const f = this.plugin.app.vault.getAbstractFileByPath(cand.notePath);
        if (f instanceof TFile) void this.plugin.openArchiveModalFor(f);
      };
    }
  }
}

// 비밀번호 재설정 모달 — 이메일 입력 → 재설정 메일 요청(웹 /reset?token=…에서 완료).
// 커맨드 팔레트 "비밀번호 재설정"에서 열린다. 로그인 안 된 상태에서도 사용 가능.
class PasswordResetModal extends Modal {
  private email = "";
  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.resetModalTitle });
    contentEl.createEl("p", { text: t.resetDesc, cls: "setting-item-description" });
    new Setting(contentEl)
      .setName(t.emailPlaceholder)
      .addText((tx) => { tx.setPlaceholder(t.emailPlaceholder).onChange((v) => (this.email = v.trim())); (tx.inputEl as HTMLInputElement).type = "email"; });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.resetOpenBtn).onClick(() => this.plugin.openExternal("/reset")))
      .addButton((b) => b.setButtonText(t.resetSendBtn).setCta().onClick(async () => {
        if (!this.email) { new Notice(t.resetNeedEmail); return; }
        try { await this.plugin.accountResetRequest(this.email); new Notice(t.resetSent(this.email)); this.close(); }
        catch (e: any) { new Notice(t.resetFail(e?.message ?? String(e))); }
      }));
  }
  onClose() {
    this.contentEl.empty();
  }
}

// GitHub OAuth Device Flow 연결 모달 — PAT 없이 "연결 클릭 + GitHub 승인 한 번"으로
// 토큰 획득 → 로그인명 조회 → private repo(nanalstamp-vault) 자동 준비 → 미러 on.
// 프리즈 재발 방지: 모든 네트워크·폴링·진행표시는 설정 display()가 아니라 이 모달에서만 처리한다.
class GitHubConnectModal extends Modal {
  private cancelled = false;
  private pollTimer?: number;
  private deviceCode = "";
  private interval = 5;      // 폴링 주기(초). slow_down 시 +5.
  private deadline = 0;      // expires_in 만료 시각(ms)
  private waitEl?: HTMLElement;
  constructor(app: App, private plugin: NanalStampPlugin, private onDone: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    // Client ID 미설정(오너 설정 전) → 안내 후 닫기만 제공
    if (!GITHUB_OAUTH_CLIENT_ID) {
      contentEl.createEl("p", { text: t.ghNoClient, cls: "setting-item-description" });
      new Setting(contentEl).addButton((b) => b.setButtonText(t.ghCloseBtn).setCta().onClick(() => this.close()));
      return;
    }
    void this.start();
  }

  onClose() {
    this.cancelled = true; // 폴링 루프 취소
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    this.contentEl.empty();
  }

  // 취소 가능한 sleep(모달 닫으면 타이머 정리)
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.pollTimer = window.setTimeout(resolve, ms); });
  }

  // ① 디바이스 코드 요청 → 안내 렌더 → 폴링 시작
  private async start() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: t.ghRequesting, cls: "setting-item-description" });
    try {
      const res = await requestUrl({
        url: "https://github.com/login/device/code",
        method: "POST",
        headers: { "Accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: `client_id=${encodeURIComponent(GITHUB_OAUTH_CLIENT_ID)}&scope=repo`,
        throw: false,
      });
      if (this.cancelled) return;
      const j = res.json;
      if (res.status !== 200 || !j?.device_code || !j?.user_code) {
        this.showRetry(t.ghDeviceFail);
        return;
      }
      this.deviceCode = j.device_code;
      this.interval = Math.max(5, Number(j.interval) || 5);
      this.deadline = Date.now() + (Number(j.expires_in) || 900) * 1000;
      this.renderCode(String(j.user_code), String(j.verification_uri || "https://github.com/login/device"));
      void this.poll();
    } catch (e: any) {
      if (!this.cancelled) this.showRetry(t.ghErr(e?.message ?? String(e)));
    }
  }

  // 코드·GitHub 열기·대기 안내를 단계별로 렌더(동기)
  private renderCode(userCode: string, verifyUri: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    // ① 코드(모노스페이스, 크게) + 자동 클립보드 복사(실패 무시)
    contentEl.createEl("p", { text: t.ghStep1, cls: "setting-item-name" });
    const code = contentEl.createEl("div", { text: userCode });
    code.style.fontFamily = "ui-monospace, Menlo, monospace";
    code.style.fontSize = "2.2rem";
    code.style.fontWeight = "700";
    code.style.letterSpacing = "0.25em";
    code.style.textAlign = "center";
    code.style.margin = "0.4rem 0 1.1rem";
    code.style.userSelect = "all";
    try { void navigator.clipboard.writeText(userCode); } catch (_) { /* ignore */ }
    // ② GitHub 열기
    new Setting(contentEl)
      .setName(t.ghStep2)
      .addButton((b) => b.setButtonText(t.ghStep2Btn).setCta().onClick(() => window.open(verifyUri, "_blank")));
    // ③ 승인 안내 + 진행 표시
    contentEl.createEl("p", { text: t.ghStep3, cls: "setting-item-description" });
    this.waitEl = contentEl.createEl("p", { text: t.ghWaiting, cls: "setting-item-description" });
  }

  // ② interval초마다 토큰 폴링. 모달 닫히면(cancelled) 중단.
  private async poll() {
    while (!this.cancelled) {
      await this.sleep(this.interval * 1000);
      if (this.cancelled) return;
      if (Date.now() > this.deadline) { this.showRetry(t.ghExpired); return; }
      let j: any;
      try {
        const res = await requestUrl({
          url: "https://github.com/login/oauth/access_token",
          method: "POST",
          headers: { "Accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: `client_id=${encodeURIComponent(GITHUB_OAUTH_CLIENT_ID)}&device_code=${encodeURIComponent(this.deviceCode)}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
          throw: false,
        });
        j = res.json;
      } catch (_) {
        continue; // 일시적 네트워크 오류 → 다음 주기에 재시도
      }
      if (this.cancelled) return;
      if (j?.access_token) { await this.onToken(String(j.access_token)); return; }
      const err = j?.error;
      if (err === "authorization_pending") continue;
      if (err === "slow_down") { this.interval += 5; continue; }
      if (err === "expired_token") { this.showRetry(t.ghExpired); return; }
      if (err === "access_denied") { this.showRetry(t.ghDenied); return; }
      this.showRetry(t.ghErr(j?.error_description || err || "unknown"));
      return;
    }
  }

  // ③ 토큰 획득 후: 로그인명 조회 → repo 준비 → 미러 on → 저장 → 성공 표시
  private async onToken(token: string) {
    if (this.waitEl) this.waitEl.setText(t.ghPreparing);
    this.plugin.settings.githubPat = token;
    // 로그인명(GET /user)
    let login = "";
    try {
      const u = await requestUrl({
        url: "https://api.github.com/user",
        method: "GET",
        headers: this.ghHeaders(token),
        throw: false,
      });
      login = u.status === 200 ? String(u.json?.login ?? "") : "";
    } catch (_) { /* ignore */ }
    if (this.cancelled) return;
    if (!login) {
      // 토큰은 저장하되(수동 repo 지정으로 미러 가능) user 조회 실패 안내
      await this.plugin.saveSettings();
      this.showRetry(t.ghUserFail);
      return;
    }
    this.plugin.settings.githubUser = login;
    // repo 자동 준비 — githubRepo가 비었을 때만(사용자가 이미 지정했으면 존중)
    if (!this.plugin.settings.githubRepo.trim()) {
      const ok = await this.ensureRepo(token, login);
      if (this.cancelled) return;
      if (!ok) {
        // 연결은 유지(내보내기 on), repo만 수동 지정 안내
        this.plugin.settings.githubExport = true;
        await this.plugin.saveSettings();
        this.onDone();
        this.showRetry(t.ghRepoFail);
        return;
      }
    }
    // GitHub 연결 완료 — 내보내기(탈출구) 켜기
    this.plugin.settings.githubExport = true;
    await this.plugin.saveSettings();
    this.showSuccess(login, this.plugin.settings.githubRepo);
  }

  private ghHeaders(token: string): Record<string, string> {
    return { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  }

  // nanalstamp-vault 확인(없으면 private·auto_init로 생성). 성공 시 settings.githubRepo 설정.
  private async ensureRepo(token: string, login: string): Promise<boolean> {
    const headers = this.ghHeaders(token);
    const full = `${login}/${GITHUB_DEFAULT_REPO}`;
    try {
      const get = await requestUrl({ url: `https://api.github.com/repos/${full}`, method: "GET", headers, throw: false });
      if (get.status === 200) { this.plugin.settings.githubRepo = full; return true; } // 이미 있음
      if (get.status === 404) {
        const create = await requestUrl({
          url: "https://api.github.com/user/repos",
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: GITHUB_DEFAULT_REPO, private: true, auto_init: true }),
          throw: false,
        });
        if (create.status === 201) { this.plugin.settings.githubRepo = full; return true; }
        return false;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  private showSuccess(login: string, repo: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: t.ghSuccess(login, repo), cls: "setting-item-name" });
    new Setting(contentEl).addButton((b) => b.setButtonText(t.ghCloseBtn).setCta().onClick(() => this.close()));
    this.onDone(); // 설정 화면을 '연결됨' 상태로 갱신
  }

  // 실패/만료/거부 → 메시지 + 닫기·재시도
  private showRetry(msg: string) {
    if (this.cancelled) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t.ghModalTitle });
    contentEl.createEl("p", { text: msg, cls: "mod-warning" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t.ghCloseBtn).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t.ghRetryBtn).setCta().onClick(() => { this.cancelled = false; void this.start(); }));
  }
}
