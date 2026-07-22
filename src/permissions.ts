import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type AgyPermissionChoice =
  | "agy-allow-once"
  | "agy-allow-conversation"
  | "agy-allow-settings"
  | "agy-reject-once";

export interface AgyPermissionOption {
  optionId: AgyPermissionChoice;
  kind: "allow_once" | "allow_always" | "reject_once";
  name: string;
}

export function permissionKeys(choice: AgyPermissionChoice): string {
  switch (choice) {
    case "agy-allow-once": return "\r";
    case "agy-allow-conversation": return "\x1b[B\r";
    case "agy-allow-settings": return "\x1b[B\x1b[B\r";
    case "agy-reject-once": return "\x1b[B\x1b[B\x1b[B\r";
  }
}

/** Build choices matching agy 1.1.5's run_command menu. */
export function permissionOptions(toolCall: SessionUpdate): AgyPermissionOption[] {
  const raw = toolCall as unknown as Record<string, unknown>;
  const input = raw.rawInput && typeof raw.rawInput === "object" ? raw.rawInput as Record<string, unknown> : {};
  const target = typeof input.CommandLine === "string" && input.CommandLine.trim()
    ? input.CommandLine.trim() : String(raw.title ?? "this command");
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    { optionId: "agy-allow-conversation", kind: "allow_always", name: `Yes, and always allow in this conversation for commands that start with '${target}'` },
    { optionId: "agy-allow-settings", kind: "allow_always", name: `Yes, and always allow for commands that start with '${target}' (Persist to settings.json)` },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}
