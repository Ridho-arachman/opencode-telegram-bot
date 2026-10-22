import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  sttProvider: "api" as string,
  apiConfigured: true,
  voskConfigured: true,
  whisperConfigured: true,
  transcribeApi: vi.fn(),
  transcribeVosk: vi.fn(),
  transcribeWhisper: vi.fn(),
  flushPendingPromptMock: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    stt: {
      get provider() {
        return mocked.sttProvider;
      },
      apiUrl: "http://localhost:1",
      apiKey: "key",
      model: "whisper",
      language: "en",
      notePrompt: "",
      requestFormat: "multipart",
    },
    telegram: { token: "test", allowedUserId: 0, proxyUrl: "" },
    opencode: {
      serverVersion: "v1",
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
      model: { provider: "test", modelId: "test" },
    },
    server: { logLevel: "error" },
  },
}));

vi.mock("../../../src/app/services/stt-service.js", () => ({
  isSttConfigured: () => mocked.apiConfigured,
  transcribeAudio: mocked.transcribeApi,
}));

vi.mock("../../../src/app/services/local-vosk-stt-service.js", () => ({
  isVoskSttConfigured: () => mocked.voskConfigured,
  transcribeAudioVosk: mocked.transcribeVosk,
}));

vi.mock("../../../src/app/services/local-whisper-stt-service.js", () => ({
  isWhisperSttConfigured: () => mocked.whisperConfigured,
  transcribeAudioWhisper: mocked.transcribeWhisper,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getTtsMode: () => "off",
  getPromptQueueMode: () => "off",
  getCurrentSession: () => undefined,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/bot/handlers/message-merger.js", () => ({
  flushPendingPrompt: mocked.flushPendingPromptMock,
  __resetMessageMergerForTests: vi.fn(),
}));

vi.mock("../../../src/app/services/prompt-queue-dispatch.js", () => ({
  tryEnqueuePromptIfBusy: vi.fn().mockResolvedValue(false),
}));

async function loadVoiceModule() {
  vi.resetModules();
  return import("../../../src/bot/handlers/voice-handler.js");
}

function createCtx(): { ctx: Context; replyMock: ReturnType<typeof vi.fn> } {
  const replyMock = vi.fn().mockResolvedValue({ message_id: 101 });
  const ctx = {
    chat: { id: 777 },
    message: { voice: { file_id: "voice-file-id" } },
    reply: replyMock,
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  } as unknown as Context;
  return { ctx, replyMock };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    bot: {} as never,
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
    downloadTelegramFile: vi.fn().mockResolvedValue({
      buffer: Buffer.from("audio"),
      filename: "file_1.ogg",
    }),
    processPrompt: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as never;
}

describe("voice-handler STT provider resolution", () => {
  beforeEach(() => {
    mocked.sttProvider = "api";
    mocked.apiConfigured = true;
    mocked.voskConfigured = true;
    mocked.whisperConfigured = true;
    mocked.transcribeApi.mockReset().mockResolvedValue({ text: "hello" });
    mocked.transcribeVosk.mockReset().mockResolvedValue({ text: "halo" });
    mocked.transcribeWhisper.mockReset().mockResolvedValue({ text: "hi" });
  });

  it("uses the remote STT API by default", async () => {
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx } = createCtx();

    await handleVoiceMessage(ctx, createDeps());

    expect(mocked.transcribeApi).toHaveBeenCalledOnce();
    expect(mocked.transcribeVosk).not.toHaveBeenCalled();
    expect(mocked.transcribeWhisper).not.toHaveBeenCalled();
  });

  it("routes to Vosk when STT_PROVIDER is vosk", async () => {
    mocked.sttProvider = "vosk";
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx } = createCtx();

    await handleVoiceMessage(ctx, createDeps());

    expect(mocked.transcribeVosk).toHaveBeenCalledOnce();
    expect(mocked.transcribeApi).not.toHaveBeenCalled();
  });

  it("routes to local Whisper when STT_PROVIDER is whisper", async () => {
    mocked.sttProvider = "whisper";
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx } = createCtx();

    await handleVoiceMessage(ctx, createDeps());

    expect(mocked.transcribeWhisper).toHaveBeenCalledOnce();
    expect(mocked.transcribeApi).not.toHaveBeenCalled();
  });

  it("reports the Vosk-specific message when the Vosk model is missing", async () => {
    mocked.sttProvider = "vosk";
    mocked.voskConfigured = false;
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx, replyMock } = createCtx();

    await handleVoiceMessage(ctx, createDeps());

    expect(replyMock).toHaveBeenCalledWith(t("stt.not_configured.vosk"));
    expect(mocked.transcribeVosk).not.toHaveBeenCalled();
  });

  it("reports the Whisper-specific message when the local runtime is missing", async () => {
    mocked.sttProvider = "whisper";
    mocked.whisperConfigured = false;
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx, replyMock } = createCtx();

    await handleVoiceMessage(ctx, createDeps());

    expect(replyMock).toHaveBeenCalledWith(t("stt.not_configured.whisper"));
    expect(mocked.transcribeWhisper).not.toHaveBeenCalled();
  });

  it("lets an injected transcribe implementation override the resolved backend", async () => {
    const injected = vi.fn().mockResolvedValue({ text: "injected" });
    const { handleVoiceMessage } = await loadVoiceModule();
    const { ctx } = createCtx();

    await handleVoiceMessage(ctx, createDeps({ transcribeAudio: injected }));

    const call = defined(injected.mock.calls[0]);
    expect(call[1]).toBe("file_1.ogg");
    expect(mocked.transcribeApi).not.toHaveBeenCalled();
  });
});
