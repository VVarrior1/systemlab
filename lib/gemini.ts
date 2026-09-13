import { GoogleGenAI } from "@google/genai";

/**
 * Minimal shape of the Gemini client surface this codebase depends on, so
 * routes and tests can inject a fake without pulling in the real SDK types.
 */
export interface GeminiClient {
  models: {
    generateContent: (args: any) => Promise<{ text?: string }>;
  };
}

export const GRADER_MODEL = process.env.GRADER_MODEL ?? "gemini-3.8-flash";

/** True when a Gemini API key is configured in the environment. */
export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Thrown when a Gemini-backed feature is invoked without a configured API key. */
export class GeminiUnavailableError extends Error {
  constructor(message = "Gemini is not configured: GEMINI_API_KEY is unset.") {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

/**
 * Creates a real Gemini client reading GEMINI_API_KEY from the environment.
 * Throws GeminiUnavailableError if the key is missing.
 */
export function createGeminiClient(): GeminiClient {
  if (!hasGeminiKey()) {
    throw new GeminiUnavailableError();
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) as unknown as GeminiClient;
}

export interface GenerateJsonArgs<T> {
  client?: GeminiClient;
  system: string;
  contents: { role: "user" | "model"; text: string }[];
  schema: object;
  parse: (value: unknown) => T;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Calls Gemini's generateContent with a JSON response schema, parses
 * response.text as JSON, and validates it through `parse` (a zod schema's
 * .parse works directly). Retries the call once on an empty or invalid JSON
 * response before throwing a friendly Error.
 */
export async function generateJson<T>(args: GenerateJsonArgs<T>): Promise<T> {
  const client = args.client ?? createGeminiClient();

  const call = async (): Promise<T> => {
    const response = await client.models.generateContent({
      model: GRADER_MODEL,
      contents: args.contents.map((entry) => ({
        role: entry.role,
        parts: [{ text: entry.text }],
      })),
      config: {
        systemInstruction: args.system,
        responseMimeType: "application/json",
        responseJsonSchema: args.schema,
        temperature: args.temperature ?? 0.3,
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      },
    });

    const text = response.text;
    if (!text || text.trim().length === 0) {
      throw new Error("Gemini returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned a response that was not valid JSON.");
    }

    return args.parse(parsed);
  };

  try {
    return await call();
  } catch {
    return await call();
  }
}
