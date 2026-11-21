import { NextResponse } from "next/server";
import { FlowError } from "./test-flow";
import { record5xx } from "./alerts";
import { CheckoutError } from "./payments/service";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ошибки предметной области → понятный ответ; остальное — 500 без подробностей наружу. */
export function handleError(e: unknown) {
  if (e instanceof FlowError || e instanceof CheckoutError) return jsonError(e.message, e.status);
  console.error(e);
  record5xx();
  return jsonError("Что-то пошло не так. Попробуй ещё раз.", 500);
}
