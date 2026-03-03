import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.CONNECTIONS_TABLE!;

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  console.log("Connect event:", JSON.stringify({
    connectionId: event.requestContext.connectionId,
    queryParams: (event as any).queryStringParameters,
  }));

  const connectionId = event.requestContext.connectionId;
  const queryParams = (event as any).queryStringParameters || {};
  const shareId = queryParams.shareId || "default";

  // Validate shareId: alphanumeric, underscores, hyphens only (max 64 chars)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
    console.error("Invalid shareId:", shareId);
    return { statusCode: 400, body: "Invalid shareId" };
  }

  // TTL: 24 hours from now
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        connectionId,
        shareId,
        ttl,
        connectedAt: new Date().toISOString(),
      },
    }));

    return { statusCode: 200, body: "Connected" };
  } catch (error) {
    console.error("Error storing connection:", error);
    return { statusCode: 500, body: "Failed to connect" };
  }
}
