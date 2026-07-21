# nanalStamp

Seal your notes with tamper-proof timestamps — anchored to the Bitcoin blockchain — **without ever uploading a single word of your content.**

nanalStamp watches the notes you choose and, whenever a note settles (you pause typing, switch away, or close Obsidian), it computes a **SHA-256 hash on your device** and sends only that hash to the nanalStamp server. The server chains your hashes, signs each entry, and periodically anchors the chain head into Bitcoin via [OpenTimestamps](https://opentimestamps.org). The result is independently verifiable proof that a given note existed, in a given form, at a given time — proof that does not depend on trusting nanalStamp.

## Why start today — you can't prove the past retroactively

nanalStamp is **not** just "this file existed once." Its real value is proving that **a note has been worked on continuously, day after day, and that its edit history is an unbroken chain** — not something assembled at the end and back-dated.

That continuity **cannot be created retroactively.** Each day's state is anchored *independently* into that day's Bitcoin block, and you cannot go back and place an anchor in a block that is already mined. So the proof you can show only ever covers the period **from the moment you start sealing forward** — every day you wait is a day of provable history you can never get back.

> **If a note matters — a research log, an invention record, a journal — seal it now, not later.** The proof is only as long as the streak you've actually been building.

## What this proof is (and isn't)

nanalStamp provides an **electronic timestamp / proof-of-existence** with strong tamper-evidence: hash-chained, signed, and Bitcoin-anchored, independently verifiable without trusting us. It is designed to be **admissible as supporting evidence** of a record's integrity and time (e.g. it aligns with the kind of hash-based verification courts already accept).

It is **not** a government-accredited or "qualified" timestamp / "공인" service — no such certified status is claimed. Whether and how it is weighed in any specific dispute is up to the relevant court or authority.

## Privacy & network use (please read)

This plugin connects to **exactly one** remote service — the nanalStamp API at **`https://api.nanalstamp.com`** (and, when you open pricing/account/checkout, its website `https://nanalstamp.com`). No other host is contacted, and no third-party analytics, tracking, or telemetry is used. The server URL is configurable in settings if you self-host. Here is exactly what leaves your device and what does not:

**What is sent** (only to the endpoint above):
- The **SHA-256 hash of the note's content** (a 64-character digest — the content cannot be reconstructed from it).
- The **SHA-256 hash of the note's file path** — so even the folder and file *names* never leave your device in readable form.
- A client timestamp and, if you are signed in, your API key.

**What is never sent:**
- Your note content / text.
- Readable file names or folder names.
- Any other vault data.

**When requests happen:**
- When a watched note settles (debounced), when you leave or close it, and a "catch-up" pass for notes changed since last run.
- When you explicitly run a command (issue certificate, create public link, anchor now, open pricing/account).

You can turn all sending off at any time with **Settings → nanalStamp → Enable sealing**, and you can limit *which* notes are watched with the include/exclude folder settings.

## Account & payment (optional)

- Sealing works with a free API key. Sign-in is optional and only used to auto-fetch your key.
- **Official certificates (PDF)** and **public verification links** are paid features. The "Buy Pro" / "Buy certificate credit" commands open an external checkout page in your browser. No payment happens inside Obsidian.
- Pricing and account management live at [nanalstamp.com](https://nanalstamp.com).

## How verification works

- **Content proof** — the content hash proves *what* the note contained. Reveal the note; anyone can re-hash it and match.
- **Path commitment** — the path hash is a commitment. If you later want to prove *which* note (its path/name) a proof refers to, you reveal the path and a verifier recomputes `SHA-256("nanalstamp/path/v1\n" + path)` and matches it.
- **Chain + signature** — each entry binds `user | seq | prev_hash | content_hash | path_hash | received_at`, is signed with the server's Ed25519 key, and links to the previous entry. Reordering or back-dating breaks the chain.
- **Bitcoin anchor** — the chain head is submitted to OpenTimestamps and, once confirmed, carries a Bitcoin block height. Verification is possible independently, without trusting the server.

## Usage

1. Install and enable the plugin.
2. Open **Settings → nanalStamp** and paste your API key (or sign in to fetch it).
3. (Optional) Restrict watched notes with **Include folders** / **Exclude folders**.
4. Keep writing. Notes are sealed automatically; the status bar shows a seal icon and a running count.

### Commands

- **Seal current note now** — seal immediately.
- **Anchor to Bitcoin now** — submit the current chain head to Bitcoin.
- **Export proof (.nanalproof)** — save a portable proof file for the active note.
- **Issue official certificate (PDF)** — paid; requires a certificate credit.
- **Create public verification link** — paid (Pro).
- **New dev note (today)** and entry-insert commands — optional note templates.
- **View pricing** / **My account & subscription** — open the website.

### Settings

| Setting | Purpose |
|---|---|
| Enable sealing | Master on/off for all sending. |
| API key | Your nanalStamp key. |
| Include / Exclude folders | Limit which notes are watched. |
| Settle debounce (ms) | Idle time before a note is treated as "paused". |
| Min interval per note (ms) | Rate-limit seals per note (edits are coalesced). |
| Retry interval (ms) | How often failed sends are retried. |
| Server URL | Advanced — change only for self-host/staging. |

## Desktop only

nanalStamp is marked **desktop-only**. On app quit it performs a synchronous last-moment seal that relies on Electron APIs unavailable on mobile.

## Self-hosting

The plugin talks to a small open server (hash chain + Ed25519 signing + OpenTimestamps anchoring). Point **Server URL** at your own instance if you prefer to run it yourself.

## License

[MIT](LICENSE) © nanal soft

---

### 한국어 요약

nanalStamp은 선택한 노트가 정착될 때 **기기에서 SHA-256 해시를 계산**해 그 해시만 보냅니다. 접속하는 서버는 **오직 `https://api.nanalstamp.com` 한 곳뿐**이며(요금제·계정·결제 시에는 웹사이트 `https://nanalstamp.com`), 제3자 분석·추적·텔레메트리는 일절 없습니다. 서버 주소는 자체 호스팅 시 설정에서 바꿀 수 있습니다. **노트 내용도, 읽을 수 있는 파일·폴더 이름도 전송되지 않습니다**(경로도 해시화). 서버는 해시를 체인으로 묶고 Ed25519로 서명한 뒤 주기적으로 **비트코인(OpenTimestamps)** 에 앵커링해, "그 시점에 그 노트가 존재했다"를 서버를 신뢰하지 않고도 검증할 수 있게 합니다.

- 전송 중단: 설정 → nanalStamp → 봉인 켜기 끄기
- 감시 범위 제한: 포함/제외 폴더 설정
- 인증서(PDF)·공개 검증 링크는 유료이며 외부 결제 페이지가 브라우저에서 열립니다(Obsidian 내 결제 없음).

**왜 지금 시작해야 하나 — 과거는 소급 증명할 수 없습니다.** nanalStamp의 핵심 가치는 "이 파일이 한 번 존재했다"가 아니라 **"이 노트를 오래전부터 꾸준히 써왔고 편집 이력이 끊김 없이 이어졌다"** 는 연속 증명입니다. 각 날짜의 상태는 그 날의 비트코인 블록에 **독립적으로** 고정되며, 이미 채굴된 과거 블록에는 앵커를 넣을 수 없으므로 **이 연속성은 소급 생성이 불가능**합니다. 즉 증명할 수 있는 기간은 **봉인을 시작하는 순간부터 앞으로**만 쌓입니다. 늦게 시작할수록 증명 가능한 과거가 짧아집니다 — 중요한 노트(연구기록·발명·저널)라면 **나중이 아니라 지금 봉인하세요.**

**이 증명의 성격.** nanalStamp은 무결성·존재시점을 강하게 증빙하는 **전자 타임스탬프/존재증명**이며, 법정에서 **증거로 채택 가능**하도록 설계되었습니다(법원이 이미 인정하는 해시 기반 검증 방식과 정합). 다만 **정부 공인·"qualified"·공인 타임스탬프가 아니며 그러한 지위를 주장하지 않습니다.** 개별 분쟁에서의 증거 가치 판단은 해당 법원·기관의 몫입니다.
