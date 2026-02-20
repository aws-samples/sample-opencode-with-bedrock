import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  healthHandler,
  createShareHandler,
  syncShareHandler,
  getShareDataHandler,
  deleteShareHandler,
  viewShareHandler,
} from "./handlers.js";

// Main Lambda handler - routes requests based on path and method
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  console.log("Event:", JSON.stringify(event));

  // Handle API Gateway v2 format (HTTP API)
  // rawPath includes stage (e.g., /prod/health) when accessed via CLI
  // rawPath is just the path (e.g., /share/xxx) when accessed via browser
  const rawPath = (event as any).rawPath || "/";
  const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

  // Strip stage prefix if present (stage names are typically short alphanumeric)
  // If rawPath starts with /prod/, /dev/, /stage/, etc., strip it
  const path = rawPath.replace(/^\/(prod|dev|stage|test)\b/, "") || "/";

  console.log("Parsed:", { rawPath, path, method });

  try {
    // Health check
    if (path === "/health" && method === "GET") {
      return await healthHandler();
    }

    // API Routes
    if (path === "/api/share" && method === "POST") {
      return await createShareHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+\/sync$/) && method === "POST") {
      return await syncShareHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+\/data$/) && method === "GET") {
      return await getShareDataHandler(event);
    }

    if (path.match(/^\/api\/share\/[^\/]+$/) && method === "DELETE") {
      return await deleteShareHandler(event);
    }

    // View share
    if (path.match(/^\/share\/[^\/]+$/) && method === "GET") {
      return await viewShareHandler(event);
    }

    // Handle OPTIONS for CORS
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Share-Secret",
        },
        body: "",
      };
    }

    // 404 for unmatched routes
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Not found" }),
    };
  } catch (error) {
    console.error("Unhandled error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
