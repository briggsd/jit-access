import * as service from "../service.js";

export type LifecycleEvent =
  | { action: "grant"; requestId: string }
  | { action: "expire"; requestId: string }
  | { action: "fail"; requestId: string; error?: { Error?: string; Cause?: string } };

export async function handler(event: LifecycleEvent) {
  switch (event.action) {
    case "grant":
      return service.grant(event.requestId);
    case "expire":
      await service.endAccess(event.requestId, "Expired.", "system");
      return { requestId: event.requestId };
    case "fail":
      await service.fail(event.requestId, failureMessage(event.error));
      return { requestId: event.requestId };
  }
}

function failureMessage(err?: { Error?: string; Cause?: string }): string {
  if (!err?.Cause) return err?.Error ?? "Unknown error";
  try {
    return (JSON.parse(err.Cause) as { errorMessage?: string }).errorMessage ?? err.Cause;
  } catch {
    return err.Cause;
  }
}
