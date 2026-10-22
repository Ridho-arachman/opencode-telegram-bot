import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import textToSpeech from "@google-cloud/text-to-speech";
import { synthesizeWithEdgeTts } from "./edge-tts.js";

const TTS_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TTS_INPUT_CHARS = 4_000;

/**
 * High-frequency Indonesian function words. Used only to pick a default Edge
 * voice when TTS_VOICE is unset; an explicit TTS_VOICE always wins.
 */
const INDONESIAN_MARKERS = new Set([
  "yang",
  "dan",
  "di",
  "ke",
  "dari",
  "untuk",
  "dengan",
  "pada",
  "ini",
  "itu",
  "adalah",
  "atau",
  "juga",
  "sudah",
  "belum",
  "bisa",
  "tidak",
  "ada",
  "akan",
  "saya",
  "kamu",
  "kita",
  "mereka",
  "sini",
  "sana",
  "apa",
  "siapa",
  "mana",
  "kapan",
  "bagaimana",
  "mengapa",
  "kenapa",
  "masih",
  "hanya",
  "saja",
  "lagi",
  "karena",
  "jadi",
  "lalu",
  "terus",
  "tapi",
  "namun",
  "kalau",
  "kalo",
  "kayak",
  "gitu",
  "gini",
  "nggak",
  "gak",
  "udah",
  "blom",
  "sdh",
  "blm",
  "tdk",
  "jg",
  "spt",
  "spy",
  "krn",
  "utk",
  "dlm",
  "lbh",
  "tp",
  "dl",
  "bnr",
  "btl",
]);

/** Informal Indonesian pronouns that never appear in English text. */
const INDONESIAN_PRONOUN_PATTERN = /\b(aku|gue|gua|gw|lu|loe|lo)\b/i;

/**
 * Guesses whether a reply is Indonesian or English from a short word sample.
 *
 * This is a heuristic, not a language model. It scores only positive evidence
 * for Indonesian (known markers and informal pronouns) and compares that
 * against the number of sampled words, rather than treating every unknown word
 * as English — otherwise ordinary Indonesian content words would cancel out
 * the markers and an Indonesian sentence would score as English.
 *
 * A reply defaults to Indonesian only when markers are a meaningful share of
 * the sample; short or marker-free text falls back to English.
 */
export function detectEdgeLanguage(text: string): "id" | "en" {
  const sample = text.toLowerCase().split(/\s+/).slice(0, 50);

  let indonesian = 0;
  for (const word of sample) {
    const clean = word.replace(/[^\w]/g, "");
    if (INDONESIAN_MARKERS.has(clean)) {
      indonesian += 1;
    }
  }

  if (INDONESIAN_PRONOUN_PATTERN.test(text)) {
    indonesian += 5;
  }

  // Require markers on at least a third of the sampled words (and at least
  // two) so a single coincidental word cannot flip an English reply.
  return indonesian >= 2 && indonesian * 3 >= sample.length ? "id" : "en";
}

/** Per-language Edge voices used when TTS_VOICE is not set explicitly. */
const EDGE_VOICE_BY_LANGUAGE = {
  id: "id-ID-ArdiNeural",
  en: "en-GB-RyanNeural",
} as const;

function getEdgeVoiceForLanguage(language: "id" | "en"): string {
  return EDGE_VOICE_BY_LANGUAGE[language];
}

export interface TtsResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

type PromptResponseMode = "text_only" | "text_and_tts";

interface PrepareTtsResponseParams {
  sessionId: string;
  text: string;
  getResponseMode: (sessionId: string) => PromptResponseMode | null;
  isTtsConfigured?: (() => boolean) | undefined;
  synthesizeSpeech?: ((text: string) => Promise<TtsResult>) | undefined;
}

export type PreparedTtsResponse = { shouldSend: false } | { shouldSend: true; speech: TtsResult };

