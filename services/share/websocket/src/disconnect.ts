import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.CONNECTIONS_TABLE!;

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  console.log("Disconnect:", event.requestContext.connectionId);

  const connectionId = event.requestContext.connectionId;

  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { connectionId },
    }));

    return { statusCode: 200, body: "Disconnected" };
  } catch (error) {
    console.error("Error removing connection:", error);
    return { statusCode: 500, body: "Failed to disconnect" };
  }
}
