import { Storage } from "./storage.js";
import { z } from "zod";
import { timingSafeEqual } from "crypto";

// Simple binary search helper
function binarySearch<T>(arr: T[], target: string, keyFn: (item: T) => string): { found: boolean; index: number } {
  let left = 0;
  let right = arr.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midKey = keyFn(arr[mid]);

    if (midKey === target) {
      return { found: true, index: mid };
    } else if (midKey < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return { found: false, index: left };
}

// Generate ULID-like identifier
function generateId(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${now.toString(36)}${random}`;
}

// Timing-safe string comparison
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Maximum sync payload size
const MAX_SYNC_DATA_ITEMS = 500;
const MAX_SYNC_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB

export namespace Share {
  export const Info = z.object({
    id: z.string(),
    secret: z.string(),
    sessionID: z.string(),
  });
  export type Info = z.infer<typeof Info>;

  // Tightened schemas with actual field validation
  const SessionData = z.object({
    type: z.literal("session"),
    data: z.object({
      id: z.string().optional(),
      title: z.string().optional(),
      version: z.string().optional(),
      time: z.object({
        created: z.union([z.string(), z.number()]).optional(),
        updated: z.union([z.string(), z.number()]).optional(),
      }).passthrough().optional(),
    }).passthrough(),
  });

  const MessageData = z.object({
    type: z.literal("message"),
    data: z.object({
      id: z.string(),
      role: z.enum(["user", "assistant", "system"]),
      time: z.object({
        created: z.union([z.string(), z.number()]).optional(),
      }).passthrough().optional(),
    }).passthrough(),
  });

  const PartData = z.object({
    type: z.literal("part"),
    data: z.object({
      id: z.string(),
      messageID: z.string(),
      type: z.string(),
    }).passthrough(),
  });

  const SessionDiffData = z.object({
    type: z.literal("session_diff"),
    data: z.array(z.object({}).passthrough()),
  });

  const ModelData = z.object({
    type: z.literal("model"),
    data: z.array(z.object({}).passthrough()),
  });

  export const Data = z.discriminatedUnion("type", [
    SessionData,
    MessageData,
    PartData,
    SessionDiffData,
    ModelData,
  ]);
  export type Data = z.infer<typeof Data>;

  export async function create(body: { sessionID: string }): Promise<Info> {
    const isTest = process.env.NODE_ENV === "test" || body.sessionID.startsWith("test_");
    const id = (isTest ? "test_" : "") + body.sessionID.slice(-8);

    // If share already exists for this session, return it with a new secret
    // (only if sessionID matches — prevents hijacking)
    const exists = await get(id);
    if (exists) {
      if (exists.sessionID === body.sessionID) {
        return exists;
      }
      throw new Errors.AlreadyExists(id);
    }

    const info: Info = {
      id,
      sessionID: body.sessionID,
      secret: crypto.randomUUID(),
    };
    await Storage.write(["share", info.id], info);
    return info;
  }

  export async function get(id: string): Promise<Info | undefined> {
    console.log("Share.get: looking up share", { shareId: id, storageKey: `share/${id}.json` });
    const result = await Storage.read<Info>(["share", id]);
    if (!result) {
      console.warn("Share.get: share not found", { shareId: id });
    } else {
      console.log("Share.get: share found", { shareId: id, sessionID: result.sessionID });
    }
    return result;
  }

  export async function remove(body: { id: string; secret: string }): Promise<void> {
    const share = await get(body.id);
    if (!share) throw new Errors.NotFound(body.id);
    if (!safeCompare(share.secret, body.secret)) throw new Errors.InvalidSecret(body.id);
    await Storage.remove(["share", body.id]);
    const list = await Storage.list({ prefix: ["share_data", body.id] });
    for (const item of list) {
      await Storage.remove(item);
    }
  }

  export async function sync(input: {
    share: { id: string; secret: string };
    data: Data[];
  }): Promise<void> {
    const share = await get(input.share.id);
    if (!share) throw new Errors.NotFound(input.share.id);
    if (!safeCompare(share.secret, input.share.secret)) throw new Errors.InvalidSecret(input.share.id);

    // Validate payload size
    if (input.data.length > MAX_SYNC_DATA_ITEMS) {
      throw new Errors.PayloadTooLarge(`Data array exceeds maximum of ${MAX_SYNC_DATA_ITEMS} items`);
    }
    const payloadSize = JSON.stringify(input.data).length;
    if (payloadSize > MAX_SYNC_PAYLOAD_BYTES) {
      throw new Errors.PayloadTooLarge(`Payload exceeds maximum of ${MAX_SYNC_PAYLOAD_BYTES} bytes`);
    }

    await Storage.write(["share_event", input.share.id, generateId()], input.data);
  }

  // Broadcast update via Lambda invocation (called from handler layer)
  export async function broadcastUpdate(shareId: string): Promise<void> {
    try {
      const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

      const broadcastLambdaArn = process.env.BROADCAST_LAMBDA_ARN;
      if (!broadcastLambdaArn) {
        console.log("Broadcast Lambda ARN not configured, skipping broadcast");
        return;
      }

      await lambda.send(new InvokeCommand({
        FunctionName: broadcastLambdaArn,
        InvocationType: "Event",
        Payload: JSON.stringify({
          shareId,
          message: { type: "sync", timestamp: Date.now() },
        }),
      }));
    } catch (error) {
      console.error("Failed to broadcast update:", error);
      // Don't throw - broadcast failures shouldn't break sync
    }
  }

  type Compaction = {
    event?: string;
    data: Data[];
  };

  export async function data(shareID: string): Promise<Data[]> {
    console.log("reading compaction");
    const compaction: Compaction = (await Storage.read<Compaction>(["share_compaction", shareID])) ?? {
      data: [],
      event: undefined,
    };
    console.log("reading pending events after", compaction.event);

    // Get events AFTER the last compaction (new events)
    // If no compaction exists, get all events
    const list = await Storage.list({
      prefix: ["share_event", shareID],
      after: compaction.event,
    }).then((x) => [...x].reverse());  // Reverse: S3 returns newest first, we want oldest first (chronological)

    console.log("found", list.length, "new events to compact");

    if (list.length > 0) {
      const data = await Promise.all(list.map(async (event: string[]) => await Storage.read<Data[]>(event))).then((x) => x.flat());
      for (const item of data) {
        if (!item) continue;
        const key = (item: Data): string => {
          switch (item.type) {
            case "session":
              return "session";
            case "message":
              return `message/${item.data.id}`;
            case "part":
              return `${item.data.messageID}/${item.data.id}`;
            case "session_diff":
              return "session_diff";
            case "model":
              return "model";
          }
          // Unreachable: all discriminated union types handled above
          return `unknown`;
        };
        const id = key(item);
        const result = binarySearch(compaction.data, id, key);
        if (result.found) {
          // For parts with streaming content (text, reasoning), merge by keeping longest content
          const existing = compaction.data[result.index];
          if (item.type === 'part' && existing.type === 'part') {
            const itemType = item.data.type;
            if (itemType === 'text' || itemType === 'reasoning') {
              const existingText = (existing.data as any).text || '';
              const newText = (item.data as any).text || '';
              if (newText.length > existingText.length) {
                (existing.data as any).text = newText;
              }
            } else {
              compaction.data[result.index] = item;
            }
          } else {
            compaction.data[result.index] = item;
          }
        } else {
          compaction.data.splice(result.index, 0, item);
        }
      }
      // Update compaction bookmark to the newest event
      // After .reverse(), list is in chronological order: oldest at index 0, newest at end
      const newestEvent = list.at(-1);
      compaction.event = newestEvent?.at(-1);
      await Storage.write(["share_compaction", shareID], compaction);
      console.log("compaction updated, now has", compaction.data.length, "items");
    }
    return compaction.data;
  }

  export const Errors = {
    NotFound: class extends Error {
      constructor(public id: string) {
        super(`Share not found: ${id}`);
      }
    },
    InvalidSecret: class extends Error {
      constructor(public id: string) {
        super(`Share secret invalid: ${id}`);
      }
    },
    AlreadyExists: class extends Error {
      constructor(public id: string) {
        super(`Share already exists: ${id}`);
      }
    },
    PayloadTooLarge: class extends Error {
      constructor(message: string) {
        super(message);
      }
    },
  };
}
