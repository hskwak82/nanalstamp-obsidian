import { arrayBufferToBase64 } from "obsidian";
import { archiveDirNameForVault } from "./archivepath";

// pathutil.ts — 해시·경로·파일명 순수 함수 + Node(데스크탑) lazy require. main.ts에서 순수 이동(2026-07-26).
// 모듈 어디서나 필요하고 main.ts의 상태에 의존하지 않는다 — 값 순환 참조를 만들지 않는 위치.

// Node 모듈 최소 타입 — 이 플러그인이 실제 부르는 표면만 선언한다(@types/node 미사용).
// 콜백형 멤버(readFile 등)는 isomorphic-git FsClient 구조 호환용으로만 존재한다.
export interface NodeFs {
  readFile: (...args: unknown[]) => unknown; writeFile: (...args: unknown[]) => unknown;
  unlink: (...args: unknown[]) => unknown; readdir: (...args: unknown[]) => unknown;
  mkdir: (...args: unknown[]) => unknown; rmdir: (...args: unknown[]) => unknown;
  stat: (...args: unknown[]) => unknown; lstat: (...args: unknown[]) => unknown;
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  readFileSync(p: string): Uint8Array;
  writeFileSync(p: string, data: string | Uint8Array, enc?: "utf8"): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readdirSync(p: string): string[];
  copyFileSync(src: string, dst: string): void;
  cpSync(src: string, dst: string, opts?: { recursive?: boolean }): void;
  statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
  chmodSync(p: string, mode: number): void;
  accessSync(p: string, mode?: number): void;
  constants: { W_OK: number };
  openSync(p: string, flags: string): number;
  readSync(fd: number, buf: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}
export interface NodePath {
  join(...p: string[]): string;
  dirname(p: string): string;
  resolve(...p: string[]): string;
  sep: string;
}
export interface NodeHash { update(d: string | Uint8Array, enc?: "utf8"): NodeHash; digest(enc: "hex"): string }
export interface ElectronRemote {
  dialog?: {
    showOpenDialog(opts: { properties: string[] }): Promise<{ canceled: boolean; filePaths?: string[] }>;
  };
}

// window.require는 데스크탑에만 존재 → 모듈 로드 시 정적 접근하면 모바일에서 플러그인
// 전체 로드가 깨진다. 그래서 lazy로 필요 시점에만 require한다.
export function nodeReq(mod: "fs"): NodeFs;
export function nodeReq(mod: "path"): NodePath;
export function nodeReq(mod: "os"): { homedir(): string };
export function nodeReq(mod: "crypto"): { createHash(alg: string): NodeHash };
export function nodeReq(mod: "@electron/remote"): ElectronRemote;
export function nodeReq(mod: string): unknown;
export function nodeReq(mod: string): unknown {
  const r = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!r) throw new Error("Node require unavailable (desktop only)");
  return r(mod);
}
// 기본 아카이브 경로: 홈 아래 nanalStamp-archive-<vault>/ (동기화 폴더 밖 권장).
// vault 이름을 붙이는 이유는 archivepath.ts 참조 — 한 기기에서 vault 를 둘 쓰면
// 기본값 하나로는 두 vault 가 같은 repo 를 쓰게 된다.
// **이미 설정된 경로는 이 함수를 거치지 않는다**(settings.archivePath 가 비었을 때만 채운다).
export function defaultArchivePath(vaultName?: string): string {
  const os = nodeReq("os");
  const path = nodeReq("path");
  return path.join(os.homedir(), archiveDirNameForVault(vaultName || ""));
}
// 플레이스홀더 표시용(실패해도 렌더가 안 깨지게 "" 반환).
export function defaultArchivePathSafe(vaultName?: string): string {
  try { return defaultArchivePath(vaultName); } catch { return ""; }
}

// catch 변수는 unknown(strict) — 메시지 추출을 한 곳으로 모아 `catch (e: any)` 를 없앤다.
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function parseFolders(s: string): string[] {
  return s.split(/[\n,]/).map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}
// ArrayBufferView(제네릭 기본 ArrayBufferLike)도 받도록 — Uint8Array<ArrayBufferLike>(TextEncoder·복호 출력)의 캐스트 잡음 제거
export async function sha256HexBytes(buf: ArrayBuffer | ArrayBufferView): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

// 파일 경로도 원문 대신 해시로만 전송 → 서버에 폴더/파일명이 남지 않음.
// 도메인 분리 프리픽스로 콘텐츠 해시와 혼동 방지. 경로 공개 시 동일하게 재계산해 커밋먼트 검증 가능.
export const PATH_HASH_PREFIX = "nanalstamp/path/v1\n";
// vault 이름 해시 — "vault" 도메인의 복호 키 파생 인자(수렴 계약: 해시가 이름을 유일 결정).
export const VAULT_HASH_PREFIX = "nanalstamp/vault/v1\n";
export async function hashVaultName(n: string): Promise<string> {
  return sha256Hex(VAULT_HASH_PREFIX + n);
}
export async function hashPath(p: string): Promise<string> {
  return sha256Hex(PATH_HASH_PREFIX + p);
}

// UTF-8 문자열 → base64(GitHub Contents API content 필드용). btoa는 유니코드를 못 다뤄 사용 불가.
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return arrayBufferToBase64(bytes.buffer);
}

// 노트 경로를 파일/URL 안전한 평면 이름으로 변환(폴더 구분은 __로 평탄화, .md 제거).
// 로컬 원장 파일명과 GitHub notes//proofs/ 하위 경로에 공통으로 쓴다(원본·증명 이름 정렬).
// 경로 문자열에서 파일명/확장자만 뽑는다(TFile 없이 leaf state의 notePath로 작업할 때 사용).
export function basenameOf(p: string): string {
  const name = p.split(/[\\/]/).pop() || p;
  return name.replace(/\.[^.]+$/, "") || name;
}
export function extOf(p: string): string {
  const name = p.split(/[\\/]/).pop() || p;
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1] : "";
}

// B: Excalidraw 노트 감지 — 경로가 .excalidraw(.md)로 끝나거나, frontmatter 블록 안에 excalidraw-plugin: 키가 있으면.
// 내용 스니핑은 첫 --- ... --- 블록으로 한정 — 본문 코드블록에 인용된 "excalidraw-plugin:" 오탐 방지.
// ArchiveSourceView가 "Excalidraw로 열기(사본)" 버튼을 낼지 판단하는 데 쓴다.
export function isExcalidrawNote(notePath: string, content?: string): boolean {
  if (/\.excalidraw(\.md)?$/i.test(notePath)) return true;
  if (!content || !content.startsWith("---")) return false;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return !!m && m[1].includes("excalidraw-plugin:");
}

// B: Excalidraw 사본 파일명 분리 — .excalidraw.md 같은 복합 확장자를 하나로 취급(일반 확장자는 마지막 점 기준).
export function splitExcalidrawName(fullName: string): { base: string; ext: string } {
  const m = /^(.*?)(\.excalidraw\.md|\.excalidraw|\.md)$/i.exec(fullName);
  if (m) return { base: m[1], ext: m[2] };
  const i = fullName.lastIndexOf(".");
  return i > 0 ? { base: fullName.slice(0, i), ext: fullName.slice(i) } : { base: fullName, ext: "" };
}

export function safeName(notePath: string): string {
  const noExt = notePath.replace(/\.md$/i, "");
  return (
    noExt
      .replace(/[\\/]+/g, "__") // 폴더 구분 평탄화
      .replace(/[:*?"<>|#%]/g, "_") // 파일시스템/URL 위험 문자
      .replace(/\s+/g, " ")
      .trim() || "note"
  );
}
