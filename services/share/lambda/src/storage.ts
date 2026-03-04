import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, _Object } from "@aws-sdk/client-s3";

export namespace Storage {
  const s3Client = new S3Client({
    region: process.env.OPENCODE_STORAGE_REGION || "us-east-1",
  });

  const bucket = (() => {
    const name = process.env.OPENCODE_STORAGE_BUCKET;
    if (!name) {
      throw new Error("OPENCODE_STORAGE_BUCKET environment variable is required");
    }
    return name;
  })();

  function resolve(key: string[]): string {
    // Validate key segments to prevent path injection
    for (const segment of key) {
      if (segment.includes("..") || segment.includes("\0")) {
        throw new Error(`Invalid key segment: ${segment}`);
      }
    }
    return key.join("/") + ".json";
  }

  export async function read<T>(key: string[]): Promise<T | undefined> {
    const path = resolve(key);
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: path,
      });
      const response = await s3Client.send(command);
      const body = await response.Body?.transformToString();
      if (!body) {
        console.warn("Storage.read: empty body returned for key", { key: path, bucket });
        return undefined;
      }
      return JSON.parse(body) as T;
    } catch (error: any) {
      if (error.name === "NoSuchKey" || error.name === "NotFound") {
        console.log("Storage.read: key not found", { key: path, bucket, errorName: error.name });
        return undefined;
      }
      console.error("Storage.read: unexpected S3 error", {
        key: path,
        bucket,
        errorName: error.name,
        errorCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        message: error.message,
      });
      throw error;
    }
  }

  export async function write<T>(key: string[], value: T): Promise<void> {
    const path = resolve(key);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: path,
      Body: JSON.stringify(value),
      ContentType: "application/json",
    });
    await s3Client.send(command);
  }

  export async function remove(key: string[]): Promise<void> {
    const path = resolve(key);
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: path,
    });
    await s3Client.send(command);
  }

  export async function list(options?: {
    prefix?: string[];
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<string[][]> {
    const prefix = options?.prefix ? options.prefix.join("/") + (options.prefix.length ? "/" : "") : "";
    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    console.log("Storage.list: listing objects", {
      bucket,
      prefix,
      after: options?.after,
      before: options?.before,
      limit: options?.limit,
      startAfter: options?.after ? prefix + options.after + ".json" : undefined,
    });

    try {
      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: options?.limit ? Math.min(options.limit, 1000) : 1000,
          StartAfter: options?.after ? prefix + options.after + ".json" : undefined,
          ContinuationToken: continuationToken,
        });
        const response = await s3Client.send(command);
        const keys = response.Contents?.map((obj: _Object) => obj.Key || "") || [];
        allKeys.push(...keys);

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;

        // Respect limit if specified
        if (options?.limit && allKeys.length >= options.limit) {
          break;
        }
      } while (continuationToken);
    } catch (error: any) {
      console.error("Storage.list: S3 list error", {
        prefix,
        bucket,
        errorName: error.name,
        errorCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        message: error.message,
      });
      throw error;
    }

    let filteredKeys = allKeys;

    if (options?.before) {
      const beforePath = prefix + options.before + ".json";
      filteredKeys = filteredKeys.filter((key: string) => key < beforePath);
    }

    if (options?.limit) {
      filteredKeys = filteredKeys.slice(0, options.limit);
    }

    console.log("Storage.list: found keys", {
      prefix,
      totalKeys: allKeys.length,
      filteredKeys: filteredKeys.length,
    });

    return filteredKeys.map((x: string) => x.replace(/\.json$/, "").split("/"));
  }
}
