import { Storage } from "./storage.js";
import { z } from "zod";

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

export namespace Share {
  export const Info = z.object({
    id: z.string(),
    secret: z.string(),
    sessionID: z.string(),
  });
  export type Info = z.infer<typeof Info>;

  export const Data = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("session"),
      data: z.record(z.any()),
    }),
    z.object({
      type: z.literal("message"),
      data: z.record(z.any()),
    }),
    z.object({
      type: z.literal("part"),
      data: z.record(z.any()),
    }),
    z.object({
      type: z.literal("session_diff"),
      data: z.array(z.record(z.any())),
    }),
    z.object({
      type: z.literal("model"),
      data: z.array(z.record(z.any())),
    }),
  ]);
  export type Data = z.infer<typeof Data>;

  export async function create(body: { sessionID: string }): Promise<Info> {
    const isTest = process.env.NODE_ENV === "test" || body.sessionID.startsWith("test_");
    const info: Info = {
      id: (isTest ? "test_" : "") + body.sessionID.slice(-8),
      sessionID: body.sessionID,
      secret: crypto.randomUUID(),
    };
    const exists = await get(info.id);
    if (exists) throw new Errors.AlreadyExists(info.id);
    await Storage.write(["share", info.id], info);
    return info;
  }

  export async function get(id: string): Promise<Info | undefined> {
    return Storage.read<Info>(["share", id]);
  }

  export async function remove(body: { id: string; secret: string }): Promise<void> {
    const share = await get(body.id);
    if (!share) throw new Errors.NotFound(body.id);
    if (share.secret !== body.secret) throw new Errors.InvalidSecret(body.id);
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
    if (share.secret !== input.share.secret) throw new Errors.InvalidSecret(input.share.id);
    await Storage.write(["share_event", input.share.id, generateId()], input.data);

    // Trigger broadcast to WebSocket connections
    await broadcastUpdate(input.share.id, { type: "sync", timestamp: Date.now() });
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
      after: compaction.event,  // Get events AFTER the last compaction
    }).then((x) => [...x].reverse());  // Reverse to get chronological order

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
        };
        const id = key(item);
        const result = binarySearch(compaction.data, id, key);
        if (result.found) {
          // For parts with streaming content (text, reasoning), merge by keeping longest content
          const existing = compaction.data[result.index];
          if (item.type === 'part' && existing.type === 'part') {
            const itemType = item.data.type;
            if (itemType === 'text' || itemType === 'reasoning') {
              const existingText = existing.data.text || '';
              const newText = item.data.text || '';
              if (newText.length > existingText.length) {
                existing.data.text = newText;
              }
            } else {
              // For other part types, replace as before
              compaction.data[result.index] = item;
            }
          } else {
            compaction.data[result.index] = item;
          }
        } else {
          compaction.data.splice(result.index, 0, item);
        }
      }
      // Update compaction to include the newest event
      // list is in chronological order (reversed), so newest is at index 0
      compaction.event = list.at(0)?.at(-1);
      await Storage.write(["share_compaction", shareID], compaction);
      console.log("compaction updated, now has", compaction.data.length, "items");
    }
    return compaction.data;
  }

  // Broadcast update via Lambda invocation
  async function broadcastUpdate(shareId: string, message: any): Promise<void> {
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
        InvocationType: "Event", // Asynchronous invocation
        Payload: JSON.stringify({ shareId, message }),
      }));
    } catch (error) {
      console.error("Failed to broadcast update:", error);
      // Don't throw - broadcast failures shouldn't break sync
    }
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
  };
}
