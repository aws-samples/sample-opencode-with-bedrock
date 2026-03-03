import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.CONNECTIONS_TABLE!;
const API_GATEWAY_ENDPOINT = process.env.API_GATEWAY_ENDPOINT!;

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  console.log("Default event:", JSON.stringify({
    connectionId: event.requestContext.connectionId,
  }));

  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body || "{}");

  try {
    // Get connection info
    const connection = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { connectionId },
    }));

    if (!connection.Item) {
      return { statusCode: 410, body: "Connection not found" };
    }

    const shareId = connection.Item.shareId;

    switch (body.action) {
      case "subscribe": {
        const newShareId = body.shareId || shareId;

        // Validate shareId
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(newShareId)) {
          return { statusCode: 400, body: "Invalid shareId" };
        }

        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { connectionId },
          UpdateExpression: "set shareId = :shareId",
          ExpressionAttributeValues: {
            ":shareId": newShareId,
          },
        }));

        await postToConnection(connectionId, { type: "subscribed", shareId: newShareId });
        break;
      }

      case "ping":
        await postToConnection(connectionId, { type: "pong" });
        break;

      default:
        console.log("Unknown action:", body.action);
    }

    return { statusCode: 200, body: "Message processed" };
  } catch (error) {
    console.error("Error processing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
}

async function postToConnection(connectionId: string, data: any): Promise<void> {
  const apigw = new ApiGatewayManagementApiClient({
    endpoint: `https://${API_GATEWAY_ENDPOINT}`,
  });

  await apigw.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: Buffer.from(JSON.stringify(data)),
  }));
}
