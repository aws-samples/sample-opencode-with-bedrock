import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, _Object } from "@aws-sdk/client-s3";

export namespace Storage {
  // Use default credential provider chain (works with ECS task role)
  const s3Client = new S3Client({
    region: process.env.OPENCODE_STORAGE_REGION || "us-east-1",
  });

  const bucket = process.env.OPENCODE_STORAGE_BUCKET!;

  function resolve(key: string[]): string {
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
      if (!body) return undefined;
      return JSON.parse(body) as T;
    } catch (error: any) {
      if (error.name === "NoSuchKey" || error.name === "NotFound") {
        return undefined;
      }
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
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: options?.limit,
      StartAfter: options?.after ? prefix + options.after + ".json" : undefined,
    });
    const response = await s3Client.send(command);
    let keys: string[] = response.Contents?.map((obj: _Object) => obj.Key || "") || [];

    if (options?.before) {
      const beforePath = prefix + options.before + ".json";
      keys = keys.filter((key: string) => key < beforePath);
    }

    return keys.map((x: string) => x.replace(/\.json$/, "").split("/"));
  }
}
