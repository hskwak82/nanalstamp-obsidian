// 봉인 노트 브라우저 코어 — /attest/notes 응답 파싱·표시 판정. 순수(node --test 검증).
// 설계: docs/superpowers/specs/2026-07-22-mobile-seal-note-browser-design.md D-2

export interface NoteRow {
  pathHash: string;        // 경로해시 64hex — 이름 복호 키 파생 인자
  encName: string | null;  // NSE1 "name" 암호문 base64 (구 봉인은 null)
  seq: number;
  receivedAt: number;      // epoch 초
  fileHash: string;        // 최신 봉인 원문 해시 — S3 열람 키
  block: number | null;    // 확정 블록(대기면 null)
  vaultHash: string | null; // vault 식별 해시(복호 키 파생 인자) — 구 봉인은 null
  encVault: string | null;  // NSE1 "vault" 암호문 base64
}

export interface VaultRow {
  vaultHash: string;
  encVault: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseNotesResponse(j: unknown): { rows: NoteRow[]; hasMore: boolean } {
  const o = j as { rows?: unknown; has_more?: unknown } | null;
  const out: NoteRow[] = [];
  if (o && Array.isArray(o.rows)) {
    for (const raw of o.rows as Array<Record<string, unknown>>) {
      if (typeof raw?.path_hash !== "string" || !HEX64.test(raw.path_hash)) continue;
      if (typeof raw.file_hash !== "string" || !HEX64.test(raw.file_hash)) continue;
      if (typeof raw.seq !== "number" || typeof raw.received_at !== "number") continue;
      out.push({
        pathHash: raw.path_hash,
        encName: typeof raw.enc_name === "string" && raw.enc_name.length > 0 ? raw.enc_name : null,
        seq: raw.seq,
        receivedAt: raw.received_at,
        fileHash: raw.file_hash,
        block: typeof raw.block === "number" ? raw.block : null,
        vaultHash: typeof raw.vault_hash === "string" && HEX64.test(raw.vault_hash) ? raw.vault_hash : null,
        encVault: typeof raw.enc_vault === "string" && raw.enc_vault.length > 0 ? raw.enc_vault : null,
      });
    }
  }
  return { rows: out, hasMore: o?.has_more === true };
}

// 복호된 이름 → 표시 조각. 이름 없으면(구 봉인·복호 실패) 해시 8자 + 열람 불가(확장자 불명 — 정직하게).
export function rowDisplay(row: NoteRow, name: string | null): { folder: string; file: string; canOpen: boolean; isMd: boolean } {
  if (!name) return { folder: "", file: row.pathHash.slice(0, 8), canOpen: false, isMd: false };
  const i = name.lastIndexOf("/");
  return {
    folder: i >= 0 ? name.slice(0, i) : "",
    file: i >= 0 ? name.slice(i + 1) : name,
    canOpen: true,
    isMd: name.toLowerCase().endsWith(".md"),
  };
}

// /attest/vaults 응답 파싱 — 불량 항목 스킵.
export function parseVaultsResponse(j: unknown): VaultRow[] {
  const o = j as { vaults?: unknown } | null;
  const out: VaultRow[] = [];
  if (o && Array.isArray(o.vaults)) {
    for (const raw of o.vaults as Array<Record<string, unknown>>) {
      if (typeof raw?.vault_hash !== "string" || !HEX64.test(raw.vault_hash)) continue;
      if (typeof raw.enc_vault !== "string" || raw.enc_vault.length === 0) continue;
      out.push({ vaultHash: raw.vault_hash, encVault: raw.enc_vault });
    }
  }
  return out;
}

// /attest/history 응답 파싱(브라우저 버전 이력 모달용) — 행: seq·received_at·file_hash·block.
export interface HistRow {
  seq: number;
  receivedAt: number;
  fileHash: string;
  block: number | null;
}

export function parseHistoryResponse(j: unknown): { rows: HistRow[]; hasMore: boolean } {
  const o = j as { rows?: unknown; has_more?: unknown } | null;
  const out: HistRow[] = [];
  if (o && Array.isArray(o.rows)) {
    for (const raw of o.rows as Array<Record<string, unknown>>) {
      if (typeof raw?.seq !== "number" || typeof raw.received_at !== "number") continue;
      if (typeof raw.file_hash !== "string" || !HEX64.test(raw.file_hash)) continue;
      out.push({
        seq: raw.seq,
        receivedAt: raw.received_at,
        fileHash: raw.file_hash,
        block: typeof raw.block === "number" ? raw.block : null,
      });
    }
  }
  return { rows: out, hasMore: o?.has_more === true };
}
