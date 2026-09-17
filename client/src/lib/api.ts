import { readPreferredLocale, type Locale } from "./i18n";
import type * as P from "../../../docs/engineering_v0.5/contracts/public.types";
export type { P };
const base = "/api/v1";
let requestLocale: Locale = readPreferredLocale();
export function setRequestLocale(locale: Locale) {
  requestLocale = locale;
}
export class ApiError extends Error {
  constructor(public problem: P.Problem) {
    super(problem.detail || problem.title);
  }
}
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request(path, { signal });
}
async function request<T>(path: string, options: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": requestLocale,
        ...options.headers,
      },
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "AbortError"
        ? "REQUEST_CANCELLED"
        : "CONNECTION_LOST",
    );
  }
  if (!response.ok) {
    const problem = await response
      .json()
      .catch(() => ({
        code: "SERVICE_UNAVAILABLE",
        detail: `Request failed (${response.status})`,
      }));
    throw new ApiError(problem);
  }
  return response.json() as Promise<T>;
}
export async function post<T>(
  path: string,
  body: unknown,
  epoch?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Idempotency-Key": crypto.randomUUID(),
  };
  if (epoch) headers["X-Run-Epoch"] = epoch;
  // A retried transport request must reuse both its UUID and identical payload.
  const options = { method: "POST", headers, body: JSON.stringify(body) };
  try {
    return await request<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return request<T>(path, options);
  }
}
export function envelope(state: P.SessionProjection, payload: unknown) {
  return {
    expectedStateVersion: state.stateVersion,
    expectedSceneId: state.sceneId,
    payload,
  };
}
export const sessionPath = (id: string, tail = "") =>
  `/sessions/${encodeURIComponent(id)}${tail}`;
