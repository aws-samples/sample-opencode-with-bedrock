import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from "@aws-sdk/client-apigatewaymanagementapi";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.CONNECTIONS_TABLE!;
const API_GATEWAY_ENDPOINT = process.env.API_GATEWAY_ENDPOINT!;

interface BroadcastEvent {
  shareId: string;
  message: any;
}

export async function handler(event: BroadcastEvent) {
  console.log("Broadcast event:", JSON.stringify({
    shareId: event.shareId,
    messageType: event.message?.type,
  }));

  const { shareId, message } = event;

  try {
    // Query all connections for this share
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "ShareIdIndex",
      KeyConditionExpression: "shareId = :shareId",
      ExpressionAttributeValues: {
        ":shareId": shareId,
      },
    }));

    if (!result.Items || result.Items.length === 0) {
      console.log("No connections for share:", shareId);
      return { statusCode: 200, body: "No connections" };
    }

    const apigw = new ApiGatewayManagementApiClient({
      endpoint: `https://${API_GATEWAY_ENDPOINT}`,
    });

    const payload = Buffer.from(JSON.stringify(message));

    // Send message to all connections
    const sendPromises = result.Items.map(async (item: Record<string, any>) => {
      try {
        await apigw.send(new PostToConnectionCommand({
          ConnectionId: item.connectionId,
          Data: payload,
        }));
      } catch (error) {
        if (error instanceof GoneException || (error as any).statusCode === 410) {
          // Connection is stale, remove it
          console.log("Removing stale connection:", item.connectionId);
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { connectionId: item.connectionId },
          }));
        } else {
          console.error("Error sending to connection:", item.connectionId, error);
        }
      }
    });

    await Promise.all(sendPromises);

    return { statusCode: 200, body: "Broadcast complete" };
  } catch (error) {
    console.error("Error broadcasting:", error);
    return { statusCode: 500, body: "Broadcast failed" };
  }
}