export function isTtsConfigured(): boolean {
  if (!config.tts || !config.tts.provider) return false;
  if (config.tts.provider === "google") {
    return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  if (config.tts.provider === "edge" || config.tts.provider === "local") {
    return true;
  }
  return Boolean(config.tts.apiUrl && config.tts.apiKey);
}

/**
 * Removes markdown syntax that TTS engines would read aloud
 * (asterisks, backticks, heading markers, etc.).
 */
export function stripMarkdownForSpeech(text: string): string {
  let clean = text;

  // fenced code blocks → inline content
  clean = clean.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    return inner.replace(/\n/g, " ");
  });

  clean = clean.replace(/`([^`]+)`/g, "$1");
  clean = clean.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  clean = clean.replace(/\*\*(.+?)\*\*/g, "$1");
  clean = clean.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  clean = clean.replace(/~~(.+?)~~/g, "$1");
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  clean = clean.replace(/^#{1,6}\s+/gm, "");
  clean = clean.replace(/^>\s?/gm, "");
  clean = clean.replace(/^[-*]\s+/gm, "");
  clean = clean.replace(/^\d+\.\s+/gm, "");
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");
  clean = clean.replace(/<\/?[A-Za-z][^>]*>/g, "");
  clean = clean.replace(/[ \t]+/g, " ");
  clean = clean.replace(/\n{3,}/g, "\n\n");

  return clean.trim();
}

/** Extracts "ll-CC" from Google voice names like "de-DE-Neural2-B". */
export function extractLanguageCode(voiceName: string): string {
  const match = voiceName.match(/^([a-z]{2,3}-[A-Z]{2})/);
  return match?.[1] ?? "en-US";
}

// --- Provider implementations ---

let googleClient: textToSpeech.TextToSpeechClient | null = null;

function getGoogleClient(): textToSpeech.TextToSpeechClient {
  if (!googleClient) {
    googleClient = new textToSpeech.TextToSpeechClient();
  }
  return googleClient;
}

/** @internal Reset Google client singleton (for tests only). */
export function _resetGoogleClient(): void {
  googleClient = null;
}


async function synthesizeWithGoogle(text: string): Promise<TtsResult> {
  const client = getGoogleClient();
  const voiceName = config.tts.voice || "en-US-Studio-O";
  const languageCode = extractLanguageCode(voiceName);

  logger.debug(
    `[TTS] Google Cloud TTS: voice=${voiceName}, languageCode=${languageCode}, chars=${text.length}`,
  );

  const [response] = await client.synthesizeSpeech(
    {
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3" },
    },
    { timeout: TTS_REQUEST_TIMEOUT_MS },
  );

  const raw = response.audioContent;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
  if (buffer.length === 0) {
    throw new Error("Google TTS API returned an empty audio response");
  }

  return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
}

async function synthesizeWithOpenAi(text: string): Promise<TtsResult> {
  const url = `${config.tts.apiUrl}/audio/speech`;

  logger.debug(
    `[TTS] OpenAI-compatible: url=${url}, model=${config.tts.model}, voice=${config.tts.voice}, chars=${text.length}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.tts.model,
        voice: config.tts.voice,
        input: text,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `TTS API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("TTS API returned an empty audio response");
    }

    logger.debug(`[TTS] Generated speech audio: ${buffer.length} bytes`);
    return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeWithElevenLabs(text: string): Promise<TtsResult> {
  const apiUrl = (config.tts.apiUrl || "").replace(/\/+$/, "");
  const voiceId = config.tts.voice || "21m00Tcm4TlvDq8ikWAM";
  const url = `${apiUrl}/text-to-speech/${encodeURIComponent(voiceId)}`;

  logger.debug(
    `[TTS] ElevenLabs: url=${url}, model=${config.tts.model}, voice=${voiceId}, chars=${text.length}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.tts.apiKey || "",
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: config.tts.model || "eleven_flash_v2_5",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `TTS API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("ElevenLabs TTS API returned an empty audio response");
    }

    logger.debug(`[TTS] Generated ElevenLabs speech audio: ${buffer.length} bytes`);
    return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeWithEdge(text: string): Promise<TtsResult> {
  const voice = config.tts.voiceIsExplicit
    ? config.tts.voice
    : getEdgeVoiceForLanguage(detectEdgeLanguage(text));

  logger.debug(`[TTS] Edge: voice=${voice}, chars=${text.length}`);

  const buffer = await synthesizeWithEdgeTts(text, {
    voice,
    timeoutMs: TTS_REQUEST_TIMEOUT_MS,
  });
  if (buffer.length === 0) {
    throw new Error("Edge TTS returned an empty audio response");
  }

  logger.debug(`[TTS] Generated Edge speech audio: ${buffer.length} bytes`);
  return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
}

// Pipeline cache: modelId -> Promise<TextToAudioPipeline>
const ttsPipelineCache = new Map<string, Promise<unknown>>();

function getTtsPipeline(modelId: string, dtype: "q8" | "fp16") {
  const key = `${modelId}@${dtype}`;
  if (!ttsPipelineCache.has(key)) {
    ttsPipelineCache.set(key, (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return await pipeline("text-to-speech", modelId, { dtype, revision: "main" });
    })());
  }
  return ttsPipelineCache.get(key)!;
}

async function synthesizeWithLocal(text: string): Promise<TtsResult> {
  const lang = detectEdgeLanguage(text);
  // Use language-specific models
  const { modelId, dtype } = lang === "id"
    ? { modelId: "payam1394/traxlate-mms-tts-ind", dtype: "q8" as const }
    : { modelId: "Xenova/mms-tts-eng", dtype: "q8" as const };
  
  logger.debug(`[TTS] Local (${lang}): model=${modelId}, chars=${text.length}`);

  // Split text into sentences to avoid token limits
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  const allAudio: Float32Array[] = [];
  let sampleRate = 16000;

  const pipelinePromise = getTtsPipeline(modelId, dtype);
  for (const sentence of sentences) {
    const tts = await pipelinePromise;
    const output = await (tts as unknown as (text: string) => Promise<{ audio: Float32Array; sampling_rate?: number }>)(sentence.trim());
    allAudio.push(output.audio);
    sampleRate = output.sampling_rate ?? 16000;
  }

  // Concatenate all audio chunks
  const totalLength = allAudio.reduce((sum, a) => sum + a.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of allAudio) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert Float32Array to 16-bit PCM WAV
  const wavBuffer = float32ToWav(combined, sampleRate ?? 16000);
  
  logger.debug(`[TTS] Generated local speech audio: ${wavBuffer.length} bytes`);
  return { buffer: wavBuffer, filename: "assistant-reply.wav", mimeType: "audio/wav" };
}

function float32ToWav(audio: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = audio.length * bytesPerSample;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(headerSize + dataSize - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM format chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert float32 [-1, 1] to int16
  let offset = headerSize;
  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i] as number));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, offset);
    offset += 2;
  }

  return buffer;
}

// --- Public API ---

function getNotConfiguredMessage(): string {
  if (config.tts.provider === "google") {
    return "TTS is not configured: set GOOGLE_APPLICATION_CREDENTIALS for Google Cloud TTS";
  }
  if (config.tts.provider === "elevenlabs") {
    return "TTS is not configured: set TTS_API_URL and TTS_API_KEY for ElevenLabs";
  }
  // No "edge" branch: isTtsConfigured() is always true for edge, so this
  // function is unreachable for that provider.
  return "TTS is not configured: set TTS_API_URL and TTS_API_KEY";
}

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const raw = text.trim();
  if (!raw) {
    throw new Error("TTS input text is empty");
  }

  const input = stripMarkdownForSpeech(raw);

  try {
    if (config.tts.provider === "google") {
      return await synthesizeWithGoogle(input);
    }
    if (config.tts.provider === "elevenlabs") {
      return await synthesizeWithElevenLabs(input);
    }
    if (config.tts.provider === "edge") {
      return await synthesizeWithEdge(input);
    }
    if (config.tts.provider === "openai") {
      return await synthesizeWithOpenAi(input);
    }
    if (config.tts.provider === "local") {
      return await synthesizeWithLocal(input);
    }
    throw new Error(getNotConfiguredMessage());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`TTS request timed out after ${TTS_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export async function prepareTtsResponseForSession({
  sessionId,
  text,
  getResponseMode,
  isTtsConfigured: isTtsConfiguredImpl = isTtsConfigured,
  synthesizeSpeech: synthesizeSpeechImpl = synthesizeSpeech,
}: PrepareTtsResponseParams): Promise<PreparedTtsResponse> {
  const responseMode = getResponseMode(sessionId);
  if (responseMode !== "text_and_tts") {
    return { shouldSend: false };
  }

  const normalizedText = text.trim();
  if (!normalizedText) {
    return { shouldSend: false };
  }

  if (!isTtsConfiguredImpl()) {
    logger.info(`[TTS] Skipping audio reply for session ${sessionId}: TTS is not configured`);
    return { shouldSend: false };
  }

  if (normalizedText.length > MAX_TTS_INPUT_CHARS) {
    logger.warn(
      `[TTS] Skipping audio reply for session ${sessionId}: text length ${normalizedText.length} exceeds limit ${MAX_TTS_INPUT_CHARS}`,
    );
    return { shouldSend: false };
  }

  return { shouldSend: true, speech: await synthesizeSpeechImpl(normalizedText) };
}
