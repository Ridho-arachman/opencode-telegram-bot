# Realtime Desktop ↔ Telegram Sync

Bahasa Indonesia first, English below.

---

## Bahasa Indonesia

### Kenapa bot-ku tidak realtime sebelumnya?

Bot Telegram dan OpenCode TUI di desktop hanya akan **sinkron** kalau keduanya
terhubung ke **instance server OpenCode yang sama** (port yang sama).

- Bot dikonfigurasi ke `http://localhost:4097` (lihat `OPENCODE_API_URL` di
  `%APPDATA%\opencode-telegram-bot\.env`).
- Kalau TUI desktop dijalankan dengan perintah `opencode` biasa, TUI itu
  memakai port acak sendiri → dua instance terpisah. Sesi/aktivitas desktop
  tidak terlihat oleh bot, dan sebaliknya.

### Cara mengaktifkan realtime

Jalankan desktop selalu lewat script ini (satu proses: TUI + server):

```cmd
D:\Coding\opencode-telegram-bot\scripts\windows\opencode-desktop.cmd
```

Atau manual:

```cmd
opencode --port 4097
```

Setelah itu:

1. Semua sesi yang ada di desktop otomatis muncul di bot (`/sessions`).
2. Pilih sesi yang sama di Telegram → bot "menempel" ke sesi itu.
3. Apa pun yang terjadi di desktop — prompt yang kamu ketik, jawaban agent,
   tool calls — muncul di Telegram hampir seketika (throttle default 1 detik,
   bisa diubah via `RESPONSE_STREAM_THROTTLE_MS`).
4. Sebaliknya juga berlaku: prompt dari Telegram tampil sebagai input eksternal
   di desktop.
5. Sesi lain di project yang sama yang sedang berjalan tetap mengirim notifikasi
   singkat (`TRACK_BACKGROUND_SESSIONS=true`, sudah aktif).

### Alternatif: server headless + attach

Kalau ingin server tetap hidup walau TUI ditutup:

```cmd
opencode serve --port 4097
```

lalu hubungkan TUI ke server tersebut:

```cmd
opencode attach http://127.0.0.1:4097
```

Catatan: `.env` bot memiliki `OPENCODE_AUTO_RESTART_ENABLED=true`, jadi jika
tidak ada server di port 4097 saat bot start, bot akan menyalakan server
headless-nya sendiri di port itu. Selama desktop diluncurkan lewat script di
atas (atau `--port 4097`), keduanya selalu bertemu di server yang sama.

### Auto-Follow (default: ON)

Masalah klasik: kamu mengeksekusi task di desktop pada **sesi lain** dari yang
dipilih bot → bot diam (semua render menggating sesi aktif).

Dengan `AUTO_FOLLOW_ACTIVE_SESSION=true` (default), begitu ada sesi di project
yang sama mulai berjalan dan bot sedang idle, **bot otomatis pindah** ke sesi
aktif itu — progres, pertanyaan, dan permintaan izin langsung mengalir tanpa
perlu `/sessions` manual.

Guard-nya: tidak aktif saat bot sedang mengerjakan prompt sendiri, saat ada
pertanyaan/izin yang belum dijawab, atau saat sesi aktif berada di project
berbeda. Matikan dengan `AUTO_FOLLOW_ACTIVE_SESSION=false`.

---

## English

The Telegram bot and the desktop OpenCode TUI stay in sync only when both talk
to the same OpenCode server instance (same port).

- The bot targets `http://localhost:4097` (`OPENCODE_API_URL`).
- Launching the TUI without a fixed port creates a separate random-port
  instance → no shared sessions, no live mirroring.

**Enable realtime:** always start the desktop via
`scripts/windows/opencode-desktop.cmd` (or `opencode --port 4097`). Then pick
the same session in Telegram; prompts, assistant replies, and tool activity
from the desktop stream into the chat in near-real-time, and Telegram prompts
appear in the desktop as external input.

Alternative for a persistent backend: `opencode serve --port 4097`, then
`opencode attach http://127.0.0.1:4097`.

`OPENCODE_AUTO_RESTART_ENABLED=true` lets the bot spawn its own headless server
on that port when none is running at startup; launching the desktop with the
script above guarantees both sides share one server regardless of order.
